/**
 * Whether the browser doing the watching is fit to be watched through.
 *
 * ## Why this module exists before any of the measuring ones
 *
 * The first attempt at browser validation, on 2026-08-03, produced a player sitting 578 seconds
 * behind live. That was not a bad result for the deployment, it was not a result about the
 * deployment at all: the automated pane reported `visibilityState: hidden` permanently, and Chromium
 * responds to a hidden page by pausing muted video outright and, once playback stalls for any
 * reason, throttling timers to roughly one per minute. hls.js drives playlist reloads and fragment
 * loading from those timers, so the first stall starves the loader and guarantees the next one. The
 * number that came out described the harness.
 *
 * So the harness has to be able to say **void** rather than say a number. Everything here exists to
 * make that verdict available and cheap.
 *
 * ## Why the check repeats instead of running once at startup
 *
 * The throttling is not a property of the page at load, it is a consequence of the first stall. A
 * preflight would have passed on 2026-08-03 and every reading after it would still have been
 * garbage. {@link judgeInstrument} therefore runs against every sample, and a run is sound only if
 * every one of its samples was.
 */

/**
 * The requested interval for the timer-fidelity probe.
 *
 * Short enough that a sample is not mostly waiting for it, long enough that ordinary scheduling
 * jitter does not read as throttling.
 */
export const TIMER_PROBE_INTERVAL_MS = 100;

/**
 * How much later than requested a timer may fire before the reading is void.
 *
 * Background throttling in Chromium takes a 100ms timer to about a minute, which is a ratio of ~600,
 * so this is nowhere near the failure it screens for. It is set at the loose end on purpose: the
 * question is "were timers running", not "was the machine quiet", and a busy encoder shares this
 * host by design.
 */
export const TIMER_DRIFT_LIMIT = 3;

/**
 * The codecs a viewer needs the browser to decode, and the reason the image cannot be stock
 * Chromium.
 *
 * Playwright's bundled Chromium is the open-source build, which ships without the proprietary
 * codecs. It renders the page, runs hls.js, fetches every segment from Swarm and then decodes none
 * of them, so the failure arrives as an empty picture and a stalled player rather than as an error
 * about codecs, which is indistinguishable at a glance from the delivery problem this harness exists
 * to look for. The image installs real Chrome for this reason, and this constant is what proves it
 * took.
 */
export const REQUIRED_CODECS = ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="mp4a.40.2"'] as const;

export interface InstrumentReading {
  /** `document.visibilityState`. Anything but `visible` means Chromium is free to degrade playback. */
  visibilityState: string;
  /** Observed firing interval of a {@link TIMER_PROBE_INTERVAL_MS} timer, divided by the request. */
  timerDriftRatio: number;
  /** Which of {@link REQUIRED_CODECS} `MediaSource.isTypeSupported` accepted. */
  codecSupport: Readonly<Record<string, boolean>>;
}

export interface InstrumentVerdict {
  sound: boolean;
  /** One sentence per failure, in the words the report prints. Empty when sound. */
  failures: string[];
  /**
   * The names of the checks that tripped.
   *
   * Carried alongside the prose so a falsifiability proof can show it fired for the reason it claims
   * rather than for some other one. A visibility proof that passes because the timer happened to
   * stutter has proven nothing about visibility, and without this that would be invisible.
   */
  firedChecks: string[];
}

/** The sensors {@link judgeInstrument} reads, each of which needs its own falsifiability proof. */
export const PROVEN_SENSORS = ['visibilityState', 'timerDriftRatio'] as const;
export type ProvenSensor = (typeof PROVEN_SENSORS)[number];

/**
 * Evidence that the sensor can report a failure at all, taken from a page that is not the subject.
 *
 * ## Why a guard needs this and the rest of the file does not
 *
 * {@link judgeInstrument} is a pure function and its rule is tested directly, against the numbers the
 * 2026-08-03 attempt produced. What has never been tested is the other half: whether the **collection**
 * path can ever hand it a failing reading. Under Playwright it largely cannot. playwright-core passes
 * `--disable-background-timer-throttling` and two siblings from its own default argument list, and
 * sends `Emulation.setFocusEmulationEnabled({enabled: true})` on every main frame, so a genuinely
 * hidden page still reports `visible` with punctual timers. Both checks then pass for reasons that
 * have nothing to do with the run being sound.
 *
 * ⛔ **A guard that cannot fail is not evidence.** So the harness degrades a throwaway page on purpose
 * and requires the instrument to notice. If it does not, the run does not get to call itself sound; it
 * reports that its own soundness is unproven, which is a different and honest thing.
 *
 * The degraded page is separate from the one being measured, in the same browser and context, so the
 * proof carries to the real page without disturbing what it is watching.
 */
export interface InstrumentProof {
  /**
   * The sensor this proof is about.
   *
   * Named so a missing proof can be reported by name. Proving the timer sensor says nothing about the
   * visibility sensor, and a single unnamed proof would let one stand in for both.
   */
  sensor: ProvenSensor;
  /** What was done to the throwaway page, in the words the report prints. */
  degradation: string;
  /** Whether {@link judgeInstrument} rejected the reading taken while the degradation was in force. */
  rejected: boolean;
  /** Which checks fired, so a proof that works for the wrong reason is visible rather than implied. */
  firedChecks: string[];
}

/**
 * Decide whether a reading came from a browser that was not degrading its own subject.
 *
 * Pure, and separate from the code that collects the reading, so the rule can be tested against the
 * exact numbers the 2026-08-03 attempt produced rather than against a browser that has to be
 * persuaded into that state.
 */
interface Check {
  name: string;
  trips: (reading: InstrumentReading) => boolean;
  say: (reading: InstrumentReading) => string;
}

/**
 * Held as a table rather than a run of `if` blocks so that the name of a check and the condition that
 * trips it cannot drift apart. A proof reports which check fired, and deriving that separately from
 * the judgement would be two copies of the same rule.
 */
const CHECKS: readonly Check[] = [
  {
    name: 'visibilityState',
    trips: (reading) => reading.visibilityState !== 'visible',
    say: (reading) =>
      `the page reported visibilityState '${reading.visibilityState}', so Chromium is entitled to pause ` +
      `muted video and throttle the timers hls.js loads from`,
  },
  {
    name: 'timerDriftRatio',
    trips: (reading) => reading.timerDriftRatio > TIMER_DRIFT_LIMIT,
    say: (reading) =>
      `a ${TIMER_PROBE_INTERVAL_MS}ms timer fired ${reading.timerDriftRatio.toFixed(1)}x late, over the ` +
      `${TIMER_DRIFT_LIMIT}x limit, so the loader hls.js drives from timers was not running at its configured rate`,
  },
  {
    name: 'codecSupport',
    trips: (reading) => missingCodecs(reading).length > 0,
    say: (reading) =>
      `the browser cannot decode ${missingCodecs(reading).join(
        ' or ',
      )}, so an empty picture here would be the build and not the stream`,
  },
];

function missingCodecs(reading: InstrumentReading): string[] {
  return REQUIRED_CODECS.filter((codec) => !reading.codecSupport[codec]);
}

export function judgeInstrument(reading: InstrumentReading): InstrumentVerdict {
  const tripped = CHECKS.filter((check) => check.trips(reading));
  return {
    sound: tripped.length === 0,
    failures: tripped.map((check) => check.say(reading)),
    firedChecks: tripped.map((check) => check.name),
  };
}

/**
 * The verdict over a whole run: sound only if every sample was.
 *
 * A run that was sound for its first minute and throttled for its last four is not partially valid.
 * The samples taken while it was sound are still readable, which is why the count comes back, but
 * the run does not get to report a median.
 */
export function judgeRun(readings: readonly InstrumentReading[]): InstrumentVerdict & { soundSamples: number } {
  const verdicts = readings.map(judgeInstrument);
  const soundSamples = verdicts.filter((verdict) => verdict.sound).length;
  // Deduplicated because a throttled run repeats one sentence once per sample, and forty copies of
  // it in a report is noise around the one fact.
  const failures = [...new Set(verdicts.flatMap((verdict) => verdict.failures))];
  const firedChecks = [...new Set(verdicts.flatMap((verdict) => verdict.firedChecks))];
  return { sound: readings.length > 0 && failures.length === 0, failures, firedChecks, soundSamples };
}

/**
 * What the report says about a run's guard, given the proof taken alongside it.
 *
 * Deliberately not folded into {@link judgeRun}. That function judges readings and nothing else, and a
 * run whose samples were all sound really did have sound samples: the proof answers the separate
 * question of whether "sound" was capable of coming out any other way. Keeping them apart is what
 * stops a failed proof from being read as a degraded viewer.
 */
export function describeProofs(proofs: readonly InstrumentProof[] | undefined): string[] {
  if (!proofs || proofs.length === 0) {
    return ["no falsifiability proof was taken, so this run's soundness verdict is untested"];
  }

  return PROVEN_SENSORS.flatMap((sensor) => {
    const proof = proofs.find((candidate) => candidate.sensor === sensor);
    if (!proof) {
      return [`the ${sensor} check was never shown able to fail, so a "sound" verdict from it is untested`];
    }
    if (!proof.rejected) {
      return [
        `the instrument did not reject a page with ${proof.degradation}, so its ${sensor} check cannot ` +
          'fail here and every "sound" verdict below is a restatement of the launch flags rather than evidence',
      ];
    }
    // A proof that fired only because some other check tripped has demonstrated that other check.
    if (!proof.firedChecks.includes(sensor)) {
      return [
        `the reading taken with ${proof.degradation} was rejected, but by ${
          proof.firedChecks.join(' and ') || 'no named check'
        } rather than by ${sensor}, so ${sensor} is still untested`,
      ];
    }
    return [];
  });
}
