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

import { FEED_STATE_ENDED, isViewerFeedState, type ViewerFeedState } from '../browser/feedState.js';
import { type ByteSource } from '../browser/fetchBackendSweep.js';
import { type QualityPhase, type QualitySwitchVerdict, type RungTimeline } from '../browser/qualitySwitch.js';
import { type E2EConfig } from '../config.js';

import { type Host } from './host.js';
import { shellQuoted } from './shellQuote.js';

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

interface BrowserArmLaunch {
  image: string;
  containerName: string;
  /** Absolute path of the bench checkout on the HOST, bind-mounted at {@link CONTAINER_REPO}. */
  repoDir: string;
  /** The pnpm script the container runs, which chooses the driver. */
  script: string;
  env: Readonly<Record<string, string>>;
}

function matching(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) {
    throw new Error(`'${value}' is not a usable ${what} (expected ${pattern.source})`);
  }
  return value;
}

/**
 * The arm's container name, checked and quoted.
 *
 * ⛔ Its own function because two commands need it: the launch, and the reclaim that removes a
 * leftover before the launch. Checking it in one of them and letting the other inherit that by
 * standing later in the same function is a guarantee nobody reading either line can see, and it was
 * written that way once already.
 */
function quotedContainerName(name: string): string {
  return shellQuoted(matching(name, CONTAINER_NAME_RE, 'container name'));
}

/**
 * The docker command line that runs one browser arm.
 *
 * ⛔ `-u` and `--group-add` are the only unquoted values here, and deliberately so: they are command
 * substitutions the host's own shell must evaluate. Without `--group-add` the mounted docker socket
 * is present and unreadable, because dropping to the invoking user also drops the group that owns it.
 *
 * ⛔ The gid is read off the socket file, not out of `getent group docker`: this command is often
 * composed inside the suite's own container, whose /etc/group has no docker entry, and the empty
 * substitution made `--group-add` swallow the next flag as its value. The mounted socket carries the
 * host's gid wherever the command runs.
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
    ([name, value]) => `-e ${matching(name, ENV_NAME_RE, 'environment variable name')}=${shellQuoted(value)}`,
  );

  return [
    'docker run --rm --network host',
    `--name ${quotedContainerName(containerName)}`,
    '-u $(id -u):$(id -g)',
    '--group-add $(stat -c %g /var/run/docker.sock)',
    '--shm-size=2g',
    '-v /var/run/docker.sock:/var/run/docker.sock',
    `-v ${shellQuoted(repoDir)}:${CONTAINER_REPO}`,
    '-e HOME=/tmp',
    `-w ${CONTAINER_REPO}`,
    ...pairs,
    `${shellQuoted(matching(image, IMAGE_RE, 'image reference'))} pnpm ${shellQuoted(
      matching(script, SCRIPT_RE, 'pnpm script name'),
    )}`,
  ].join(' ');
}

/** The line `writeRunArtifacts` makes the drivers print, naming the report they wrote. */
const WROTE_ARTIFACT_RE = /^browser: wrote (.+)\.md$/gm;

/**
 * What the arm said about itself: its own narration, and the page console lines it forwards.
 *
 * ⛔⛔⛔ **All of this was being thrown away, and it cost a whole sitting.** `openViewer` installs a
 * console handler that forwards every page error and every ladder, rung and restart line, precisely
 * so a ladder failure is diagnosable without a second paid run. The arm prints them to its stdout,
 * `runBrowserArm` read ONE line out of that stdout and dropped the rest, and the suite log therefore
 * carried not a single word the client said. On 2026-08-31 V3 went red with the viewer stuck on a
 * dead rung, and the one thing that would have said whether the client had decided to drop that rung
 * had been captured, forwarded, and then binned by the harness.
 *
 * ⭐ The client narrates itself. Something has to listen.
 */
const ARM_NARRATION_RE = /^\s*(browser: |page (log|warning|error|info|debug): ).*$/gm;

/** Distinct things the arm said, bounded so a chatty arm cannot bury the TAP output. */
const ARM_NARRATION_KINDS = 60;

/**
 * Print what the arm said, one line per distinct thing said, with how many times it said it.
 *
 * ⛔⛔⛔ **Keeping the newest N lines is the wrong bound, and it wasted a run proving it.** The first
 * version kept the last 80 of 480, and a viewer at the live edge asks for a slot the publisher has
 * not written yet several times a second, each of which Chrome reports as `Failed to load resource:
 * 404`. So 400 lines were dropped and the 80 kept were 78 copies of that one message. The single
 * line the run existed to read, printed once at the moment the client judged a rung dead, was in the
 * dropped part.
 *
 * ⭐ **Repetition is not information, and it must not be able to crowd information out.** Collapsing
 * to distinct lines in first-appearance order makes a flood cost one line however long it runs, so
 * the bound now falls on how many DIFFERENT things happened, which is a number that stays small.
 *
 * Printed even when the arm succeeded: a green run's narration is the baseline the next red one is
 * read against, and it is the only place the client's own account of a broadcast is ever written.
 */
export function reportArmNarration(stdout: string, log: (line: string) => void = console.log): void {
  const lines = stdout.match(ARM_NARRATION_RE)?.map((line) => line.trim()) ?? [];
  if (lines.length === 0) {
    return;
  }

  const timesSaid = new Map<string, number>();
  for (const line of lines) {
    timesSaid.set(line, (timesSaid.get(line) ?? 0) + 1);
  }

  const shown = [...timesSaid].slice(0, ARM_NARRATION_KINDS);
  const kindsDropped = timesSaid.size - shown.length;
  // Named rather than silently truncated. A bound nobody is told about reads as "that was all of it".
  log(
    `  arm said ${lines.length} line(s), ${timesSaid.size} distinct` +
      `${kindsDropped > 0 ? `, ${kindsDropped} kind(s) not shown` : ''}:`,
  );
  for (const [line, times] of shown) {
    log(`  | ${line}${times > 1 ? `  (x${times})` : ''}`);
  }
}

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

/**
 * The artifact path as the READER of the file will see it, which is not one namespace.
 *
 * The driver prints the path from inside the browser container, under `/repo`. Over ssh the reader
 * is the deploy host's shell, where that checkout lives at `repoDir`. In local mode the reader is
 * the suite's own container, which mounts the same checkout at `/repo`, so the printed path is
 * already the right one and the `repoDir` mapping points at a directory that does not exist here.
 * Both viewer suites failed their first real run on exactly that.
 */
export function artifactReadPath(containerPath: string, repoDir: string, readerIsLocal: boolean): string {
  const prefix = `${CONTAINER_REPO}/`;
  if (!containerPath.startsWith(prefix)) {
    throw new Error(
      `the arm wrote ${containerPath}, which is outside ${CONTAINER_REPO} and so is not readable ` +
        'from anywhere. The driver writes under the checkout it was mounted from.',
    );
  }
  return readerIsLocal ? containerPath : `${repoDir}/${containerPath.slice(prefix.length)}`;
}

/** The condition the arm asked for beside the one the client landed on, never one standing for both. */
interface BrowserArmProof {
  requested: string | null;
  reported: string | null;
  settledForMs: number | null;
}

/**
 * What a fault did to the viewer, as `judgeRecovery` decided it from the samples either side.
 *
 * ⛔ Only `browser:crash` writes this, so a plain watch legitimately has none and the field is null
 * rather than a refusal. Everything inside it is required once it exists, for the reason every other
 * field is: a crash scenario's pass or fail IS these numbers.
 */
/**
 * When the driver broke the service and when it put it back, in epoch milliseconds.
 *
 * ⛔ Epoch rather than a formatted time, so the instants are frame independent. The driver stamps
 * them inside its own container and they are read here to scope a log on the host, and only an
 * absolute instant survives that crossing without a skew correction nobody would remember to apply.
 */
export interface FaultWindow {
  injectedAtMs: number;
  liftedAtMs: number;
  /** When the service answered again. Null where it never did before the arm ended. */
  servingAtMs: number | null;
}

export interface CrashRecoveryResult {
  /** The fault this verdict is about, so one scenario's thresholds cannot be applied to another's run. */
  scenario: string;
  /** The longest unbroken stretch the picture did not move, anywhere in the run rather than only after the fault. */
  longestFreezeMs: number;
  /**
   * How long the picture kept moving after the fault landed, which is the viewer's buffer spending
   * itself. Null where it never stopped at all.
   */
  freezeStartedAfterFaultMs: number | null;
  /**
   * Wall time from the service ANSWERING AGAIN to the picture moving again, which is the only figure
   * here a client change can move. Null where it never moved again. Negative where the buffer
   * outlasted the outage, which is a viewer who never depended on the service.
   */
  recoveredAfterLiftMs: number | null;
  /** How long the service took to answer after docker returned, which no client change can shorten. */
  serviceStartupMs: number | null;
  /** Whether the picture was moving again by the last sample of the run. */
  recovered: boolean;
  /** Everything the client said while the picture was stopped, deduplicated, in first-seen order. */
  saidWhileFrozen: readonly string[];
  /**
   * Whether the client explained the freeze while it was happening.
   *
   * ⭐ False beside a non-zero freeze is the shape issue #100 describes: a stopped picture under an
   * overlay that says nothing.
   */
  explainedTheFreeze: boolean;
  /**
   * The instants the fault was live between, taken from the driver's own stamps.
   *
   * ⭐ What it is for is scoping a host side log read to the fault. A crash arm watches for minutes
   * and the fault lasts seconds, so a count taken across the whole arm charges the fault with
   * everything else the deployment did meanwhile. `harness/crashArm.ts` turns this into the window.
   */
  fault: FaultWindow;
}

/** How far behind live the player sat. Null where the overlay never reported a latency. */
interface BehindLive {
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
  /** What the fault did to them, on a scenario arm. Null on a plain watch, which drove no fault. */
  recovery: CrashRecoveryResult | null;
  /**
   * What their player chose across a squeezed connection, on a squeeze arm. Null on every other arm.
   *
   * ⛔ Null is the answer a suite asserting on ABR must refuse. A plain watch produces a full report
   * with every playback figure in it, and reading one as a quality-switch run would certify the
   * ladder off a viewer whose connection was never touched.
   */
  quality: QualitySwitchVerdict | null;
  /**
   * Why the squeeze question could not be put to this viewer, on a squeeze arm. Null where it could.
   *
   * ⛔ The difference between "the ladder does not adapt" and "this viewer had nowhere to go". The
   * second is a property of the byte source, and reporting it as the first is a finding about the
   * gateway filed against the client.
   */
  cannotSqueeze: string | null;
  /**
   * What their player chose across a silenced rung, on a rung-outage arm. Null on every other arm.
   *
   * ⛔ Paired with {@link recovery}, which a rung-outage arm also carries. Either alone reads as a
   * success on its own: a player that switched away instantly and then stalled, or a picture that
   * never stopped because the buffer outlasted the outage.
   */
  rungs: RungTimeline | null;
  /** Which rung was silenced under this viewer, by name. Null on every arm that silenced none. */
  silencedRung: string | null;
  /** What a finished recording did, on a playback arm. Null on every arm that opened a live stream. */
  vod: VodResult | null;
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
    throw new Error(`the arm's state has no object at ${at}, got ${shownValue(value)}`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`the arm's state has no finite number at ${at}, got ${shownValue(value)}`);
  }
  return value;
}

/** A reading the player may genuinely not have taken. Absent and null both mean it had none. */
function asNumberOrNull(value: unknown, at: string): number | null {
  return value === null || value === undefined ? null : asNumber(value, at);
}

function asString(value: unknown, at: string): string {
  if (typeof value !== 'string') {
    throw new Error(`the arm's state has no string at ${at}, got ${shownValue(value)}`);
  }
  return value;
}

/** A value the sample may genuinely not have, such as a resolution before the first frame decoded. */
function asStringOrNull(value: unknown, at: string): string | null {
  return value === null || value === undefined ? null : asString(value, at);
}

/**
 * ⛔ Checked against the known states rather than cast to them.
 *
 * These decide a pass or a fail: `reachedEndedOverlay` is what the ended-broadcast scenario asserts
 * on. The file is written by whichever driver produced it, which may be a build newer than this
 * reader, and a string taken as a state on trust is how a sixth state would arrive unnoticed inside
 * a verdict.
 */
function asFeedState(value: unknown, at: string): ViewerFeedState {
  if (!isViewerFeedState(value)) {
    throw new Error(
      `the arm's state has no feed state this harness knows at ${at}, got ${shownValue(value)}. The ` +
        'client gained a state, or the file was written by a driver this reader does not match.',
    );
  }
  return value;
}

function asArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`the arm's state has no array at ${at}, got ${shownValue(value)}`);
  }
  return value;
}

function asBoolean(value: unknown, at: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`the arm's state has no boolean at ${at}, got ${shownValue(value)}`);
  }
  return value;
}

function shownValue(value: unknown): string {
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
    asFeedState(state, `run.summary.feedStatesSeen[${i}]`),
  );

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
    reachedEndedOverlay: feedStatesSeen.includes(FEED_STATE_ENDED),
    recovery: readCrashRecovery(run),
    quality: readQualityVerdict(run),
    cannotSqueeze: readCannotSqueeze(run),
    rungs: readRungTimeline(run),
    silencedRung: readSilencedRung(run),
    vod: readVodResult(run),
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

/**
 * The fault verdict, or the absence of one.
 *
 * ⛔ Absent is a legitimate answer here and a refusal everywhere else in this reader. `watch.ts`
 * writes no `recovery` at all, so treating its absence as malformed would fail the two viewer suites
 * that already pass on a file that is exactly right. A `recovery` that is present is read whole, and
 * so is the scenario beside it: a fault verdict that does not say which fault it is could have one
 * scenario's thresholds applied to another scenario's run.
 */
function readCrashRecovery(run: Record<string, unknown>): CrashRecoveryResult | null {
  if (run.recovery === undefined || run.recovery === null) {
    return null;
  }
  const recovery = asObject(run.recovery, 'run.recovery');
  const scenario = asObject(run.scenario, 'run.scenario');
  // Read strictly. Every artifact carrying a recovery was written by `browser/crash.ts`, which
  // stamps the fault unconditionally, so an absent one is a malformed file rather than a plain watch.
  const fault = asObject(run.fault, 'run.fault');

  return {
    scenario: asString(scenario.name, 'run.scenario.name'),
    longestFreezeMs: asNumber(recovery.longestFreezeMs, 'run.recovery.longestFreezeMs'),
    freezeStartedAfterFaultMs: asNumberOrNull(
      recovery.freezeStartedAfterFaultMs,
      'run.recovery.freezeStartedAfterFaultMs',
    ),
    recoveredAfterLiftMs: asNumberOrNull(recovery.recoveredAfterLiftMs, 'run.recovery.recoveredAfterLiftMs'),
    serviceStartupMs: asNumberOrNull(recovery.serviceStartupMs, 'run.recovery.serviceStartupMs'),
    recovered: asBoolean(recovery.recovered, 'run.recovery.recovered'),
    saidWhileFrozen: asArray(recovery.saidWhileFrozen, 'run.recovery.saidWhileFrozen').map((said, i) =>
      asString(said, `run.recovery.saidWhileFrozen[${i}]`),
    ),
    explainedTheFreeze: asBoolean(recovery.explainedTheFreeze, 'run.recovery.explainedTheFreeze'),
    fault: {
      injectedAtMs: asNumber(fault.injectedAtMs, 'run.fault.injectedAtMs'),
      liftedAtMs: asNumber(fault.liftedAtMs, 'run.fault.liftedAtMs'),
      servingAtMs: asNumberOrNull(fault.servingAtMs, 'run.fault.servingAtMs'),
    },
  };
}

/**
 * What the player chose across a squeezed connection, or the absence of it.
 *
 * ⛔ Absent is legitimate, exactly as it is for the fault verdict: `watch.ts` and `crash.ts` write no
 * `quality` and a reader that refused its absence would fail the arms that are exactly right. A
 * `quality` that is present is read whole.
 */
function readQualityVerdict(run: Record<string, unknown>): QualitySwitchVerdict | null {
  if (run.quality === undefined || run.quality === null) {
    return null;
  }
  const quality = asObject(run.quality, 'run.quality');

  return {
    ...readTimeline(quality, 'run.quality'),
    throttledToKbps: asNumber(quality.throttledToKbps, 'run.quality.throttledToKbps'),
  };
}

/**
 * What the player chose across a silenced rung, or the absence of it.
 *
 * ⛔ Absent is legitimate. Only `browser/rung-outage.ts` writes `rungs`, and a reader that refused its
 * absence would fail every other arm.
 */
function readRungTimeline(run: Record<string, unknown>): RungTimeline | null {
  if (run.rungs === undefined || run.rungs === null) {
    return null;
  }
  return readTimeline(asObject(run.rungs, 'run.rungs'), 'run.rungs');
}

/**
 * Which rung this arm silenced.
 *
 * ⛔ Read strictly where the section exists, and a null NAME inside a present section is refused. The
 * driver writes null there only when it never got as far as choosing a rung, which is an arm that
 * silenced nothing while carrying a full rung timeline, and it would read as a ladder that survived.
 */
function readSilencedRung(run: Record<string, unknown>): string | null {
  if (run.silenced === undefined || run.silenced === null) {
    return null;
  }
  const silenced = asObject(run.silenced, 'run.silenced');
  if (silenced.rung === null || silenced.rung === undefined) {
    throw new Error(
      'this artifact carries a silenced section naming no rung, so the run reached its outage window ' +
        'without choosing anything to silence. Its rung timeline is a healthy ladder being read as one ' +
        'that survived a fault.',
    );
  }
  return asString(silenced.rung, 'run.silenced.rung');
}

/** What a finished recording gave a player, as `browser/vod.ts` judges it. */
export interface VodResult {
  /**
   * Why the recording did not play, or null where it did.
   *
   * ⛔ A result rather than an exception, because "it never started" is the headline finding of a
   * playback run and a run that threw would leave no artifact to read it from.
   */
  openError: string | null;
  /** The finite duration the player was handed. A live playlist reports Infinity here instead. */
  durationS: number | null;
  seekableToS: number | null;
  /** Every rung the player parsed out of the recording's master, by height. */
  ladderHeights: readonly number[];
}

/**
 * What a recording gave the player, or the absence of a recording run.
 *
 * ⛔ A duration of `Infinity` is read through rather than refused here. It means the player was
 * handed a LIVE playlist where a finished one was expected, which is a finding for the suite to
 * refuse in its own words rather than a malformed artifact.
 */
function readVodResult(run: Record<string, unknown>): VodResult | null {
  if (run.vod === undefined || run.vod === null) {
    return null;
  }
  const vod = asObject(run.vod, 'run.vod');

  return {
    openError:
      vod.openError === null || vod.openError === undefined ? null : asString(vod.openError, 'run.vod.openError'),
    durationS: readMaybeInfinite(vod.durationS, 'run.vod.durationS'),
    seekableToS: readMaybeInfinite(vod.seekableToS, 'run.vod.seekableToS'),
    ladderHeights: asArray(vod.ladderHeights, 'run.vod.ladderHeights').map((height, i) =>
      asNumber(height, `run.vod.ladderHeights[${i}]`),
    ),
  };
}

/**
 * A duration, which may legitimately be infinite.
 *
 * ⛔ `JSON.stringify` writes `Infinity` as `null`, so a live playlist's duration reaches this reader
 * indistinguishable from an absent one. Both mean the same thing here, which is that the player was
 * not handed a finite timeline, and the suite says so.
 */
function readMaybeInfinite(value: unknown, at: string): number | null {
  return value === null || value === undefined ? null : asNumber(value, at);
}

function readTimeline(timeline: Record<string, unknown>, at: string): RungTimeline {
  return {
    before: readQualityPhase(timeline.before, `${at}.before`),
    during: readQualityPhase(timeline.during, `${at}.during`),
    after: readQualityPhase(timeline.after, `${at}.after`),
    switchesCounted: asNumber(timeline.switchesCounted, `${at}.switchesCounted`),
    abrEnabledThroughout: asBoolean(timeline.abrEnabledThroughout, `${at}.abrEnabledThroughout`),
    steppedDownAfterMs: asNumberOrNull(timeline.steppedDownAfterMs, `${at}.steppedDownAfterMs`),
    climbedBackAfterMs: asNumberOrNull(timeline.climbedBackAfterMs, `${at}.climbedBackAfterMs`),
  };
}

/** Why this viewer could not be asked the quality-switch question, as the driver recorded it. */
function readCannotSqueeze(run: Record<string, unknown>): string | null {
  if (run.squeeze === undefined || run.squeeze === null) {
    return null;
  }
  const squeeze = asObject(run.squeeze, 'run.squeeze');
  return squeeze.cannotAsk === null || squeeze.cannotAsk === undefined
    ? null
    : asString(squeeze.cannotAsk, 'run.squeeze.cannotAsk');
}

function readQualityPhase(value: unknown, at: string): QualityPhase {
  const phase = asObject(value, at);
  const advance = asObject(phase.advance, `${at}.advance`);

  return {
    advance: {
      ratio: asNumber(advance.ratio, `${at}.advance.ratio`),
      wallMs: asNumber(advance.wallMs, `${at}.advance.wallMs`),
      samples: asNumber(advance.samples, `${at}.advance.samples`),
    },
    lowestRungHeight: asNumberOrNull(phase.lowestRungHeight, `${at}.lowestRungHeight`),
    tallestRungHeight: asNumberOrNull(phase.tallestRungHeight, `${at}.tallestRungHeight`),
    endedOnRungHeight: asNumberOrNull(phase.endedOnRungHeight, `${at}.endedOnRungHeight`),
    resolutions: asArray(phase.resolutions, `${at}.resolutions`).map((entry, i) =>
      asString(entry, `${at}.resolutions[${i}]`),
    ),
    bandwidthEstimateKbps: asNumberOrNull(phase.bandwidthEstimateKbps, `${at}.bandwidthEstimateKbps`),
  };
}

/**
 * Each resolution the decoder produced, once, in the order it first appeared.
 *
 * ⛔ A value that is neither a resolution nor the absence of one is refused, not filtered out. Null
 * is the absence: the player had not decoded a frame yet. Anything else silently dropped would come
 * back as a shorter list rather than as an error, and a shorter list of resolutions is a viewer
 * verdict.
 */
function distinctResolutions(samples: readonly unknown[]): string[] {
  const seen = samples
    .map((sample, i) =>
      asStringOrNull(asObject(sample, `run.samples[${i}]`).resolution, `run.samples[${i}].resolution`),
    )
    .filter((resolution): resolution is string => resolution !== null && resolution !== '');
  return [...new Set(seen)];
}

interface BrowserArmOptions {
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
  /**
   * Squeeze the tab's bandwidth mid-watch, which switches the driver to `browser:quality`.
   *
   * ⛔ Exclusive with {@link scenario}. One treatment per arm, or a rung that moved could have moved
   * because of either and the run answers neither question.
   */
  squeeze?: boolean;
  /**
   * Silence the rung the viewer settles on, which switches the driver to `browser:rung-outage`.
   *
   * ⛔ Exclusive with the other two treatments, for the same reason they are exclusive with each
   * other. Which rung the driver silences is its own decision, taken from the overlay after the
   * settle, so a suite states the treatment and never the rung.
   */
  silenceSelectedRung?: boolean;
  /**
   * Play a finished recording back, which switches the driver to `browser:vod`.
   *
   * ⛔ Not a treatment on a live broadcast, and exclusive with all three of them: this arm opens a
   * recording rather than joining a stream, so there is nothing live for a fault to break.
   */
  vod?: { owner: string; topic: string };
  /** Anything else the driver reads. A suite states its own treatments here, never the harness. */
  env?: Readonly<Record<string, string>>;
}

/** Where the bench checkout lives on the host, and which image and container name to use. */
interface BrowserArmHostSetup {
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
/**
 * ⛔ `repoDir` is passed in rather than read from `process.env`, because the deployment declares it in
 * the profile's env file and only `loadConfig` reads those. Taking it from the environment here meant
 * a value declared exactly where `viewer-coverage`'s refusal says to put it was invisible.
 */
export function browserArmHostSetup(repoDir: string, env: NodeJS.ProcessEnv = process.env): BrowserArmHostSetup {
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
  // ⛔ A squeeze arm is not watching either. `browser:quality` owns its own windows and never reads
  // BROWSER_WATCH_SECONDS, and a passed-but-unread variable looks exactly like one set to its default.
  const watching =
    options.scenario === undefined &&
    options.squeeze !== true &&
    options.silenceSelectedRung !== true &&
    options.vod === undefined;
  return {
    E2E_SSH_TARGET: 'local',
    E2E_PUBLIC_HOST: '127.0.0.1',
    E2E_PROFILE: cfg.profile,
    E2E_PORT_SLOT: String(cfg.portSlot),
    BROWSER_CLIENT_URL: `http://127.0.0.1:${cfg.ports.client}`,
    BROWSER_FETCH_BACKEND: options.backend,
    ...(watching ? { BROWSER_WATCH_SECONDS: String(Math.round(options.watchMinutes * 60)) } : {}),
    ...(options.scenario === undefined ? {} : { BROWSER_SCENARIO: options.scenario }),
    ...(options.vod === undefined
      ? {}
      : { BROWSER_VOD_OWNER: options.vod.owner, BROWSER_VOD_TOPIC: options.vod.topic }),
    ...options.env,
  };
}

/**
 * Which driver an arm runs: a fault, a squeezed connection, or a plain watch.
 *
 * ⛔ The two treatments are refused together rather than one silently winning. A viewer whose gateway
 * was stopped AND whose bandwidth was capped tells you nothing about either, and the arm would still
 * produce a full report.
 */
export function browserArmScript(options: BrowserArmOptions): string {
  const asked = [
    options.scenario === undefined ? null : `the ${options.scenario} fault`,
    options.squeeze === true ? 'a bandwidth squeeze' : null,
    options.silenceSelectedRung === true ? 'a silenced rung' : null,
    options.vod === undefined ? null : 'a recording to play back',
  ].filter((treatment): treatment is string => treatment !== null);

  if (asked.length > 1) {
    throw new Error(
      `this arm asks for ${asked.join(' and ')}. One treatment per arm: with two, a rung that moved or a ` +
        'picture that stopped could have done so because of either, and the run answers neither.',
    );
  }
  if (options.squeeze === true) {
    return 'browser:quality';
  }
  if (options.silenceSelectedRung === true) {
    return 'browser:rung-outage';
  }
  if (options.vod !== undefined) {
    return 'browser:vod';
  }
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
  const setup = browserArmHostSetup(cfg.browserRepoDir);
  const command = browserArmCommand({
    ...setup,
    script: browserArmScript(options),
    env: browserArmEnv(cfg, options),
  });

  // Before the arm, never after it. A container left behind by a crashed arm holds the image's single
  // Xvfb display, and every later arm then fails at startup looking like a broken browser.
  //
  await host
    .run(`docker rm -f ${quotedContainerName(setup.containerName)} > /dev/null 2>&1 || true`)
    .catch(() => undefined);

  const timeoutMs = options.watchMinutes * 60_000 + BROWSER_ARM_OVERHEAD_MS;
  const { stdout } = await host.run(command, timeoutMs);

  // Before anything below can throw. An arm whose artifact line is missing is exactly the arm whose
  // narration is worth reading, and printing it afterwards would print it never.
  reportArmNarration(stdout);

  // Quoted like everything else. This path is read out of the container's own output, so it is data
  // from the far side of the run rather than something the suite chose.
  const artifact = artifactReadPath(artifactJsonFromArmLog(stdout), setup.repoDir, host.isLocal);
  const state = await host.run(`cat ${shellQuoted(artifact)}`);
  return parseBrowserArmState(JSON.parse(state.stdout));
}
