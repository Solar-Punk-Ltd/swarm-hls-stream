import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy/scripts/byte-source-arms.sh');
const BATCH = '7849851f404265dd2bea17e4229b45be23e245210ea17ac0af3a2a2b13faa2fd';

/**
 * That a gateway-versus-in-tab-node sitting measures two byte sources rather than one path twice.
 *
 * ⛔⛔⛔ THE FAILURE THIS FILE EXISTS FOR PRODUCES A COMPLETE, PLAUSIBLE, WRONG RESULT, and a more
 * attractive one than the funding sitting's. If the switch is dead, every arm reads segments through
 * the gateway, both columns agree, the tables fill, nothing errors, and the report concludes that **an
 * in-tab Swarm node holds a live edge exactly as well as a gateway does**. That is the headline this
 * whole line of work would most like to be true, so nothing about it invites a second look.
 *
 * ⛔⛔ AND A STUB PROVES THE GATES, NEVER THE DRIVER. On 2026-08-13 `unfunded-gateway.sh` passed nine
 * stubbed tests while being completely broken, and one real start found five defects in a row. On the
 * same day twelve stubbed tests passed over a fetch backend that was handing hls.js a corrupt
 * transport stream, and one free run in a real browser caught it. Nothing below shows that this script
 * can run. ⭐ Run one short real arm before trusting it with a paid sitting.
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
 * ⭐ Deliberately not `gateway weeb3 gateway weeb3`. The driver must run what the harness printed; a
 * driver that derived the order itself would produce the natural one and pass regardless, which is the
 * whole reason `browser:byte-source-order` exists as a separate command.
 */
const STUB_ARM_ORDER = 'weeb3 gateway gateway weeb3';

function setup({
  backendCheckFails = false,
  selfcheckFails = false,
  missingImage = false,
  armOrder = STUB_ARM_ORDER,
  /**
   * 100 BZZ, which no stubbed sitting here comes near, so the ceiling never decides by accident.
   *
   * ⚠️ Kept well inside 2^63: the gate does its arithmetic in bash, where a wrapped negative would
   * make every comparison pass.
   */
  ceilingPlur = String(100n * 10n ** 16n),
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'byte-source-arms-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const out = join(dir, 'out');
  mkdirSync(out, { recursive: true });

  const dockerLog = join(dir, 'docker.jsonl');
  const metricsLog = join(dir, 'node-metrics.jsonl');
  const publishLog = join(dir, 'publish.jsonl');
  // Its presence is "a broadcast is running", which makes the health endpoint and the publisher
  // listing stateful. A stub that always reported a live stream would send the teardown through the
  // whole wait_for_quiet budget, which is the very state the script exists to notice.
  const liveFlag = join(dir, 'BROADCAST-LIVE');

  for (const path of [dockerLog, metricsLog, publishLog]) {
    writeFileSync(path, '');
  }

  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(dockerLog)}, JSON.stringify(argv) + '\\n');

if (argv[0] === 'image' && argv[1] === 'inspect') process.exit(${missingImage ? 1 : 0});

if (argv[0] === 'ps') {
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

// The SRS stage, as \`stage-fingerprint.sh\` reads it: the config for hls_fragment and hls_aof_ratio,
// then a playlist per rung for its raw #EXTINF. Driven by env so a case can hand the sitting a stage
// that disagrees with the GOP it asked for, which is the whole point of the gate.
//
// ⛔ A listing and a read are answered differently, because real \`docker exec\` does. The gate now
// discovers paths with \`find ... | head -n\` and then reads each one, so a stub that emitted playlist
// text for any command mentioning m3u8 would answer the listing with content and the gate would go
// looking for a file called '#EXTM3U'. That is how this stub silently starved the gate of every
// playlist and the sitting refused with nothing wrong.
if (argv[0] === 'exec') {
  const asked = argv[argv.length - 1] || '';
  const fragment = process.env.STUB_HLS_FRAGMENT || '0.25';
  const aof = process.env.STUB_HLS_AOF || '10';
  const segment = process.env.STUB_SEGMENT_SECONDS || '0.501';
  const segments = Number(process.env.STUB_SEGMENT_COUNT || '12');
  const rungs = (process.env.STUB_RUNG_NAMES || 'live').split(',');
  const playlist = () => {
    let out = '#EXTM3U\\n#EXT-X-TARGETDURATION:1\\n';
    for (let i = 0; i < segments; i += 1) out += '#EXTINF:' + segment + ',\\nseg' + i + '.ts\\n';
    return out;
  };

  if (asked.includes('srs.conf')) {
    process.stdout.write('vhost __defaultVhost__ {\\n  hls {\\n    hls_fragment    ' + fragment +
      ';\\n    hls_aof_ratio   ' + aof + ';\\n    hls_window      30;\\n  }\\n}\\n');
  } else if (asked.includes('-name') && asked.includes('m3u8')) {
    // Newest first, bounded by whatever \`head -n\` the gate asked for, which is its --rungs.
    const limit = Number((asked.match(/head -(\\d+)/) || [])[1] || '1');
    process.stdout.write(rungs.slice(0, limit).map((r) => '/hls/live/' + r + '/index.m3u8').join('\\n') + '\\n');
  } else if (asked.includes('m3u8')) {
    process.stdout.write(playlist());
  }
  process.exit(0);
}

if (argv[0] === 'run') {
  // By presence, not by position: the order command carries a rounds argument after it.
  const ran = (script) => argv.includes(script);
  const envOf = (name) => {
    const hit = argv.find((a, i) => argv[i - 1] === '-e' && a.startsWith(name + '='));
    return hit ? hit.slice(name.length + 1) : '';
  };
  if (ran('browser:byte-source-order')) process.stdout.write(${JSON.stringify(armOrder)} + '\\n');
  if (ran('browser:selfcheck')) process.exit(${selfcheckFails ? 1 : 0});
  if (ran('browser:fetch-backend-check')) process.exit(${backendCheckFails ? 1 : 0});
  if (ran('browser:watch')) {
    fs.appendFileSync(${JSON.stringify(dockerLog)},
      JSON.stringify(['WATCH', envOf('BROWSER_FETCH_BACKEND'), envOf('BROWSER_GATEWAY_URL'),
        envOf('BROWSER_SETTLE_SECONDS'), envOf('BROWSER_WATCH_SECONDS'),
        envOf('BROWSER_TARGET_LATENCY_S'), 'VIEWER_CDP_PORT=' + envOf('VIEWER_CDP_PORT')]) + '\\n');
  }
}
process.exit(0);
`,
  );

  const plur = String(5000n * 10n ** 13n);
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
  process.stdout.write(JSON.stringify({ availableBalance: '${plur}' }));
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

  for (const path of [join(bin, 'docker'), join(bin, 'curl'), join(bin, 'getent'), nodeMetrics, stampGuard]) {
    chmodSync(path, 0o755);
  }

  // The night's authorisation. Both nodes start where the stub chequebook answers, so a default
  // sitting has spent nothing yet and the ceiling is what decides.
  const ledger = join(dir, 'spend-ledger.env');
  writeFileSync(
    ledger,
    [
      'authorised_at=2026-08-14T00:00:00Z',
      `ceiling_plur=${ceilingPlur}`,
      `uploader_start_plur=${plur}`,
      `gateway_start_plur=${plur}`,
      '',
    ].join('\n'),
  );

  return { dir, bin, out, dockerLog, metricsLog, publishLog, benchRepo, nodeMetrics, stampGuard, ledger };
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
        NODE_METRICS: stubs.nodeMetrics,
        STAMP_GUARD: stubs.stampGuard,
        STAMP: BATCH,
        SPEND_LEDGER: stubs.ledger,
        ROUNDS: '2',
        ARM_MINUTES: '2',
        ARM_GAP_S: '0',
        PUBLISHER_LEAD_S: '0',
        STOP_POLL_S: '0.05',
        // ⚠️ The default here, not in the driver. Most cases below are about gates and ordering and
        // have no opinion about the thread column, and a real sitting must state one either way.
        ALLOW_NO_THREAD_READING: '1',
        ...env,
      },
      encoding: 'utf8',
    });
  } catch (failure) {
    code = failure.code;
  }

  const read = (name) => (existsSync(join(stubs.out, name)) ? readFileSync(join(stubs.out, name), 'utf8') : '');
  const jsonl = (path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  return {
    code,
    log: read('byte-source-arms.log'),
    state: read('byte-source-arms-state.tsv'),
    docker: jsonl(stubs.dockerLog),
    metrics: jsonl(stubs.metricsLog),
    publishes: readFileSync(stubs.publishLog, 'utf8').split('\n').filter(Boolean),
  };
}

const watches = (result) => result.docker.filter((call) => call[0] === 'WATCH');

describe('the sitting reads one live broadcast through two byte sources', () => {
  it('starts exactly one publisher for every arm', async () => {
    const stubs = setup();

    const result = await runSitting(stubs);

    assert.equal(result.publishes.length, 1, 'a sitting that publishes twice measures two corpora');
    assert.equal(watches(result).length, 4);
  });

  /**
   * ⛔⛔⛔ The treatment reaching the arm. Without this the driver could pass every other case here
   * while running four identical gateway arms.
   */
  it('sends each arm its own byte source', async () => {
    const stubs = setup();

    const result = await runSitting(stubs);
    const sources = watches(result).map((call) => call[1]);

    assert.deepEqual(sources, ['weeb3', 'gateway', 'gateway', 'weeb3']);
  });

  /**
   * ⭐ The gateway is the variable held FIXED. A sitting that moved it as well would be varying two
   * things, and this project has already withdrawn one finding for exactly that.
   */
  it('holds every arm on one gateway, so the byte source is the only thing that moves', async () => {
    const stubs = setup();

    const result = await runSitting(stubs);
    const gateways = new Set(watches(result).map((call) => call[2]));

    assert.equal(gateways.size, 1, `arms read ${[...gateways].join(' and ')}, so the gateway moved too`);
    assert.match([...gateways][0], /10077$/);
  });

  it('passes the settle each arm has to wait before its window opens', async () => {
    const stubs = setup();

    const result = await runSitting(stubs, { SETTLE_SECONDS: '45' });

    assert.deepEqual(new Set(watches(result).map((call) => call[3])), new Set(['45']));
  });

  it('runs the order the harness printed rather than one of its own', async () => {
    const stubs = setup({ armOrder: 'gateway gateway weeb3 weeb3' });

    const result = await runSitting(stubs);

    assert.deepEqual(
      watches(result).map((call) => call[1]),
      ['gateway', 'gateway', 'weeb3', 'weeb3'],
    );
  });

  it('refuses when the printed order is not the number of arms it asked for', async () => {
    const stubs = setup({ armOrder: 'weeb3 gateway' });

    const result = await runSitting(stubs);

    assert.notEqual(result.code, 0);
    assert.match(result.log, /gave 2 arms for 2 rounds/);
    assert.equal(result.publishes.length, 0);
  });
});

describe('the two arms are two conditions, or nothing is published', () => {
  /**
   * ⛔⛔⛔ The free check that stands between this sitting and its most attractive wrong answer. It
   * proves the deployed client publishes a switch, that the switch moves both ways, that it refuses a
   * value it does not know, and that an in-tab node can actually reach a peer from this host.
   */
  it('refuses when the deployed client cannot be moved between byte sources', async () => {
    const stubs = setup({ backendCheckFails: true });

    const result = await runSitting(stubs);

    assert.notEqual(result.code, 0);
    assert.match(result.log, /cannot be moved between byte sources/);
    assert.equal(result.publishes.length, 0, 'a broadcast was paid for with no contrast to spend it on');
  });

  it('publishes nothing when the free selfcheck fails', async () => {
    const stubs = setup({ selfcheckFails: true });

    const result = await runSitting(stubs);

    assert.notEqual(result.code, 0);
    assert.equal(result.publishes.length, 0);
  });

  it('publishes nothing when the browser image is not on the host', async () => {
    const stubs = setup({ missingImage: true });

    const result = await runSitting(stubs);

    assert.notEqual(result.code, 0);
    assert.equal(result.publishes.length, 0);
  });
});

describe('the arm budget covers what an arm actually does', () => {
  /**
   * ⛔⛔ The gate this driver needed and the gateway one did not.
   *
   * Every arm here waits out the settle before its window opens, and a weeb-3 arm spends part of it
   * booting a node. An overhead budgeted for the gateway sitting's 90s would leave the broadcast
   * running out under the last arms: the sitting is paid for in full and comes back with fewer
   * replicates than it was booked for, which is the expensive way to learn an arithmetic error.
   */
  it('refuses an overhead that does not cover the settle, before publishing anything', async () => {
    const stubs = setup();

    const result = await runSitting(stubs, { SETTLE_SECONDS: '60', ARM_OVERHEAD_S: '60' });

    assert.notEqual(result.code, 0);
    assert.match(result.log, /does not cover the 60s settle/);
    assert.equal(result.publishes.length, 0);
  });

  it('accepts an overhead with room above the settle', async () => {
    const stubs = setup();

    const result = await runSitting(stubs, { SETTLE_SECONDS: '60', ARM_OVERHEAD_S: '170' });

    assert.equal(result.code, 0);
    assert.equal(result.publishes.length, 1);
  });
});

describe('a sitting that refuses leaves the box as it found it', () => {
  it('takes a preflight reading and stops without publishing anything', async () => {
    const stubs = setup();

    const result = await runSitting(stubs, { PREFLIGHT_ONLY: '1' });

    assert.equal(result.code, 0);
    assert.match(result.log, /every gate passed and nothing was published/);
    assert.equal(result.publishes.length, 0);
    assert.equal(watches(result).length, 0);
  });

  /**
   * ⛔⛔ A teardown keyed on a name pattern killed a live paid broadcast on this box on 2026-08-12.
   * The names present before the run are recorded once and excluded from every teardown.
   */
  it('never removes a publisher it did not start', async () => {
    const stubs = setup();

    const result = await runSitting(stubs);
    const removed = result.docker.filter((call) => call[0] === 'rm').flat();

    assert.ok(!removed.includes('someone-elses-publisher'), 'this sitting tore down a stranger’s broadcast');
  });
});

describe('the spend ceiling stands between the operator and the broadcast', () => {
  it('refuses a sitting with no authorisation at all, and publishes nothing', async () => {
    const stubs = setup();
    // The owner authorises a night by writing the ledger. Without one there is no authorisation, and
    // the safe reading of a missing file is zero rather than unlimited.
    rmSync(stubs.ledger);

    const result = await runSitting(stubs);

    assert.notEqual(result.code, 0);
    assert.match(result.log, /no spend ledger/);
    assert.equal(result.publishes.length, 0, 'a sitting refused on budget must not have published');
  });

  it('refuses once earlier sittings have spent the authorisation, which can_afford cannot see', async () => {
    // 0.1 BZZ authorised. Both nodes still answer with 5 BZZ, so `can_afford` is happy and only the
    // ceiling knows this night is over.
    const stubs = setup({ ceilingPlur: String(1n * 10n ** 15n) });

    const result = await runSitting(stubs);

    assert.notEqual(result.code, 0);
    assert.match(result.log, /REFUSING/);
    assert.match(result.log, /authorisation/);
    assert.equal(result.publishes.length, 0);
  });

  it('lets a sitting that fits run, so the gate is not simply stuck closed', async () => {
    const stubs = setup();

    const result = await runSitting(stubs);

    assert.equal(result.code, 0);
    assert.equal(result.publishes.length, 1);
    assert.match(result.log, /BZZ authorised/);
  });
});

describe('every arm is held at one latency target', () => {
  it('passes the same target to both conditions, so it stays a constant and not a second treatment', async () => {
    const stubs = setup();

    const result = await runSitting(stubs, { TARGET_LATENCY_S: '2' });

    const targets = watches(result).map((call) => call[5]);
    assert.equal(targets.length, 4);
    assert.deepEqual([...new Set(targets)], ['2'], 'a target that differs between arms is a second variable');
  });

  it('carries a changed target through to the browser rather than hard-coding one', async () => {
    const stubs = setup();

    const result = await runSitting(stubs, { TARGET_LATENCY_S: '4' });

    assert.deepEqual([...new Set(watches(result).map((call) => call[5]))], ['4']);
  });
});

/**
 * ⛔⛔⛔ `run_arm` polls STOP_FILE for the whole length of the watch and stops the BROADCAST when it
 * appears. `node-metrics.sh watch` is the only writer of that file in this repo and `start_sampler`
 * is its only caller, so a driver that never starts the sampler is polling a path no process in the
 * run will ever create. The two paid sittings of 2026-08-13 ran exactly that way.
 *
 * ⭐ Both assertions below count first and inspect second, deliberately. The defect this covers was
 * concealed for a week by a sibling test that looped over the `watch` calls and checked a property
 * of each: with no sampler the list was empty, the body never ran, and it passed.
 */
const sampling = (result) => result.metrics.filter((entry) => entry.cmd === 'watch');

describe('the mid-arm floor check has something that writes its file', () => {
  it('runs a sampler for every arm, so a crossed floor can actually stop the broadcast', async () => {
    const stubs = setup();

    const result = await runSitting(stubs);

    assert.ok(sampling(result).length > 0, 'no sampler ran at all, so STOP_FILE has no writer');
    assert.equal(sampling(result).length, watches(result).length, 'an arm ran with no sampler beside it');
  });

  it('reads the series off the gateway the arms actually used', async () => {
    const stubs = setup();

    const result = await runSitting(stubs);

    assert.ok(sampling(result).length > 0, 'no sampler ran, so nothing here checked which node it read');
    for (const call of sampling(result)) {
      assert.match(call.gateway, /10077$/, 'the series is off a node no arm read');
    }
  });
});

/**
 * ⭐ The CPU gap this sitting has carried since #92: both arms decode the same picture, so whatever
 * separates them is the cost of the byte source, and a weeb-3 arm runs a Swarm node in the tab.
 *
 * ⛔⛔ A reading nobody took is not a cheap viewer. The assertions below decide the COUNT before any
 * property of the samples, which is gate lesson AHU and the reason the trap line in this driver read
 * as evidence of wiring that was not there.
 */
describe('what the browser cost, per arm', () => {
  const cpuCalls = (result) => result.docker.filter((argv) => Array.isArray(argv) && argv[0] === 'stats');

  it('samples the browser container for every arm, so neither arm is priced from an empty series', async () => {
    const result = await runSitting(setup());

    assert.ok(cpuCalls(result).length > 0, 'nothing ever asked docker for CPU, so both arms are unpriced');
    assert.equal(
      (result.log.match(/sampling byte-source-browser CPU/g) ?? []).length,
      watches(result).length,
      'an arm ran with no CPU sampler beside it',
    );
  });

  it('says a reading was missed rather than printing zero cores for it', async () => {
    const result = await runSitting(setup(), { BROWSER_CPU_INTERVAL_S: '0' });

    assert.match(result.log, /NO CPU READING/);
    assert.doesNotMatch(result.log, /mean 0\.00 cores/, 'an unsampled arm was reported as a free one');
  });
});

/**
 * ⛔⛔ The container total and the thread reading are two instruments, and the danger is that a run
 * takes one and gets quoted for the other. A sitting with no `VIEWER_CDP_PORT` still produces a
 * complete-looking cost table, so the absence has to be as loud as a failure.
 */
describe('whether the viewer had any thread left, per arm', () => {
  // ⚠️ Counts the refusal the SAMPLER prints when it declines, not every line carrying that phrase.
  // The summary refuses again at the end of the arm for the same cause, which is deliberate (a run
  // must not have to remember a line printed forty minutes earlier) and would double the count.
  it('says plainly at the start of the arm that nothing will measure the thread', async () => {
    const result = await runSitting(setup(), { ALLOW_NO_THREAD_READING: '1' });

    assert.ok(watches(result).length > 0, 'no arm ran, so nothing could have been sampled or skipped');
    assert.equal(
      (result.log.match(/NO SATURATION READING for [^:]+: VIEWER_CDP_PORT is unset/g) ?? []).length,
      watches(result).length,
      'an arm ran with neither a thread reading nor a line saying it was missing',
    );
  });

  // ⭐ The control. Without it, a driver that printed the refusal unconditionally would pass the case
  // above and never sample anything, which is precisely the defect the refusal exists to expose.
  it('starts the sampler instead of refusing once the port is set', async () => {
    const result = await runSitting(setup(), { VIEWER_CDP_PORT: '9333' });

    assert.ok(watches(result).length > 0, 'no arm ran');
    assert.match(result.log, /sampling the page main thread/);
    assert.doesNotMatch(
      result.log,
      /NO SATURATION READING: VIEWER_CDP_PORT is unset/,
      'the port was set and the driver still said it was not',
    );
  });

  // ⚠️ The WATCH containers only, and that is the behaviour rather than a convenience for the test.
  // The driver also starts short-lived helpers in the same image (selfcheck, arm order, the gateway
  // and byte-source checks). Handing them the same port would have two Chromes bind it and the second
  // would lose, so the page under measurement is the only one that gets it.
  it('passes the port into the watch container, since Chrome opens it and Chrome is in there', async () => {
    const result = await runSitting(setup(), { VIEWER_CDP_PORT: '9333' });
    const watched = watches(result);

    assert.ok(watched.length > 0, 'no arm ran, so nothing could carry the port');
    assert.ok(
      watched.every((call) => call.join(' ').includes('VIEWER_CDP_PORT=9333')),
      'an arm was watched without the port, so its Chrome opens no debugging endpoint',
    );
  });
});

/**
 * That a sitting can be ONE condition, for the questions where the second one answers nothing.
 *
 * ⭐ A drift slope is read WITHIN an arm, so #106 wants one three-hour in-tab arm behind a short
 * warm-up. Run as a counterbalanced pair that is six hours of broadcast to answer a three-hour
 * question, and the half that pays for itself is the half nobody asked about.
 *
 * ⛔⛔ THE EXPENSIVE FAILURE HERE IS SILENT AND ARITHMETIC. A plan whose arms are longer than
 * `ARM_MINUTES` while the broadcast is still sized from `ARM_MINUTES` starts a stream that ends
 * before its own last arm does, and the arm comes back NO-STREAM after the money is spent. Which is
 * why the length of the broadcast is asserted here rather than the number of arms.
 */
describe('a sitting whose arms are a plan rather than a counterbalanced pair', () => {
  const plan = (entries, env = {}) => runSitting(setup(), { ARM_PLAN: entries, ...env });
  const secondsPublished = (result) => Number((result.publishes[0]?.match(/--seconds=(\d+)/) ?? [])[1] ?? Number.NaN);

  it('runs each arm for its own length rather than one length for all of them', async () => {
    const result = await plan('weeb3:2:warm-up weeb3:3:counted');
    const watched = watches(result);

    assert.equal(result.code, 0, result.log);
    assert.equal(watched.length, 2);
    assert.deepEqual(
      watched.map((call) => call[4]),
      ['120', '180'],
      'the arms did not get their own watch windows',
    );
  });

  it('sizes the broadcast from the sum of the plan, so the last arm is not cut off', async () => {
    // 0s lead, 170s overhead each, 0s gap: (120 + 170) + (180 + 170).
    const result = await plan('weeb3:2:warm-up weeb3:3:counted');

    assert.equal(secondsPublished(result), 640, result.log);
  });

  it('never numbers a counted arm into round 1, which the reader drops as warm-up', async () => {
    const result = await plan('weeb3:2:warm-up weeb3:3:counted');
    const rows = result.state
      .trim()
      .split('\n')
      .map((line) => line.split('\t'));

    assert.deepEqual(
      rows.map((row) => [row[2], row[4]]),
      [
        ['1', 'warm-up'],
        ['2', 'counted'],
      ],
      'a counted arm landed in round 1, so read-sitting.py would discard it',
    );
  });

  it('refuses a byte source the harness does not know, and publishes nothing', async () => {
    const result = await plan('weeb-3:3:counted');

    assert.notEqual(result.code, 0);
    assert.equal(result.publishes.length, 0, 'a typo in the plan reached a paid broadcast');
    assert.match(result.log, /does not know/);
  });

  it('refuses an entry that is not source:minutes:role, and publishes nothing', async () => {
    const result = await plan('weeb3:3');

    assert.notEqual(result.code, 0);
    assert.equal(result.publishes.length, 0);
    assert.match(result.log, /is not source:minutes:role/);
  });

  it('refuses a role that is neither warm-up nor counted, and publishes nothing', async () => {
    const result = await plan('weeb3:3:control');

    assert.notEqual(result.code, 0);
    assert.equal(result.publishes.length, 0);
    assert.match(result.log, /wanted warm-up or counted/);
  });

  it('applies the steady-state floor to every entry, not just to ARM_MINUTES', async () => {
    const result = await plan('weeb3:1:counted');

    assert.notEqual(result.code, 0);
    assert.equal(result.publishes.length, 0);
    assert.match(result.log, /too short for a player to reach steady state/);
  });

  it('leaves the counterbalanced default alone when no plan is given', async () => {
    const result = await runSitting(setup(), { ROUNDS: '2', ARM_MINUTES: '2' });
    const watched = watches(result);

    assert.equal(result.code, 0, result.log);
    assert.equal(watched.length, 4);
    assert.ok(
      watched.every((call) => call[4] === '120'),
      'the default path stopped honouring ARM_MINUTES',
    );
  });
});

/**
 * That a sitting cannot quietly produce no saturation reading at all.
 *
 * ⛔⛔⛔ THE WARNING WAS ALREADY THERE AND IT DID NOT WORK. `browser-cpu.sh` prints "NO SATURATION
 * READING ... VIEWER_CDP_PORT is unset" once per arm, and on 2026-08-15 a proof sitting was launched
 * straight past two of them, in a run whose entire output is the thread column. It surfaced because a
 * file was missing from a directory listing, not because anything refused.
 *
 * ⭐ A warning inside a detached run nobody is watching is not a control. The gate is the refusal.
 */
describe('a sitting that would measure no thread at all', () => {
  it('refuses before publishing anything when nothing would sample the thread', async () => {
    const stubs = setup();
    const result = await runSitting(stubs, { ALLOW_NO_THREAD_READING: '0', VIEWER_CDP_PORT: '' });

    assert.notEqual(result.code, 0);
    assert.equal(result.publishes.length, 0, 'a sitting with no thread column reached a paid broadcast');
    assert.match(result.log, /VIEWER_CDP_PORT is unset, so no arm would measure the page main thread/);
  });

  it('runs once the port is set, so the gate is not simply stuck closed', async () => {
    const result = await runSitting(setup(), { ALLOW_NO_THREAD_READING: '0', VIEWER_CDP_PORT: '9333' });

    assert.equal(result.code, 0, result.log);
    assert.ok(watches(result).length > 0, 'no arm ran');
  });

  it('lets a sitting that genuinely does not need the column say so', async () => {
    const result = await runSitting(setup(), { ALLOW_NO_THREAD_READING: '1', VIEWER_CDP_PORT: '' });

    assert.equal(result.code, 0, result.log);
    assert.ok(watches(result).length > 0, 'no arm ran');
  });
});

/**
 * The stage fingerprint, in its real position inside the driver.
 *
 * ⛔⛔ `--gop` is a request. Until 2026-08-17 nothing checked the answer, so a sitting could run for
 * hours against a stage configured differently and label every artefact with the GOP it wanted. A
 * co-tenant session changed `hls_fragment` on a neighbouring SRS stack on this host that day, which is
 * one wrong compose file away from being ours.
 *
 * ⭐ These assert on `publishes` and `watches` rather than on the log, because the thing that matters
 * is that no arm and no broadcast is paid for once the stage disagrees.
 */
describe('the stage has to be publishing the GOP the sitting asked for', () => {
  it('runs when the stage matches, so the refusals below are the gate and not the harness', async () => {
    const result = await runSitting(setup());

    assert.equal(result.code, 0, result.log);
    assert.ok(watches(result).length > 0, 'no arm ran');
    assert.match(result.log, /matches what the driver asked for/);
  });

  /**
   * ⛔⛔⛔ THE CASE THE GATE EXISTS FOR. `hls_fragment 2.0` makes SRS publish 2.0s segments whatever
   * GOP is asked for, so a sitting believing it ran at 0.5s would write that into every artefact.
   */
  it('refuses when hls_fragment forces a segment longer than the GOP, before any arm runs', async () => {
    const result = await runSitting(setup(), {
      STUB_HLS_FRAGMENT: '2.0',
      STUB_HLS_AOF: '2.1',
      STUB_SEGMENT_SECONDS: '2.002',
    });

    assert.notEqual(result.code, 0);
    assert.equal(watches(result).length, 0, 'an arm ran against a stage that was not what it asked for');
    assert.match(result.log, /the stage is not publishing the 0\.5s GOP this sitting asked for/);
  });

  it('refuses when the stage publishes something other than its own config predicts', async () => {
    const result = await runSitting(setup(), { STUB_SEGMENT_SECONDS: '1.001' });

    assert.notEqual(result.code, 0);
    assert.equal(watches(result).length, 0);
    assert.match(result.log, /not delivering the keyframe cadence/);
  });

  /**
   * ⛔ A stage that never publishes enough to have a median is not a stage to spend a broadcast
   * against. The driver retries this case and refuses at its deadline, rather than treating an empty
   * reading as agreement.
   */
  it('refuses rather than passing when the stage publishes nothing to measure', async () => {
    const result = await runSitting(setup(), {
      STUB_SEGMENT_COUNT: '0',
      STAGE_FINGERPRINT_TIMEOUT_S: '0',
    });

    assert.notEqual(result.code, 0);
    assert.equal(watches(result).length, 0);
  });

  it('accepts a deliberate 2.0s sitting on a stage that can serve it', async () => {
    const result = await runSitting(setup(), {
      GOP_SECONDS: '2.0',
      STUB_SEGMENT_SECONDS: '2.002',
    });

    assert.equal(result.code, 0, result.log);
    assert.ok(watches(result).length > 0, 'no arm ran');
  });
});
