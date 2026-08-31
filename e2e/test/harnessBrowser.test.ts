import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GATEWAY_BYTES, WEEB3_BYTES } from '../src/browser/fetchBackendSweep.js';
import { loadConfig } from '../src/config.js';
import {
  artifactJsonFromArmLog,
  artifactReadPath,
  BROWSER_ARM_OVERHEAD_MS,
  browserArmCommand,
  browserArmEnv,
  browserArmHostSetup,
  browserArmScript,
  DEFAULT_BROWSER_CONTAINER,
  DEFAULT_BROWSER_IMAGE,
  parseBrowserArmState,
  reportArmNarration,
  runBrowserArm,
} from '../src/harness/browser.js';
import { type Host } from '../src/harness/host.js';
import { shellQuoted } from '../src/harness/shellQuote.js';

import { armState, crashArmState, GATEWAY_OUTAGE_RECOVERY } from './helpers/browserArmFixtures.js';

/**
 * That the suite can launch a real viewer the way the bench scripts do, and read back a verdict it
 * is allowed to assert on.
 *
 * ⛔ Nothing here talks to a host. Every piece the launch is made of is a pure function precisely so
 * the parts that can be wrong for free are wrong here rather than three minutes into a paid
 * broadcast: a command line missing the shared-memory size, an artifact path that names the
 * container's filesystem rather than the host's, a state file from a driver older than the reader.
 */

const LAUNCH = {
  image: 'swarm-hls-browser:latest',
  containerName: 'e2e-viewer-browser',
  repoDir: '/home/solarpunk/swarm-hls-bench',
  script: 'browser:watch',
  env: { BROWSER_CLIENT_URL: 'http://127.0.0.1:10074', BROWSER_FETCH_BACKEND: WEEB3_BYTES },
} as const;

describe('the command that launches a viewer', () => {
  it('joins the host network, so the client and the gateway are both reached over loopback', () => {
    assert.match(browserArmCommand(LAUNCH), /docker run --rm --network host/);
  });

  /**
   * ⛔ The one difference between the two bench scripts, and it is not cosmetic. `bench-on-host.sh`
   * passes it and `byte-source-arms.sh` does not. Chrome puts its renderer's shared buffers in
   * /dev/shm, and docker's 64MB default makes it crash PARTWAY THROUGH a video session rather than at
   * startup, which reads as the stream failing. `browser-on-host.sh` routes through the script that
   * passes it, so this follows that one.
   */
  it('gives Chrome the shared memory it needs to survive a whole session', () => {
    assert.match(browserArmCommand(LAUNCH), /--shm-size=2g/);
  });

  it('mounts the docker socket and the bench checkout the driver writes its artifacts into', () => {
    const command = browserArmCommand(LAUNCH);

    assert.match(command, /-v \/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
    assert.match(command, /-v '\/home\/solarpunk\/swarm-hls-bench':\/repo/);
    assert.match(command, /-w \/repo/);
  });

  /**
   * Left unquoted deliberately, and the only thing here that is. They are command substitutions the
   * host's own shell must evaluate: quoting them would run the container as a user called
   * `$(id -u)`. Everything a caller supplies is quoted instead.
   */
  it('runs as the invoking user and carries the host docker group in', () => {
    const command = browserArmCommand(LAUNCH);

    assert.match(command, /-u \$\(id -u\):\$\(id -g\)/);
    assert.match(command, /--group-add \$\(stat -c %g \/var\/run\/docker\.sock\)/);
  });

  it('names the container, so a leftover can be reclaimed by name rather than by pattern', () => {
    assert.match(browserArmCommand(LAUNCH), /--name 'e2e-viewer-browser'/);
  });

  it('ends with the image and the pnpm script, which is what the bench scripts run', () => {
    assert.match(browserArmCommand(LAUNCH), /'swarm-hls-browser:latest' pnpm 'browser:watch'$/);
  });

  it('passes every environment pair the caller gave it', () => {
    const command = browserArmCommand(LAUNCH);

    assert.match(command, /-e BROWSER_CLIENT_URL='http:\/\/127\.0\.0\.1:10074'/);
    assert.match(command, new RegExp(`-e BROWSER_FETCH_BACKEND='${WEEB3_BYTES}'`));
  });

  it('always sets HOME, because the image runs as a user with no home directory of its own', () => {
    assert.match(browserArmCommand(LAUNCH), /-e HOME=\/tmp/);
  });

  /**
   * ⛔ This command line is interpolated into a string a shell parses, on the far side of ssh, on a
   * host this suite also injects faults on. A value that closed its own quoting could run anything.
   *
   * What this asserts is that every caller-supplied value goes through the shared quoter. That the
   * quoter is actually safe is `test/shellQuote.test.ts`'s job, and it proves it by round-tripping
   * through a real `bash` rather than against the escaping the code would have written.
   */
  it('puts a value carrying a quote through the shared quoter rather than inline', () => {
    const hostile = "http://x'; touch /tmp/e2e-should-never-exist; #";
    const command = browserArmCommand({ ...LAUNCH, env: { BROWSER_CLIENT_URL: hostile } });

    assert.ok(
      command.includes(`-e BROWSER_CLIENT_URL=${shellQuoted(hostile)}`),
      `the value reached the command line unquoted: ${command}`,
    );
    assert.ok(!command.includes(`=${hostile}`), 'the raw value is in the command line as well as the quoted one');
  });

  it('refuses an environment name that is not one', () => {
    assert.throws(() => browserArmCommand({ ...LAUNCH, env: { 'not a name': 'x' } }), /not a name/);
  });

  it('refuses a container name docker would not accept', () => {
    assert.throws(() => browserArmCommand({ ...LAUNCH, containerName: 'has spaces' }), /container name/);
  });

  /**
   * A relative or tilde path would be resolved against whatever directory the host command happens to
   * run in, or not expanded at all once quoted, and docker would then create an empty directory and
   * mount that. The run fails several minutes later looking like a broken image.
   */
  it('refuses a checkout path that is not absolute, which docker would silently create empty', () => {
    assert.throws(() => browserArmCommand({ ...LAUNCH, repoDir: '~/swarm-hls-bench' }), /absolute/);
  });
});

describe('finding the artifact a run wrote', () => {
  const log = [
    'browser: playback started',
    '  30 samples, 2.01s behind live, 0 rebuffers',
    '',
    'browser: wrote /repo/docs/bench/browser-watch-2026-08-28T10-00-00-000Z.md',
    'browser: instrument SOUND',
  ].join('\n');

  /**
   * Read out of the driver's own line rather than by looking for the newest file in the directory.
   * The run id is stamped inside the container from its own clock, so the caller cannot predict it,
   * and this host carries other people's sittings: picking the newest file is how a viewer verdict
   * ends up being read out of a co-tenant's run.
   */
  it('takes the path the driver printed, and reads the json beside the report', () => {
    assert.equal(artifactJsonFromArmLog(log), '/repo/docs/bench/browser-watch-2026-08-28T10-00-00-000Z.json');
  });

  it('takes the last one, so a log carrying more than one names the run that just finished', () => {
    const twice = `browser: wrote /repo/docs/bench/a.md\nbrowser: wrote /repo/docs/bench/b.md`;

    assert.equal(artifactJsonFromArmLog(twice), '/repo/docs/bench/b.json');
  });

  it('refuses a log with no artifact line rather than guessing at a filename', () => {
    assert.throws(() => artifactJsonFromArmLog('browser: playback started\n'), /wrote no artifact/);
  });

  /**
   * ⛔ The pattern is a module-level `/g` regex, which is stateful under `exec` and `test`: those
   * advance `lastIndex` and the SECOND call over the same text finds nothing. `matchAll` clones the
   * regex instead and leaves `lastIndex` at zero, which is why it is used. Two arms run per suite
   * file, so a refactor to either of the other two would leave the second arm reporting that it wrote
   * no artifact, on a paid broadcast, having written one.
   */
  it('finds the artifact every time it is asked, not only the first', () => {
    for (let call = 0; call < 3; call += 1) {
      assert.equal(
        artifactJsonFromArmLog(log),
        '/repo/docs/bench/browser-watch-2026-08-28T10-00-00-000Z.json',
        `call ${call}`,
      );
    }
  });

  /**
   * ⛔ The driver prints the path it saw, which is inside the container. Over ssh the reader is the
   * host's shell, where that path finds nothing, or worse finds the harness's own checkout at the
   * same relative place.
   */
  it('translates the container path onto the host checkout when the reader is the host', () => {
    assert.equal(
      artifactReadPath('/repo/docs/bench/browser-watch-1.json', '/home/solarpunk/swarm-hls-bench', false),
      '/home/solarpunk/swarm-hls-bench/docs/bench/browser-watch-1.json',
    );
  });

  /**
   * ⛔ In local mode the reader is the suite's own container, which mounts the same checkout at
   * /repo, and the host path does not exist there. Both viewer suites failed exactly this way on
   * their first real run.
   */
  it('keeps the container path when the reader shares the container namespace', () => {
    assert.equal(
      artifactReadPath('/repo/docs/bench/browser-watch-1.json', '/home/solarpunk/swarm-hls-bench', true),
      '/repo/docs/bench/browser-watch-1.json',
    );
  });

  it('refuses a path outside the mount in either mode, since no reader can reach it', () => {
    assert.throws(() => artifactReadPath('/tmp/elsewhere.json', '/home/solarpunk/swarm-hls-bench', false), /\/repo/);
    assert.throws(() => artifactReadPath('/tmp/elsewhere.json', '/home/solarpunk/swarm-hls-bench', true), /\/repo/);
  });
});

describe('reading what the viewer got out of a run', () => {
  it('reports the figures a viewer verdict is made of', () => {
    const result = parseBrowserArmState(armState());

    assert.equal(result.advanceRatio, 0.999);
    assert.equal(result.rebufferCount, 0);
    assert.equal(result.fatalErrors, 0);
    assert.equal(result.segmentRequests, 6);
    assert.equal(result.samples, 240);
    assert.equal(result.watchUrl, 'http://127.0.0.1:10074/watch/abc?qoe=1');
  });

  it('reports how far behind live the player was, and says nothing where nothing was read', () => {
    const result = parseBrowserArmState(armState());

    assert.deepEqual(result.behindLive, { joinS: 2.11, medianS: 2.03, minS: 1.88, maxS: 2.4 });
    assert.equal(parseBrowserArmState(armState({ latency: { medianLatencyS: null } })).behindLive.medianS, null);
  });

  /** Every distinct resolution the decoder produced, which is the rung a viewer actually rode. */
  it('collects the resolutions the player decoded, once each', () => {
    const result = parseBrowserArmState(
      armState({ resolutions: ['640x360', '1280x720', '1280x720', '1920x1080', null] }),
    );

    assert.deepEqual(result.resolutions, ['640x360', '1280x720', '1920x1080']);
  });

  it('reports the arm the client was asked for beside the one it landed on, never one standing for both', () => {
    const result = parseBrowserArmState(armState());

    assert.deepEqual(result.proof, { requested: WEEB3_BYTES, reported: WEEB3_BYTES, settledForMs: 60_000 });
  });

  it('reports no arm for a run that never named a byte source, rather than inventing one', () => {
    const result = parseBrowserArmState(armState({ byteSource: null }));

    assert.deepEqual(result.proof, { requested: null, reported: null, settledForMs: null });
  });

  it('carries the instrument verdict, since a figure from a degraded browser is not a reading', () => {
    const sound = parseBrowserArmState(armState());
    const degraded = parseBrowserArmState(armState({ instrument: { sound: false, failures: ['timer drift 61x'] } }));

    assert.equal(sound.instrumentSound, true);
    assert.equal(degraded.instrumentSound, false);
    assert.deepEqual(degraded.instrumentFailures, ['timer drift 61x']);
  });

  it('reports whether the viewer was ever told the broadcast had ended', () => {
    assert.equal(parseBrowserArmState(armState()).reachedEndedOverlay, false);
    assert.equal(parseBrowserArmState(armState({ feedStatesSeen: ['live', 'ended'] })).reachedEndedOverlay, true);
  });

  it('keeps the states the viewer passed through, so a scenario can assert on the route as well', () => {
    const result = parseBrowserArmState(armState({ feedStatesSeen: ['live', 'reconnecting', 'live'] }));

    assert.deepEqual(result.feedStatesSeen, ['live', 'reconnecting', 'live']);
  });
});

describe('refusing a state file rather than guessing at it', () => {
  it('refuses something that is not an object at all', () => {
    assert.throws(() => parseBrowserArmState('a report, not a run'), /run/);
  });

  it('refuses a run with no summary, naming the field that is missing', () => {
    assert.throws(() => parseBrowserArmState({ watchUrl: 'http://x', network: {} }), /summary/);
  });

  it('refuses a figure that arrived as text, rather than reading NaN as a viewer verdict', () => {
    assert.throws(() => parseBrowserArmState(armState({ overallAdvanceRatio: '0.999' })), /overallAdvanceRatio/);
  });

  /**
   * ⛔ The stale-driver case, and the reason this refuses instead of defaulting. The feed states are
   * newer than the rest of the artifact shape, so an image built before them writes a run with every
   * other field intact. Defaulting to no states would make the ended-broadcast scenario report that
   * the viewer was never told, which is a wrong answer rather than a missing one.
   */
  it('refuses a run written by a driver too old to record the feed states', () => {
    assert.throws(() => parseBrowserArmState(armState({ feedStatesSeen: undefined })), /feedStatesSeen/);
  });

  /**
   * ⛔ The array whose contents decide a pass/fail. Validating it only as "strings" and casting to
   * the state type would let an unknown state through as a state, and `reachedEndedOverlay` is what
   * `broadcast-ended` asserts on. A newer client that gained a sixth state would reach a viewer, be
   * accepted here, and report as a broadcast that never ended.
   */
  it('refuses a feed state it does not know rather than casting it to one', () => {
    assert.throws(() => parseBrowserArmState(armState({ feedStatesSeen: ['live', 'buffering'] })), /buffering/);
  });

  it('refuses a feed state that is not even a string', () => {
    assert.throws(
      () => parseBrowserArmState(armState({ feedStatesSeen: [7] as unknown as readonly string[] })),
      /feedStatesSeen\[0\]/,
    );
  });

  it('refuses a byte source that named no condition, which is a half-written arm', () => {
    assert.throws(() => parseBrowserArmState(armState({ byteSource: { requested: WEEB3_BYTES } })), /reported/);
  });

  it('refuses a gateway arm whose network summary is missing, since the count is the whole proof', () => {
    assert.throws(
      () => parseBrowserArmState(armState({ backend: GATEWAY_BYTES, segmentRequests: undefined })),
      /segmentRequests/,
    );
  });

  /**
   * ⛔ Every sibling field throws on the wrong type, and this one used to filter silently, so a
   * corrupted samples array came back as a shorter resolution list rather than as an error. `null` is
   * the one value that is legitimately not a resolution: the player has not decoded a frame yet.
   */
  it('refuses a resolution that is neither a string nor the absence of one', () => {
    assert.throws(
      () => parseBrowserArmState(armState({ resolutions: [1080 as unknown as string] })),
      /samples\[0\]\.resolution/,
    );
  });

  it('accepts a sample that has not decoded a frame yet, which reports no resolution', () => {
    assert.deepEqual(parseBrowserArmState(armState({ resolutions: [null, '1280x720'] })).resolutions, ['1280x720']);
  });
});

/**
 * The sections only `browser:crash` writes, which are what a fault scenario is a reading of.
 *
 * A watch and a crash arm come back through one reader because they are one artifact shape with the
 * crash sections added. ⛔ Absent is therefore a legitimate answer here and NOT a refusal, unlike
 * every other field: a plain watch writes no `recovery` at all, and treating that as malformed would
 * make the two viewer suites that already pass start failing on a file that is exactly right.
 */
describe('what the fault did to the viewer, out of a crash arm', () => {
  it("reports the freeze, the resume and what the client said, off the driver's own verdict", () => {
    const recovery = parseBrowserArmState(crashArmState()).recovery;

    assert.equal(recovery?.scenario, 'viewer-gateway-outage');
    assert.equal(recovery?.longestFreezeMs, 28_600);
    assert.equal(recovery?.freezeStartedAfterFaultMs, 6_000);
    assert.equal(recovery?.recoveredAfterLiftMs, 10_700);
    assert.equal(recovery?.serviceStartupMs, 7_200);
    assert.equal(recovery?.recovered, true);
    assert.deepEqual(recovery?.saidWhileFrozen, ['Reconnecting to the stream']);
    assert.equal(recovery?.explainedTheFreeze, true);
  });

  it('reports no fault verdict for a plain watch, which drove none', () => {
    assert.equal(parseBrowserArmState(armState()).recovery, null);
  });

  /**
   * ⛔ The three figures a scenario turns into a pass or a fail are all legitimately absent-looking:
   * a viewer who never froze records a null freeze start, one who never came back records a null
   * resume, and `recovered: false` is the correct outcome of the engine-restart arm. A reader that
   * defaulted any of them would file the terminal scenario's own correct answer as a missing one.
   */
  it('keeps a fault nobody recovered from as exactly that, rather than as an absent reading', () => {
    const stranded = parseBrowserArmState(
      crashArmState({
        scenario: 'engine-restart',
        recovery: {
          longestFreezeMs: 83_200,
          freezeStartedAfterFaultMs: 7_000,
          recoveredAfterLiftMs: null,
          serviceStartupMs: null,
          recovered: false,
          saidWhileFrozen: ['Waiting for the broadcast to continue', 'This broadcast has ended'],
          explainedTheFreeze: true,
        },
      }),
    );

    assert.equal(stranded.recovery?.recovered, false);
    assert.equal(stranded.recovery?.recoveredAfterLiftMs, null);
    assert.equal(stranded.recovery?.serviceStartupMs, null);
  });

  it('refuses a fault verdict missing the freeze, which is the figure most scenarios are about', () => {
    assert.throws(() => parseBrowserArmState(crashArmState({ recovery: { recovered: true } })), /longestFreezeMs/);
  });

  it('refuses a message the client is said to have shown that is not even text', () => {
    const notText = { ...GATEWAY_OUTAGE_RECOVERY, saidWhileFrozen: [7] };

    assert.throws(() => parseBrowserArmState(crashArmState({ recovery: notText })), /saidWhileFrozen\[0\]/);
  });

  /**
   * ⛔ A verdict with no fault attached cannot be filed against one. The suites each drive a single
   * named scenario and assert the matrix's figures for it, so an artifact that does not say which
   * fault it is would let one scenario's thresholds be applied to another's run.
   */
  it('refuses a fault verdict that does not say which fault it is', () => {
    assert.throws(() => parseBrowserArmState(crashArmState({ scenario: null })), /scenario/);
  });
});

/** A deployment on the bench profile, resolved against a root that holds no env files of its own. */
const cfg = loadConfig({ env: { E2E_PROFILE: 'latbench', E2E_PORT_SLOT: '7' }, rootDir: '/no-such-e2e-root' });

describe('the environment an arm is run with', () => {
  const watch = browserArmEnv(cfg, { backend: WEEB3_BYTES, watchMinutes: 4 });

  /**
   * `local` is the sentinel that makes the driver's own harness shell out instead of trying to ssh
   * from the host to itself, which it has no key for. Both addresses are loopback because the
   * container joins the host network.
   */
  it('points the driver at this deployment over loopback', () => {
    assert.equal(watch.E2E_SSH_TARGET, 'local');
    assert.equal(watch.E2E_PUBLIC_HOST, '127.0.0.1');
    assert.equal(watch.E2E_PROFILE, 'latbench');
    assert.equal(watch.E2E_PORT_SLOT, '7');
    assert.equal(watch.BROWSER_CLIENT_URL, `http://127.0.0.1:${cfg.ports.client}`);
  });

  it('names the byte source, which is the one thing a viewer arm is a reading of', () => {
    assert.equal(watch.BROWSER_FETCH_BACKEND, WEEB3_BYTES);
    assert.equal(browserArmEnv(cfg, { backend: GATEWAY_BYTES, watchMinutes: 4 }).BROWSER_FETCH_BACKEND, GATEWAY_BYTES);
  });

  it('gives the watch driver its minutes as seconds', () => {
    assert.equal(watch.BROWSER_WATCH_SECONDS, '240');
  });

  it('adds nothing a suite did not ask for, so no treatment arrives by default', () => {
    assert.equal(watch.BROWSER_TARGET_LATENCY_S, undefined);
    assert.equal(watch.BROWSER_GATEWAY_URL, undefined);
    assert.equal(watch.VIEWER_CDP_PORT, undefined);
  });

  it('carries what the suite did ask for, and lets it win over a default', () => {
    const withTreatment = browserArmEnv(cfg, {
      backend: WEEB3_BYTES,
      watchMinutes: 4,
      env: { BROWSER_TARGET_LATENCY_S: '2', BROWSER_CLIENT_URL: 'http://127.0.0.1:9999' },
    });

    assert.equal(withTreatment.BROWSER_TARGET_LATENCY_S, '2');
    assert.equal(withTreatment.BROWSER_CLIENT_URL, 'http://127.0.0.1:9999');
  });
});

describe('an arm that drives a fault under the viewer', () => {
  const crash = { backend: WEEB3_BYTES, watchMinutes: 4, scenario: 'viewer-gateway-outage' } as const;

  it('runs the crash driver rather than the watch one', () => {
    assert.equal(browserArmScript(crash), 'browser:crash');
    assert.equal(browserArmScript({ backend: WEEB3_BYTES, watchMinutes: 4 }), 'browser:watch');
  });

  it('passes the scenario through, which is what names the fault', () => {
    assert.equal(browserArmEnv(cfg, crash).BROWSER_SCENARIO, 'viewer-gateway-outage');
  });

  /**
   * ⛔ `browser:crash` never reads BROWSER_WATCH_SECONDS: its windows are the pre-fault settle, the
   * scenario's own downtime and the recovery watch. Passing it anyway would put a number in the arm's
   * environment that nothing acts on, and an unread variable looks exactly like one set to its
   * default. That is how three drivers came to run on the gateway while claiming otherwise.
   */
  it('does not hand the crash driver a watch length it never reads', () => {
    assert.equal(browserArmEnv(cfg, crash).BROWSER_WATCH_SECONDS, undefined);
  });
});

describe('the other two treatments an arm can drive', () => {
  const fault = { backend: WEEB3_BYTES, watchMinutes: 4, scenario: 'viewer-gateway-outage' } as const;
  const squeeze = { backend: WEEB3_BYTES, watchMinutes: 4, squeeze: true } as const;
  const silence = { backend: WEEB3_BYTES, watchMinutes: 4, silenceSelectedRung: true } as const;

  const playback = { backend: WEEB3_BYTES, watchMinutes: 3, vod: { owner: '0xabc', topic: 'demo' } } as const;

  it('runs the driver each treatment belongs to', () => {
    assert.equal(browserArmScript(squeeze), 'browser:quality');
    assert.equal(browserArmScript(silence), 'browser:rung-outage');
    assert.equal(browserArmScript(playback), 'browser:vod');
  });

  /** The recording is addressed by owner and topic, and the driver reads both out of its environment. */
  it('names the recording a playback arm opens', () => {
    const env = browserArmEnv(cfg, playback);

    assert.equal(env.BROWSER_VOD_OWNER, '0xabc');
    assert.equal(env.BROWSER_VOD_TOPIC, 'demo');
    assert.equal(browserArmEnv(cfg, squeeze).BROWSER_VOD_OWNER, undefined);
  });

  /**
   * ⛔ Neither reads BROWSER_WATCH_SECONDS, and both own their own windows. The same trap as the crash
   * driver's: a passed-but-unread variable looks exactly like one set to its default.
   */
  it('hands neither of them a watch length it never reads', () => {
    assert.equal(browserArmEnv(cfg, squeeze).BROWSER_WATCH_SECONDS, undefined);
    assert.equal(browserArmEnv(cfg, silence).BROWSER_WATCH_SECONDS, undefined);
    assert.equal(browserArmEnv(cfg, playback).BROWSER_WATCH_SECONDS, undefined);
  });

  /**
   * ⛔ Refused together rather than one silently winning. With two treatments a rung that moved or a
   * picture that stopped could have done so because of either, and the arm would still produce a full
   * report that reads as an answer.
   */
  it('refuses an arm asking for more than one treatment', () => {
    assert.throws(() => browserArmScript({ ...fault, squeeze: true }), /One treatment per arm/);
    assert.throws(() => browserArmScript({ ...fault, silenceSelectedRung: true }), /One treatment per arm/);
    assert.throws(() => browserArmScript({ ...squeeze, silenceSelectedRung: true }), /One treatment per arm/);
    assert.throws(() => browserArmScript({ ...fault, vod: playback.vod }), /One treatment per arm/);
  });

  /** The message names what was asked for, so an operator can see which two collided. */
  it('names both treatments it was asked for', () => {
    assert.throws(() => browserArmScript({ ...squeeze, silenceSelectedRung: true }), /squeeze and a silenced rung/);
  });
});

describe('where the arm runs on the host', () => {
  /**
   * ⛔ No default is possible. The suite runs inside the bench image at /repo, which is a bind mount,
   * so nothing inside it can work out the host path it came from. A guessed default that happened not
   * to exist would have docker create an empty directory, mount that, and fail minutes later looking
   * like a broken image.
   */
  it('refuses to launch without the host path of the bench checkout', () => {
    assert.throws(() => browserArmHostSetup({}), /E2E_BROWSER_REPO_DIR/);
  });

  it('uses the image and container name the bench scripts use, unless told otherwise', () => {
    const setup = browserArmHostSetup({ E2E_BROWSER_REPO_DIR: '/srv/bench' });

    assert.equal(setup.repoDir, '/srv/bench');
    assert.equal(setup.image, DEFAULT_BROWSER_IMAGE);
    assert.equal(setup.containerName, DEFAULT_BROWSER_CONTAINER);
  });

  it('lets an operator name a different image and container', () => {
    const setup = browserArmHostSetup({
      E2E_BROWSER_REPO_DIR: '/srv/bench',
      E2E_BROWSER_IMAGE: 'swarm-hls-browser:pr-221',
      E2E_BROWSER_CONTAINER: 'viewer-v1',
    });

    assert.equal(setup.image, 'swarm-hls-browser:pr-221');
    assert.equal(setup.containerName, 'viewer-v1');
  });
});

interface HostRun {
  command: string;
  timeoutMs?: number;
}

/** A Host that answers a browser arm with a canned run, and records the command lines it was given. */
function stubHost(stdout: string, state: unknown = armState()): { host: Host; runs: HostRun[] } {
  const runs: HostRun[] = [];
  const host = {
    run: async (command: string, timeoutMs?: number) => {
      runs.push({ command, timeoutMs });
      return { stdout: command.startsWith('cat ') ? JSON.stringify(state) : stdout, stderr: '' };
    },
  } as unknown as Host;
  return { host, runs };
}

const AN_ARM_THAT_FINISHED = 'browser: wrote /repo/docs/bench/browser-watch-2026-08-28T10-00-00-000Z.md';

describe('running an arm end to end', () => {
  const previous = process.env.E2E_BROWSER_REPO_DIR;

  // Per test rather than once for the suite: `runBrowserArm` reads the live process environment, so
  // a single restore after the first case would leave every later one launching from nowhere.
  beforeEach(() => {
    process.env.E2E_BROWSER_REPO_DIR = '/srv/bench';
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.E2E_BROWSER_REPO_DIR;
      return;
    }
    process.env.E2E_BROWSER_REPO_DIR = previous;
  });

  const arm = { backend: WEEB3_BYTES, watchMinutes: 4 } as const;

  it('returns what the viewer got, read off the state file the run wrote', async () => {
    const { host } = stubHost(AN_ARM_THAT_FINISHED);

    const result = await runBrowserArm(host, cfg, arm);

    assert.equal(result.advanceRatio, 0.999);
    assert.equal(result.proof.reported, WEEB3_BYTES);
  });

  /**
   * ⛔ Before the arm and never after. A container left behind by a crashed arm holds the image's
   * single Xvfb display, and every later arm then fails at startup with `Cannot establish any
   * listening sockets`, which reads as a broken browser rather than a stale one. By exact name: a
   * pattern-matched teardown killed a live paid broadcast on this host on 2026-08-12.
   */
  it('reclaims a leftover container by name before it launches anything', async () => {
    const { host, runs } = stubHost(AN_ARM_THAT_FINISHED);

    await runBrowserArm(host, cfg, arm);

    assert.match(runs[0].command, new RegExp(`^docker rm -f '${DEFAULT_BROWSER_CONTAINER}' `));
    assert.match(runs[1].command, /^docker run --rm --network host/);
  });

  /**
   * The arm holds one call open for the whole watch. `Host.run`'s own default is thirty seconds, so
   * without this every arm past the first half-minute would be killed and report as a broken browser.
   */
  it('gives the arm the whole watch plus the overhead outside the measured window', async () => {
    const { host, runs } = stubHost(AN_ARM_THAT_FINISHED);

    await runBrowserArm(host, cfg, arm);

    assert.equal(runs[1].timeoutMs, 4 * 60_000 + BROWSER_ARM_OVERHEAD_MS);
  });

  it('reads the state file from the host checkout, not from the path inside the container', async () => {
    const { host, runs } = stubHost(AN_ARM_THAT_FINISHED);

    await runBrowserArm(host, cfg, arm);

    assert.equal(runs[2].command, "cat '/srv/bench/docs/bench/browser-watch-2026-08-28T10-00-00-000Z.json'");
  });

  /**
   * ⭐ A refused arm is usually one of the driver's own gates rejecting the condition, which is the
   * harness working rather than failing. It must reach the suite as a failure either way.
   */
  it('surfaces an arm that wrote no artifact rather than returning an empty verdict', async () => {
    const { host } = stubHost('browser: playback started\n');

    await assert.rejects(runBrowserArm(host, cfg, arm), /wrote no artifact/);
  });
});

/**
 * ⛔⛔⛔ What every driver writing a fault verdict owes the reader.
 *
 * `readCrashRecovery` reads `run.recovery`, `run.scenario` and `run.fault`, all three strictly, and
 * refuses an artifact carrying one without the others. That strictness is right: a fault verdict that
 * cannot say which fault it is would have one scenario's thresholds applied to another's viewer.
 *
 * ⛔ **It cost a paid arm on 2026-08-30.** `browser/rung-outage.ts` wrote `recovery` and neither of
 * the other two. Every unit test passed, because the FIXTURE was more complete than the driver. The
 * arm ran its full 276 seconds against a real broadcast, injected its fault, recovered, and then died
 * in the reader with the broadcast already spent.
 *
 * ⭐ Stated over the drivers rather than over a fixture, for exactly that reason. A fixture is
 * written by the same person who wrote the reader and agrees with it by construction.
 */
describe('what a driver writing a fault verdict owes the reader', () => {
  const DRIVERS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'browser');

  it('finds the drivers at all, so an empty sweep cannot pass by accident', () => {
    const writing = driversWritingRecovery();

    assert.ok(writing.length >= 2, `only ${writing.length} drivers write a recovery verdict`);
    assert.ok(writing.includes('crash.ts'), 'browser/crash.ts must be one of them');
  });

  it('makes every driver writing a recovery write the scenario and the fault beside it', () => {
    for (const driver of driversWritingRecovery()) {
      const body = readFileSync(join(DRIVERS_DIR, driver), 'utf8');

      // Either spelling: `crash.ts` holds the scenario in a variable and writes it shorthand.
      assert.match(body, /^\s+scenario[,:]/m, `browser/${driver} writes a recovery and never names the scenario`);
      assert.match(body, /^\s+fault[,:]/m, `browser/${driver} writes a recovery and never stamps the fault window`);
    }
  });

  /** A driver writes it into its own run object, which is the `recovery:` key rather than an import. */
  function driversWritingRecovery(): string[] {
    return readdirSync(DRIVERS_DIR)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /^\s+recovery: judgeRecovery\(/m.test(readFileSync(join(DRIVERS_DIR, file), 'utf8')));
  }
});

/**
 * ⛔⛔⛔ **The arm's own account of the broadcast, which the harness used to bin.**
 *
 * `openViewer` forwards every page error and every ladder, rung and restart line from the client's
 * console, so a ladder failure is diagnosable without a second paid run. `runBrowserArm` read one
 * line out of that stdout and dropped the rest. On 2026-08-31 a sitting went red with a viewer stuck
 * on a rung that had stopped, and the client's own statement of whether it had decided to drop that
 * rung was captured, forwarded, and then discarded by the layer above.
 */
describe('what the browser arm said about itself', () => {
  const ARM_STDOUT = [
    'browser: watching http://127.0.0.1:10074/#/watch/video/abc/def',
    '  page log: ladder master arrived with 4 rungs',
    'browser: playback started',
    '  page warning: Rung 480p has stopped being produced, dropping it from the ladder',
    '  page error: something the player shouted about',
    'some unrelated container chatter nobody asked for',
    'browser: wrote /repo/docs/bench/browser-rung-outage-1.md',
  ].join('\n');

  function captured(stdout: string): string[] {
    const lines: string[] = [];
    reportArmNarration(stdout, (line) => lines.push(line));
    return lines;
  }

  it('carries the line that says whether the client dropped the rung', () => {
    assert.ok(
      captured(ARM_STDOUT).some((line) => line.includes('has stopped being produced')),
      'the one line a rung-outage run is read by was dropped',
    );
  });

  it('keeps the arm narration and the page console, and leaves the container chatter out', () => {
    const lines = captured(ARM_STDOUT).join('\n');

    assert.ok(lines.includes('playback started'), 'the arm narrates its own progress');
    assert.ok(lines.includes('page error: something the player shouted about'), 'a page error is the point');
    assert.ok(!lines.includes('unrelated container chatter'), 'unmatched output should stay out');
  });

  /** Silence has to stay silent, or every arm gains a heading over nothing. */
  it('says nothing at all when the arm said nothing', () => {
    assert.deepEqual(captured('no matching output here\nnor here'), []);
  });

  /**
   * ⛔ A bound nobody is told about reads as "that was all of it". The count is the whole point of
   * the heading, so it is asserted rather than the lines alone.
   */
  it('names how many lines it dropped rather than truncating quietly', () => {
    const many = Array.from({ length: 200 }, (_, n) => `  page log: rung line ${n}`).join('\n');
    const lines = captured(many);

    assert.match(lines[0], /arm said 200 line\(s\), oldest 120 not shown/);
    assert.equal(lines.length, 81, 'the heading plus the bound');
    assert.ok(lines.at(-1)?.includes('rung line 199'), 'the newest lines are the ones kept');
  });
});
