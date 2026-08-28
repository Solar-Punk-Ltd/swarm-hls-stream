/**
 * Running a real viewer as part of the pass/fail suite, through the same host the scenarios use.
 *
 * ## What this promotes, and from where
 *
 * The browser drivers under `e2e/browser/` have always been measurement runs: a person launches one
 * through `deploy/scripts/browser-on-host.sh`, reads the report it writes and forms a judgement. The
 * suite's own viewer legs were HTTP polls, so nothing under `suites/` had ever opened a player. This
 * is the same launch, made by the suite, with the result parsed into something a test can assert on.
 *
 * The launch is `browser-on-host.sh`'s, which reaches docker through `bench-on-host.sh`. Host
 * networking so the client and the gateway are both loopback, the invoking user so artifacts do not
 * come back owned by root, the host docker group so the mounted socket is readable, and the shared
 * memory Chrome needs. ⛔ That last one is the single difference between the two bench scripts:
 * `byte-source-arms.sh` omits `--shm-size`, and docker's 64MB default makes Chrome crash partway
 * through a video session rather than at startup, which reads as the stream failing.
 *
 * ## ⛔ Why the artifact is found by reading the driver's own line
 *
 * The run id is stamped inside the container from its own clock, so a caller cannot predict the
 * filename. Picking the newest file in `docs/bench` would work until the day a co-tenant's sitting
 * writes one first, and this host carries other people's sittings. The driver prints the stem it
 * wrote, so that is what is read, and the container path is translated onto the host checkout it was
 * mounted from.
 *
 * ## ⛔ What this deliberately does not decide
 *
 * No latency target, no gateway arm, no CDP port. Each of those is a treatment, and a harness that
 * added one by default would put it into every viewer verdict without the suite naming it. They go
 * through `env`, where a suite states them.
 */

import { type ViewerFeedState } from '../browser/feedState.js';
import { type ByteSource } from '../browser/fetchBackendSweep.js';
import { type E2EConfig } from '../config.js';

import { type Host } from './host.js';

/** Where the bench image mounts the checkout, and the working directory the driver runs in. */
const CONTAINER_REPO = '/repo';

/** The browser image `deploy/scripts/browser-on-host.sh` builds and `byte-source-arms.sh` runs. */
export const DEFAULT_BROWSER_IMAGE = 'swarm-hls-browser:latest';

/**
 * ⛔ By exact name, so a leftover can be reclaimed by name rather than by pattern. The image serves a
 * single Xvfb display, so a container left behind by a crashed arm makes every later arm fail with
 * `Cannot establish any listening sockets`, which reads as a broken browser rather than a stale one.
 * A pattern-matched teardown killed a live paid broadcast on this host on 2026-08-12.
 */
export const DEFAULT_BROWSER_CONTAINER = 'e2e-viewer-browser';

/**
 * How much wall clock an arm gets on top of the minutes it watches.
 *
 * Sized against what happens outside the measured window rather than picked. The image start, the
 * catalog wait the client's discovery allows a minute for, the settle a byte-source arm holds before
 * its window opens, and the in-tab node's join: 4.5 MB of wasm and a peer dial that A2 timed at 9.4
 * to 10.5 seconds to a first retrieval. Generous on purpose, because a timeout that fires early kills
 * a paid arm and throws away every sample it had taken, while one that fires late costs only the time
 * a failed arm was going to take anyway.
 */
export const BROWSER_ARM_OVERHEAD_MS = 300_000;

/** docker's own rule for a container name, which is also what keeps it safe in a shell command. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** An image reference: repository, optional registry and port, optional tag or digest. */
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-/:@]*$/;
/** A pnpm script name, which is the only thing after the image. */
const SCRIPT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/;
/** An environment variable name, spelled the way every driver spells them. */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export interface BrowserArmLaunch {
  image: string;
  containerName: string;
  /** Absolute path of the bench checkout on the HOST, bind-mounted at {@link CONTAINER_REPO}. */
  repoDir: string;
  /** The pnpm script the container runs, which chooses the driver. */
  script: string;
  env: Readonly<Record<string, string>>;
}

/**
 * Quote a value the caller supplied, refusing one that could break out.
 *
 * Refused rather than escaped. This string is parsed by a shell on the far side of ssh, nothing
 * legitimate in a launch carries a quote, and an escaping routine is a thing that can be subtly
 * wrong where a refusal cannot be.
 */
function quoted(value: string, what: string): string {
  if (value.includes("'")) {
    throw new Error(`the ${what} carries a single quote, which this cannot pass safely to a shell: ${value}`);
  }
  return `'${value}'`;
}

function matching(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) {
    throw new Error(`'${value}' is not a usable ${what} (expected ${pattern.source})`);
  }
  return value;
}

/**
 * The docker command line that runs one browser arm.
 *
 * ⛔ `-u` and `--group-add` are the only unquoted values here, and deliberately so: they are command
 * substitutions the host's own shell must evaluate. Without `--group-add` the mounted docker socket
 * is present and unreadable, because dropping to the invoking user also drops the group that owns it.
 */
export function browserArmCommand({ image, containerName, repoDir, script, env }: BrowserArmLaunch): string {
  if (!repoDir.startsWith('/')) {
    throw new Error(
      `the bench checkout must be an absolute path on the host, got '${repoDir}'. A relative or ~ path ` +
        'is resolved against whatever directory the command runs in, or not expanded at all once ' +
        'quoted, and docker then creates an empty directory and mounts that.',
    );
  }

  const pairs = Object.entries(env).map(
    ([name, value]) =>
      `-e ${matching(name, ENV_NAME_RE, 'environment variable name')}=${quoted(value, `${name} value`)}`,
  );

  return [
    'docker run --rm --network host',
    `--name ${quoted(matching(containerName, CONTAINER_NAME_RE, 'container name'), 'container name')}`,
    '-u $(id -u):$(id -g)',
    '--group-add $(getent group docker | cut -d: -f3)',
    '--shm-size=2g',
    '-v /var/run/docker.sock:/var/run/docker.sock',
    `-v ${quoted(repoDir, 'bench checkout')}:${CONTAINER_REPO}`,
    '-e HOME=/tmp',
    `-w ${CONTAINER_REPO}`,
    ...pairs,
    `${quoted(matching(image, IMAGE_RE, 'image reference'), 'image reference')} pnpm ${quoted(
      matching(script, SCRIPT_RE, 'pnpm script name'),
      'pnpm script name',
    )}`,
  ].join(' ');
}

/** The line `writeRunArtifacts` makes the drivers print, naming the report they wrote. */
const WROTE_ARTIFACT_RE = /^browser: wrote (.+)\.md$/gm;

/**
 * The state file a run wrote, out of the run's own output.
 *
 * The stem names the report, the json and the request log, so the json is the report's path with its
 * extension changed. The last match wins: a log carrying more than one names the run that just
 * finished last.
 */
export function artifactJsonFromArmLog(stdout: string): string {
  const stems = [...stdout.matchAll(WROTE_ARTIFACT_RE)].map((match) => match[1]);
  const stem = stems[stems.length - 1];
  if (stem === undefined) {
    throw new Error(
      'the browser arm wrote no artifact line, so there is no state file to read and nothing about ' +
        `this run is a viewer result. Its output ended:\n${stdout.slice(-2_000)}`,
    );
  }
  return `${stem}.json`;
}

/** The same file as the host sees it, since the driver printed the path from inside the container. */
export function hostPathOfArtifact(containerPath: string, repoDir: string): string {
  const prefix = `${CONTAINER_REPO}/`;
  if (!containerPath.startsWith(prefix)) {
    throw new Error(
      `the arm wrote ${containerPath}, which is outside ${CONTAINER_REPO} and so is not readable on ` +
        'the host at any path. The driver writes under the checkout it was mounted from.',
    );
  }
  return `${repoDir}/${containerPath.slice(prefix.length)}`;
}

/** The condition the arm asked for beside the one the client landed on, never one standing for both. */
export interface BrowserArmProof {
  requested: string | null;
  reported: string | null;
  settledForMs: number | null;
}

/** How far behind live the player sat. Null where the overlay never reported a latency. */
export interface BehindLive {
  joinS: number | null;
  medianS: number | null;
  minS: number | null;
  maxS: number | null;
}

export interface BrowserArmResult {
  /** The broadcast the arm actually opened, which is how a reading is traced back to one. */
  watchUrl: string;
  /** Media seconds delivered per wall second across the watch, stalls included. 1.0 is keeping up. */
  advanceRatio: number;
  rebufferCount: number;
  fatalErrors: number;
  /** Every distinct resolution the decoder produced, which is the rung the viewer rode. */
  resolutions: readonly string[];
  behindLive: BehindLive;
  /**
   * `/bytes/` requests the page made over the whole run, settle included.
   *
   * ⭐ The number a weeb-3 arm is judged on. Its headline is that segment bytes did not come from the
   * gateway, and the driver's own gate already refuses an arm whose zero came from never loading a
   * node. What is left for a suite is the count.
   */
  segmentRequests: number;
  proof: BrowserArmProof;
  /** Each feed state the viewer was shown, once, in the order they first met it. */
  feedStatesSeen: readonly ViewerFeedState[];
  /** Whether the viewer was ever told the broadcast had ended, which is the terminal state. */
  reachedEndedOverlay: boolean;
  /**
   * Whether the browser was a usable instrument throughout.
   *
   * ⛔ Read before asserting on any figure above. A hidden or throttled page produces numbers that
   * are properties of the harness, and a suite that passed on them would be certifying the harness.
   */
  instrumentSound: boolean;
  instrumentFailures: readonly string[];
  samples: number;
}

function asObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`the arm's state has no object at ${at}, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`the arm's state has no finite number at ${at}, got ${describe(value)}`);
  }
  return value;
}

/** A reading the player may genuinely not have taken. Absent and null both mean it had none. */
function asNumberOrNull(value: unknown, at: string): number | null {
  return value === null || value === undefined ? null : asNumber(value, at);
}

function asString(value: unknown, at: string): string {
  if (typeof value !== 'string') {
    throw new Error(`the arm's state has no string at ${at}, got ${describe(value)}`);
  }
  return value;
}

function asArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`the arm's state has no array at ${at}, got ${describe(value)}`);
  }
  return value;
}

function asBoolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`the arm's state has no boolean at ${at}, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value)?.slice(0, 80) ?? String(value);
}

/**
 * What the viewer got, out of the state file the driver wrote.
 *
 * ⛔ Every field is required to be the shape it claims, and a missing one is a refusal rather than a
 * default. The case that matters is a driver older than this reader: `summary.feedStatesSeen` is
 * newer than the rest of the artifact, so an image built before it writes a run with every other
 * field intact. Defaulting there would make the ended-broadcast scenario report that the viewer was
 * never told the broadcast finished, which is a wrong answer rather than a missing one, and it would
 * look exactly like a product defect.
 */
export function parseBrowserArmState(raw: unknown): BrowserArmResult {
  const run = asObject(raw, 'the run');
  const summary = asObject(run.summary, 'run.summary');
  const latency = asObject(summary.latency, 'run.summary.latency');
  const network = asObject(run.network, 'run.network');
  const instrument = asObject(run.instrument, 'run.instrument');

  const feedStatesSeen = asArray(summary.feedStatesSeen, 'run.summary.feedStatesSeen').map((state, i) =>
    asString(state, `run.summary.feedStatesSeen[${i}]`),
  ) as ViewerFeedState[];

  return {
    watchUrl: asString(run.watchUrl, 'run.watchUrl'),
    advanceRatio: asNumber(summary.overallAdvanceRatio, 'run.summary.overallAdvanceRatio'),
    rebufferCount: asNumber(summary.rebufferCount, 'run.summary.rebufferCount'),
    fatalErrors: asNumber(summary.fatalErrors, 'run.summary.fatalErrors'),
    resolutions: distinctResolutions(asArray(run.samples, 'run.samples')),
    behindLive: {
      joinS: asNumberOrNull(latency.joinLatencyS, 'run.summary.latency.joinLatencyS'),
      medianS: asNumberOrNull(latency.medianLatencyS, 'run.summary.latency.medianLatencyS'),
      minS: asNumberOrNull(latency.minLatencyS, 'run.summary.latency.minLatencyS'),
      maxS: asNumberOrNull(latency.maxLatencyS, 'run.summary.latency.maxLatencyS'),
    },
    segmentRequests: asNumber(network.segmentRequests, 'run.network.segmentRequests'),
    proof: readProof(run.byteSource),
    feedStatesSeen,
    reachedEndedOverlay: feedStatesSeen.includes('ended'),
    instrumentSound: asBoolean(instrument.sound, 'run.instrument.sound'),
    instrumentFailures: asArray(instrument.failures, 'run.instrument.failures').map((failure, i) =>
      asString(failure, `run.instrument.failures[${i}]`),
    ),
    samples: asNumber(summary.samples, 'run.summary.samples'),
  };
}

/**
 * The arm, or the absence of one.
 *
 * A run that named no byte source writes no `byteSource` at all, and that is a run on whatever the
 * build defaults to rather than a malformed one. A `byteSource` that is present and incomplete is
 * malformed, and is refused: half an arm is not a condition.
 */
function readProof(value: unknown): BrowserArmProof {
  if (value === undefined || value === null) {
    return { requested: null, reported: null, settledForMs: null };
  }
  const arm = asObject(value, 'run.byteSource');
  return {
    requested: asString(arm.requested, 'run.byteSource.requested'),
    reported: asString(arm.reported, 'run.byteSource.reported'),
    settledForMs: asNumber(arm.settledForMs, 'run.byteSource.settledForMs'),
  };
}

/** Each resolution the decoder produced, once, in the order it first appeared. */
function distinctResolutions(samples: readonly unknown[]): string[] {
  const seen = samples
    .map((sample, i) => asObject(sample, `run.samples[${i}]`).resolution)
    .filter((resolution): resolution is string => typeof resolution === 'string' && resolution !== '');
  return [...new Set(seen)];
}

export interface BrowserArmOptions {
  /** Where segment bytes come from. The one thing a viewer arm is a reading of. */
  backend: ByteSource;
  /**
   * How long the arm runs for.
   *
   * The measured watch on a plain arm. On a scenario arm it is the wall-clock budget the whole arm
   * gets, because the fault windows are the scenario's and the driver's own settings, and
   * ⛔ `BROWSER_WATCH_SECONDS` is deliberately not passed to `browser:crash`, which never reads it.
   * A passed-but-unread variable looks exactly like one set to its default, and that is how three
   * drivers came to run on the gateway while claiming otherwise.
   */
  watchMinutes: number;
  /** A fault to drive the viewer through, which switches the driver to `browser:crash`. */
  scenario?: string;
  /** Anything else the driver reads. A suite states its own treatments here, never the harness. */
  env?: Readonly<Record<string, string>>;
}

/** Where the bench checkout lives on the host, and which image and container name to use. */
export interface BrowserArmHostSetup {
  repoDir: string;
  image: string;
  containerName: string;
}

/**
 * The host-side settings a browser arm needs and the config cannot know.
 *
 * ⛔ `E2E_BROWSER_REPO_DIR` has no default. The suite runs inside the bench image at `/repo`, which is
 * a bind mount, so nothing inside it can work out the host path it came from. A guessed default that
 * happened not to exist would make docker create an empty directory, mount that, and fail minutes
 * later looking like a broken image.
 */
export function browserArmHostSetup(env: NodeJS.ProcessEnv = process.env): BrowserArmHostSetup {
  const repoDir = env.E2E_BROWSER_REPO_DIR ?? '';
  if (repoDir === '') {
    throw new Error(
      'E2E_BROWSER_REPO_DIR is required to launch a viewer: it is the absolute path of the bench ' +
        'checkout ON THE HOST, which is bind-mounted into the browser container as /repo. The suite ' +
        'runs from inside that mount and cannot work the host path out for itself. It is the same ' +
        'directory deploy/scripts/bench-on-host.sh rsyncs to, BENCH_REPO in byte-source-arms.sh.',
    );
  }
  return {
    repoDir,
    image: env.E2E_BROWSER_IMAGE || DEFAULT_BROWSER_IMAGE,
    containerName: env.E2E_BROWSER_CONTAINER || DEFAULT_BROWSER_CONTAINER,
  };
}

/**
 * The environment a viewer arm is run with, which is `byte-source-arms.sh`'s minus the treatments.
 *
 * `E2E_SSH_TARGET=local` is what makes the driver's own harness shell out rather than try to ssh from
 * the host to itself, and `127.0.0.1` is what the client and the gateway are both reached on from a
 * host-networked container.
 */
export function browserArmEnv(cfg: E2EConfig, options: BrowserArmOptions): Record<string, string> {
  const watching = options.scenario === undefined;
  return {
    E2E_SSH_TARGET: 'local',
    E2E_PUBLIC_HOST: '127.0.0.1',
    E2E_PROFILE: cfg.profile,
    E2E_PORT_SLOT: String(cfg.portSlot),
    BROWSER_CLIENT_URL: `http://127.0.0.1:${cfg.ports.client}`,
    BROWSER_FETCH_BACKEND: options.backend,
    ...(watching ? { BROWSER_WATCH_SECONDS: String(Math.round(options.watchMinutes * 60)) } : {}),
    ...(options.scenario === undefined ? {} : { BROWSER_SCENARIO: options.scenario }),
    ...options.env,
  };
}

/** `browser:crash` drives a fault under a watching viewer. Everything else is a plain watch. */
export function browserArmScript(options: BrowserArmOptions): string {
  return options.scenario === undefined ? 'browser:watch' : 'browser:crash';
}

/**
 * Watch a live broadcast in a real browser on the deployment host, and report what the viewer got.
 *
 * Runs to completion: the arm holds the ssh session for the whole watch, exactly as
 * `bench-on-host.sh` does, and a non-zero exit surfaces as a rejection. ⭐ A refused arm is usually
 * one of the driver's own gates rejecting the condition, which is the harness working rather than
 * failing, and the message it throws says which gate.
 */
export async function runBrowserArm(host: Host, cfg: E2EConfig, options: BrowserArmOptions): Promise<BrowserArmResult> {
  const setup = browserArmHostSetup();
  const command = browserArmCommand({
    ...setup,
    script: browserArmScript(options),
    env: browserArmEnv(cfg, options),
  });

  // Before the arm, never after it. A container left behind by a crashed arm holds the image's single
  // Xvfb display, and every later arm then fails at startup looking like a broken browser.
  //
  // ⛔ Validated here rather than relying on `browserArmCommand` above having already done it. That
  // is true today and true only because of the order these two lines happen to be in, which is not a
  // property anyone reading either line can see.
  const name = quoted(matching(setup.containerName, CONTAINER_NAME_RE, 'container name'), 'container name');
  await host.run(`docker rm -f ${name} > /dev/null 2>&1 || true`).catch(() => undefined);

  const timeoutMs = options.watchMinutes * 60_000 + BROWSER_ARM_OVERHEAD_MS;
  const { stdout } = await host.run(command, timeoutMs);

  // Quoted through the same refusal the launch uses. This path is read out of the container's own
  // output, so it is data from the far side of the run rather than something the suite chose.
  const artifact = hostPathOfArtifact(artifactJsonFromArmLog(stdout), setup.repoDir);
  const state = await host.run(`cat ${quoted(artifact, 'artifact path the arm printed')}`);
  return parseBrowserArmState(JSON.parse(state.stdout));
}
