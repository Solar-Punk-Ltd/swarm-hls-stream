/**
 * Whether a deployment's log level can support what this harness reads.
 *
 * Every upload-side assertion in the suite is parsed out of the stream-uploader's own log, which
 * makes the deployment's `LOG_LEVEL` a silent precondition of the whole suite. It is not a
 * hypothetical one: `.env.sample` recommends `info` to drop the per-segment line for every live
 * stream, and at `info` the segment counter never advances, so each scenario spends its full
 * `waitFor` budget and then fails with a label that blames the publisher.
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
    what: 'per-segment upload lines ("Segment N uploaded")',
    level: 'log',
    emittedBy: { file: 'libs/StreamUploader.ts', fragment: 'uploaded: ${ref}' },
    neededBy: 'every scenario that counts segments or checks they are gapless',
  },
  {
    what: 'manifest publishes ("Manifest uploaded at SOC index N")',
    level: 'log',
    emittedBy: { file: 'libs/StreamUploader.ts', fragment: 'Manifest uploaded at SOC index' },
    neededBy: 'service/happy-path, which asserts the live manifest keeps advancing',
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
 * The level a deployment is really running at, given whatever `LOG_LEVEL` holds.
 *
 * Mirrors what `Logger` does with the value: unset falls back to the default, and a value that is
 * not a level is reported once and then ignored, which also lands on the default. Treating either
 * as a problem here would fail the guard on a deployment that prints everything the suite needs.
 */
export function effectiveLogLevel(raw: string | undefined): LogThreshold {
  return raw !== undefined && isLogThreshold(raw) ? raw : REQUIRED_LOG_LEVEL;
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
