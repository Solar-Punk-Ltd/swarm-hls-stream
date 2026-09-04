import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/**
 * That the script arming one rung's postage batch to run dry swaps exactly one rung, refuses every
 * batch that would not run dry, and never buys anything.
 *
 * ⛔ The sitting it arms is `docs/e2e-batch-drain-plan.md`: one rung is pointed at a deliberately tiny
 * batch, the batch fills mid-broadcast, and the other three rungs are supposed to carry on. Arming it
 * means rewriting one entry of `BEE_PUBLISHERS` in the profile env and redeploying the uploader,
 * because the uploader reads that variable once at process start. Two things make that worth a test
 * rather than a paste. The line carries four 64-character batch ids, so an edit that damages one of
 * the other three arrives as a rung publishing to the wrong batch mid-broadcast. And a batch that is
 * not empty, or not the smallest depth bee allows, drains at a moment nobody chose, which turns the
 * one thing the sitting measures into an accident.
 *
 * ⚠️ Two test-only accommodations, and nothing in the script is relaxed for either.
 *
 * A `curl` stub in the sandbox's bin directory answers `/chainstate` and `/stamps`. The script reads
 * both the way `bee-publishers.sh` does, over `ssh <target> "curl ..."` for a remote target and
 * directly for a local one, and the sandbox's `ssh` stub really runs what it is handed, so a remote
 * read reaches this stub through the same route a deployment would.
 *
 * The success paths redeploy, and they run against a `localhost` topology with a seeded
 * `packages/stream-uploader/dist`. `deploy.sh` runs `pnpm install && pnpm build` unconditionally for
 * a REMOTE uploader deploy and only when `dist/` is missing for a local one, and a sandbox is an
 * `mkdtemp` with no workspace in it. So the refusals are driven remotely, where the read route is the
 * real one, and the two paths that reach a redeploy are driven locally, where it can complete.
 */
const SCRIPT = 'drain-stage.sh';
const PROFILE = 'latbench';
const RUNG = '1080p';

/** Slot 7 is the latbench stage's, so the ports below are the ones an operator would recognise. */
const PORT_SLOT = '7';
const RUNG_PORT = 11075;

/** Synthetic. A live batch id in a committed fixture is a stamp anyone can spend against. */
const ORIGINAL = {
  '360p': 'a'.repeat(64),
  '480p': 'b'.repeat(64),
  '720p': 'c'.repeat(64),
  '1080p': 'd'.repeat(64),
};
const SMALL_BATCH = 'e'.repeat(64);

const PORTS = { '360p': 10075, '480p': 11071, '720p': 11073, '1080p': RUNG_PORT };

const RECORD = `.drain-stage.${PROFILE}.env`;

/** What the stage's chain state reads, and what the plan priced the small batch from. */
const CHAIN_PRICE = 84370;
const MINIMUM_VALIDITY_BLOCKS = 17280;

/** The smallest depth bee accepts, which is the only depth this script arms. */
const DEPTH = 17;

/** An empty depth-17 batch with two days on it, which is what `arm` is supposed to accept. */
const ARMABLE = {
  batchID: SMALL_BATCH,
  utilization: 0,
  usable: true,
  exists: true,
  label: 'drain-1080p',
  depth: DEPTH,
  bucketDepth: 16,
  amount: '2915827200',
  immutableFlag: true,
  batchTTL: 2 * 24 * 3600,
};

function publishersLine(batches = ORIGINAL) {
  const entries = Object.entries(PORTS).map(([rung, port]) => `${rung}@http://127.0.0.1:${port}<${batches[rung]}>`);
  return entries.join(' ');
}

function envFiles({ publishers = publishersLine(), extra = '' } = {}) {
  return {
    '.env': 'STAMP=stamp\nSTREAM_KEY=key\n',
    [`.env.${PROFILE}`]: `STAMP=stamp\nSTREAM_KEY=key\nABR_ENABLED=true\nBEE_PUBLISHERS=${publishers}\n${extra}`,
  };
}

/**
 * A `curl` that answers only the two endpoints this script reads, from fixtures, and refuses
 * everything else so a script reaching for a third endpoint fails here rather than silently.
 */
function stubCurl(sandbox, { chainstate = {}, stamps = [] } = {}) {
  const body = {
    chainstate: {
      chainTip: 1,
      block: 1,
      totalAmount: '0',
      currentPrice: CHAIN_PRICE,
      minimumValidityBlocks: MINIMUM_VALIDITY_BLOCKS,
      ...chainstate,
    },
    stamps: { stamps },
  };
  const path = join(sandbox.binDir, 'curl');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const url = process.argv.slice(2).find((a) => a.startsWith('http')) || '';
const answers = ${JSON.stringify(body)};
if (url.includes('/chainstate')) {
  process.stdout.write(JSON.stringify(answers.chainstate));
} else if (url.includes('/stamps')) {
  process.stdout.write(JSON.stringify(answers.stamps));
} else {
  process.stderr.write('curl stub was asked for ' + url + '\\n');
  process.exit(7);
}
`,
  );
  chmodSync(path, 0o755);
  return sandbox;
}

/** A sandbox on a remote topology, which is where the ssh-and-curl read route is the real one. */
function remoteSandbox({ readings = {}, ...options } = {}) {
  const sandbox = makeSandbox({ config: ALL_REMOTE, project: PROFILE, envFiles: envFiles(options) });
  return stubCurl(sandbox, readings);
}

/**
 * A sandbox on a local topology with the uploader's build output seeded, so the redeploy the success
 * paths issue can actually complete.
 */
function localSandbox({ readings = {}, ...options } = {}) {
  const sandbox = makeSandbox({ project: PROFILE, envFiles: envFiles(options) });
  mkdirSync(join(sandbox.root, 'packages', 'stream-uploader', 'dist'), { recursive: true });
  writeFileSync(join(sandbox.root, 'packages', 'stream-uploader', 'dist', 'index.js'), '');
  return stubCurl(sandbox, readings);
}

function drainStage(sandbox, args, env = {}) {
  return runScript(
    sandbox,
    SCRIPT,
    [`--profile=${PROFILE}`, `--portSlot=${PORT_SLOT}`, `--rung=${RUNG}`, ...args],
    env,
  );
}

function envText(sandbox) {
  return readFileSync(join(sandbox.root, `.env.${PROFILE}`), 'utf8');
}

function publishersOf(sandbox) {
  const line = /^BEE_PUBLISHERS=(.*)$/m.exec(envText(sandbox));
  assert.ok(line, `the env file no longer carries a BEE_PUBLISHERS line:\n${envText(sandbox)}`);
  return Object.fromEntries(
    line[1]
      .trim()
      .split(/\s+/)
      .map((entry) => [entry.slice(0, entry.indexOf('@')), entry.slice(entry.lastIndexOf('<') + 1, -1)]),
  );
}

function backups(sandbox) {
  return readdirSync(sandbox.root).filter((name) => name.startsWith(`.env.${PROFILE}.bak-`));
}

/**
 * Anything beside the profile env that shares its name and is not one of the copies it takes, which
 * is what a rewrite that wrote somewhere else and did not clean up after itself leaves behind.
 */
function halfWrittenEnvFiles(sandbox) {
  return readdirSync(sandbox.root).filter(
    (name) => name.startsWith(`.env.${PROFILE}.`) && !name.startsWith(`.env.${PROFILE}.bak-`),
  );
}

/**
 * A directory for `PYTHONPATH` whose `sitecustomize.py` makes the first write to the profile env
 * raise, and returns its path. See the test that uses it for why the fault has to be injected here.
 */
function failingEnvWrite(sandbox) {
  const directory = join(sandbox.root, 'python-path');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'sitecustomize.py'),
    `import builtins

NAME = ${JSON.stringify(`.env.${PROFILE}`)}
real_open = builtins.open


def guarded_open(file, mode="r", *args, **kwargs):
    handle = real_open(file, mode, *args, **kwargs)
    if isinstance(file, str) and "w" in mode and file.split("/")[-1].startswith(NAME):
        raise OSError(28, "No space left on device")
    return handle


builtins.open = guarded_open
`,
  );
  return directory;
}

function recordPath(sandbox) {
  return join(sandbox.root, RECORD);
}

/** Whether the redeploy of the uploader, and nothing else, reached compose. */
function redeployedServices(sandbox) {
  return sandbox
    .calls()
    .filter((call) => call.startsWith('compose ') && call.includes(' up -d'))
    .map((call) => [...call.matchAll(/--profile (\S+)/g)].map((hit) => hit[1]).join(','));
}

describe('drain-stage print-buy hands the purchase to the owner', () => {
  /**
   * The command has to name the rung's OWN node. Every rung publishes through its own bee with its
   * own wallet, so a batch bought on the coordinator's node is a batch the 1080p rung cannot spend,
   * and it would arm cleanly and refuse at the first upload.
   */
  it('prints the buy for the rung’s own node, at the amount the chain price implies', async () => {
    const sandbox = remoteSandbox();

    const run = await drainStage(sandbox, ['print-buy']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    // 84370 PLUR per chunk per block * 17280 blocks per day * 2 days.
    assert.match(run.stdout, new RegExp(`/stamps/${CHAIN_PRICE * MINIMUM_VALIDITY_BLOCKS * 2}/${DEPTH}`));
    assert.match(run.stdout, new RegExp(`127\\.0\\.0\\.1:${RUNG_PORT}`));
    assert.match(run.stdout, /Immutable: true/);
  });

  /**
   * Bee 2.8.2 answers `currentPrice` as a JSON string ("84370"), not a number, and the first live
   * print-buy on 2026-09-04 was refused for it while every fixture here sent a number. The stand-in
   * now sends what bee sends.
   */
  it('reads a currentPrice bee sends as a string, which is what bee sends', async () => {
    const sandbox = remoteSandbox({ readings: { chainstate: { currentPrice: String(CHAIN_PRICE) } } });

    const run = await drainStage(sandbox, ['print-buy']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, new RegExp(`/stamps/${CHAIN_PRICE * MINIMUM_VALIDITY_BLOCKS * 2}/${DEPTH}`));
  });

  it('scales the amount with --days, since the amount is what buys the life', async () => {
    const sandbox = remoteSandbox();

    const run = await drainStage(sandbox, ['print-buy', '--days=3']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, new RegExp(`/stamps/${CHAIN_PRICE * MINIMUM_VALIDITY_BLOCKS * 3}/${DEPTH}`));
  });

  /** 2^17 chunks * 2915827200 PLUR is 382183302758400 PLUR, and a BZZ is 1e16 of those. */
  it('prices it in BZZ, so the owner sees the spend before running the command', async () => {
    const sandbox = remoteSandbox();

    const run = await drainStage(sandbox, ['print-buy']);

    assert.match(run.stdout, /0\.0382 BZZ/);
  });

  it('says how much the batch holds before it starts refusing', async () => {
    const sandbox = remoteSandbox();

    const run = await drainStage(sandbox, ['print-buy']);

    // 65536 buckets of two chunks each, and a third chunk in any one of them ends the batch.
    assert.match(run.stdout, /65536 buckets of 2 chunks/);
    assert.match(run.stdout, /refus\w+ near 2\d{3} chunks/);
    // ⛔ And the spread, because the closed form runs about 12% high and the first refusal is a
    // chance event: simulated at depth 17, a tenth of the trials refused under 1350 chunks and a
    // tenth over 3874. An operator told one figure reads a slow fill as a failed drain.
    assert.match(run.stdout, /anywhere from about 1\d{3} .* to about 3\d{3} /);
    assert.match(run.stdout, /the spread is the point/);
  });

  /**
   * ⛔ The whole two-step ownership is this line. The agent never moves money, so the script prints
   * the command and stops, and it says so rather than leaving an operator to wonder whether a batch
   * was just bought.
   */
  it('says in its own output that it never runs the command', async () => {
    const sandbox = remoteSandbox();

    const run = await drainStage(sandbox, ['print-buy']);

    assert.match(run.stdout, /never runs it/);
  });

  /**
   * The one assertion that a print is a print. A POST to `/stamps` spends, so the read this
   * subcommand makes has to be the only request it issues.
   */
  it('issues nothing but the chainstate read', async () => {
    const sandbox = remoteSandbox();

    await drainStage(sandbox, ['print-buy']);

    const reads = sandbox.sshCommands();
    assert.equal(reads.length, 1, `print-buy reached the host more than once: ${reads.join(' | ')}`);
    assert.match(reads[0], /\/chainstate/);
    assert.doesNotMatch(reads[0], /XPOST/);
    assert.deepEqual(redeployedServices(sandbox), [], 'print-buy redeployed something');
  });

  it('refuses a node that cannot say what a batch costs', async () => {
    const sandbox = makeSandbox({ config: ALL_REMOTE, project: PROFILE, envFiles: envFiles() });
    // A curl that fails rather than one that answers, which is the shape a node that is up but not
    // listening produces: an empty body and a non-zero status.
    writeFileSync(join(sandbox.binDir, 'curl'), '#!/bin/sh\nexit 7\n');
    chmodSync(join(sandbox.binDir, 'curl'), 0o755);

    const run = await drainStage(sandbox, ['print-buy']);

    assert.notEqual(run.exitCode, 0, 'a node that answered nothing produced a price anyway');
    assert.match(run.stderr, /did not answer \/chainstate/);
  });

  /**
   * ⛔ Absence is a refusal, never a default. `minimumValidityBlocks` is what turns days into an
   * amount, and reading a missing one as zero would print a command that buys a batch expiring
   * immediately, which the uploader's own startup floor would then refuse.
   */
  it('refuses a chainstate with no minimum validity in it', async () => {
    const sandbox = remoteSandbox({ readings: { chainstate: { minimumValidityBlocks: null } } });

    const run = await drainStage(sandbox, ['print-buy']);

    assert.notEqual(run.exitCode, 0, 'a chainstate missing a field was priced anyway');
    assert.match(run.stderr, /minimumValidityBlocks/);
  });
});

describe('drain-stage arm refuses every batch that would not run dry', () => {
  it('refuses a batch the node does not hold', async () => {
    const sandbox = remoteSandbox({ readings: { stamps: [] } });

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`]);

    assert.notEqual(run.exitCode, 0, 'a batch that is not on the node was armed');
    assert.match(run.stderr, /is not on the 1080p node/);
    assert.equal(publishersOf(sandbox)[RUNG], ORIGINAL[RUNG], 'the env file was rewritten anyway');
  });

  /**
   * ⛔ A bigger batch is the quiet failure. Depth 18 holds twice what depth 17 holds, so the sitting
   * runs its course with the rung still publishing and reports that nothing drained, which reads as
   * the product surviving rather than as the test never happening.
   */
  it('refuses a depth above 17, and says why a bigger batch cannot run dry', async () => {
    const sandbox = remoteSandbox({ readings: { stamps: [{ ...ARMABLE, depth: 25 }] } });

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`]);

    assert.notEqual(run.exitCode, 0, 'a depth-25 batch was armed to run dry');
    assert.match(run.stderr, /depth 25/);
    assert.match(run.stderr, /17/);
    assert.equal(publishersOf(sandbox)[RUNG], ORIGINAL[RUNG]);
  });

  /**
   * The uploader's own `PostageGate` refuses a configured batch under 24 hours, so a batch under the
   * floor arms cleanly and then stops the container from starting at all. An hour of margin, because
   * the arm and the sitting are not the same minute.
   */
  it('refuses a TTL under the floor the uploader itself applies', async () => {
    const sandbox = remoteSandbox({ readings: { stamps: [{ ...ARMABLE, batchTTL: 20 * 3600 }] } });

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`]);

    assert.notEqual(run.exitCode, 0, 'a batch expiring inside the uploader’s floor was armed');
    assert.match(run.stderr, /20\.0h/);
    assert.match(run.stderr, /25\.0h/);
    assert.equal(publishersOf(sandbox)[RUNG], ORIGINAL[RUNG]);
  });

  /**
   * ⛔ A batch that is already part full drains sooner than the arithmetic says, so the drain lands
   * at a moment nobody chose. The sitting reads the drop against the segment the rung was on, and a
   * batch starting at some unknown fraction makes that unrepeatable.
   */
  it('refuses a batch that already holds chunks', async () => {
    const sandbox = remoteSandbox({ readings: { stamps: [{ ...ARMABLE, utilization: 7 }] } });

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`]);

    assert.notEqual(run.exitCode, 0, 'a batch that was already in use was armed');
    assert.match(run.stderr, /empty/);
    assert.equal(publishersOf(sandbox)[RUNG], ORIGINAL[RUNG]);
  });

  it('refuses a batch the node reports unusable', async () => {
    const sandbox = remoteSandbox({ readings: { stamps: [{ ...ARMABLE, usable: false }] } });

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`]);

    assert.notEqual(run.exitCode, 0, 'an unusable batch was armed');
    assert.match(run.stderr, /usable=false/);
  });

  /**
   * ⛔ A second arm on top of the first loses the original batch id, which is the only record of what
   * the rung was publishing through. `restore` would then put back a small dead batch and the stage
   * would stay broken with nothing saying so.
   */
  it('refuses a second arm on the same rung, so the original cannot be lost', async () => {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });
    writeFileSync(recordPath(sandbox), `${RUNG}=${ORIGINAL[RUNG]}\n`);

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`]);

    assert.notEqual(run.exitCode, 0, 'a rung was armed twice');
    assert.match(run.stderr, /already armed/);
    assert.match(run.stderr, /restore/);
    assert.deepEqual(redeployedServices(sandbox), [], 'a refused arm still redeployed the uploader');
  });

  it('refuses a batch id that is not 64 hex characters', async () => {
    const sandbox = remoteSandbox({ readings: { stamps: [ARMABLE] } });

    const run = await drainStage(sandbox, ['arm', '--batch=deadbeef']);

    assert.notEqual(run.exitCode, 0, 'a short batch id was armed');
    assert.match(run.stderr, /64 hex characters/);
  });

  it('refuses a rung the BEE_PUBLISHERS line has no entry for', async () => {
    const sandbox = remoteSandbox({
      publishers: `360p@http://127.0.0.1:${PORTS['360p']}<${ORIGINAL['360p']}>`,
      readings: { stamps: [ARMABLE] },
    });

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`]);

    assert.notEqual(run.exitCode, 0, 'a rung with no entry was armed');
    assert.match(run.stderr, /no entry for rung 1080p/);
  });
});

/**
 * ⛔⛔⛔ A stage left armed with no way back is what this script's own header calls worse than a lost
 * log, and two writes on the SUCCESS track used to produce exactly that. Neither `cp` nor the append
 * that records the original was checked, so a failed one still reached a `✓` line and the arm carried
 * on. Losing the record means an operator works out by hand which of four 64-character batch ids on
 * one line the rung was spending, and `restore` refuses in the meantime.
 */
describe('drain-stage arm refuses to arm a stage it cannot put back', () => {
  /** ⛔ The copy is the fallback. Reporting one that was never made is worse than not making it. */
  it('refuses when the env file cannot be copied aside, rather than arming with no copy', async () => {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });

    // A directory nothing can create a file in, which is what a full disk and a read-only mount both
    // look like to `cp`. The env file itself stays writable, so only the copy is blocked.
    chmodSync(sandbox.root, 0o500);
    try {
      const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`], { HOME: sandbox.root });

      assert.notEqual(run.exitCode, 0, 'a rung was armed with no copy of the env file to fall back on');
      assert.match(run.stderr, /could not copy/);
      assert.equal(publishersOf(sandbox)[RUNG], ORIGINAL[RUNG], 'the env file was rewritten with no copy of it');
      assert.deepEqual(redeployedServices(sandbox), [], 'a failed copy still redeployed the uploader');
    } finally {
      chmodSync(sandbox.root, 0o755);
    }
  });

  /**
   * ⛔ The record is the only thing that knows which batch the rung was publishing through. An arm
   * that reports it recorded and did not leaves `restore` refusing with "nothing is armed" on a stage
   * that is armed.
   */
  it('refuses when the original cannot be recorded, rather than arming with nothing to put back', async () => {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });
    // A record another rung is already in and this process cannot append to, which is the shape of
    // one written by a different account.
    writeFileSync(recordPath(sandbox), `720p=${ORIGINAL['720p']}\n`);
    chmodSync(recordPath(sandbox), 0o444);

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`], { HOME: sandbox.root });

    assert.notEqual(run.exitCode, 0, 'a rung was armed with no record of the batch it was spending');
    assert.match(run.stderr, /could not record/);
    assert.equal(publishersOf(sandbox)[RUNG], ORIGINAL[RUNG], 'the env file was rewritten with nothing to put back');
    assert.deepEqual(redeployedServices(sandbox), [], 'a failed record still redeployed the uploader');
  });

  /**
   * ⛔⛔⛔ The profile env carries every setting the stage runs on, and a rewrite used to truncate it
   * before writing a byte. A write that died part way through left it empty or half written while the
   * script reported that the entry could not be rewritten, which an operator reads as nothing changed.
   *
   * The write is driven to fail here through `PYTHONPATH`, because a write that has begun and cannot
   * finish is not a state a sandbox can reach any other way. `sitecustomize.py` is imported by
   * python's own startup, so the wrapper below is in place before the program the script pipes in
   * runs a line. It lets the truncating open happen and then raises, which is the shape of a
   * filesystem that fills between the two, and it fires on any file beside the env file whose name
   * starts the same way, so it catches the rewrite wherever the rewrite chooses to land.
   */
  it('leaves the env file as it was when the rewrite cannot finish, rather than truncating it first', async () => {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });
    const before = envText(sandbox);

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`], {
      HOME: sandbox.root,
      PYTHONPATH: failingEnvWrite(sandbox),
    });

    assert.notEqual(run.exitCode, 0, 'a rewrite that could not finish reported an armed rung');
    assert.equal(envText(sandbox), before, 'the profile env did not survive a rewrite that could not finish');
    assert.match(run.stderr, /could not be rewritten/);
    assert.deepEqual(halfWrittenEnvFiles(sandbox), [], 'a half-written env file was left beside the real one');
    assert.deepEqual(redeployedServices(sandbox), [], 'a failed rewrite still redeployed the uploader');
  });
});

describe('drain-stage arm swaps one rung and nothing else', () => {
  // ⚠️ HOME inside the sandbox, because an arm dumps the uploader's log beside the bench checkout in
  // the home directory and a suite must not write into the operator's own. See the dump block below.
  async function armed() {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });
    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`], { HOME: sandbox.root });
    assert.equal(run.exitCode, 0, `arm failed: ${run.stdout}${run.stderr}`);
    return { sandbox, run };
  }

  /**
   * ⛔⛔ The assertion the whole file exists for. `BEE_PUBLISHERS` is one line carrying four batch
   * ids, and a rewrite that damages one of the other three sends that rung's segments to a batch it
   * does not own. That arrives as a rung failing to publish during the sitting, which is exactly the
   * signal the sitting is measuring on a different rung, so it would read as a product finding.
   */
  it('leaves the other three rungs byte for byte as they were', async () => {
    const { sandbox } = await armed();

    assert.deepEqual(publishersOf(sandbox), { ...ORIGINAL, [RUNG]: SMALL_BATCH });
  });

  it('keeps the line where it was rather than appending a second one', async () => {
    const { sandbox } = await armed();

    const lines = envText(sandbox)
      .split('\n')
      .filter((line) => line.startsWith('BEE_PUBLISHERS='));
    assert.equal(lines.length, 1, `the env file now has ${lines.length} BEE_PUBLISHERS lines`);
    assert.match(envText(sandbox), /^ABR_ENABLED=true$/m, 'the rest of the env file did not survive');
  });

  it('copies the env file aside before touching it', async () => {
    const { sandbox } = await armed();

    const copies = backups(sandbox);
    assert.equal(copies.length, 1, `expected one backup, got ${copies.join(', ')}`);
    assert.match(readFileSync(join(sandbox.root, copies[0]), 'utf8'), new RegExp(ORIGINAL[RUNG]));
  });

  it('records the batch the rung was publishing through, so restore has something to put back', async () => {
    const { sandbox } = await armed();

    assert.equal(readFileSync(recordPath(sandbox), 'utf8').includes(`${RUNG}=${ORIGINAL[RUNG]}`), true);
  });

  /** The uploader reads BEE_PUBLISHERS once at process start, so an arm that does not redeploy is inert. */
  it('redeploys the uploader, and only the uploader', async () => {
    const { sandbox } = await armed();

    assert.deepEqual(redeployedServices(sandbox), ['stream-uploader']);
  });

  it('prints each step it took', async () => {
    const { run } = await armed();

    assert.match(run.stdout, /BEE_PUBLISHERS/);
    assert.match(run.stdout, /stream-uploader/);
  });

  /** ⛔ Eight characters on stdout, the rule `bee-publishers.sh` sets: a scrollback outlives the command. */
  it('never prints a whole batch id', async () => {
    const { run } = await armed();

    for (const id of [SMALL_BATCH, ORIGINAL[RUNG]]) {
      assert.doesNotMatch(run.stdout, new RegExp(id), 'a whole batch id reached stdout');
    }
  });
});

describe('drain-stage restore puts the stage back', () => {
  async function restored() {
    const sandbox = localSandbox({
      publishers: publishersLine({ ...ORIGINAL, [RUNG]: SMALL_BATCH }),
      readings: { stamps: [ARMABLE] },
    });
    writeFileSync(recordPath(sandbox), `${RUNG}=${ORIGINAL[RUNG]}\n`);

    // ⚠️ HOME inside the sandbox, for the reason the arm helper above records.
    const run = await drainStage(sandbox, ['restore'], { HOME: sandbox.root });
    assert.equal(run.exitCode, 0, `restore failed: ${run.stdout}${run.stderr}`);
    return { sandbox, run };
  }

  it('writes the original batch back into the rung’s entry', async () => {
    const { sandbox } = await restored();

    assert.deepEqual(publishersOf(sandbox), ORIGINAL);
  });

  it('removes the record, so the stage is not left looking armed', async () => {
    const { sandbox } = await restored();

    assert.equal(existsSync(recordPath(sandbox)), false, 'the record survived a restore');
  });

  /** One rung at a time. Restoring one has to leave any other rung's record where it is. */
  it('keeps the record of a rung it was not asked about', async () => {
    const sandbox = localSandbox({
      publishers: publishersLine({ ...ORIGINAL, [RUNG]: SMALL_BATCH, '720p': SMALL_BATCH }),
      readings: { stamps: [ARMABLE] },
    });
    writeFileSync(recordPath(sandbox), `${RUNG}=${ORIGINAL[RUNG]}\n720p=${ORIGINAL['720p']}\n`);

    const run = await drainStage(sandbox, ['restore'], { HOME: sandbox.root });

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(readFileSync(recordPath(sandbox), 'utf8'), new RegExp(`720p=${ORIGINAL['720p']}`));
    assert.doesNotMatch(readFileSync(recordPath(sandbox), 'utf8'), new RegExp(`${RUNG}=`));
    assert.deepEqual(publishersOf(sandbox), { ...ORIGINAL, '720p': SMALL_BATCH });
  });

  it('copies the env file aside before touching it', async () => {
    const { sandbox } = await restored();

    assert.equal(backups(sandbox).length, 1);
  });

  it('redeploys the uploader, since the container is still running the small batch', async () => {
    const { sandbox } = await restored();

    assert.deepEqual(redeployedServices(sandbox), ['stream-uploader']);
  });

  /**
   * ⛔ A restore with nothing recorded cannot know what to put back, and the tempting default is the
   * healthiest batch on the node. That is `bee-publishers.sh`, and it is a different answer: the rung
   * may have been publishing through a batch that is no longer the healthiest one.
   */
  it('refuses when nothing is armed, rather than guessing an original', async () => {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });

    const run = await drainStage(sandbox, ['restore']);

    assert.notEqual(run.exitCode, 0, 'a restore with no record was allowed to rewrite the env file');
    assert.match(run.stderr, /nothing is armed/);
    assert.deepEqual(redeployedServices(sandbox), [], 'a refused restore still redeployed the uploader');
    assert.deepEqual(backups(sandbox), [], 'a refused restore still copied the env file aside');
  });
});

/**
 * ⛔⛔⛔ The evidence of a drain sitting is the uploader's own log, and a redeploy destroys it.
 *
 * On 2026-09-04 the first live drain refused the armed rung four times in about fifty seconds, and
 * the restore redeployed the uploader before anybody read the container log. `docker logs` belongs to
 * the container, so bee's own answers went with it and all that was left was a count of refusals,
 * which says nothing about which batch on which stream was refused or in what words. That was the
 * one thing the sitting was for.
 *
 * ⚠️ The dump lands in the home directory of the account the deployment is reached as, beside the
 * `~/swarm-hls-bench` checkout `bench-on-host.sh` keeps rather than inside it, because that script
 * syncs with `rsync --delete` and would remove it at the next sitting. These tests point `HOME` at
 * the sandbox, so the path under test is the real one and nothing is written to the operator's own
 * home.
 */
describe('drain-stage keeps the uploader log before it redeploys', () => {
  /** Every dump this run left beside the checkout, by name, which is what an operator greps for. */
  function keptLogs(sandbox) {
    return readdirSync(sandbox.root).filter((name) => name.startsWith('drain-') && name.endsWith('.uploader.log'));
  }

  /** Where the `docker logs` read and the redeploy landed in the order docker was called. */
  function callOrder(sandbox) {
    const calls = sandbox.calls();
    return {
      calls,
      dumpedAt: calls.findIndex((call) => call.startsWith('logs ')),
      redeployedAt: calls.findIndex((call) => call.startsWith('compose ') && call.includes(' up -d')),
    };
  }

  async function armedWithHome() {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });
    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`], { HOME: sandbox.root });
    assert.equal(run.exitCode, 0, `arm failed: ${run.stdout}${run.stderr}`);
    return { sandbox, run };
  }

  async function restoredWithHome() {
    const sandbox = localSandbox({
      publishers: publishersLine({ ...ORIGINAL, [RUNG]: SMALL_BATCH }),
      readings: { stamps: [ARMABLE] },
    });
    writeFileSync(recordPath(sandbox), `${RUNG}=${ORIGINAL[RUNG]}\n`);
    const run = await drainStage(sandbox, ['restore'], { HOME: sandbox.root });
    assert.equal(run.exitCode, 0, `restore failed: ${run.stdout}${run.stderr}`);
    return { sandbox, run };
  }

  it('dumps the drained process log on a restore, named for the profile, the rung and the instant', async () => {
    const { sandbox, run } = await restoredWithHome();

    const kept = keptLogs(sandbox);
    assert.equal(kept.length, 1, `expected one dump, got ${kept.join(', ') || 'none'}`);
    assert.match(kept[0], new RegExp(`^drain-${PROFILE}-${RUNG}-\\d{8}T\\d{6}Z\\.uploader\\.log$`));
    assert.match(run.stdout, new RegExp(kept[0]), 'the path was not printed, so nobody can find the file');
  });

  /** ⛔ Both process lives, because the arm ends the one that was running on the original batch. */
  it('dumps the previous process log on an arm, marked as the life before it', async () => {
    const { sandbox } = await armedWithHome();

    const kept = keptLogs(sandbox);
    assert.equal(kept.length, 1, `expected one dump, got ${kept.join(', ') || 'none'}`);
    assert.match(kept[0], new RegExp(`^drain-${PROFILE}-${RUNG}-\\d{8}T\\d{6}Z-before-arm\\.uploader\\.log$`));
  });

  /**
   * ⛔⛔ The whole point of the order. A container compose has replaced has no log to read, so a dump
   * after the redeploy would collect the fresh process and report success at having saved nothing.
   */
  for (const [subcommand, drive] of [
    ['restore', restoredWithHome],
    ['arm', armedWithHome],
  ]) {
    it(`reads the log before the redeploy on a ${subcommand}, not after it`, async () => {
      const { sandbox } = await drive();

      const { calls, dumpedAt, redeployedAt } = callOrder(sandbox);
      assert.ok(dumpedAt >= 0, `no docker logs call at all: ${calls.join(' | ')}`);
      assert.ok(redeployedAt >= 0, `no redeploy at all: ${calls.join(' | ')}`);
      assert.ok(
        dumpedAt < redeployedAt,
        `the log was read after the redeploy, which reads a container the old one was replaced by: ${calls.join(
          ' | ',
        )}`,
      );
      assert.match(calls[dumpedAt], new RegExp(`${PROFILE}-stream-uploader-1`));
    });
  }

  /**
   * ⛔ That the file holds what the container said, and both streams of it. The uploader writes the
   * refused-batch line at error level, so a dump that kept stdout alone would save every ordinary
   * line and lose the one the sitting is about.
   */
  it('carries what the container said into the file, stderr included', async () => {
    const sandbox = localSandbox({
      publishers: publishersLine({ ...ORIGINAL, [RUNG]: SMALL_BATCH }),
      readings: { stamps: [ARMABLE] },
    });
    writeFileSync(recordPath(sandbox), `${RUNG}=${ORIGINAL[RUNG]}\n`);
    // A docker that answers `logs` with one line on each stream and hands everything else to the
    // ordinary stub, which journals. The default stub answers `logs` with nothing at all, so an empty
    // file would pass a test that only looked for the file.
    writeFileSync(
      join(sandbox.binDir, 'docker'),
      '#!/bin/sh\nif [ "$1" = "logs" ]; then echo ordinary-line; echo refused-line >&2; exit 0; fi\n' +
        'exec node -- "$0.cjs" "$@"\n',
    );
    chmodSync(join(sandbox.binDir, 'docker'), 0o755);

    const run = await drainStage(sandbox, ['restore'], { HOME: sandbox.root });

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    const kept = keptLogs(sandbox);
    assert.equal(kept.length, 1, `expected one dump, got ${kept.join(', ') || 'none'}`);
    const dumped = readFileSync(join(sandbox.root, kept[0]), 'utf8');
    assert.match(dumped, /ordinary-line/);
    assert.match(dumped, /refused-line/, 'the error stream was dropped, which is where the refusal is written');
  });

  /**
   * ⛔⛔ A stage left armed is worse than a lost log. The restore is the step that puts the deployment
   * back, so a container that cannot be read has to cost the evidence and nothing else.
   */
  it('still restores when the dump fails, and says the log was not kept', async () => {
    const sandbox = localSandbox({
      publishers: publishersLine({ ...ORIGINAL, [RUNG]: SMALL_BATCH }),
      readings: { stamps: [ARMABLE] },
    });
    writeFileSync(recordPath(sandbox), `${RUNG}=${ORIGINAL[RUNG]}\n`);
    // A docker that refuses `logs` alone and answers everything else through the ordinary stub, which
    // is the shape of a container that is not there any more.
    writeFileSync(
      join(sandbox.binDir, 'docker'),
      '#!/bin/sh\nif [ "$1" = "logs" ]; then exit 9; fi\nexec node -- "$0.cjs" "$@"\n',
    );
    chmodSync(join(sandbox.binDir, 'docker'), 0o755);

    const run = await drainStage(sandbox, ['restore'], { HOME: sandbox.root });

    assert.equal(run.exitCode, 0, `a failed dump stopped the restore: ${run.stdout}${run.stderr}`);
    assert.deepEqual(publishersOf(sandbox), ORIGINAL, 'the original batch was not put back');
    assert.deepEqual(redeployedServices(sandbox), ['stream-uploader'], 'the restore did not redeploy');
    assert.match(run.stdout, /not kept/);
    assert.match(run.stdout, /carries on/);
  });

  /** ⛔ Neither read is a write. A dump is a read of a log, and nothing else about the stage moves. */
  it('writes nothing on a status or a print-buy, which redeploy nothing', async () => {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });

    await drainStage(sandbox, ['status'], { HOME: sandbox.root });

    assert.deepEqual(keptLogs(sandbox), [], 'a read-only subcommand dumped a log');
  });
});

/**
 * ⛔⛔⛔ A READ THIS SCRIPT CUT SHORT IS NOT A NODE ANSWERING BADLY, and the two used to arrive as the
 * same refusal. `read_node` captures curl's exit code and the guard under it only read that code on
 * the remote path, so a local curl that died at its own `--max-time` left a truncated body that is
 * not empty, reached the parser, and made the script blame bee for a sentence bee never finished
 * saying. This repo has already lost a whole measurement arm to the same confusion on the ssh side.
 */
describe('drain-stage tells a read that failed from a node that answered', () => {
  /** curl exits 28 at its own --max-time and 18 on a transfer that stopped early. */
  it('refuses a local read that curl cut short, and blames the read rather than the node', async () => {
    const sandbox = localSandbox();
    // A curl that prints half an answer and then reports it timed out, which is what a node that
    // accepts the connection and then stops writing produces.
    writeFileSync(join(sandbox.binDir, 'curl'), `#!/bin/sh\nprintf '%s' '{"stamps":[{"batchID":"'\nexit 28\n`);
    chmodSync(join(sandbox.binDir, 'curl'), 0o755);

    const run = await drainStage(sandbox, ['arm', `--batch=${SMALL_BATCH}`], { HOME: sandbox.root });

    assert.notEqual(run.exitCode, 0, 'a read that was cut short was armed on anyway');
    assert.match(run.stderr, /exited 28/);
    assert.doesNotMatch(
      run.stderr,
      /unreadable/,
      'a read this script cut short was reported as the node answering badly',
    );
    assert.equal(publishersOf(sandbox)[RUNG], ORIGINAL[RUNG], 'the env file was rewritten on a read that failed');
  });
});

describe('drain-stage status reads all three places at once', () => {
  it('reports the configured batch, the record and the node’s own reading', async () => {
    const sandbox = remoteSandbox({
      publishers: publishersLine({ ...ORIGINAL, [RUNG]: SMALL_BATCH }),
      readings: { stamps: [ARMABLE] },
    });
    writeFileSync(recordPath(sandbox), `${RUNG}=${ORIGINAL[RUNG]}\n`);

    const run = await drainStage(sandbox, ['status']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, new RegExp(SMALL_BATCH.slice(0, 8)));
    assert.match(run.stdout, new RegExp(ORIGINAL[RUNG].slice(0, 8)));
    assert.match(run.stdout, /depth 17/);
    assert.doesNotMatch(run.stdout, new RegExp(SMALL_BATCH), 'a whole batch id reached stdout');
  });

  it('says so plainly when the rung is not armed', async () => {
    const sandbox = remoteSandbox({ readings: { stamps: [{ ...ARMABLE, batchID: ORIGINAL[RUNG] }] } });

    const run = await drainStage(sandbox, ['status']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /armed: no/);
  });

  it('changes nothing', async () => {
    const sandbox = localSandbox({ readings: { stamps: [ARMABLE] } });
    const before = envText(sandbox);

    const run = await drainStage(sandbox, ['status']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.equal(envText(sandbox), before);
    assert.deepEqual(backups(sandbox), []);
    assert.deepEqual(redeployedServices(sandbox), []);
  });
});

describe('drain-stage argument handling', () => {
  it('refuses a rung this deployment has no node for, naming the ones it has', async () => {
    const sandbox = remoteSandbox();

    const run = await runScript(sandbox, SCRIPT, [
      `--profile=${PROFILE}`,
      `--portSlot=${PORT_SLOT}`,
      '--rung=2160p',
      'status',
    ]);

    assert.notEqual(run.exitCode, 0, 'an unknown rung was accepted');
    assert.match(run.stderr, /2160p/);
    assert.match(run.stderr, /1080p/);
  });

  it('refuses a subcommand it does not have', async () => {
    const sandbox = remoteSandbox();

    const run = await drainStage(sandbox, ['drain']);

    assert.notEqual(run.exitCode, 0, 'an unknown subcommand was accepted');
    assert.match(run.stderr, /print-buy/);
  });

  /**
   * ⛔ `--batch` on a restore is the dangerous typo. It would read as naming the batch to put back
   * and there is no such argument, so a silent accept would restore whatever the record holds while
   * the operator believed they had chosen.
   */
  for (const [flag, subcommand] of [
    ['--batch=' + SMALL_BATCH, 'restore'],
    ['--batch=' + SMALL_BATCH, 'status'],
    ['--days=3', 'arm'],
  ]) {
    it(`refuses ${flag.split('=')[0]} on ${subcommand}, which has no such argument`, async () => {
      const sandbox = remoteSandbox({ readings: { stamps: [ARMABLE] } });

      const run = await runScript(sandbox, SCRIPT, [
        `--profile=${PROFILE}`,
        `--portSlot=${PORT_SLOT}`,
        `--rung=${RUNG}`,
        subcommand,
        flag,
      ]);

      assert.notEqual(run.exitCode, 0, `${flag} was accepted on ${subcommand}`);
      assert.match(run.stderr, new RegExp(`${flag.split('=')[0]} belongs to`));
    });
  }

  /**
   * ⛔ A natively-run uploader takes its environment from the shell that started it, and `deploy.sh`
   * skips it entirely. The rewrite would land in a file nothing reads and the redeploy would be a
   * silent no-op, which is the shape this repo has paid for twice: a setting that looks applied.
   */
  it('refuses a natively-run uploader, whose environment this cannot reach', async () => {
    const sandbox = makeSandbox({
      config: { services: { ...ALL_REMOTE.services, srs: 'localhost', 'stream-uploader': 'native' } },
      project: PROFILE,
      envFiles: envFiles(),
    });
    stubCurl(sandbox, { stamps: [ARMABLE] });

    const run = await drainStage(sandbox, ['status']);

    assert.notEqual(run.exitCode, 0, 'a natively-run uploader was treated as one this can redeploy');
    assert.match(run.stderr, /runs natively/);
  });

  it('refuses to act on no rung at all', async () => {
    const sandbox = remoteSandbox();

    const run = await runScript(sandbox, SCRIPT, [`--profile=${PROFILE}`, `--portSlot=${PORT_SLOT}`, 'status']);

    assert.notEqual(run.exitCode, 0, 'a run with no --rung was accepted');
    assert.match(run.stderr, /--rung/);
  });

  /**
   * ⛔⛔ The regression that made `bee-publishers.sh`'s ORDINARY invocation the only broken one, and
   * this script sets `-u` for the same reason it does. macOS ships bash 3.2, where an EMPTY array
   * expanded as `"${arr[@]}"` under `set -u` is an unbound variable rather than an empty list.
   */
  it('gets past its own argument handling with only the profile flags', async () => {
    const sandbox = remoteSandbox();

    const run = await runScript(sandbox, SCRIPT, [`--profile=${PROFILE}`, `--portSlot=${PORT_SLOT}`]);

    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /unbound variable/, 'the script died on its own arguments');
    assert.notEqual(run.exitCode, 0, 'a run naming no subcommand has to refuse');
    assert.match(run.stderr, /print-buy/, 'the refusal should be about the missing subcommand');
  });

  it('prints its usage without needing a deployment', async () => {
    const sandbox = remoteSandbox();

    const run = await runScript(sandbox, SCRIPT, ['--help']);

    assert.equal(run.exitCode, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /print-buy/);
    assert.match(run.stdout, /e2e-batch-drain-plan/);
    // The range is a line number, the way `bee-publishers.sh` writes it, so a comment added past the
    // end of the header silently truncates the help and one added inside it spills code into it.
    assert.doesNotMatch(run.stdout, /set -u/, 'the help range now reaches past the header comment');
    assert.match(run.stdout, /No batch id is ever printed whole/, 'the help range stops short of the header');
  });

  /**
   * The readings are parsed by inline `python3` programs inside single-quoted shell strings, so one
   * apostrophe or backtick in a comment closes the string and the whole file stops parsing. That has
   * happened once already in this directory, to a backtick in a docstring.
   */
  it('parses as bash, embedded python and all', () => {
    execFileSync('bash', ['-n', join(SCRIPTS, SCRIPT)], { stdio: 'pipe' });
  });
});
