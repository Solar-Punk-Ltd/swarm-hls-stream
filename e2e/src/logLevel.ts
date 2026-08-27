/**
 * Whether a deployment's log level can support what this harness reads.
 *
 * Every upload-side assertion in the suite is parsed out of the stream-uploader's own log, which
 * makes the deployment's `LOG_LEVEL` a silent precondition of the whole suite. It is not a
 * hypothetical one: `.env.sample` documents `info` as the level that drops the per-segment line for
 * every live stream, which is the reason an operator reaches for it. At `info` the segment counter
 * never advances, so each scenario spends its full `waitFor` budget and then fails with a label
 * that blames the publisher.
 *
 * The sample itself ships `LOG_LEVEL=debug`. An earlier version of this comment said the sample
 * "recommends" `info`, which overstated it and was corrected by the gate.
 *
 * The per-line levels below are a mirror of the uploader's own call sites, not an import: e2e must
 * not reach past a package boundary into another package's internals. `test/logLevel.test.ts` reads
 * those call sites out of the uploader source and fails if any of them moved, which is the same
 * mirror-and-prove arrangement `test/ports.test.ts` uses against `_lib.sh`.
 */

export const LOG_LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Every level, plus the threshold that admits nothing. Mirrors the uploader's `LogThreshold`. */
export const LOG_THRESHOLDS = [...LOG_LEVELS, 'silent'] as const;
export type LogThreshold = (typeof LOG_THRESHOLDS)[number];

/** A threshold admits a level at or above its own rank, which is the uploader's `admits` rule. */
function admits(threshold: LogThreshold, level: LogLevel): boolean {
  return LOG_THRESHOLDS.indexOf(level) >= LOG_THRESHOLDS.indexOf(threshold);
}

export function isLogThreshold(value: string): value is LogThreshold {
  return (LOG_THRESHOLDS as readonly string[]).includes(value);
}

/** One uploader log line the harness parses, the level that emits it, and what stops without it. */
export interface ParsedLine {
  /** What the line tells the harness, in the terms an operator reading a failure would use. */
  readonly what: string;
  /** The level the uploader emits it at. */
  readonly level: LogLevel;
  /** A distinctive fragment of the emitting call, used to locate it in the uploader source. */
  readonly emittedBy: { readonly file: string; readonly fragment: string };
  /** The parts of the suite that cannot work once it is dropped. */
  readonly neededBy: string;
}

/**
 * The uploader lines this harness depends on. Each entry names a real call site, so a level change
 * in the uploader shows up here as a failing unit test rather than as a timeout during a live run.
 */
export const PARSED_LINES: readonly ParsedLine[] = [
  {
    what: 'the catalog feed location (owner + topicHex)',
    level: 'debug',
    emittedBy: { file: 'libs/StreamCatalog.ts', fragment: 'owner=${ownerAddr} topicHex=' },
    neededBy: 'discoverCatalogFeed, so scenario F and service/catalog-via-gateway cannot start',
  },
  {
    what: 'per-segment upload lines ("Segment N of <stream> uploaded")',
    level: 'log',
    emittedBy: { file: 'libs/StreamUploader.ts', fragment: 'segmentUploaded(this.streamId, segmentIndex, ref)' },
    neededBy: 'every scenario that counts segments or checks they are gapless',
  },
  {
    what: 'manifest publishes ("Manifest uploaded at SOC index N")',
    level: 'log',
    emittedBy: { file: 'libs/StreamUploader.ts', fragment: 'Manifest uploaded at SOC index' },
    neededBy: 'service/happy-path, which asserts the live manifest keeps advancing',
  },
  {
    what: 'single-rendition VOD finalizes ("Updating stream in list to VOD")',
    level: 'log',
    emittedBy: { file: 'libs/StreamUploader.ts', fragment: 'updatingStreamToVod(JSON.stringify(entry))' },
    neededBy: 'every scenario that waits for a clean stop or a drain to finalize',
  },
  {
    what: 'ladder VOD finalizes ("Ladder <group> finalized to VOD")',
    level: 'log',
    emittedBy: { file: 'libs/StreamCatalog.ts', fragment: 'ladderFinalized(identity.group)' },
    neededBy: 'the same scenarios on an ABR deployment, where the single-rendition line never appears',
  },
  {
    what: 'catalog announcements ("Adding stream to list")',
    level: 'log',
    emittedBy: { file: 'libs/StreamUploader.ts', fragment: 'Adding stream to list:' },
    neededBy: 'announcedLiveTopics, which is how scenario F identifies its own stream',
  },
  {
    what: 'the SRS lifecycle marker ("[SRS] Stream published")',
    level: 'info',
    emittedBy: { file: 'engines/srs.ts', fragment: '[SRS] Stream published:' },
    neededBy: 'the scenarios that wait for a broadcaster session to begin or end',
  },
  {
    what: 'the OME lifecycle marker ("[OME] Stream opening")',
    level: 'info',
    emittedBy: { file: 'engines/ome.ts', fragment: '[OME] Stream opening:' },
    neededBy: 'the scenarios that wait for a broadcaster session to begin or end',
  },
  {
    what: 'upload retries ("Retrying in ~")',
    level: 'info',
    emittedBy: { file: 'utils/common.ts', fragment: 'Retrying in ~' },
    neededBy: 'the retry counter the bee-outage scenarios report',
  },
];

/** The quietest level that still emits every line above, and so the loudest the suite can require. */
export const REQUIRED_LOG_LEVEL: LogThreshold = 'debug';

/**
 * The uploader's own fallback for an unset or unrecognised `LOG_LEVEL`, mirrored from
 * `DEFAULT_LOG_LEVEL` in its `logLevels.ts`.
 *
 * Deliberately a separate constant from `REQUIRED_LOG_LEVEL` even though the two hold the same
 * value today. Folding them together is what let the uploader's default move without any test
 * noticing: `effectiveLogLevel(undefined)` was asserted against the same constant the
 * implementation returned, so both sides moved together and the assertion could never fail.
 * `test/logLevel.test.ts` now reads the uploader's value out of its source and compares.
 */
export const DEFAULT_LOG_LEVEL: LogThreshold = 'debug';

/**
 * The level a deployment is really running at, given whatever `LOG_LEVEL` holds.
 *
 * Mirrors what `Logger` does with the value, **including the normalisation**, which is the part
 * this originally got wrong. `loggerOptionsFromEnv` does `requested.trim().toLowerCase()` before it
 * tests the value, so `INFO` is a level to the uploader and only a genuinely unrecognisable value
 * falls back to the default. Comparing the raw string instead sent every differently-cased spelling
 * down the fallback and onto `debug`, which is the one answer that makes `logLevelProblem` return
 * null. `LOG_LEVEL=SILENT` was the worst of them: the uploader printed nothing at all and the guard
 * reported the deployment readable.
 *
 * Unset and unrecognised still land on the default, because that is what the uploader does with
 * them, and treating either as a problem would fail the guard on a deployment that prints
 * everything the suite needs.
 */
export function effectiveLogLevel(raw: string | undefined): LogThreshold {
  if (raw === undefined) {
    return DEFAULT_LOG_LEVEL;
  }
  const normalized = raw.trim().toLowerCase();
  return isLogThreshold(normalized) ? normalized : DEFAULT_LOG_LEVEL;
}

/** The lines a deployment at `threshold` does not print, in the order they appear above. */
export function droppedParsedLines(threshold: LogThreshold): readonly ParsedLine[] {
  return PARSED_LINES.filter((line) => !admits(threshold, line.level));
}

/**
 * An operator-facing explanation of why the suite cannot read this deployment, or null when it can.
 *
 * Returned rather than thrown so the caller decides whether a level is fatal here (the smoke test)
 * or merely worth printing. The message names the level and the affected tests, because the failure
 * this replaces was a 90 second timeout whose label pointed at ffmpeg.
 */
export function logLevelProblem(threshold: LogThreshold): string | null {
  const dropped = droppedParsedLines(threshold);
  if (dropped.length === 0) {
    return null;
  }
  const detail = dropped.map((line) => `  - ${line.what} (${line.level}) — ${line.neededBy}`).join('\n');
  return (
    `The deployment runs at LOG_LEVEL=${threshold}, which drops ${dropped.length} of the ` +
    `${PARSED_LINES.length} uploader log lines this suite reads:\n${detail}\n` +
    `Redeploy with LOG_LEVEL=${REQUIRED_LOG_LEVEL} before running the suite. Left as is, the ` +
    `affected tests do not fail fast — they wait out their full timeout and then blame the publisher.`
  );
}
