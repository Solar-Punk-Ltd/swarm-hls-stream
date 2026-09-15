import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScript } from './helpers/sandbox.js';

after(removeSandboxes);

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'scripts', 'bee-publishers.sh');
const SCRIPT_NAME = 'bee-publishers.sh';
const PROFILE = 'latbench';

/** Slot 7 is the latbench stage's, so the ports below are the ones an operator would recognise. */
const PORT_SLOT = '7';
const PORTS = { '360p': 10075, '480p': 11071, '720p': 11073, '1080p': 11075 };

/** Synthetic. A live batch id in a committed fixture is a stamp anyone can spend against. */
const BATCHES = {
  '360p': 'a'.repeat(64),
  '480p': 'b'.repeat(64),
  '720p': 'c'.repeat(64),
  '1080p': 'd'.repeat(64),
};

const STACK_ROOT = resolve(HERE, '..', '..');

/**
 * Every file that names the postage floor, and the shape each one names it in.
 *
 * The stack carries this threshold in two shell defaults, in the uploader's compiled default, in the
 * compose fallback and in the sample an operator copies. All of them have to agree, because a
 * deployment reads whichever one its own path reaches and the rest are invisible from there.
 *
 * ⛔ Every pattern is the whole definition line, anchored at both ends and global. These files
 * discuss these very constants in their own comment blocks, and a pattern that can match anywhere
 * reads the prose instead of the definition: a sentence naming the floor as 1, above a value that
 * still says 24, kept this check green and every file "agreeing" on a number no deployment used.
 */
const MIN_TTL_SOURCES = [
  { file: 'deploy/scripts/bee-publishers.sh', pattern: /^readonly DEFAULT_MIN_TTL_HOURS=([\d.]+)$/gm },
  { file: 'deploy/scripts/drain-stage.sh', pattern: /^readonly DEFAULT_MIN_TTL_HOURS=([\d.]+)$/gm },
  {
    file: 'packages/stream-uploader/src/utils/config.ts',
    pattern: /^const DEFAULT_STAMP_MIN_TTL_HOURS = ([\d.]+);$/gm,
  },
  {
    file: 'deploy/docker-compose.yml',
    pattern: /^[ \t]*STAMP_MIN_TTL_HOURS: \$\{STAMP_MIN_TTL_HOURS:-([\d.]+)\}$/gm,
  },
  { file: '.env.sample', pattern: /^STAMP_MIN_TTL_HOURS=([\d.]+)$/gm },
];

/** The ceiling, same rule. `drain-stage.sh` carries no copy of this one, so it is not listed. */
const MAX_UTILIZATION_SOURCES = [
  { file: 'deploy/scripts/bee-publishers.sh', pattern: /^readonly DEFAULT_MAX_UTILIZATION=([\d.]+)$/gm },
  {
    file: 'packages/stream-uploader/src/utils/config.ts',
    pattern: /^const DEFAULT_STAMP_MAX_UTILIZATION = ([\d.]+);$/gm,
  },
  {
    file: 'deploy/docker-compose.yml',
    pattern: /^[ \t]*STAMP_MAX_UTILIZATION: \$\{STAMP_MAX_UTILIZATION:-([\d.]+)\}$/gm,
  },
  { file: '.env.sample', pattern: /^STAMP_MAX_UTILIZATION=([\d.]+)$/gm },
];

/**
 * The one number each file names, refusing anything this check cannot read as exactly one number.
 *
 * ⛔ Counted rather than taken first. `exec` returns the earliest match of however many there are and
 * says nothing about the rest, so a second definition further down the file, which is the state a
 * half-finished edit leaves, was invisible to the reader and decisive for whatever reads that file.
 *
 * ⛔ And checked for a number before it is compared. A capture accepting anything turned a value
 * written as a variable rather than a literal into NaN, and `assert.strictEqual` compares with
 * Object.is, where NaN equals NaN. So two files this check could not read at all reported agreement,
 * which is the one answer a threshold check must never give.
 */
function valuesNamed(sources) {
  return sources.map((source) => {
    const found = [...readFileSync(join(STACK_ROOT, source.file), 'utf8').matchAll(source.pattern)];
    assert.equal(
      found.length,
      1,
      `${source.file} names this threshold on ${found.length} lines in the shape this check reads, and one is the only readable answer`,
    );
    const value = Number(found[0][1]);
    assert.ok(Number.isFinite(value), `${source.file} names this threshold as ${found[0][1]}, which is not a number`);
    return { file: source.file, value };
  });
}

/** A batch that clears both of the thresholds this script shares with the uploader's postage gate. */
function healthy(batchID) {
  return { batchID, exists: true, usable: true, batchTTL: 5 * 24 * 3600, utilizationRatio: 0.1, depth: 22 };
}

function run(args) {
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * A `curl` answering `/stamps` for all four rungs' nodes, one fixture per port, honouring
 * `--write-out` the way curl does: the format string is appended to the body, which is how the
 * script reads an HTTP status at all. A stub that ignored it would leave every answer looking like a
 * 200 and the error-envelope tests below could not fail.
 *
 * @param {object} sandbox
 * @param {object} [options]
 * @param {Record<number, string>} [options.bodies] A literal body per port, replacing the fixture.
 * @param {Record<number, number>} [options.statuses] The HTTP status per port, 200 by default.
 */
function stubCurl(sandbox, { bodies = {}, statuses = {} } = {}) {
  const answers = Object.fromEntries(
    Object.entries(PORTS).map(([rung, port]) => [
      port,
      bodies[port] ?? JSON.stringify({ stamps: [healthy(BATCHES[rung])] }),
    ]),
  );
  const codes = Object.fromEntries(Object.entries(PORTS).map(([, port]) => [port, statuses[port] ?? 200]));
  const path = join(sandbox.binDir, 'curl');
  writeFileSync(
    `${path}.cjs`,
    `const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('http')) || '';
const answers = ${JSON.stringify(answers)};
const codes = ${JSON.stringify(codes)};
const port = (url.match(/:(\\d+)\\//) || [])[1] || '';
if (!(port in answers) || !url.endsWith('/stamps')) {
  process.stderr.write('curl stub was asked for ' + url + '\\n');
  process.exit(7);
}
process.stdout.write(answers[port]);
const at = argv.indexOf('-w');
if (at !== -1 && at + 1 < argv.length) {
  process.stdout.write(argv[at + 1].replace(/\\\\n/g, '\\n').replace('%{http_code}', String(codes[port])));
}
`,
  );
  writeFileSync(path, '#!/bin/sh\nexec node -- "$0.cjs" "$@"\n');
  chmodSync(path, 0o755);
  return sandbox;
}

/**
 * A sandbox on a remote topology, which is where the ssh-and-curl read route is the real one.
 *
 * @param {object} [options]
 * @param {string} [options.extra] Lines appended to the profile env file, which is the only place
 *   the uploader's own container reads its environment from.
 */
function publisherSandbox({ extra = '', ...options } = {}) {
  const sandbox = makeSandbox({
    config: ALL_REMOTE,
    project: PROFILE,
    envFiles: {
      '.env': 'STAMP=stamp\nSTREAM_KEY=key\n',
      [`.env.${PROFILE}`]: `STAMP=stamp\nSTREAM_KEY=key\nABR_ENABLED=true\n${extra}`,
    },
  });
  return stubCurl(sandbox, options);
}

function generate(sandbox, env = {}) {
  return runScript(sandbox, SCRIPT_NAME, [`--profile=${PROFILE}`, `--portSlot=${PORT_SLOT}`], env);
}

/**
 * The generator that writes BEE_PUBLISHERS by asking each rung's Bee node which batch it holds.
 *
 * Only what can be checked without a deployment. Its selection and refusal rules are exercised
 * against captured `/stamps` responses through `--stamps-from`, which needs a profile env file and so
 * belongs to the host rather than to CI.
 */
describe('the BEE_PUBLISHERS generator', () => {
  /**
   * ⛔⛔ The regression that made the script's ORDINARY invocation the only broken one. macOS ships
   * bash 3.2, where an **empty** array expanded as `"${arr[@]}"` under `set -u` is an unbound
   * variable rather than an empty list. `parse_profile_args` consumes `--profile` and `--portSlot`
   * and leaves `REST_ARGS` empty, so the script died on its own argument handling the moment nobody
   * passed a third flag. Every path exercised while writing it passed `--stamps-from`, which is
   * exactly why it survived to be committed.
   *
   * Asserted as "not this failure" plus "still refuses", because what should happen next is a refusal
   * about the missing env file. A test that only checked the exit code would pass against the bug.
   */
  it('gets past argument parsing when the profile flags are the only arguments', () => {
    const { code, out } = run(['--profile=no-such-profile-for-tests', '--portSlot=1']);

    assert.doesNotMatch(out, /unbound variable/, 'the script died on its own argument handling');
    assert.notEqual(code, 0, 'a profile with no env file has to refuse');
    assert.match(out, /no-such-profile-for-tests/, 'the refusal should name the profile it could not load');
  });

  it('prints its usage without needing a deployment', () => {
    const { code, out } = run(['--help']);

    assert.equal(code, 0);
    assert.match(out, /BEE_PUBLISHERS/);
    assert.match(out, /--write/);
    // ⛔ The LAST line of the header, not the first line of its last paragraph. Matching the first
    // one passes while the range cuts that paragraph in half, which is how the help of the script
    // beside this one printed half a sentence for two days.
    assert.doesNotMatch(out, /set -u/, 'the help reaches past the header comment into the script');
    assert.match(
      out,
      /selection and refusal paths get verified without a deployment/,
      'the help stops short of the end of the header',
    );
  });

  /**
   * The batch selection is an inline `python3 -c '...'` program inside a single-quoted shell string, so
   * one apostrophe or backtick in a comment closes the string and the whole file stops parsing. That
   * has happened once already, to a backtick in a docstring.
   */
  it('parses as bash, embedded python and all', () => {
    execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' });
  });

  /**
   * The floor and the ceiling have to be the ones PostageGate applies, or config this writes is
   * config the service refuses.
   *
   * ⛔ Asserted as agreement between the files rather than against a number written here, because
   * a number written here is what failed. Five files name the floor and this case checked two of
   * them, so on 2026-09-15 it was lowered in one and left at 24 in the other four, and which value
   * a deployment got depended on which of the five its path happened to reach.
   */
  it('names one postage floor and one ceiling across every file that carries them', () => {
    for (const threshold of [MIN_TTL_SOURCES, MAX_UTILIZATION_SOURCES]) {
      const named = valuesNamed(threshold);
      const [first, ...rest] = named;
      for (const other of rest) {
        assert.equal(
          other.value,
          first.value,
          `${other.file} names ${other.value} and ${first.file} names ${first.value}`,
        );
      }
    }
  });
});

/**
 * ⛔⛔⛔ THE CONTAINER NEVER SEES THE OPERATOR'S SHELL. This script writes the line the uploader
 * starts on, and it refuses a batch on the two thresholds the uploader's own `PostageGate` applies.
 * Both were read off the shell with a literal default, and the uploader reads its environment from
 * `.env.<profile>`. So an export in one terminal moved the floor here and nowhere else, and the line
 * this wrote could carry a batch the container refuses at startup, or leave out one it would have
 * taken.
 *
 * `drain-stage.sh` closed the same hole on its own copy of the floor. This is the other half of it.
 */
describe('the generator takes its thresholds from the file the container reads', () => {
  /** 40 hours clears the default floor of 12 and misses the 48 the env file below asks for. */
  const FORTY_HOURS = JSON.stringify({ stamps: [{ ...healthy(BATCHES['720p']), batchTTL: 40 * 3600 }] });

  it('applies the TTL floor the env file names, rather than its own default', async () => {
    const sandbox = publisherSandbox({
      extra: 'STAMP_MIN_TTL_HOURS=48\n',
      bodies: { [PORTS['720p']]: FORTY_HOURS },
    });

    const { exitCode, stdout, stderr } = await generate(sandbox);

    assert.notEqual(exitCode, 0, 'a batch the container will refuse at startup was written into the line');
    const out = `${stdout}${stderr}`;
    assert.match(out, /40\.0h left/);
    assert.match(out, /floor is 48\.0h/, 'the floor came from this script’s default rather than from the env file');
  });

  it('refuses when a shell TTL floor disagrees with the env file, naming both', async () => {
    const sandbox = publisherSandbox({ extra: 'STAMP_MIN_TTL_HOURS=48\n' });

    const { exitCode, stdout, stderr } = await generate(sandbox, { STAMP_MIN_TTL_HOURS: '24' });

    assert.notEqual(exitCode, 0, 'a shell value the container never sees was allowed to set the floor');
    const out = `${stdout}${stderr}`;
    assert.match(out, /STAMP_MIN_TTL_HOURS/);
    assert.match(out, /24/, 'the refusal did not name the value in this shell');
    assert.match(out, /48/, 'the refusal did not name the value the container will read');
  });

  /** ⛔ And a shell value with nothing in the file, which is exactly the export nobody deployed. */
  it('refuses a shell TTL floor the env file says nothing about', async () => {
    const sandbox = publisherSandbox();

    const { exitCode, stdout, stderr } = await generate(sandbox, { STAMP_MIN_TTL_HOURS: '48' });

    assert.notEqual(exitCode, 0, 'a shell export the container never sees was allowed to set the floor');
    const out = `${stdout}${stderr}`;
    assert.match(out, /48/, 'the refusal did not name the value in this shell');
    assert.match(out, /and 12 for the uploader/, 'the refusal did not name the floor the container will apply');
  });

  it('applies the utilization ceiling the env file names, rather than its own default', async () => {
    const sandbox = publisherSandbox({ extra: 'STAMP_MAX_UTILIZATION=0.05\n' });

    const { exitCode, stdout, stderr } = await generate(sandbox);

    assert.notEqual(exitCode, 0, 'a batch over the ceiling the container will apply was written into the line');
    const out = `${stdout}${stderr}`;
    assert.match(out, /10\.0% used/);
    assert.match(out, /ceiling is 5\.0%/, 'the ceiling came from this script’s default rather than from the env file');
  });

  it('refuses when a shell utilization ceiling disagrees with the env file, naming both', async () => {
    const sandbox = publisherSandbox({ extra: 'STAMP_MAX_UTILIZATION=0.5\n' });

    const { exitCode, stdout, stderr } = await generate(sandbox, { STAMP_MAX_UTILIZATION: '0.9' });

    assert.notEqual(exitCode, 0, 'a shell value the container never sees was allowed to set the ceiling');
    const out = `${stdout}${stderr}`;
    assert.match(out, /STAMP_MAX_UTILIZATION/);
    assert.match(out, /0\.9/, 'the refusal did not name the value in this shell');
    assert.match(out, /0\.5/, 'the refusal did not name the value the container will read');
  });

  it('refuses a shell utilization ceiling the env file says nothing about', async () => {
    const sandbox = publisherSandbox();

    const { exitCode, stdout, stderr } = await generate(sandbox, { STAMP_MAX_UTILIZATION: '0.5' });

    assert.notEqual(exitCode, 0, 'a shell export the container never sees was allowed to set the ceiling');
    const out = `${stdout}${stderr}`;
    assert.match(out, /0\.5/, 'the refusal did not name the value in this shell');
    assert.match(out, /0\.9/, 'the refusal did not name the ceiling the container will actually apply');
  });

  /** ⛔ The control. A refusal that fired whatever the two values were would pass every test above. */
  it('writes the ordinary line when the shell and the env file agree', async () => {
    const sandbox = publisherSandbox({ extra: 'STAMP_MIN_TTL_HOURS=48\nSTAMP_MAX_UTILIZATION=0.5\n' });

    const { exitCode, stdout, stderr } = await generate(sandbox, {
      STAMP_MIN_TTL_HOURS: '48',
      STAMP_MAX_UTILIZATION: '0.5',
    });

    assert.equal(exitCode, 0, `${stdout}${stderr}`);
    for (const [rung, port] of Object.entries(PORTS)) {
      assert.match(stdout, new RegExp(`${rung}@http://127\\.0\\.0\\.1:${port}<${BATCHES[rung].slice(0, 8)}…>`));
    }
  });
});

/**
 * ⛔⛔⛔ A NODE THAT ANSWERS AN ERROR IS NOT A NODE HOLDING NO BATCH. Bee answers a failure with an
 * ordinary JSON body carrying `code` and `message` and no `stamps` list at all, the read asked for no
 * HTTP status, and the parser read a missing list as an empty one. So an erroring node was refused
 * for holding "no batches at all", and the printed fix was to go and buy one on a node that had said
 * nothing about batches. The refusal was right and its reason was wrong, which is the more expensive
 * of the two failures: an operator acts on the reason.
 */
describe('the generator tells a node that answered an error from a node holding no batch', () => {
  const NOT_READY = JSON.stringify({ code: 503, message: 'batchstore is not ready' });

  it('names the status and the node’s own words, rather than reporting no batches at all', async () => {
    const sandbox = publisherSandbox({
      bodies: { [PORTS['720p']]: NOT_READY },
      statuses: { [PORTS['720p']]: 503 },
    });

    const { exitCode, stdout, stderr } = await generate(sandbox);

    assert.notEqual(exitCode, 0, 'a node answering 503 was read as one holding no usable batch');
    const out = `${stdout}${stderr}`;
    assert.match(out, new RegExp(`720p node on :${PORTS['720p']}`));
    assert.match(out, /answered 503/);
    assert.match(out, /batchstore is not ready/, 'the node’s own words were dropped from the refusal');
    assert.doesNotMatch(out, /no batches at all/, 'an erroring node was reported as holding no batches');
  });

  /** ⛔ The 200 that carries an envelope anyway, which is the case an HTTP status cannot catch. */
  it('refuses a 200 whose body carries no list of stamps, rather than reading it as an empty node', async () => {
    const sandbox = publisherSandbox({ bodies: { [PORTS['480p']]: JSON.stringify({ code: 404, message: 'nope' }) } });

    const { exitCode, stdout, stderr } = await generate(sandbox);

    assert.notEqual(exitCode, 0, 'a body with no list of stamps was read as a node holding none');
    const out = `${stdout}${stderr}`;
    assert.match(out, /no list of stamps/);
    assert.doesNotMatch(out, /no batches at all/, 'an unreadable body was reported as an empty node');
  });

  /** ⛔ And the ordinary answer still reads, with the status line curl appends kept out of the body. */
  it('builds the line from four nodes that answered 200, one batch each', async () => {
    const sandbox = publisherSandbox();

    const { exitCode, stdout, stderr } = await generate(sandbox);

    assert.equal(exitCode, 0, `${stdout}${stderr}`);
    for (const [rung, port] of Object.entries(PORTS)) {
      assert.match(stdout, new RegExp(`${rung}@http://127\\.0\\.0\\.1:${port}<${BATCHES[rung].slice(0, 8)}…>`));
    }
    assert.doesNotMatch(stdout, /unreadable/, 'the status line curl appends was parsed as part of the body');
  });
});
