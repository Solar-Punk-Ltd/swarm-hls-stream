/**
 * A browser arm's state file, in the shape `browser/watch.ts` actually writes, and the extra sections
 * `browser/crash.ts` adds on top of it.
 *
 * ⛔ Every field below is one the driver emits, and none of them is invented. `watch.ts` builds `run`
 * out of `summarize` (`SessionSummary`), `judgeRun` (`InstrumentVerdict`), `summarizeNetwork`
 * (`NetworkSummary`), the sampled `ViewerSample[]` and the byte-source arm, then `writeRunArtifacts`
 * puts it through `JSON.stringify`. A fixture carrying a field the driver never writes would let the
 * reader pass here and fail against the only file it will ever be handed in anger.
 *
 * ⭐ Trimmed rather than padded. The driver also writes `chromeVersion`, `screenshots`, `cost`,
 * `gateway`, `gatewaySamples`, `arm`, `instrumentProofs` and `latencyTarget`, which the reader does
 * not touch. Leaving them out is what shows it does not touch them: a reader that quietly needed one
 * would fail on this fixture rather than on a paid run.
 */

/** What a caller wants different about this run. Anything omitted is a clean weeb-3 watch. */
interface ArmStateOverrides {
  overallAdvanceRatio?: unknown;
  latency?: Record<string, unknown>;
  resolutions?: readonly (string | null)[];
  feedStatesSeen?: readonly string[] | undefined;
  byteSource?: Record<string, unknown> | null;
  instrument?: Record<string, unknown>;
  segmentRequests?: number | undefined;
  backend?: string;
  /**
   * The fault verdict `crash.ts` adds and `watch.ts` never writes. Null leaves it out, which is what
   * a plain watch looks like, and is why {@link armState} defaults it that way.
   */
  recovery?: Record<string, unknown> | null;
  /** The fault the run was, named the way `crash.ts` writes it. Null leaves the section out. */
  scenario?: string | null;
  /**
   * The quality verdict `browser/quality.ts` adds and no other driver writes. Null leaves it out,
   * which is what a plain watch and a crash arm both look like.
   */
  quality?: Record<string, unknown> | null;
  /**
   * The rung timeline `browser/rung-outage.ts` adds and no other driver writes, and the section
   * naming what it silenced. Null leaves both out.
   */
  rungs?: Record<string, unknown> | null;
  silenced?: Record<string, unknown> | null;
  /** The playback verdict `browser/vod.ts` adds and no other driver writes. Null leaves it out. */
  vod?: Record<string, unknown> | null;
  /** The squeeze section `browser/quality.ts` writes, naming the rung and why it could not be asked. */
  squeeze?: Record<string, unknown> | null;
}

const SAMPLE_COUNT = 240;

/**
 * One sampled second, carrying only what the reader looks at.
 *
 * The real `ViewerSample` has sixteen fields. The resolution is the one this reads, and a fixture
 * that restated the other fifteen would be a fixture about `readSample` rather than about the reader.
 */
const sampleWith = (resolution: string | null): Record<string, unknown> => ({ resolution });

export function armState(overrides: ArmStateOverrides = {}): unknown {
  const {
    overallAdvanceRatio = 0.999,
    latency = {},
    resolutions = ['1920x1080'],
    feedStatesSeen = ['live'],
    byteSource = {
      requested: overrides.backend ?? 'weeb3',
      reported: overrides.backend ?? 'weeb3',
      settledForMs: 60_000,
    },
    instrument = { sound: true, failures: [], firedChecks: [], soundSamples: SAMPLE_COUNT },
    segmentRequests = 6,
    recovery = null,
    scenario = null,
    quality = null,
    rungs = null,
    silenced = null,
    vod = null,
    squeeze = null,
  } = overrides;

  const run: Record<string, unknown> = {
    measuredAt: '2026-08-28T10:00:00.000Z',
    watchUrl: 'http://127.0.0.1:10074/watch/abc?qoe=1',
    gopSeconds: 0.5,
    summary: {
      samples: SAMPLE_COUNT,
      spanMs: 240_000,
      stalledSamples: 0,
      medianAdvanceRatio: 1,
      overallAdvanceRatio,
      forwardSeeks: 1,
      seekedPastS: 3.2,
      rebufferCount: 0,
      rebufferMs: 0,
      fatalErrors: 0,
      droppedFrames: 12,
      resolution: resolutions[resolutions.length - 1] ?? null,
      deliveredFps: 30,
      medianBufferAheadS: 2.4,
      feedStatesSeen,
      latency: {
        joinLatencyS: 2.11,
        medianLatencyS: 2.03,
        minLatencyS: 1.88,
        maxLatencyS: 2.4,
        reachedTargetAtJoin: true,
        heldTarget: true,
        joinedPastSeekThreshold: false,
        ranLong: false,
        ...latency,
      },
      latencyTarget: {
        configuredS: 2,
        worstS: 2,
        medianPastTargetS: 0.03,
        raisedByS: 0,
        stalls: 0,
        held: true,
      },
    },
    instrument,
    network: {
      spanMs: 240_000,
      segmentRequests,
      distinctSegments: 6,
      refusals: 0,
      refusalShare: 0,
      segmentsRefusedAtLeastOnce: 0,
      segmentsNeverServed: 0,
      medianTransferMs: 41,
      totalWaitedBetweenAttemptsMs: 0,
      segmentBytesPerSecond: 0,
      segmentBytesDelivered: 0,
      maxConcurrent: 1,
    },
    samples: resolutions.map(sampleWith),
  };

  if (byteSource !== null) {
    run.byteSource = byteSource;
  }
  if (recovery !== null) {
    run.recovery = recovery;
  }
  if (quality !== null) {
    run.quality = quality;
  }
  if (rungs !== null) {
    run.rungs = rungs;
  }
  if (silenced !== null) {
    run.silenced = silenced;
  }
  if (vod !== null) {
    run.vod = vod;
  }
  if (squeeze !== null) {
    run.squeeze = squeeze;
  }
  if (scenario !== null) {
    run.scenario = { name: scenario, service: 'bee-gateway', action: 'stop', downMs: 20_000 };
    run.fault = { injectedAtMs: 1_756_377_600_000, liftedAtMs: 1_756_377_620_500, servingAtMs: 1_756_377_627_700 };
  }
  // ⛔ Keyed on the override being PRESENT, not on its value. A destructuring default replaces an
  // explicit `undefined` with the default, so `{ feedStatesSeen: undefined }` would otherwise produce
  // the ordinary fixture and the stale-driver test would pass against a field that was there.
  // `JSON.stringify` drops an undefined field, so an absent one is what a caller is asking for.
  if ('feedStatesSeen' in overrides && overrides.feedStatesSeen === undefined) {
    delete (run.summary as Record<string, unknown>).feedStatesSeen;
  }
  if ('segmentRequests' in overrides && overrides.segmentRequests === undefined) {
    delete (run.network as Record<string, unknown>).segmentRequests;
  }

  return run;
}

/**
 * The recovery verdict `judgeRecovery` writes, holding the doc's own arm 1.
 *
 * The numbers are the 2026-08-27 in-tab gateway-outage arm as
 * `docs/bench/crash-at-an-in-tab-viewer-2026-08-27.md` records it, so a reader tested against this is
 * tested against a run that happened. Trimmed the same way the watch fixture is: `judgeRecovery` also
 * writes `before`, `during`, `after`, `latencyBeforeS`, `latencyAfterS` and `targetRaisedByS`, which
 * the reader does not touch.
 */
export const GATEWAY_OUTAGE_RECOVERY: Record<string, unknown> = {
  longestFreezeMs: 28_600,
  freezeStartedAfterFaultMs: 6_000,
  recoveredAfterLiftMs: 10_700,
  serviceStartupMs: 7_200,
  recovered: true,
  saidWhileFrozen: ['Reconnecting to the stream'],
  explainedTheFreeze: true,
};

/**
 * A crash arm's state file, which is a watch's plus the sections only `browser/crash.ts` writes.
 *
 * Defaults to the doc's arm 1: the gateway stopped under an in-tab viewer, who froze, was told why,
 * and came back. A caller overriding `recovery` states the whole verdict rather than a patch of one,
 * because a half-stated verdict is what the reader is supposed to refuse.
 */
export function crashArmState(overrides: ArmStateOverrides = {}): unknown {
  return armState({
    scenario: 'viewer-gateway-outage',
    recovery: GATEWAY_OUTAGE_RECOVERY,
    ...overrides,
  });
}

/** One stretch of a squeeze arm, in the shape `judgeQualitySwitch` writes it. */
function qualityPhase(rung: number | null, ratio: number, kbps: number | null): Record<string, unknown> {
  return {
    advance: { ratio, wallMs: 60_000, samples: 60 },
    lowestRungHeight: rung,
    tallestRungHeight: rung,
    endedOnRungHeight: rung,
    resolutions: rung === null ? [] : [`x${rung}`],
    bandwidthEstimateKbps: kbps,
  };
}

/**
 * The quality verdict of a viewer who came down when their link was capped and went back up after.
 *
 * The shape V2 asserts, against the ladder `DEFAULT_LADDER_SPEC` declares: 1080p before the cap,
 * 360p under a 1200 kbps cap, 1080p again once it lifted.
 */
export const STEPPED_DOWN_AND_BACK: Record<string, unknown> = {
  throttledToKbps: 1200,
  before: qualityPhase(1080, 1.0, 6_400),
  during: qualityPhase(360, 0.98, 1_050),
  after: qualityPhase(1080, 1.0, 6_100),
  switchesCounted: 2,
  abrEnabledThroughout: true,
  steppedDownAfterMs: 7_000,
  climbedBackAfterMs: 12_000,
};

/**
 * A squeeze arm's state file, which is a watch's plus the section only `browser/quality.ts` writes.
 *
 * A caller overriding `quality` states the whole verdict rather than a patch of one, for the same
 * reason `crashArmState` does: a half-stated verdict is what the reader is supposed to refuse.
 */
export function qualityArmState(overrides: ArmStateOverrides = {}): unknown {
  return armState({ quality: STEPPED_DOWN_AND_BACK, ...overrides });
}

/**
 * The rung timeline of a viewer who moved off a rung that stopped being produced, and kept watching.
 *
 * The shape V3 asserts: 720p before the outage, 480p while the 720p transcode was stopped, 720p again
 * once it resumed.
 */
export const MOVED_OFF_A_DEAD_RUNG: Record<string, unknown> = {
  before: qualityPhase(720, 1.0, 6_400),
  during: qualityPhase(480, 0.97, 6_200),
  after: qualityPhase(720, 1.0, 6_300),
  switchesCounted: 2,
  abrEnabledThroughout: true,
  steppedDownAfterMs: 9_000,
  climbedBackAfterMs: 14_000,
};

/**
 * A rung-outage arm's state file: a crash arm's freeze verdict plus the rung timeline only
 * `browser/rung-outage.ts` writes.
 *
 * ⛔ Carries BOTH `recovery` and `rungs`, because the suite asserts on both and either alone reads as
 * a success on its own.
 */
export function rungArmState(overrides: ArmStateOverrides = {}): unknown {
  return armState({
    scenario: 'rung-outage',
    recovery: GATEWAY_OUTAGE_RECOVERY,
    rungs: MOVED_OFF_A_DEAD_RUNG,
    silenced: { rung: '720p', height: 720, processes: [{ pid: 418, args: 'ffmpeg ... demo_720p?vhost=abr' }] },
    ...overrides,
  });
}

/** A recording that played whole: finite timeline, the full ladder, seekable to the end. */
export const PLAYED_THE_WHOLE_LADDER: Record<string, unknown> = {
  openError: null,
  durationS: 62.4,
  seekableToS: 62.4,
  ladderHeights: [1080, 720, 480, 360],
};

/** A playback arm's state file, which is a watch's plus the section only `browser/vod.ts` writes. */
export function vodArmState(overrides: ArmStateOverrides = {}): unknown {
  return armState({ vod: PLAYED_THE_WHOLE_LADDER, ...overrides });
}
