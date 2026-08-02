/**
 * Parses the stream-uploader's own log lines into structured events. These lines are the most
 * direct truth of what the uploader did — which segments landed, whether a discontinuity was
 * armed, how many manifest publishes/retries occurred — and are the primary assertion source for
 * the upload-side scenarios (bee outage, crash recovery).
 *
 * The uploader emits either `[ts] [LEVEL] - message` or, under `LOG_FORMAT=json`, one
 * `{"ts","level","msg"}` object per line. Every line is reduced to its message first, so which one
 * a deployment chose does not reach the patterns below.
 *
 * Only one pattern needs that today, and the tests say so rather than implying more: reverting the
 * unwrap in `announcedLiveTopics` fails a test, reverting it in `parseUploaderLog` fails none.
 * A JSON line escapes the quotes of the catalog entry embedded in it, so that function parsed
 * nothing and returned nothing, and the scenario depending on it blamed the uploader for never
 * announcing a stream. The others are plain substrings with no quotes or backslashes in them, so
 * escaping cannot disturb them and normalizing is currently a no-op for those.
 *
 * It is still applied in both places. The alternative is one function that normalizes and one that
 * does not, which holds only while no pattern ever contains a quote — and the day one does, the
 * failure is another silent empty result rather than an error.
 */

export interface UploaderEvents {
  uploadedSegments: number[];
  /**
   * How many discontinuities were armed, by any of the three paths.
   *
   * A count rather than a list of indices, because two of the three paths name no segment. The
   * scenarios that care read `.length`, and the one that wants an index reads
   * `discontinuitySegments`.
   */
  discontinuitiesArmed: number;
  /** Segment indices from the upload-failure path, the only one that reports an index. */
  discontinuitySegments: number[];
  manifestSocIndices: number[];
  staleWarnings: number;
  retries: number;
}

const RE_UPLOADED = /Segment (\d+) uploaded/g;
/**
 * All three ways the uploader arms a discontinuity, not just the upload failure.
 *
 * `StreamUploader` sets `pendingDiscontinuity` from three call sites, each with its own message:
 * the retry window being spent (`Failed to upload segment N …`), `handleSegmentLoss`
 * (`… never reached the uploader, marking a discontinuity`), and `markDiscontinuity`
 * (`Origin declared a discontinuity …, marking the next segment`). Only the first carries a segment
 * index, which is why this counts occurrences rather than capturing one.
 *
 * Anchoring on the upload failure alone matched one of the three. Both misses are OME-only, and the
 * `markDiscontinuity` one is the dangerous shape: the segment carrying the marker IS accepted and
 * uploaded, so it leaves no hole in the indices and `isContiguous` is not a backstop either. Four
 * scenarios assert `discontinuitiesArmed.length === 0` in the general wording "must not arm a
 * discontinuity", and on OME none of them could observe two of the three ways one gets armed.
 */
const RE_DISCONTINUITY = /marking a discontinuity|marking the next segment/g;

/** The upload-failure path is the only one naming a segment, and scenario B asserts on that index. */
const RE_DISCONTINUITY_SEGMENT = /Failed to upload segment (\d+)[^\n]*marking a discontinuity/g;
const RE_MANIFEST = /Manifest uploaded at SOC index (\d+)/g;
const RE_STALE = /is stale: \d+ consecutive/g;
const RE_RETRY = /Retrying in ~/g;
const RE_STREAM_ANNOUNCE = /Adding stream to list: (\{[^\n]*\})/g;

/** One line of `LOG_FORMAT=json` output, as `Logger` writes it. */
interface StructuredLogLine {
  ts: string;
  level: string;
  msg: string;
}

function isStructuredLogLine(value: unknown): value is StructuredLogLine {
  const line = value as Partial<StructuredLogLine> | null;
  return (
    typeof line === 'object' &&
    line !== null &&
    typeof line.ts === 'string' &&
    typeof line.level === 'string' &&
    typeof line.msg === 'string'
  );
}

/**
 * A line's message, whichever format produced it.
 *
 * Only a line that is itself a log object is unwrapped. A text-format line merely *containing* JSON
 * — which the catalog announcement is — has to be left alone, or its payload would be mistaken for
 * the envelope and discarded.
 */
function messageOf(line: string): string {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('{')) {
    return line;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isStructuredLogLine(parsed) ? parsed.msg : line;
  } catch {
    // Not an envelope, so it is content. A truncated line is normal in a `docker logs` tail.
    return line;
  }
}

/** Reduce a `docker logs` dump to one message per line, so the patterns never see an envelope. */
export function messageText(text: string): string {
  return text.split('\n').map(messageOf).join('\n');
}

function captureNumbers(source: string, re: RegExp): number[] {
  return [...source.matchAll(re)].map((m) => Number(m[1]));
}

function countMatches(source: string, re: RegExp): number {
  return [...source.matchAll(re)].length;
}

export function parseUploaderLog(text: string): UploaderEvents {
  const messages = messageText(text);
  return {
    uploadedSegments: captureNumbers(messages, RE_UPLOADED),
    discontinuitiesArmed: countMatches(messages, RE_DISCONTINUITY),
    discontinuitySegments: captureNumbers(messages, RE_DISCONTINUITY_SEGMENT),
    manifestSocIndices: captureNumbers(messages, RE_MANIFEST),
    staleWarnings: countMatches(messages, RE_STALE),
    retries: countMatches(messages, RE_RETRY),
  };
}

/**
 * Topics the uploader announced as `live` in its own `Adding stream to list:` log lines, in order.
 * This is the authoritative, lag-free source of the stream's topic — unlike the gateway-served
 * catalog, which trails the uploader by minutes and can surface a stale topic from a prior stream.
 */
export function announcedLiveTopics(text: string): string[] {
  const topics: string[] = [];
  for (const match of messageText(text).matchAll(RE_STREAM_ANNOUNCE)) {
    try {
      const entry = JSON.parse(match[1]) as { topic?: string; state?: string };
      if (entry.state === 'live' && entry.topic) {
        topics.push(entry.topic);
      }
    } catch {
      // A log line whose JSON tail is truncated is not a usable announcement — skip it.
    }
  }
  return topics;
}

/** True if the sorted unique indices form a gapless run (max − min + 1 === unique count). */
export function isContiguous(indices: number[]): boolean {
  if (indices.length === 0) {
    return true;
  }
  const unique = [...new Set(indices)].sort((a, b) => a - b);
  return unique[unique.length - 1] - unique[0] + 1 === unique.length;
}

/** Indices present in `after` but not in `before` — used to scope assertions to one test window. */
export function newIndices(before: number[], after: number[]): number[] {
  const seen = new Set(before);
  return after.filter((i) => !seen.has(i));
}
