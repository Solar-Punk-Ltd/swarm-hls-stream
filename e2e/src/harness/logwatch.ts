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

import {
  addingStreamToListPattern,
  catalogStateLostPattern,
  finalizeResumedPattern,
  ladderFinalizedPattern,
  manifestUploadedPattern,
  omeSegmentLossReportedPattern,
  originDeclaredDiscontinuityPattern,
  publishingRenditionPattern,
  replacedSessionFinalizedPattern,
  rungAnnouncedPattern,
  segmentsNeverArrivedPattern,
  segmentUploadedPattern,
  segmentUploadFailedPattern,
  streamStoppedPattern,
  updatingStreamToVodPattern,
  videolessSegmentPattern,
} from '@swarm-hls-stream/shared';

export interface UploaderEvents {
  uploadedSegments: number[];
  /**
   * How many discontinuities were armed, by any of the four lines that say one was.
   *
   * A count rather than a list of indices, because only one of the four names a segment. The
   * scenarios that care read this number, and the one that wants an index reads
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

/**
 * Every line that means a discontinuity was armed, in the shapes the producers compose them.
 *
 * `StreamUploader` sets `pendingDiscontinuity` from three call sites: the retry window being spent,
 * `handleSegmentLoss`, and `markDiscontinuity`. The OME puller writes a fourth line reporting the
 * same loss `handleSegmentLoss` is about to record, beside the uploader's rather than instead of it,
 * so one loss on OME contributes two. That double count is what this counter has always produced and
 * it is preserved deliberately: changing a count in the same step as moving a message leaves neither
 * provable, and `test/logwatch.test.ts` pins both halves.
 *
 * ⛔ Not written out here. Each pattern is derived from the composer the producer logs with, so a
 * reworded message cannot leave this matching nothing. Six suites assert this count is zero on a
 * clean run and a blind reader passes every one of them, for ever, on a stage arming discontinuities
 * all night. Anchoring on the upload failure alone once matched one of the four for exactly that
 * reason, and the `markDiscontinuity` miss is the dangerous shape: the segment carrying an
 * origin-declared marker IS accepted and uploaded, so it leaves no hole and `isContiguous` is no
 * backstop either.
 */
const discontinuityPatterns = (): RegExp[] => [
  segmentUploadFailedPattern('g'),
  segmentsNeverArrivedPattern('g'),
  originDeclaredDiscontinuityPattern('g'),
  omeSegmentLossReportedPattern('g'),
];

/**
 * ⚠️ Capture group 2, not 1. `manifestUploadedPattern` puts the stream first because its message
 * does, which is the reverse of the segment pattern beside it.
 */
const manifestSocPattern = () => manifestUploadedPattern('g');
/**
 * ⚠️ The two below stay raw regexes on purpose. They are observation-only counters that no suite
 * asserts on, so a reworded message costs a number nobody reads rather than a green run nobody can
 * trust, which is the whole reason the others are a contract.
 */
const RE_STALE = /is stale: \d+ consecutive/g;
const RE_RETRY = /Retrying in ~/g;

/**
 * ⛔ Not a raw regex, unlike the two above, and the difference is that something refuses on this one.
 * `e2e/browser/make-recording.ts` will not hand back a recording whose segments held no video, so a
 * pattern that quietly stopped matching would let the task #40 failure through as a success: a
 * recording that plays as sound over a blank picture, called good. Derived from the composer the
 * uploader writes with, so a reword cannot do that silently.
 */
const videolessPattern = () => videolessSegmentPattern('g');

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

/** For a pattern whose numeric capture is group 2 rather than group 1. */
function captureSecondNumbers(source: string, re: RegExp): number[] {
  return [...source.matchAll(re)].map((m) => Number(m[2]));
}

function countMatches(source: string, re: RegExp): number {
  return [...source.matchAll(re)].length;
}

/**
 * One count over several patterns. Summing is sound here because each arming message matches exactly
 * one of them, which `test/logwatch.test.ts` asserts message by message rather than leaving to the
 * reader: a pattern that started matching a sibling's line would double a count nobody would query.
 */
function countAnyMatch(source: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((total, re) => total + countMatches(source, re), 0);
}

export function parseUploaderLog(text: string): UploaderEvents {
  const messages = messageText(text);
  return {
    uploadedSegments: captureNumbers(messages, segmentUploadedPattern('g')),
    discontinuitiesArmed: countAnyMatch(messages, discontinuityPatterns()),
    discontinuitySegments: captureNumbers(messages, segmentUploadFailedPattern('g')),
    manifestSocIndices: captureSecondNumbers(messages, manifestSocPattern()),
    staleWarnings: countMatches(messages, RE_STALE),
    retries: countMatches(messages, RE_RETRY),
    videolessSegments: captureNumbers(messages, videolessPattern()),
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
  for (const match of messageText(text).matchAll(addingStreamToListPattern('g'))) {
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
interface PublishedRendition {
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
 * One `Segment N of <stream> uploaded` line: which stream's counter moved, to what, and the
 * reference the bytes landed under.
 * Not exported: callers take it from {@link segmentUploads}'s inferred return, and exporting it
 * would add a name to the surface that nothing imports.
 */
interface SegmentUpload {
  streamId: string;
  index: number;
  /** The Swarm reference, which is the only field that identifies a segment across broadcasts. */
  reference: string;
}

/**
 * Segment uploads with the stream they belong to, which is the only sound way to read them under a
 * ladder: four rungs are four independent counters, and the merged deduplicated indices can mask a
 * one-rung gap exactly as easily as they can invent one. `uploadedSegments` keeps the merged view
 * for single-rendition scenarios; anything judging gaps on a ladder deployment scopes through this.
 */
export function segmentUploads(text: string): SegmentUpload[] {
  return [...messageText(text).matchAll(segmentUploadedPattern('g'))].map((match) => ({
    streamId: match[2],
    index: Number(match[1]),
    reference: match[3],
  }));
}

/** `live/stream_1080p` is the `1080p` rung. Null where a stream id names no rung. */
const RUNG_OF_STREAM = /stream_(\S+)$/;

function rungNameOf(streamId: string): string | null {
  return RUNG_OF_STREAM.exec(streamId)?.[1] ?? null;
}

/**
 * The reference of the LAST segment the uploader published on each rung, keyed by rung name.
 *
 * ⛔⛔ The last line per rung wins, and that is the whole point of reading it this way. SRS's segment
 * counter runs on across broadcasts, so a log window opened at a broadcast's start also carries the
 * previous broadcast's final segments at indices that continue the sequence. Anything that COUNTS
 * lines in the window therefore counts a neighbour's stragglers as this broadcast's media: on
 * 2026-09-02 that put a sixteenth 1080p segment into V4's arithmetic from a broadcast that had ended
 * eleven seconds before this one began, and V4 refused a complete recording for being 2.4s short. A
 * straggler precedes this broadcast's own segments in the log, so the last line is always this
 * broadcast's.
 *
 * ⛔ Keyed by rung NAME rather than by stream id, because the ladder the deployment declares names
 * rungs while the log names streams. A stream id carrying no `stream_<rung>` suffix is not a rung of
 * a ladder and is left out rather than keyed under its whole id, which would put a name no ladder
 * declares next to the ones that do.
 */
export function lastUploadedSegmentRefByRung(text: string): ReadonlyMap<string, string> {
  const byRung = new Map<string, string>();
  for (const upload of segmentUploads(text)) {
    const rung = rungNameOf(upload.streamId);
    if (rung !== null) {
      byRung.set(rung, upload.reference);
    }
  }
  return byRung;
}

/**
 * Stream ids whose sessions ended successfully, through either of the two ways a session ends: the
 * ordinary drain (`Stopped stream`), or the replacement path finalizing a session a reconnect
 * overtook mid-drain (`Finalized the replaced session`). Which one fires per stream is a race the
 * caller cannot control, so anything asserting "the old session ended" reads both.
 */
export function sessionEnds(text: string): string[] {
  const messages = messageText(text);
  return [
    ...[...messages.matchAll(streamStoppedPattern('g'))].map((match) => match[1]),
    ...[...messages.matchAll(replacedSessionFinalizedPattern('g'))].map((match) => match[1]),
  ];
}

/**
 * The session topics a broadcast announced, whichever shape the deployment publishes: the single
 * stream's catalog announce lines, or under a ladder every rung's announce. The two line families
 * are mode-exclusive (a ladder never writes `Adding stream to list`, a single rendition never
 * announces a rung), so presence decides and no caller carries a mode flag.
 */
export function announcedSessionTopics(text: string): string[] {
  const single = announcedLiveTopics(text);
  return single.length > 0 ? single : announcedRungs(text).map((announce) => announce.topic);
}

/**
 * How many broadcasts have finalized to VOD, whichever shape the deployment publishes: the
 * single-rendition catalog update, or the ladder flip. A ladder counts once, not once per rung.
 */
export function vodFinalizeCount(text: string): number {
  const messages = messageText(text);
  return (
    [...messages.matchAll(updatingStreamToVodPattern('g'))].length +
    [...messages.matchAll(ladderFinalizedPattern('g'))].length
  );
}

/**
 * How many times THIS broadcast finalized to VOD, identified by its session topics.
 *
 * ⛔ The unscoped {@link vodFinalizeCount} reads every broadcast's flip in the window, and a
 * neighbouring scenario's flip trailing into this one's window then reads as a double publish.
 * Scenario H went red on exactly that on 2026-08-28: the two-streams scenario's second flip landed
 * inside H's window and H reported one recording published and paid for twice, which the uploader's
 * own log disproved — two ladders, one flip each.
 *
 * A ladder flip names only its group, so it is attributed through the rung announces that carry
 * both the group and its topics. A single-rendition flip carries the published entry's JSON on the
 * line itself, so the topic is matched inside it.
 */
export function vodFinalizeCountFor(text: string, sessionTopics: readonly string[]): number {
  const topics = new Set(sessionTopics);
  const messages = messageText(text);

  const ladders = new Set(
    announcedRungs(text)
      .filter((announce) => topics.has(announce.topic))
      .map((announce) => announce.ladder),
  );
  const ladderFlips = [...messages.matchAll(ladderFinalizedPattern('g'))].filter((match) =>
    ladders.has(match[1]),
  ).length;

  const singleFlips = [...messages.matchAll(updatingStreamToVodPattern('g'))].filter((match) =>
    [...topics].some((topic) => match[1].includes(topic)),
  ).length;

  return ladderFlips + singleFlips;
}

/**
 * {@link vodFinalizeCountFor} scoped to the broadcasts announced inside this same log window.
 *
 * Every scenario reads its log since its own `startedAt`, taken after `waitForIdle`, so an announce
 * inside the window is its own broadcast (a recovery's re-announce included), while a neighbour can
 * contribute at most a trailing flip, which this excludes.
 */
export function announcedVodFinalizeCount(text: string): number {
  return vodFinalizeCountFor(text, announcedSessionTopics(text));
}

/**
 * `StreamCatalog` giving up on its previous state and writing over it with an empty list.
 *
 * ⛔ This is the discriminator scenario H needs. Its count of `Ladder <group> finalized to VOD` is
 * guarded by "the catalog does not already say VOD", so a second one means either a genuine second
 * finalize or a first one the guard could not see. Only this line separates them, and it is emitted
 * exactly where the second case happens: after a boot that resumed to an index whose state it never
 * read AND three consecutive failures to read it.
 *
 * ⚠️ Anchored on the conclusion, not on the warning. The two attempts before it carry a nearly
 * identical message and they KEPT the catalog, so counting those would report loss that did not
 * happen. The pattern comes from `catalogStateLost` in the shared package, built from the composer
 * `StreamCatalog` writes with, so the two cannot drift into agreeing about a line neither produces.
 */
export function catalogContinuedEmpty(text: string): number {
  return countMatches(messageText(text), catalogStateLostPattern('g'));
}

/**
 * Finalizes that came back after a crash, found their own recording already in the feed, and
 * published nothing rather than buying it a second time.
 *
 * ⛔ An observation, not a fault, and the difference matters to whoever reads a run. A non-zero here
 * means the kill in scenario H landed inside the window it aims at AND the uploader answered it the
 * way it is supposed to. Zero means either a clean ordering or a window the kill missed, which the
 * scenario already reports for itself off the surviving recovery entries.
 *
 * Deliberately separate from {@link announcedVodFinalizeCount}: this line is not a flip and must
 * never be added to one. A reader that counted it would report the fix for the double publish as
 * the double publish.
 */
export function resumedFinalizeCount(text: string): number {
  return countMatches(messageText(text), finalizeResumedPattern('g'));
}

/**
 * Every rung's manifest SOC indices, keyed by stream, in publish order.
 *
 * ⛔ The merged list is not a substitute and `service/happy-path` proved it: `isContiguous`
 * deduplicates, so four rungs each publishing 0,1,2 and a ladder where one rung froze at 0 while the
 * rest reached 2 produce the identical set {0,1,2}. Judged per stream the frozen rung is a list of
 * length one beside three of length three, which is visible.
 */
export function manifestIndicesByStream(text: string): Map<string, number[]> {
  const byStream = new Map<string, number[]>();
  for (const match of messageText(text).matchAll(manifestUploadedPattern('g'))) {
    const indices = byStream.get(match[1]) ?? [];
    indices.push(Number(match[2]));
    byStream.set(match[1], indices);
  }
  return byStream;
}

/**
 * Each stream's uploaded indices, in upload order: the only sound unit for gap analysis. Under a
 * ladder the merged view interleaves four counters that start at different SRS sequence numbers,
 * so it holes at every log-window boundary while no rung has lost anything, and it can equally
 * mask a real one-rung gap behind a sibling's healthy index.
 */
export function segmentIndicesByStream(text: string): Map<string, number[]> {
  const byStream = new Map<string, number[]>();
  for (const upload of segmentUploads(text)) {
    const indices = byStream.get(upload.streamId) ?? [];
    indices.push(upload.index);
    byStream.set(upload.streamId, indices);
  }
  return byStream;
}

/** One rung-announce line: the only place a session's topic is visible next to its ladder. */
export interface AnnouncedRung {
  streamId: string;
  rung: string;
  ladder: string;
  topic: string;
}

/**
 * Every rung announce, in order. A session announces once at start, so a recovered rung is visible
 * here as the same rung on a fresh topic. The ladder group deliberately survives an engine restart
 * while any sibling is still draining, so recovery must be read off topics, never off groups.
 */
export function announcedRungs(text: string): AnnouncedRung[] {
  return [...messageText(text).matchAll(rungAnnouncedPattern('g'))].map((match) => ({
    streamId: match[1],
    rung: match[2],
    ladder: match[3],
    topic: match[4],
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
