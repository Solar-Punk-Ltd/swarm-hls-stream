/**
 * Where the suite points, resolved the way a deploy resolves it.
 *
 * `deploy.sh` decides a deployment's compose project, host ports and engine from a profile name, a
 * port slot and a layered set of env files. This module reproduces that decision rather than asking
 * the operator to restate it: give it the same `--profile` and `--portSlot` the deploy was given
 * and it finds the same containers on the same ports. Only the things a deploy genuinely does not
 * know — how to reach the host, and which address a publisher should dial — come from `E2E_*` vars.
 *
 * Layering, most authoritative first: the process environment, then the root env file, then the
 * engine's. That is `load_env` before `load_engine_envs`, and the shell's "already set wins".
 */

import { assertUsablePublishKeySecret } from '@swarm-hls-stream/shared/publishKey';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type AbrExpectation, readAbrExpectation } from './abrCoverage.js';
import { type EnvBag, layerEnv, processEnv, readEnvFile } from './envFile.js';
import { type OmePortVar, type PortVar, requireValidPortSlot, resolveOmePort, resolvePort } from './ports.js';
import { applyRunProfile, type RunProfile } from './profiles.js';
import { readSegmentExpectation, type SegmentExpectation } from './segmentLength.js';
import { readViewerExpectation, type ViewerExpectation } from './viewerCoverage.js';

/** The repository root, three levels up from this file (`<root>/e2e/src/config.ts`). */
export const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The run profile, applied as this module is imported. Every suite and every driver imports it.
 *
 * ⛔⛔⛔ Applied HERE, at import, and deliberately not inside {@link loadConfig}. `browser/watch.ts`
 * reads `BROWSER_FETCH_BACKEND` at the top of `main()` and calls `loadConfig()` eleven lines later,
 * and `crash.ts` and `buffer-sweep.ts` do the same. A profile applied inside the call would be in
 * place too late for the one key that separates the two profiles, so the drivers would run on the
 * build's default while every report named the profile that was asked for. That is the shape this
 * repo has already paid for once, when those two drivers ignored `BROWSER_FETCH_BACKEND` entirely:
 * an unread variable looks exactly like a variable set to its default.
 *
 * Exported so a caller can print what the profile decided and what it stood down on. See
 * `describeRunProfile`. `test/runProfileWiring.test.ts` runs a real process to prove the ordering.
 */
export const runProfile: RunProfile = applyRunProfile();

export const MODES = ['attach', 'deploy'] as const;
export type Mode = (typeof MODES)[number];

export const ENGINES = ['srs', 'ome'] as const;
export type EngineName = (typeof ENGINES)[number];

/** `PROFILE`'s default in `_lib.sh`, and the compose project a deploy without `--profile` uses. */
export const DEFAULT_PROFILE = 'default';

/** Default HLS/ingest stream path per engine (OME apps must be `video` or `audio`, never `live`). */
const DEFAULT_STREAM_PATH: Record<EngineName, string> = {
  srs: 'live/stream',
  ome: 'video/stream',
};

/**
 * The ladder the uploader and the SRS entrypoint both fall back to when `ABR_LADDER` is empty, so the
 * suite reads the same four rungs a documented install actually runs. `.env.sample` ships `ABR_LADDER=`
 * blank on purpose, precisely because both sides carry this default, so a suite reading it as no rungs
 * disagrees with a live ladder. Mirrors `DEFAULT_LADDER_SPEC` in
 * `packages/stream-uploader/src/libs/AbrLadder.ts` and the `${ABR_LADDER:-…}` in
 * `engines/srs/entrypoint.sh`; keep the three in step.
 */
const DEFAULT_LADDER_SPEC = '1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700';

/**
 * The slot-aware host ports the suite talks to, under names that read at a call site. The mapping
 * to the deploy's own variable names is here and nowhere else, so there is one place to look when
 * `_lib.sh` gains a port.
 */
const PORT_SOURCES = {
  uploaderApi: 'API_PORT',
  srt: 'SRS_SRT_PORT',
  rtmp: 'SRS_RTMP_PORT',
  srsHttp: 'SRS_HTTP_PORT',
  client: 'CLIENT_PORT',
  beeUploaderApi: 'BEE_UPLOADER_API_PORT',
  beeGatewayApi: 'BEE_GATEWAY_API_PORT',
} as const satisfies Record<string, PortVar>;

export type Ports = Record<keyof typeof PORT_SOURCES, number>;

export interface E2EConfig {
  mode: Mode;
  /** Media engine the target runs; selects the SRT streamid form, log markers and `/health.engines`. */
  engine: EngineName;
  /** ssh target from ~/.ssh/config used for attach-mode transport and fault injection. */
  sshTarget: string;
  /** Public host or IP the SRT publisher and viewer reach from wherever the tests run. */
  publicHost: string;
  /** The deploy's `--profile`: the docker compose project, and so the container-name prefix. */
  profile: string;
  /** The deploy's `--portSlot`. 0 means no slot, and env values decide the ports. */
  portSlot: number;
  ports: Ports;
  /** HLS stream path in the SRT streamid (SRS `live/<name>`, OME `<video|audio>/<name>`). */
  streamPath: string;
  /** OME SRT ingest port. Read from the engine env, never slot-shifted. */
  omeSrtPort: number;
  /** OME HLS port the uploader's puller reads. Read from the engine env, never slot-shifted. */
  omeHlsPort: number;
  /** OME container for the engine-restart scenario. */
  omeContainer: string;
  /**
   * The deployment's `PUBLISH_KEY_SECRET`, or empty when publisher authentication is off. See SEC-28.
   *
   * Read from the deployment's own env rather than an `E2E_` var, because it is not a choice this
   * suite gets to make: the engine either demands a key or it does not, and a publisher that guesses
   * wrong is refused. Empty is the ordinary case, since `docker-compose.yml` defaults it empty.
   *
   * Every scenario here published without one until 2026-08-03, so against a deployment that had
   * turned SEC-28 on, all of them failed at the first admission and blamed the publisher.
   */
  publishKeySecret: string;
  /**
   * Whether the deployment transcodes an ABR ladder, and the rung names it was configured with.
   *
   * Read from the deployment's own env for the same reason as {@link publishKeySecret}: it is not a
   * choice this suite gets to make. The engine either produces four rungs or one, and an ABR suite
   * run against a single-rendition stack is not applicable rather than failing.
   *
   * `abrRungs` comes from `ABR_LADDER`, whose entries are `name:width:height:kbps`. Empty when the
   * deployment leaves it unset, in which case the engine falls back to its own default ladder and
   * this cannot name the rungs, so a suite asserting on specific names has to say so.
   */
  abrEnabled: boolean;
  /**
   * BEE_PUBLISHERS exactly as the deployment's env file has it, unparsed.
   *
   * Read rather than interpreted here: whether it is well formed is the uploader's to decide, and it
   * decides by refusing to start. What the suite needs is the shape the deployment *declares*, so it
   * can be held against the shape the uploader reports on `/health`. Empty is an unsplit deployment,
   * one Bee node carrying every rung. See `src/publisherRouting.ts`.
   */
  declaredPublishers: string;
  abrRungs: readonly string[];
  /**
   * Every resolution `ABR_LADDER` declares, as the client renders them: `1920×1080`, U+00D7.
   *
   * Separate from {@link abrRungs} because a rung NAME is what the uploader logs and a RESOLUTION is
   * what a browser reports, and no suite can join the two without this. Empty on a single-rendition
   * deployment, which is the signal to `ladderResolutionRefusal` that there is no ladder to be
   * outside of.
   */
  abrLadderResolutions: readonly string[];
  /**
   * Every rung `ABR_LADDER` declares, parsed whole: name, geometry and the bitrate it was cut at.
   *
   * ⛔ Its own parse rather than a shared one, because each of these three fields needs a DIFFERENT
   * part of an entry to be present and a shared strictness would change what the other two accept.
   * {@link abrRungs} needs only a name, {@link abrLadderResolutions} needs the two dimensions, and
   * this needs the bitrate as well, so an entry missing it is dropped here and kept there.
   *
   * ⭐ What the bitrate is for is deriving a bandwidth that makes the upper rungs unaffordable, so
   * `suites/viewer/quality-switch.test.ts` throttles against the ladder the deployment actually
   * declares rather than against a number somebody picked.
   */
  abrLadder: readonly LadderRung[];
  /**
   * What the operator declared this run is for, out of `E2E_EXPECT_ABR`.
   *
   * Separate from {@link abrEnabled} because they answer different questions. That one is what the
   * deployment does, which the suite only reads. This is what the run is claiming to cover, which is
   * the operator's to state, and `suites/preflight/abr-coverage.test.ts` refuses the run when the
   * two disagree.
   */
  abrExpectation: AbrExpectation;
  /**
   * What the operator declared about a real viewer, out of `E2E_EXPECT_BROWSER`.
   *
   * The same shape as {@link abrExpectation} and for the same reason. A viewer suite that skips
   * reaches no column in the run summary, so a run where nobody watched the broadcast is
   * indistinguishable from one where a real player did. `suites/preflight/viewer-coverage.test.ts`
   * refuses a run that never said which of the two it is.
   */
  viewerExpectation: ViewerExpectation;
  /**
   * How long a segment this run needs, out of `E2E_EXPECT_SEGMENT_S`.
   *
   * The same shape as {@link abrExpectation} and for the same reason, except that the two shipped
   * profiles declare DIFFERENT numbers on purpose: an in-tab weeb-3 node sustains realtime on 2s
   * segments and 0.426x on 0.5s, while the gateway measures the opposite optimum. See
   * `src/segmentLength.ts` for the measurement, and `suites/preflight/segment-length.test.ts` for
   * the gate that refuses a stack producing the other one.
   */
  segmentExpectation: SegmentExpectation;
  /**
   * Absolute path of the bench checkout ON THE HOST, out of `E2E_BROWSER_REPO_DIR`, or empty.
   *
   * A viewer arm bind-mounts it into the browser container as `/repo` and runs the harness from it,
   * and the suite cannot work the host path out for itself from inside that mount.
   *
   * ⛔ Read from the env files here, and it was not until 2026-08-31. Every consumer took it straight
   * off `process.env`, while `viewer-coverage`'s own refusal told the operator to put it in the
   * profile's env file "alongside E2E_SSH_TARGET". Following that advice exactly left the value
   * invisible and the refusal identical, so the gate's instructions could not clear the gate. Its two
   * neighbours were always read from these files, which is what made the advice look right.
   */
  browserRepoDir: string;
  /** Env files that were actually found and read, in precedence order. Printed by the smoke test. */
  envFiles: readonly string[];
}

/**
 * Container and compose-project charset, which is docker's own rule. These values are interpolated
 * into docker commands carried over ssh, so the charset is also what keeps them shell-safe.
 */
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * An ssh target is an argv element, not a shell word, so the risk here is not injection but option
 * confusion: a value starting with `-` is read by ssh as a flag of its own. Host, user@host and an
 * ~/.ssh/config alias all fit this, and a leading dash does not.
 */
const SSH_TARGET_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.@-]*$/;

/** Hostname, IPv4, or bracketed IPv6 — what can sit in the authority of an `srt://` URL. */
const PUBLIC_HOST_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_.-]+)$/;

/** `<app>/<name>`, the only shape either engine's ingest accepts. */
const STREAM_PATH_RE = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

/**
 * The two knobs that cannot come from an env file, because they choose which env file is read.
 *
 * `E2E_PROFILE` selects the root and engine files, so honouring it from inside one of them is
 * circular, and letting a file decide which file is trusted is a hole worth keeping shut. The port
 * slot rides along with it: the pair names one deployment and splitting where they may be set makes
 * a half-applied target, which is the worse failure.
 */
const PROCESS_ENV_ONLY = ['E2E_PROFILE', 'E2E_PORT_SLOT'] as const;

/**
 * Refuse an env file that sets one of them, rather than ignoring it.
 *
 * Ignoring is what this did first, and it was silent in the one direction that matters. The
 * neighbouring `E2E_SSH_TARGET` and `E2E_PUBLIC_HOST` ARE read from these files, so an operator who
 * puts all four in `.env` gets a suite that reaches the right host and then targets the wrong
 * deployment on it: `e2e:smoke` passes end to end, and `e2e:run` stops and kills the containers of
 * whatever is running under the default profile while the profile they named is never touched.
 */
function requireNotSetInFile(bag: EnvBag, path: string): void {
  const present = PROCESS_ENV_ONLY.filter((name) => name in bag);
  if (present.length > 0) {
    throw new Error(
      `${present.join(' and ')} cannot be set in ${path}, because ${PROCESS_ENV_ONLY[0]} is what ` +
        'chooses that file. Pass them in the environment instead, for example: ' +
        `${present.map((name) => `${name}=<value>`).join(' ')} pnpm e2e:smoke`,
    );
  }
}

function env(bag: EnvBag, name: string, fallback: string): string {
  const value = bag[name];
  return value === undefined || value === '' ? fallback : value;
}

function requireOneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new Error(`Invalid ${name} "${raw}"; expected one of: ${allowed.join(', ')}`);
}

function requireMatch(name: string, raw: string, pattern: RegExp, expected: string): string {
  if (!pattern.test(raw)) {
    throw new Error(`Invalid ${name} "${raw}"; expected ${expected}`);
  }
  return raw;
}

/**
 * Screened by the service's own rule rather than accepted as given, so a secret too short to have
 * been accepted by the deployment fails here instead of one admission later.
 *
 * The failure it prevents is the confusing one. A short secret makes `createOmeEngineFromEnv` throw
 * at startup, so the uploader is not running at all, and a suite that derived a key from it anyway
 * would report a publisher timeout on every scenario rather than a stack that never came up. The
 * value itself never appears in the message, here or in the shared helper.
 */
function requireUsableSecret(raw: string): string {
  if (raw !== '') {
    assertUsablePublishKeySecret(raw);
  }
  return raw;
}

/** Root env file for a profile: `.env` for the default profile, `.env.<profile>` otherwise. */
export function rootEnvPath(profile: string, rootDir: string = ROOT_DIR): string {
  return join(rootDir, profile === DEFAULT_PROFILE ? '.env' : `.env.${profile}`);
}

/** Engine env file for a profile. One file, not a layered pair — `engine_env_file` picks exactly one. */
export function engineEnvPath(engine: EngineName, profile: string, rootDir: string = ROOT_DIR): string {
  return join(rootDir, 'engines', engine, profile === DEFAULT_PROFILE ? '.env' : `.env.${profile}`);
}

export interface LoadOptions {
  /** Stands in for the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Repository root to resolve env files against. Overridden by tests so fixtures replace the real files. */
  rootDir?: string;
}

export function loadConfig({ env: source = process.env, rootDir = ROOT_DIR }: LoadOptions = {}): E2EConfig {
  const shell = processEnv(source);

  const mode = requireOneOf('E2E_MODE', env(shell, 'E2E_MODE', 'attach'), MODES);
  if (mode === 'deploy') {
    throw new Error(
      'E2E_MODE=deploy is not implemented — the suite only attaches. Deploy the stack yourself ' +
        '(deploy/scripts/deploy.sh), then point the suite at it with E2E_PROFILE / E2E_PORT_SLOT.',
    );
  }

  const profile = requireMatch(
    'E2E_PROFILE',
    env(shell, 'E2E_PROFILE', DEFAULT_PROFILE),
    DOCKER_NAME_RE,
    `a docker-safe compose project name (${DOCKER_NAME_RE.source})`,
  );
  const portSlot = requireValidPortSlot(env(shell, 'E2E_PORT_SLOT', '0'));

  // The root env has to be read before the engine is known, because the engine is one of its keys.
  // This is the order deploy.sh runs in for the same reason.
  const rootPath = rootEnvPath(profile, rootDir);
  const rootEnv = readEnvFile(rootPath);
  requireNotSetInFile(rootEnv, rootPath);
  const withRoot = layerEnv(shell, rootEnv);
  const engine = requireOneOf('E2E_ENGINE', env(withRoot, 'E2E_ENGINE', env(withRoot, 'ENGINE', 'srs')), ENGINES);

  const enginePath = engineEnvPath(engine, profile, rootDir);
  const engineEnv = readEnvFile(enginePath);
  requireNotSetInFile(engineEnv, enginePath);
  const resolved = layerEnv(withRoot, engineEnv);

  const ports = Object.fromEntries(
    Object.entries(PORT_SOURCES).map(([key, name]) => [key, resolvePort(name, portSlot, resolved)]),
  ) as Ports;

  return {
    mode,
    engine,
    sshTarget: requireMatch(
      'E2E_SSH_TARGET',
      env(resolved, 'E2E_SSH_TARGET', 'localhost'),
      SSH_TARGET_RE,
      'a host, user@host or ~/.ssh/config alias, and not a value starting with "-"',
    ),
    publicHost: requireMatch(
      'E2E_PUBLIC_HOST',
      env(resolved, 'E2E_PUBLIC_HOST', '127.0.0.1'),
      PUBLIC_HOST_RE,
      'a hostname, IPv4 address, or bracketed IPv6 address',
    ),
    profile,
    portSlot,
    ports,
    streamPath: requireMatch(
      'E2E_STREAM_PATH',
      env(resolved, 'E2E_STREAM_PATH', DEFAULT_STREAM_PATH[engine]),
      STREAM_PATH_RE,
      '<app>/<name>, e.g. live/stream for SRS or video/stream for OME',
    ),
    omeSrtPort: omePortWithOverride(resolved, 'E2E_OME_SRT_PORT', 'OME_SRT_PORT'),
    omeHlsPort: resolveOmePort('OME_HLS_PORT', resolved),
    omeContainer: requireMatch(
      'E2E_OME_CONTAINER',
      env(resolved, 'E2E_OME_CONTAINER', containerNameFor(profile, 'ome')),
      DOCKER_NAME_RE,
      `a docker-safe container name (${DOCKER_NAME_RE.source})`,
    ),
    publishKeySecret: requireUsableSecret(env(resolved, 'PUBLISH_KEY_SECRET', '')),
    abrEnabled: isEnabled(env(resolved, 'ABR_ENABLED', 'false')),
    declaredPublishers: env(resolved, 'BEE_PUBLISHERS', ''),
    abrRungs: ladderRungNames(env(resolved, 'ABR_LADDER', DEFAULT_LADDER_SPEC)),
    abrLadderResolutions: ladderResolutions(env(resolved, 'ABR_LADDER', DEFAULT_LADDER_SPEC)),
    abrLadder: ladderRungs(env(resolved, 'ABR_LADDER', DEFAULT_LADDER_SPEC)),
    abrExpectation: readAbrExpectation(env(resolved, 'E2E_EXPECT_ABR', '')),
    viewerExpectation: readViewerExpectation(env(resolved, 'E2E_EXPECT_BROWSER', '')),
    segmentExpectation: readSegmentExpectation(env(resolved, 'E2E_EXPECT_SEGMENT_S', '')),
    browserRepoDir: env(resolved, 'E2E_BROWSER_REPO_DIR', ''),
    envFiles: [rootPath, enginePath],
  };
}

/**
 * The spellings the uploader's own `optionalBool` accepts, and only those.
 *
 * Deliberately not a truthiness check. The uploader refuses to start on anything else, so reading a
 * typo as `false` here would have this suite disagree with the service about what the deployment is.
 */
function isEnabled(value: string): boolean {
  return value.trim() === 'true' || value.trim() === '1';
}

/**
 * Rung names out of `ABR_LADDER`, whose entries are `name:width:height:kbps` separated by spaces.
 *
 * Names only, because that is what the uploader logs and therefore what a suite can observe. The
 * geometry is the engine's business and asserting on it here would duplicate `AbrLadder.parse`.
 */
function ladderRungNames(spec: string): readonly string[] {
  return spec
    .split(/\s+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(':')[0])
    .filter((name) => name.length > 0);
}

/** One rung of `ABR_LADDER`, as the deployment declares it: `name:width:height:kbps`. */
export interface LadderRung {
  name: string;
  width: number;
  height: number;
  /** What the engine was told to cut this rung at, which is the bandwidth it needs to be deliverable. */
  kbps: number;
}

/**
 * Every rung of `ABR_LADDER` parsed whole, in the order the deployment declares them.
 *
 * An entry missing any of the four parts, or carrying a number that is not one, is dropped rather
 * than yielding a rung with a NaN bitrate. A NaN would propagate silently into any bandwidth derived
 * from it and produce a throttle nobody chose.
 */
function ladderRungs(spec: string): readonly LadderRung[] {
  return spec
    .split(/\s+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(':'))
    .filter((parts) => parts.length === 4 && parts.every((part) => part.length > 0))
    .map(([name, width, height, kbps]) => ({
      name,
      width: Number(width),
      height: Number(height),
      kbps: Number(kbps),
    }))
    .filter((rung) => [rung.width, rung.height, rung.kbps].every((value) => Number.isFinite(value) && value > 0));
}

/**
 * Resolutions out of `ABR_LADDER`, spelled the way a browser reports them.
 *
 * ⛔ The separator is U+00D7 and not the letter x, because `useHlsQoeMetrics` builds the string the
 * suites compare against as `${videoWidth}×${videoHeight}`. An expectation assembled with an ASCII x
 * matches nothing and passes every run.
 *
 * An entry missing either dimension is dropped rather than yielding a half-formed string, so a
 * malformed `ABR_LADDER` shrinks the expectation instead of inventing a resolution to demand.
 */
function ladderResolutions(spec: string): readonly string[] {
  return spec
    .split(/\s+/)
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(':'))
    .filter(([, width, height]) => Boolean(width) && Boolean(height))
    .map(([, width, height]) => `${width}\u00d7${height}`);
}

/**
 * `E2E_OME_SRT_PORT` exists for a standalone OME that no profile deployed
 * (`engines/ome/docker-compose.yml`), where the engine env file the deploy would have written does
 * not exist. Layering the override over the bag rather than reading it separately keeps one
 * validation path for both spellings.
 */
function omePortWithOverride(bag: EnvBag, override: string, name: OmePortVar): number {
  const explicit = bag[override];
  return explicit === undefined || explicit === ''
    ? resolveOmePort(name, bag)
    : resolveOmePort(name, { ...bag, [name]: explicit });
}

export const SERVICES = {
  srs: 'srs',
  ome: 'ome',
  streamUploader: 'stream-uploader',
  /**
   * The shared publisher, which on a split stage carries the coordinator rung and nothing else.
   *
   * ⛔ Do not read this as "the publisher". It was the only bee publisher this file named until
   * 2026-08-31, so a fault could reach no other, and `scenarios/bee-outage-long` stopped it while
   * asserting every rung had lost segments. See `BEE_SERVICE_BY_RUNG` in `harness/publishers.ts`.
   */
  beeUploader: 'bee-uploader',
  beeRung480p: 'bee-uploader-480p',
  beeRung720p: 'bee-uploader-720p',
  beeRung1080p: 'bee-uploader-1080p',
  beeGateway: 'bee-gateway',
  client: 'client',
} as const;

export type ServiceName = (typeof SERVICES)[keyof typeof SERVICES];

export function containerNameFor(profile: string, service: ServiceName): string {
  return `${profile}-${service}-1`;
}

/** docker compose's default container name for a service: `<project>-<service>-1`. */
export function containerName(cfg: E2EConfig, service: ServiceName): string {
  return containerNameFor(cfg.profile, service);
}
