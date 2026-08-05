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
}

/**
 * Decide whether a reading came from a browser that was not degrading its own subject.
 *
 * Pure, and separate from the code that collects the reading, so the rule can be tested against the
 * exact numbers the 2026-08-03 attempt produced rather than against a browser that has to be
 * persuaded into that state.
 */
export function judgeInstrument(reading: InstrumentReading): InstrumentVerdict {
  const failures: string[] = [];

  if (reading.visibilityState !== 'visible') {
    failures.push(
      `the page reported visibilityState '${reading.visibilityState}', so Chromium is entitled to pause ` +
        `muted video and throttle the timers hls.js loads from`,
    );
  }

  if (reading.timerDriftRatio > TIMER_DRIFT_LIMIT) {
    failures.push(
      `a ${TIMER_PROBE_INTERVAL_MS}ms timer fired ${reading.timerDriftRatio.toFixed(1)}x late, over the ` +
        `${TIMER_DRIFT_LIMIT}x limit, so the loader hls.js drives from timers was not running at its configured rate`,
    );
  }

  const missing = REQUIRED_CODECS.filter((codec) => !reading.codecSupport[codec]);
  if (missing.length > 0) {
    failures.push(
      `the browser cannot decode ${missing.join(
        ' or ',
      )}, so an empty picture here would be the build and not the stream`,
    );
  }

  return { sound: failures.length === 0, failures };
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
  return { sound: readings.length > 0 && failures.length === 0, failures, soundSamples };
}
