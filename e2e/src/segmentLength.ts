/**
 * Whether the stack a run is pointed at cuts segments at the length that run's viewer needs.
 *
 * ⭐⭐⭐ **The two viewer types this project ships want opposite numbers, and that is a product trade
 * rather than a defect to reconcile.** Measured 2026-08-16 by the sibling repo
 * `swarm-stream-loadlab`, in `docs/measurements/2026-08-16-a-stock-tab-holds-realtime-on-two-second-segments.md`
 * and recorded as the open question Q23 in its `docs/spec/product-spec.md`:
 *
 *  - A stock weeb-3 tab, the in-tab node this project exists to measure, sustains **1.000x of
 *    realtime on 2s segments** holding about 90s of buffer, and **0.426x on 0.5s** holding 0.5 to
 *    3.5s. The mechanism is arithmetic, not tuning: weeb-3 admits about one segment per second
 *    whatever its peer count, so a 0.5s profile needs two admissions a second against a ceiling near
 *    one. Adding peers cannot help, because peers were never the constraint.
 *  - The **gateway** path measures the opposite optimum over 21 funded arms, 0.5s beating 2s on
 *    capture-to-fetchable latency at 1.55s against 3.88s.
 *
 * So a run has to name the number it needs, and the stack has to be producing it. Our own latbench
 * stage publishes 0.5s, and the `in-browser` profile has been running the byte source that cannot
 * sustain that: live in-tab readings sat at 0.35 to 0.68 of realtime with a 44ms buffer, which is the
 * 0.426x law and not a client fault.
 *
 * ## How our stage decides the number
 *
 * SRS publishes `segment = ceil(hls_fragment / GOP) * GOP`, force-closed at `hls_fragment *
 * hls_aof_ratio` whether a keyframe arrived or not. With the ladder on, `engines/srs/entrypoint.sh`
 * derives every rung's keyframe cadence from `HLS_FRAGMENT` itself, so the round-up is by one and the
 * fragment IS the segment. With the ladder off the cadence is whatever publishes, which for this
 * suite is `startPublisher`'s 2s GOP.
 *
 * The verdict lives here rather than in the preflight because nothing under `suites/` runs in CI.
 * This file is reached by `test/segmentLength.test.ts`, so the rules are covered by `pnpm verify` and
 * the preflight is left with the container read and a failure message.
 */

/** The word that waives the check, spelled once so the parser and the messages cannot drift apart. */
export const SEGMENT_ANY = 'any';

/**
 * What the operator said this run needs, out of `E2E_EXPECT_SEGMENT_S`.
 *
 * `'any'` is a declaration and not an absence: a run against a stage this cannot read is legitimate
 * and says so once, the way `E2E_EXPECT_ABR=false` does. `'undeclared'` is the gap the gate refuses.
 */
export type SegmentExpectation = number | typeof SEGMENT_ANY | 'undeclared';

/**
 * The refusal for a run that named no segment length, which is a run whose report cannot be read.
 *
 * A constant rather than a function because two gates raise it: the profile preflight, which settles
 * it with no network at all, and the segment preflight, which must not dial a stage it has no
 * yardstick for.
 */
export const SEGMENT_UNDECLARED_REFUSAL =
  'This run has not said how long a segment it needs, and the two viewer types want opposite ' +
  'numbers: measured 2026-08-16, an in-tab weeb-3 node holds 1.000x of realtime on 2s segments and ' +
  '0.426x on 0.5s, while the gateway measures the opposite optimum. A reading taken against the ' +
  'wrong one is a wrong number rather than a missing one, so say which run this is. ' +
  `E2E_EXPECT_SEGMENT_S=2 is what an in-tab viewer needs, 0.5 is what the gateway control needs, and ` +
  `E2E_EXPECT_SEGMENT_S=${SEGMENT_ANY} declares a run that does not pin one and is never asked again.`;

/** Whole seconds and fractional seconds, and nothing with a unit or an exponent stuck to it. */
const SECONDS_RE = /^[0-9]+(\.[0-9]+)?$/;

/**
 * `E2E_EXPECT_SEGMENT_S` as an expectation, refusing a spelling it does not know.
 *
 * ⛔ Matched against a pattern before it is parsed, deliberately. `Number.parseFloat` stops at the
 * first character it cannot use, so `2s` would read as 2 and `0x2` as 0. The second is the one that
 * matters: a zero-length declaration and an unparseable one would become the same value, and the
 * arithmetic downstream divides by it.
 */
export function readSegmentExpectation(raw: string): SegmentExpectation {
  const value = raw.trim();

  if (value === '') {
    return 'undeclared';
  }
  if (value === SEGMENT_ANY) {
    return SEGMENT_ANY;
  }
  if (!SECONDS_RE.test(value) || Number.parseFloat(value) <= 0) {
    throw new Error(
      `E2E_EXPECT_SEGMENT_S must be a positive number of seconds, the word ${SEGMENT_ANY}, or unset. ` +
        `Got '${raw}'.`,
    );
  }

  return Number.parseFloat(value);
}

/**
 * What a running SRS stage cuts a segment at, read out of the config it was actually started with.
 *
 * Never out of an env file. `entrypoint.sh` generates this config at container start and SRS is
 * exec'd on it, so it is what the process is running; an env file edited after the last deploy
 * describes an intention. `Host.containerEnv` already carries that rule for `LOG_LEVEL`, and this is
 * the same rule applied to the segmenter. It matters here because the bench host is shared: on
 * 2026-08-17 a co-tenant session changed `hls_fragment` to 2.0 on its own SRS stack and the only
 * reason anyone knew is that somebody ran `docker exec` by hand.
 */
export interface StageSegmenting {
  /** `hls_fragment`: the floor SRS looks for a keyframe at or after. */
  fragment: number;
  /** `hls_aof_ratio`: SRS force-closes at `fragment * aofRatio`, keyframe or not. */
  aofRatio: number;
  /** The keyframe cadence in seconds reaching the segmenter. */
  gopSeconds: number;
  /** Whether the cadence above is the stage's own, or whatever happens to publish into it. */
  transcodes: boolean;
}

/** Not exported: the shape is an argument, and exporting it would add a name nothing else needs. */
interface SegmentCheck {
  /** The run profile's name, so a refusal says which run it is refusing. */
  profile: string;
  /** Seconds per segment this run needs. Already past {@link readSegmentExpectation}. */
  needed: number;
  stage: StageSegmenting;
}

/** A whole or fractional number, and nothing an SRS config would not hold. */
const CONF_NUMBER = '([0-9]+(?:\\.[0-9]+)?)';

/**
 * Comparison slack. Near zero on purpose: this is arithmetic over two configured numbers, not a
 * measurement, so there is nothing to tolerate beyond the decimal parse itself.
 */
const EPSILON = 1e-9;

/**
 * What the stage publishes: `ceil(hls_fragment / GOP) * GOP`, which is SRS preferring to cut on the
 * first keyframe at or after the fragment.
 *
 * ⛔ Only inside the force-close range. Past `fragment * aofRatio` SRS cuts mid-GOP instead and this
 * number stops describing the stage, which is why {@link segmentLengthRefusal} checks the range
 * first rather than comparing lengths and reporting a difference that is not the fault.
 */
export function stageSegmentSeconds({ fragment, gopSeconds }: StageSegmenting): number {
  return Math.ceil(fragment / gopSeconds) * gopSeconds;
}

/**
 * Read a running SRS config into what it will cut at, refusing every way of learning nothing.
 *
 * `publisherGopSeconds` is used only where the stage transcodes nothing, because then the keyframe
 * cadence belongs to whatever publishes rather than to the deployment. Injected rather than imported
 * so the arithmetic here stays free of the harness.
 *
 * ⭐ The cadence comes off `force_key_frames` rather than off `g` and `vfps`. All three are written
 * by the same generator, and `entrypoint.sh` records which one decides: force_key_frames does the
 * real work, and g/keyint_min only stop x264 inserting extra keyframes in between. It is also
 * already in seconds, so nothing here divides by a frame rate it would then have to validate.
 */
export function parseStageSegmenting(conf: string, publisherGopSeconds: number): StageSegmenting {
  if (conf.trim() === '') {
    throw new Error('the running SRS config read back empty, and an unreadable stage is not a matching stage');
  }

  const fragment = onlyValue(
    conf,
    'hls_fragment',
    new RegExp(`^[ \\t]*hls_fragment[ \\t]+${CONF_NUMBER}[ \\t]*;`, 'gm'),
  );
  const aofRatio = onlyValue(
    conf,
    'hls_aof_ratio',
    new RegExp(`^[ \\t]*hls_aof_ratio[ \\t]+${CONF_NUMBER}[ \\t]*;`, 'gm'),
  );

  if (fragment === null || aofRatio === null) {
    const absent = [fragment === null ? 'hls_fragment' : '', aofRatio === null ? 'hls_aof_ratio' : ''].filter(Boolean);
    throw new Error(
      `${absent.join(' and ')} is not in the running SRS config, so what this stage cuts at cannot ` +
        'be worked out and nothing here can say it matches',
    );
  }
  if (fragment <= 0) {
    throw new Error(`the running SRS config has hls_fragment ${fragment}, which no segment arithmetic survives`);
  }

  const cadence = onlyValue(
    conf,
    'force_key_frames',
    new RegExp(`force_key_frames[ \\t]+expr:gte\\(t,n_forced\\*${CONF_NUMBER}\\)[ \\t]*;`, 'g'),
  );

  return {
    fragment,
    aofRatio,
    gopSeconds: cadence ?? publisherGopSeconds,
    transcodes: cadence !== null,
  };
}

/**
 * Why this stack cannot carry a run that needs `needed` seconds per segment, or `null`.
 *
 * ⛔⛔⛔ The run's declaration is the reference and the stage is the suspect, never the other way
 * round. Comparing the stage against its own prediction agrees with itself by construction, which is
 * how a neighbour's `hls_fragment 2.0` would pass the exact check written to catch it.
 */
export function segmentLengthRefusal({ profile, needed, stage }: SegmentCheck): string | null {
  const { fragment, aofRatio, gopSeconds } = stage;
  const produces = stageSegmentSeconds(stage);
  const ceiling = fragment * aofRatio;

  if (produces > ceiling + EPSILON) {
    return (
      `The stage this run points at cannot publish a whole GOP. hls_fragment ${fragment} against a ` +
      `${gopSeconds}s keyframe cadence wants ${produces.toFixed(3)}s segments, which is outside the ` +
      `[${fragment}, ${ceiling}] SRS can serve: it force-closes at hls_fragment * hls_aof_ratio ` +
      'whether a keyframe has arrived or not, so what actually lands is a mid-GOP cut and some of ' +
      'those segments carry no keyframe at all. Measured 2026-08-05, 281 of them could not be read. ' +
      `Raise HLS_AOF_RATIO until ${produces.toFixed(3)}s fits, or bring the cadence inside the range.`
    );
  }

  if (Math.abs(produces - needed) <= EPSILON) {
    return null;
  }

  return (
    `Run profile '${profile}' needs ${needed}s segments and this stack publishes ` +
    `${produces.toFixed(3)}s. ${stageStory(stage, produces)} ${remedy(stage, needed)} ` +
    'This is a wrong number rather than a missing one: the run would produce a complete, plausible ' +
    'reading of a viewer that was never going to behave as the report will say it did. Measured ' +
    '2026-08-16, an in-tab weeb-3 node holds 1.000x of realtime on 2s segments and 0.426x on 0.5s, ' +
    'while the gateway measures the opposite optimum, so the two profiles need opposite stages.'
  );
}

/** What the two halves of a stage were started with, as each container's own environment carries it. */
interface DatingCheck {
  /** The run profile's name, so a refusal says which run it is refusing. */
  profile: string;
  /** Seconds per segment this run needs. Already past {@link readSegmentExpectation}. */
  needed: number;
  /** `HLS_FRAGMENT` exactly as the uploader container carries it, or undefined where it carries none. */
  uploader: string | undefined;
  /** The same variable on the engine container, which is what its segmenter config was generated from. */
  engine: string | undefined;
}

/** `HLS_FRAGMENT` as a positive number of seconds, or null for absent and for anything unparseable. */
function fragmentSecondsOf(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!SECONDS_RE.test(value) || Number.parseFloat(value) <= 0) {
    return null;
  }
  return Number.parseFloat(value);
}

/** How the pair goes wrong, in the one sentence both directions share. */
const TWO_CLOCKS =
  'The uploader dates every segment by its own HLS_FRAGMENT, because #EXT-X-PROGRAM-DATE-TIME steps ' +
  'by that value from the broadcast start rather than by anything measured, while the engine cuts ' +
  'segments by its own. So the two disagreeing means the playlist says a segment covers one length ' +
  'of media and the media covers another, on a stage where every other instrument looks healthy.';

/**
 * Why this stage's uploader dates segments by the wrong length, or `null`.
 *
 * ⛔⛔⛔ The gap the ten gates could not see until 2026-09-04. `HLS_FRAGMENT` reaches two containers
 * from one variable, and nothing had ever held one against the other: the uploader ran with 1.0 while
 * SRS cut at 2.0, every gate passed, and the only thing that noticed was the ABR ladder suite's
 * timeline subtest, which found segments dated 1000ms after the one before them on a stage cutting
 * 2s fragments. That is a paid sitting to learn something two `docker inspect` reads answer for free.
 *
 * ⛔ Absence is a refusal rather than the uploader's own default. A container whose environment
 * carries no `HLS_FRAGMENT` dates by whatever that package compiled in, which is a number this
 * deployment never declared, and a gate may not pass a stage it could not read.
 *
 * ⛔ The run's declaration is the reference and both containers are suspects, the same way
 * {@link segmentLengthRefusal} treats the stage.
 */
export function uploaderDatingRefusal({ profile, needed, uploader, engine }: DatingCheck): string | null {
  const dated = fragmentSecondsOf(uploader);
  const cut = fragmentSecondsOf(engine);

  for (const [who, raw, seconds] of [
    ['uploader', uploader, dated],
    ['engine', engine, cut],
  ] as const) {
    if (seconds === null) {
      return (
        `The ${who} container of this stage declares HLS_FRAGMENT ` +
        `${raw === undefined ? 'not at all' : `as '${raw}'`}, so the length it works to is unknown, ` +
        `and this run needs ${needed}s segments. ${TWO_CLOCKS} Redeploy through ` +
        'deploy/scripts/deploy.sh, which supplies the variable to both containers from one value in ' +
        'the profile env, rather than reading an unset one as the default somebody happened to compile.'
      );
    }
  }

  if (dated !== null && cut !== null && Math.abs(dated - cut) > EPSILON) {
    return (
      `The uploader of this stage was started with HLS_FRAGMENT ${dated} and the engine with ` +
      `${cut}. ${TWO_CLOCKS} One of the two containers is running an older deploy: the variable is ` +
      'one value in the profile env and it reaches both, so a difference is a container that was ' +
      'never restarted on the current one. Redeploy the stale one.'
    );
  }

  if (dated !== null && Math.abs(dated - needed) > EPSILON) {
    return (
      `Run profile '${profile}' needs ${needed}s segments and both containers of this stage were ` +
      `started with HLS_FRAGMENT ${dated}. ${TWO_CLOCKS} Set HLS_FRAGMENT=${needed} in the profile ` +
      'env and redeploy the engine and the uploader together, because the pair has to agree whatever ' +
      'the number is.'
    );
  }

  return null;
}

/**
 * Why a run that named a length cannot be checked on this engine.
 *
 * The reader knows the config `engines/srs/entrypoint.sh` generates and nothing else. Passing an OME
 * run would be the gate reporting a check it never made, which is the shape of defect the whole
 * preflight tier exists to remove.
 */
export function unreadableEngineRefusal(engine: string, needed: number): string {
  return (
    `This run needs ${needed}s segments and this deployment runs ${engine}, whose segmenter config ` +
    'this gate cannot read. Passing it would file a check that never happened. Point the run at an ' +
    `SRS deployment, or set E2E_EXPECT_SEGMENT_S=${SEGMENT_ANY} to declare that this run does not ` +
    'pin a segment length, which is a declaration and is never asked again.'
  );
}

/** The arithmetic in one sentence, so the operator can check the gate rather than trust it. */
function stageStory({ fragment, aofRatio, gopSeconds, transcodes }: StageSegmenting, produces: number): string {
  const cadence = transcodes
    ? `the ladder's own force_key_frames puts a keyframe every ${gopSeconds}s`
    : `nothing on the stage transcodes, so the cadence is the suite publisher's ${gopSeconds}s GOP`;

  return (
    `The running SRS config has hls_fragment ${fragment} and hls_aof_ratio ${aofRatio}, and ` +
    `${cadence}, so SRS cuts at ceil(${fragment}/${gopSeconds})*${gopSeconds} = ${produces.toFixed(3)}s.`
  );
}

/** The one knob that moves the number, which is a different knob depending on what the stage does. */
function remedy({ transcodes }: StageSegmenting, needed: number): string {
  if (transcodes) {
    return (
      `Set HLS_FRAGMENT=${needed} and redeploy: with the ladder on, engines/srs/entrypoint.sh ` +
      'derives every rung GOP from it, so the round-up is by exactly one and the fragment IS the ' +
      'segment.'
    );
  }

  return (
    'A single-rendition stage takes its cadence from whatever publishes rather than from a ' +
    'deployment knob, so it can only ever cut at a multiple of the publisher GOP and HLS_FRAGMENT ' +
    'is a floor here. Turn ABR_ENABLED on, where the fragment sets the segment directly.'
  );
}

/**
 * The one value a directive holds, `null` when it holds none, and a throw when it holds two.
 *
 * ⛔⛔ Never the first match. A ladder makes `entrypoint.sh` generate a second vhost with its own
 * `hls` block, so "the first `hls_fragment` in the file" stopped meaning the stage's fragment and
 * started meaning whichever vhost happened to be written first. Both interpolate the same
 * `${HLS_FRAGMENT}` today, so identical values are the ordinary case and a disagreement means the
 * config did not come from our entrypoint. Which vhost a run publishes through is not visible from
 * here, so a rule for picking a winner would be a guess, and a gate that guesses is the failure.
 */
function onlyValue(conf: string, name: string, pattern: RegExp): number | null {
  const values = [...conf.matchAll(pattern)].map((match) => Number.parseFloat(match[1]));
  if (values.length === 0) {
    return null;
  }

  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new Error(
      `${name} has ${distinct.length} different values in the running SRS config ` +
        `(${distinct.join(', ')}). One fingerprint cannot describe two profiles, and picking ` +
        'whichever came first is how a run measures a stage nobody looked at.',
    );
  }

  return distinct[0];
}
