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

import { publishingRenditionPattern } from '@swarm-hls-stream/shared';

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
  /**
   * Segment indices the uploader found to hold **no video packets at all**, from its own duration
   * warning. Empty on any ordinary broadcast.
   *
   * ⛔ This is not a cosmetic complaint about a duration. A recording whose opening segments carry
   * only audio plays as sound over a blank picture **for its whole length**, because the player fixes
   * its codec set from the first fragment it parses and never revises it. Measured 2026-08-09: four
   * opening segments with 0 video packets and 41 AAC packets, and every later video sample refused
   * with a non-fatal warning. See task #40.
   *
   * ⚠️ The uploader reports this **once per stream**, so this names the first one and not all of them.
   * Presence is the signal; the length is not a rate.
   */
  videolessSegments: number[];
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
/**
 * The uploader's own words for a segment carrying no video, from `measureSegmentDuration`'s
 * fallback. Anchored on the reason and not on the warning, because the same warning also fires for a
 * segment whose timestamps are unusable, which is a different fault with a different consequence.
 */
const RE_VIDEOLESS_SEGMENT = /Cannot read how much media segment (\d+) of [^\n]*holds no video packets/g;

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

/** A log line with the instant it was written, for readers that measure rather than count. */
export interface TimestampedMessage {
  /** Epoch milliseconds from the line's own timestamp, which is the **uploader host's** clock. */
  atMs: number;
  message: string;
}

/** `[2026-08-02T19:38:06.123Z] [LOG] - message`, the text format `formatLine` writes. */
const RE_TEXT_LINE = /^\[([^\]]+)\] \[[A-Z]+\] - (.*)$/;

/**
 * Log lines paired with when they were written, for the bench: counting events answers what happened
 * and measuring latency needs when.
 *
 * Lines carrying no timestamp of their own are dropped rather than guessed at. That covers the
 * continuation lines of a multi-line error and anything a container writes outside the logger, and it
 * is safe for the patterns that read this because every one of them is written by a single
 * `logger.*` call on one line.
 */
export function timestampedMessages(text: string): TimestampedMessage[] {
  const stamped: TimestampedMessage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isStructuredLogLine(parsed)) {
          pushIfDated(stamped, parsed.ts, parsed.msg);
        }
      } catch {
        // A truncated line in a `docker logs` tail, same as `messageOf` treats it.
      }
      continue;
    }
    const match = RE_TEXT_LINE.exec(line);
    if (match) {
      pushIfDated(stamped, match[1], match[2]);
    }
  }
  return stamped;
}

function pushIfDated(into: TimestampedMessage[], ts: string, message: string): void {
  const atMs = Date.parse(ts);
  if (Number.isFinite(atMs)) {
    into.push({ atMs, message });
  }
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
    videolessSegments: captureNumbers(messages, RE_VIDEOLESS_SEGMENT),
  };
}

/** Where a stream's feed lives: the signer's address, and the raw topic it has yet to be hashed from. */
export interface AnnouncedStream {
  topic: string;
  owner: string;
}

/**
 * Every `live` announcement in the log, as parsed, with whatever fields the entry carried.
 *
 * Deliberately does not require both fields. The two readers below want different amounts of the
 * entry, and tightening the shared parse to what the stricter one needs would quietly shorten the
 * other's answer: `announcedLiveTopics` returning fewer topics does not fail, it makes a scenario
 * wait out its timeout and blame the publisher.
 */
function announcedLiveEntries(text: string): Partial<AnnouncedStream>[] {
  const entries: Partial<AnnouncedStream>[] = [];
  for (const match of messageText(text).matchAll(RE_STREAM_ANNOUNCE)) {
    try {
      const entry = JSON.parse(match[1]) as Partial<AnnouncedStream> & { state?: string };
      if (entry.state === 'live') {
        entries.push(entry);
      }
    } catch {
      // A log line whose JSON tail is truncated is not a usable announcement — skip it.
    }
  }
  return entries;
}

/**
 * Topics the uploader announced as `live` in its own `Adding stream to list:` log lines, in order.
 * This is the authoritative, lag-free source of the stream's topic — unlike the gateway-served
 * catalog, which trails the uploader by minutes and can surface a stale topic from a prior stream.
 */
export function announcedLiveTopics(text: string): string[] {
  return (
    announcedLiveEntries(text)
      .map((entry) => entry.topic)
      // Checked against the runtime type, not against `undefined`, because these entries come out of
      // `JSON.parse` and the shape they are cast to is a claim about the uploader rather than a fact
      // about the string. A predicate narrowing to `string` has to earn it, or `null` reaches a caller
      // wearing a type that says it cannot be there.
      .filter((topic): topic is string => typeof topic === 'string' && topic !== '')
  );
}

/**
 * The same announcements, kept only where they name a whole feed location.
 *
 * The bench needs the owner as well as the topic, because it reads the feed through a gateway rather
 * than asking the uploader. An entry with one of the two names a feed nothing can fetch, so it is
 * dropped here rather than becoming a request to `/feeds/undefined/...`.
 */
export function announcedLiveStreams(text: string): AnnouncedStream[] {
  return announcedLiveEntries(text).filter((entry): entry is AnnouncedStream => Boolean(entry.topic && entry.owner));
}

/** One rung's publish, as the uploader reported it. */
export interface PublishedRendition {
  rung: string;
  ladder: string;
}

/**
 * Every rung publish in the log, in order, which is the only externally visible evidence that a
 * ladder is publishing all of its rungs rather than one.
 *
 * ⛔ The pattern is not written here. It comes from `publishingRenditionPattern` in the shared
 * package, built from the same composer the uploader logs with, so a reworded message cannot leave
 * this matching nothing. That failure is silent and it has already happened once in this file, over
 * JSON envelopes: a scenario blamed the uploader for never announcing a stream it had announced.
 */
export function publishedRenditions(text: string): PublishedRendition[] {
  return [...messageText(text).matchAll(publishingRenditionPattern('g'))].map((match) => ({
    rung: match[1],
    ladder: match[2],
  }));
}

/**
 * The distinct rungs seen publishing under one ladder, in first-publish order.
 *
 * Deduplicated because a rung publishes on every announce, so the raw count measures how long the
 * broadcast ran rather than how wide the ladder is. A caller asking "did all four rungs come up"
 * wants this; one asking "did they keep publishing" wants {@link publishedRenditions}.
 */
export function ladderRungs(text: string, ladder?: string): string[] {
  const seen = new Set<string>();
  for (const publish of publishedRenditions(text)) {
    if (ladder === undefined || publish.ladder === ladder) {
      seen.add(publish.rung);
    }
  }
  return [...seen];
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
