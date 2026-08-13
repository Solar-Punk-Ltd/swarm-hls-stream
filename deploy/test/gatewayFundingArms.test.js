import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/gateway-funding-arms.sh');
const BATCH = '7849851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd';

/**
 * That a funded-versus-unfunded sitting measures two conditions rather than one node twice.
 *
 * ⛔⛔⛔ THE FAILURE THIS FILE EXISTS FOR PRODUCES A COMPLETE, PLAUSIBLE, WRONG RESULT. If both arms
 * end up reading the same gateway, every metric agrees, the tables fill, nothing errors, and the
 * report concludes that **funding makes no difference to a viewer** — which is exactly what an
 * optimist expects, so nothing about it invites a second look. There is no signal anywhere in the
 * viewer-facing output that would give it away. Every case here is about that.
 *
 * ⛔⛔ AND A STUB PROVES THE GATES, NEVER THE DRIVER. On 2026-08-13 `unfunded-gateway.sh` passed nine
 * stubbed tests while being completely broken, and one real start found five defects in a row, of
 * which the CORS one would have been silently fatal. Nothing below shows that this script can run.
 * ⭐ Run one short real arm before trusting it with a paid sitting.
 */

const cleanups = [];

after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

/**
 * An arm order the counterbalance would never produce for two rounds.
 *
 * ⭐ Deliberately not `funded unfunded funded unfunded`. The driver must run what the harness printed;
 * a driver that derived the order itself would produce the natural one and fail the case that checks
 * this, which is the whole point of `browser:arm-order` existing.
 */
const STUB_ARM_ORDER = 'unfunded funded funded unfunded';

function setup({
  fundedBzz = 5,
  unfundedIsUnfunded = true,
  gatewayCheckFails = false,
  selfcheckFails = false,
  missingImage = false,
  armOrder = STUB_ARM_ORDER,
  stopFileFirst = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-funding-arms-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const out = join(dir, 'out');
  mkdirSync(out, { recursive: true });

  const dockerLog = join(dir, 'docker.jsonl');
  const metricsLog = join(dir, 'node-metrics.jsonl');
  const unfundedLog = join(dir, 'unfunded-gateway.jsonl');
  const publishLog = join(dir, 'publish.jsonl');
  // Its presence is "a broadcast is running", which makes the health endpoint and the publisher
  // listing stateful. A stub that always reported a live stream would send the teardown through the
  // whole wait_for_quiet budget, which is the very state the script exists to notice.
  const liveFlag = join(dir, 'BROADCAST-LIVE');

  for (const [path, contents] of [
    [dockerLog, ''],
    [metricsLog, ''],
    [unfundedLog, ''],
    [publishLog, ''],
  ]) {
    writeFileSync(path, contents);
  }

  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(argv) + '\\n');

if (argv[0] === 'image' && argv[1] === 'inspect') process.exit(${missingImage ? 1 : 0});

if (argv[0] === 'ps') {
  // Ours only exists while a broadcast does, so the name recorded at startup is somebody else's and
  // the teardown has to leave it alone.
  const filter = argv.find((a) => a.startsWith('name=')) || '';
  if (filter.includes('publish')) {
    process.stdout.write(fs.existsSync(${JSON.stringify(liveFlag)})
      ? 'ours-publisher\\nsomeone-elses-publisher\\n'
      : 'someone-elses-publisher\\n');
  }
  process.exit(0);
}

if (argv[0] === 'rm') {
  if (argv.includes('ours-publisher')) {
    try { fs.unlinkSync(${JSON.stringify(liveFlag)}); } catch {}
  }
  process.exit(0);
}

if (argv[0] === 'run') {
  // By presence, not by position: browser:arm-order carries a rounds argument after it.
  const ran = (script) => argv.includes(script);
  const envOf = (name) => {
    const hit = argv.find((a, i) => argv[i - 1] === '-e' && a.startsWith(name + '='));
    return hit ? hit.slice(name.length + 1) : '';
  };
  if (ran('browser:arm-order')) process.stdout.write(${JSON.stringify(armOrder)} + '\\n');
  if (ran('browser:selfcheck')) process.exit(${selfcheckFails ? 1 : 0});
  if (ran('browser:gateway-check')) process.exit(${gatewayCheckFails ? 1 : 0});
  if (ran('browser:watch')) {
    fs.appendFileSync(${JSON.stringify(dockerLog)},
      JSON.stringify(['WATCH', envOf('BROWSER_GATEWAY_ARM'), envOf('BROWSER_GATEWAY_URL'),
        envOf('BROWSER_WATCH_SECONDS')]) + '\\n');
  }
}
process.exit(0);
`,
  );

  const plur = String(BigInt(Math.round(fundedBzz * 1000)) * 10n ** 13n);
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const url = process.argv.slice(2).find((a) => a.startsWith('http')) || '';
if (url.includes('/health')) {
  process.stdout.write(JSON.stringify({
    activeStreams: fs.existsSync(${JSON.stringify(liveFlag)}) ? 1 : 0,
    segmentsSkipped: 0,
  }));
} else if (url.includes('/chequebook/balance')) {
  // The funded gateway and the uploader answer with a balance. The unfunded node is ultra-light and
  // has no chequebook at all, which is the arm rather than a fault.
  const unfunded = url.includes(':10087') && ${unfundedIsUnfunded};
  if (!unfunded) process.stdout.write(JSON.stringify({ availableBalance: '${plur}' }));
} else if (url.includes('/stamps')) {
  process.stdout.write(JSON.stringify({ stamps: [{ batchID: '${BATCH}', utilization: 254, usable: true,
    depth: 25, bucketDepth: 16, immutableFlag: true, exists: true, batchTTL: 900000 }] }));
} else if (url.includes('/metrics')) {
  process.stdout.write('bee_retrieval_request_count 1\\n');
}
process.exit(0);
`,
  );

  // `run_browser_arm` passes the host docker group through, and this box is not the host.
  writeFileSync(join(bin, 'getent'), `#!/usr/bin/env node\nprocess.stdout.write('docker:x:999:\\n');\n`);

  const unfundedGateway = join(dir, 'unfunded-gateway.sh');
  writeFileSync(
    unfundedGateway,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(unfundedLog)}
[ "\${1:-}" = status ] && exit ${unfundedIsUnfunded ? 0 : 1}
exit 0
`,
  );

  const nodeMetrics = join(dir, 'node-metrics.sh');
  writeFileSync(
    nodeMetrics,
    `#!/usr/bin/env bash
printf '{"cmd":"%s","out":"%s","label":"%s","gateway":"%s"}\\n' \\
  "\${1:-}" "\${2:-}" "\${3:-}" "\${GATEWAY_BEE_PORT:-}" >> ${JSON.stringify(metricsLog)}
[ "\${1:-}" = snapshot ] && printf '{}' > "\${2}"
exit 0
`,
  );

  const stampGuard = join(dir, 'stamp-guard.sh');
  writeFileSync(stampGuard, `#!/usr/bin/env bash\nexit 0\n`);

  // The publisher is reached through the bench checkout, so the checkout needs one.
  const benchRepo = join(dir, 'bench');
  mkdirSync(join(benchRepo, 'deploy/scripts'), { recursive: true });
  writeFileSync(
    join(benchRepo, 'deploy/scripts/publish-clock.sh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(publishLog)}
: > ${JSON.stringify(liveFlag)}
exit 0
`,
  );
  chmodSync(join(benchRepo, 'deploy/scripts/publish-clock.sh'), 0o755);

  for (const path of [
    join(bin, 'docker'),
    join(bin, 'curl'),
    join(bin, 'getent'),
    unfundedGateway,
    nodeMetrics,
    stampGuard,
  ]) {
    chmodSync(path, 0o755);
  }

  if (stopFileFirst) {
    writeFileSync(join(out, 'STOP'), 'a previous sitting crossed a floor\n');
  }

  return {
    dir,
    bin,
    out,
    dockerLog,
    metricsLog,
    unfundedLog,
    publishLog,
    benchRepo,
    unfundedGateway,
    nodeMetrics,
    stampGuard,
  };
}

async function runSitting(stubs, env = {}) {
  let code = 0;
  try {
    await run('bash', [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${stubs.bin}:${process.env.PATH}`,
        OUT_DIR: stubs.out,
        BENCH_REPO: stubs.benchRepo,
        UNFUNDED_GATEWAY: stubs.unfundedGateway,
        NODE_METRICS: stubs.nodeMetrics,
        STAMP_GUARD: stubs.stampGuard,
        STAMP: BATCH,
        ROUNDS: '2',
        ARM_MINUTES: '2',
        ARM_GAP_S: '0',
        PUBLISHER_LEAD_S: '0',
        STOP_POLL_S: '0.05',
        ...env,
      },
      encoding: 'utf8',
    });
  } catch (failure) {
    code = failure.code;
  }

  const log = existsSync(join(stubs.out, 'gateway-funding-arms.log'))
    ? readFileSync(join(stubs.out, 'gateway-funding-arms.log'), 'utf8')
    : '';
  const state = existsSync(join(stubs.out, 'gateway-funding-arms-state.tsv'))
    ? readFileSync(join(stubs.out, 'gateway-funding-arms-state.tsv'), 'utf8')
    : '';
  const jsonl = (path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean);

  return {
    code,
    log,
    state,
    docker: jsonl(stubs.dockerLog),
    metrics: jsonl(stubs.metricsLog),
    unfunded: lines(stubs.unfundedLog),
    publishes: lines(stubs.publishLog),
  };
}

const watches = (result) => result.docker.filter((call) => call[0] === 'WATCH');
const snapshots = (result) => result.metrics.filter((call) => call.cmd === 'snapshot');

describe('the sitting reads one broadcast through two gateways', () => {
  /**
   * ⛔⛔⛔ The whole design. Two arms drawing from two broadcasts is how the fragment-size cliff was
   * found and then withdrawn: both arms drew from one corpus whose health was moving, and neither a
   * within-round contrast nor a replicate saved it. One publisher for the sitting is what makes the
   * content, the encoder, the window and the network shared rather than merely similar.
   */
  it('starts exactly one publisher for every arm', async () => {
    const result = await runSitting(setup());

    assert.equal(result.publishes.length, 1, `published ${result.publishes.length} times`);
    assert.equal(watches(result).length, 4);
  });

  /**
   * ⛔⛔ The broadcast has to outlive every arm, and an arm is longer than its watch. It also starts a
   * container, joins the stream, and takes four node readings, and `openViewer` waits up to 90s for
   * playback before giving up. A publisher budgeted at watch-plus-gap runs out during the last arms of
   * a sitting: the broadcast is paid for in full, the arms find no live stream, and the sitting comes
   * back short of the replicates it was booked for. The preflight cannot show this, because it
   * publishes nothing.
   */
  it('publishes for longer than the arms can possibly take', async () => {
    const armMinutes = 6;
    const rounds = 4;
    const result = await runSitting(setup(), {
      ROUNDS: String(rounds),
      ARM_MINUTES: String(armMinutes),
      ARM_GAP_S: '20',
      PUBLISHER_LEAD_S: '60',
      PREFLIGHT_ONLY: '1',
    });

    const declared = /one broadcast of (\d+) min/.exec(result.log);
    assert.ok(declared, 'the sitting did not say how long it publishes for');
    // The watch and the gaps alone, which is what an earlier version budgeted and is not enough.
    const watchOnlySeconds = 60 * 2 + rounds * 2 * (armMinutes * 60 + 20);
    assert.ok(
      Number(declared[1]) * 60 > watchOnlySeconds,
      `budgets ${declared[1]} min for arms whose watches alone are ${Math.ceil(watchOnlySeconds / 60)} min`,
    );
  });

  it('sends each arm to its own gateway', async () => {
    const result = await runSitting(setup());

    assert.deepEqual(
      watches(result).map((call) => [call[1], call[2]]),
      [
        ['unfunded', 'http://127.0.0.1:10087'],
        ['funded', 'http://127.0.0.1:10077'],
        ['funded', 'http://127.0.0.1:10077'],
        ['unfunded', 'http://127.0.0.1:10087'],
      ],
    );
  });

  /**
   * ⭐ The stub prints an order the counterbalance would never produce for two rounds, so a driver
   * that derived the order itself would run `funded unfunded funded unfunded` and fail here. The rule
   * lives in `gatewaySweep.ts` and this proves the shell does not carry a second copy of it.
   */
  it('runs the order the harness printed rather than one of its own', async () => {
    const result = await runSitting(setup({ armOrder: 'funded funded unfunded unfunded' }));

    assert.deepEqual(
      watches(result).map((call) => call[1]),
      ['funded', 'funded', 'unfunded', 'unfunded'],
    );
  });

  it('refuses when the printed order is not the number of arms it asked for', async () => {
    const result = await runSitting(setup({ armOrder: 'funded unfunded' }));

    assert.equal(result.code, 1);
    assert.equal(result.publishes.length, 0);
    assert.match(result.log, /wanted 4/);
  });
});

/**
 * ⛔⛔⛔ Every case here is a way for both arms to end up on one node. None of them produces an error,
 * a gap in the tables, or a number that looks odd. They produce a finished sitting that says funding
 * does not matter.
 */
describe('the two arms are two conditions, or nothing is published', () => {
  it('refuses when the funded gateway has no chequebook, so both arms would be unfunded', async () => {
    const result = await runSitting(setup({ fundedBzz: 5 }), { GATEWAY_BEE_PORT: '10087' });

    assert.equal(result.code, 1);
    assert.equal(result.publishes.length, 0);
    assert.match(result.log, /no chequebook/);
  });

  it('refuses when the unfunded node has one, so both arms would be funded', async () => {
    const result = await runSitting(setup({ unfundedIsUnfunded: false }));

    assert.equal(result.code, 1);
    assert.equal(result.publishes.length, 0);
    assert.match(result.log, /not the unfunded arm/);
  });

  /**
   * ⛔⛔⛔ The free canary for the worst case available. A client built without VITE_EXPOSE_PLAYER
   * publishes no switch, so every arm reads whatever the build defaults to. The per-arm readback
   * catches it as well, but only once a broadcast is live and paid for.
   */
  it('refuses when the deployed client cannot be moved between gateways', async () => {
    const result = await runSitting(setup({ gatewayCheckFails: true }));

    assert.equal(result.code, 1);
    assert.equal(result.publishes.length, 0);
    assert.match(result.log, /both arms would be one/);
  });

  it('re-checks the conditions before every arm, not once at the top', async () => {
    const result = await runSitting(setup());

    // One at the preflight and one before each of the four arms.
    assert.equal(
      result.unfunded.filter((call) => call === 'status').length,
      5,
      `asked the unfunded node its condition ${result.unfunded.length} times`,
    );
  });
});

describe('both gateways are read either side of every arm', () => {
  it('brackets each arm on the node it reads and on the one it does not', async () => {
    const result = await runSitting(setup());

    for (const arm of ['arm01', 'arm02', 'arm03', 'arm04']) {
      for (const which of ['funded', 'unfunded']) {
        for (const phase of ['before', 'after']) {
          assert.ok(
            snapshots(result).some(
              (call) => call.label.startsWith(arm) && call.label.endsWith(`-on-${which}-${phase}`),
            ),
            `no ${which} ${phase} reading for ${arm}`,
          );
        }
      }
    }
  });

  /**
   * ⛔⛔ A lifetime counter read once says nothing, so an unpaired reading is a defect rather than a
   * partial result. Seventeen arms of a funded sweep were once scored entirely from outside while
   * both nodes kept a complete account nothing ever read.
   */
  it('leaves no reading unpaired', async () => {
    const result = await runSitting(setup());

    const labels = snapshots(result).map((call) => call.label);
    for (const before of labels.filter((label) => label.endsWith('-before'))) {
      assert.ok(labels.includes(before.replace(/-before$/, '-after')), `${before} has no matching after`);
    }
    assert.ok(labels.includes('sitting-on-funded-before'));
    assert.ok(labels.includes('sitting-on-unfunded-after'));
  });

  it('points each reading at the node it names', async () => {
    const result = await runSitting(setup());

    for (const call of snapshots(result)) {
      const wanted = call.label.includes('-on-unfunded-') ? '10087' : '10077';
      assert.equal(call.gateway, wanted, `${call.label} was read off port ${call.gateway}`);
    }
  });

  /**
   * ⛔⛔⛔ `node_metrics.py` reads a missing chequebook as "the budget is unknown" and writes a stop
   * file, which is right for a node that is supposed to have one. Pointing the sampler at the
   * ultra-light node would abort the sitting on the strength of its own treatment, mid-arm, after the
   * broadcast was paid for. A node that cannot spend cannot run dry, so it is never sampled.
   */
  it('never points the running sampler at the node that has no chequebook', async () => {
    const result = await runSitting(setup(), { METRICS_INTERVAL_S: '1' });

    for (const call of result.metrics.filter((entry) => entry.cmd === 'watch')) {
      assert.notEqual(call.gateway, '10087', 'the sampler would stop the sitting for being the treatment');
    }
  });
});

describe('a sitting that refuses leaves the box as it found it', () => {
  it('publishes nothing when a previous sitting left a stop file', async () => {
    const result = await runSitting(setup({ stopFileFirst: true }));

    assert.equal(result.code, 1);
    assert.equal(result.publishes.length, 0);
    assert.equal(watches(result).length, 0);
  });

  it('publishes nothing when the browser image is not on the host', async () => {
    const result = await runSitting(setup({ missingImage: true }));

    assert.equal(result.code, 1);
    assert.equal(result.publishes.length, 0);
  });

  it('publishes nothing when the free selfcheck fails', async () => {
    const result = await runSitting(setup({ selfcheckFails: true }));

    assert.equal(result.code, 1);
    assert.equal(result.publishes.length, 0);
  });

  /**
   * ⛔⛔⛔ A PREFLIGHT_ONLY run publishes nothing, so it must tear nothing down either. On 2026-08-12
   * exactly such an invocation of `viewer-arms.sh` exited through its teardown trap and removed the
   * publisher a paid buffer sweep had been running against for forty minutes. The sweep went on
   * sampling a dead stream.
   */
  it('takes a preflight reading and stops without publishing or removing anything', async () => {
    const stubs = setup();
    const result = await runSitting(stubs, { PREFLIGHT_ONLY: '1' });

    assert.equal(result.code, 0);
    assert.equal(result.publishes.length, 0);
    assert.deepEqual(
      result.docker.filter((call) => call[0] === 'rm'),
      [],
      'a run that published nothing removed a container',
    );
    assert.ok(snapshots(result).some((call) => call.label === 'sitting-on-funded-before'));
  });

  /**
   * ⭐ A dry run has to reach every gate, or the gates it skips are reachable only by paying. An
   * earlier version stopped above the browser checks, which left the most important precondition here
   * (can the deployed client be moved between gateways at all) behind a broadcast. Its first real use
   * found the deployed client was eleven hours too old to have the switch in it.
   */
  it('runs every free check in a dry run, including the one about moving gateways', async () => {
    const result = await runSitting(setup(), { PREFLIGHT_ONLY: '1' });

    const ran = (script) => result.docker.some((call) => call.includes(script));
    assert.ok(ran('browser:arm-order'), 'a dry run did not read the arm order');
    assert.ok(ran('browser:selfcheck'), 'a dry run did not run the selfcheck');
    assert.ok(ran('browser:gateway-check'), 'a dry run did not check the client can change gateway');
  });

  it('still refuses a dry run whose client cannot be moved between gateways', async () => {
    const result = await runSitting(setup({ gatewayCheckFails: true }), { PREFLIGHT_ONLY: '1' });

    assert.equal(result.code, 1);
    assert.match(result.log, /both arms would be one/);
  });

  /**
   * ⛔⛔⛔ By name, and only the names this run created. A teardown keyed on a name pattern killed a
   * live paid broadcast on 2026-08-12: the pattern matched every publisher on the box, including one
   * serving somebody else's sitting.
   */
  it('removes only the publisher it started, never one that was already running', async () => {
    const result = await runSitting(setup());

    const removed = result.docker.filter((call) => call[0] === 'rm').flat();
    assert.ok(removed.includes('ours-publisher'), 'it left its own publisher running');
    assert.ok(!removed.includes('someone-elses-publisher'), 'it removed a publisher it did not start');
  });
});

describe('the funding gate asks only the nodes that can spend', () => {
  /**
   * ⛔ Asking whether the ultra-light node can pay would refuse the sitting on the strength of its own
   * treatment. `phase06-light-vs-ultralight.sh` learned this as a special case; here the node is
   * simply not on the list.
   */
  it('never reports the unfunded node as short of funds', async () => {
    const result = await runSitting(setup());

    assert.doesNotMatch(result.log, /10087.*SHORT/);
    assert.doesNotMatch(result.log, /10087 did not answer/);
  });

  it('refuses the whole sitting when the uploader cannot pay for it', async () => {
    const result = await runSitting(setup({ fundedBzz: 0.001 }));

    assert.equal(result.code, 1);
    assert.equal(result.publishes.length, 0);
    assert.match(result.log, /cannot pay for itself/);
  });
});

describe('every arm is filed with the condition it ran under', () => {
  it('records the arm, its round and whether it counts', async () => {
    const result = await runSitting(setup());

    const rows = result.state
      .trim()
      .split('\n')
      .map((row) => row.split('\t'));
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((row) => [row[1], row[2], row[3], row[4]]),
      [
        ['1', '1', 'unfunded', 'warm-up'],
        ['2', '1', 'funded', 'warm-up'],
        ['3', '2', 'funded', 'counted'],
        ['4', '2', 'unfunded', 'counted'],
      ],
    );
  });

  it('writes the readings where the arm that produced them can be found', async () => {
    const stubs = setup();
    await runSitting(stubs);

    const written = readdirSync(join(stubs.out, 'node-metrics'));
    assert.ok(written.some((name) => name === 'arm01-round1-unfunded-on-unfunded-before.json'));
    assert.ok(written.some((name) => name === 'arm03-round2-funded-on-funded-after.json'));
  });
});
