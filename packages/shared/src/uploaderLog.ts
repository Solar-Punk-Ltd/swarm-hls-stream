/**
 * Log messages the uploader writes that something else parses back.
 *
 * ⛔ These are a contract, not prose. The e2e harness reads the uploader's own log as its primary
 * assertion source for the upload-side scenarios, so a reworded message is a silently empty parse
 * and a scenario that blames the uploader for never doing the thing it did. `logwatch.ts` has been
 * bitten by that shape once already, over JSON envelopes.
 *
 * One definition, so the producer and the reader cannot drift apart. See ARCH-1, and
 * `announcedLiveTopics` in the e2e harness for what a blind parse costs.
 */

/** Regex metacharacters, escaped so a composed message is matched as the literal text it is. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Stand-ins the pattern builder substitutes capture groups for.
 *
 * Alphabetic and distinctive: they have to survive escaping unchanged and must not occur anywhere
 * else in the composed message, or the substitution would land in the literal half.
 */
const RUNG_SLOT = 'RUNGSLOT';
const LADDER_SLOT = 'LADDERSLOT';

/**
 * Written once per rung per announce, which is the only externally visible evidence that a ladder is
 * publishing every rung rather than one.
 */
export function publishingRendition(rung: string, ladder: string): string {
  return `Publishing rendition ${rung} of ladder ${ladder}`;
}

/**
 * {@link publishingRendition} as a matcher, with the rung and the ladder as capture groups 1 and 2.
 *
 * Built by running the composer on placeholders and escaping everything around them, so the literal
 * text is never written twice and a reworded message cannot leave the reader matching nothing. A
 * caller wanting every match supplies its own `g`.
 */
export function publishingRenditionPattern(flags = ''): RegExp {
  const escaped = publishingRendition(RUNG_SLOT, LADDER_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(RUNG_SLOT, '(\\S+)').replace(LADDER_SLOT, '(\\S+)'), flags);
}

const STREAM_SLOT = 'STREAMSLOT';
const TOPIC_SLOT = 'TOPICSLOT';
/** Numeric stand-in for the index parameter, distinctive enough to never occur in the literal half. */
const INDEX_SLOT = 424242424242;

/**
 * Written once per uploaded segment. The stream id is part of the message because a ladder is four
 * independent segment counters: without it the interleaved indices of four rungs are one
 * unreadable sequence, in the harness and for an operator alike.
 */
export function segmentUploaded(streamId: string, index: number, reference: string): string {
  return `Segment ${index} of ${streamId} uploaded: ${reference}`;
}

/**
 * {@link segmentUploaded} as a matcher: index, stream and reference as capture groups 1, 2 and 3.
 */
export function segmentUploadedPattern(flags = ''): RegExp {
  const escaped = segmentUploaded(STREAM_SLOT, INDEX_SLOT, TOPIC_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(
    escaped.replace(String(INDEX_SLOT), '(\\d+)').replace(STREAM_SLOT, '(\\S+)').replace(TOPIC_SLOT, '(\\S+)'),
    flags,
  );
}

/**
 * Written once per published live manifest. Carries the stream for exactly the reason
 * {@link segmentUploaded} does: a ladder is four independent SOC counters, and four interleaved
 * `Manifest uploaded at SOC index N` lines are one unreadable sequence.
 *
 * ⛔ Found 2026-09-01, two days after the same defect was fixed on the segment line and five weeks
 * after this line was first parsed. `service/happy-path` was the only check on it, it deduplicated
 * the four counters into one set, and a set is contiguous whether one rung froze at index 3 or none
 * did. A rung whose manifest publishing stopped for a whole broadcast was therefore invisible to the
 * suite, on the deployment whose entire failure mode this year has been one rung of four stopping.
 */
export function manifestUploaded(streamId: string, index: number): string {
  return `Manifest of ${streamId} uploaded at SOC index ${index}`;
}

/**
 * {@link manifestUploaded} as a matcher, with the stream and the index as capture groups 1 and 2.
 *
 * ⚠️ That order is the reverse of {@link segmentUploadedPattern}'s, because the groups follow the
 * words and these two messages read in opposite orders. Read the group numbers off this docblock
 * rather than off the sibling.
 */
export function manifestUploadedPattern(flags = ''): RegExp {
  const escaped = manifestUploaded(STREAM_SLOT, INDEX_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(STREAM_SLOT, '(\\S+)').replace(String(INDEX_SLOT), '(\\d+)'), flags);
}

/**
 * Written once when a rung is grouped into its ladder, at session start. Byte-identical to the line
 * `StreamOrchestrator` wrote before this composer existed, so the derived pattern also reads logs
 * from deployments that predate it.
 *
 * This is the only line that carries the session topic, and the topic is what tells a recovered
 * session from a retired one: the ladder group deliberately survives an engine restart while any
 * sibling is still draining, so recovery is visible as fresh topics, never as a fresh group.
 */
export function rungAnnounced(streamId: string, rung: string, ladder: string, topic: string): string {
  return `${streamId} is rung ${rung} of ladder ${ladder}, topic ${topic}`;
}

/**
 * {@link rungAnnounced} as a matcher: stream, rung, ladder and topic as capture groups 1 to 4.
 */
export function rungAnnouncedPattern(flags = ''): RegExp {
  const escaped = rungAnnounced(STREAM_SLOT, RUNG_SLOT, LADDER_SLOT, TOPIC_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(
    escaped
      .replace(STREAM_SLOT, '(\\S+)')
      .replace(RUNG_SLOT, '(\\S+)')
      .replace(LADDER_SLOT, '(\\S+)')
      .replace(TOPIC_SLOT, '(\\S+)'),
    flags,
  );
}

const JSON_SLOT = 'JSONSLOT';

/**
 * Written once when a single-rendition stream is announced to the catalog as live. The JSON payload
 * is the entry as published, and it is the only place a broadcast's own topic and owner reach the
 * log before anything has been uploaded.
 *
 * ⛔ A ladder never writes this line and a single rendition never announces a rung, so which of the
 * two a log holds is how a reader tells the two deployment shapes apart. Reworded, it reads as a
 * broadcast that never started, and the scenario waits out its timeout blaming the publisher.
 */
export function addingStreamToList(entryJson: string): string {
  return `Adding stream to list: ${entryJson}`;
}

/**
 * {@link addingStreamToList} as a matcher, the entry JSON as capture group 1.
 *
 * ⚠️ Bounded to the braces rather than run to the end of the line, unlike
 * {@link updatingStreamToVodPattern}. What is captured here goes straight into `JSON.parse`, so a
 * capture that swallowed anything a later message appended after the entry would parse to nothing,
 * and a parse that returns nothing is indistinguishable from a stream that was never announced.
 */
export function addingStreamToListPattern(flags = ''): RegExp {
  const escaped = addingStreamToList(JSON_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(JSON_SLOT, '(\\{[^\\n]*\\})'), flags);
}

/**
 * Written once when a single-rendition stream's catalog entry flips to VOD. Byte-identical to the
 * line the uploader has always written; the JSON payload is the entry as published.
 */
export function updatingStreamToVod(entryJson: string): string {
  return `Updating stream in list to VOD: ${entryJson}`;
}

/** {@link updatingStreamToVod} as a matcher, the entry JSON as capture group 1. */
export function updatingStreamToVodPattern(flags = ''): RegExp {
  const escaped = updatingStreamToVod(JSON_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(JSON_SLOT, '(.*)'), flags);
}

/**
 * Written once when a ladder's catalog entry flips to VOD, which happens only when its last live
 * rung finalizes. Until this line existed the flip was visible nowhere but the catalog feed: an
 * operator could not grep for when a ladder ended, and the harness's clean-stop scenario waited on
 * the single-rendition line forever.
 */
export function ladderFinalized(ladder: string): string {
  return `Ladder ${ladder} finalized to VOD`;
}

/** {@link ladderFinalized} as a matcher, the ladder group as capture group 1. */
export function ladderFinalizedPattern(flags = ''): RegExp {
  const escaped = ladderFinalized(LADDER_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(LADDER_SLOT, '(\\S+)'), flags);
}

/**
 * Written once when a session ends through the ordinary drain and nothing replaced it mid-drain.
 * Byte-identical to the line the orchestrator has always written.
 */
export function streamStopped(streamId: string): string {
  return `Stopped stream: ${streamId}`;
}

/** {@link streamStopped} as a matcher, the stream id as capture group 1. */
export function streamStoppedPattern(flags = ''): RegExp {
  const escaped = streamStopped(STREAM_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(STREAM_SLOT, '(\\S+)'), flags);
}

/**
 * Written once when a session that was replaced mid-drain has had its recording finalized by the
 * replacement path. Byte-identical to the line the orchestrator has always written. Together with
 * {@link streamStopped} these are the two ways a session ends successfully, whichever the
 * drain-versus-reconnect race produced.
 */
export function replacedSessionFinalized(streamId: string): string {
  return `Finalized the replaced session for ${streamId}`;
}

/** {@link replacedSessionFinalized} as a matcher, the stream id as capture group 1. */
export function replacedSessionFinalizedPattern(flags = ''): RegExp {
  const escaped = replacedSessionFinalized(STREAM_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(STREAM_SLOT, '(\\S+)'), flags);
}

/** Free-text stand-in for a phrase the caller assembles, which can hold spaces the others cannot. */
const SUBJECT_SLOT = 'SUBJECTSLOT';
const CAUSE_SLOT = 'CAUSESLOT';

/**
 * ## The six lines below all mean one thing: a discontinuity was armed
 *
 * A discontinuity tells a player the media after it is not a continuation of the media before it, so
 * it skips the join instead of stalling on a hole it was told was seamless. Six separate messages
 * report one being armed, and the harness counts all six as one number.
 *
 * ⛔⛔ **The reason the wording is a contract.** Six suites assert that a clean broadcast armed
 * NONE. A message reworded here and not deployed, or deployed and not read, does not fail those
 * six: it passes them, silently, for ever, on a stage arming discontinuities all night. That is the
 * worst failure this repo knows how to produce, and it is why these composers exist rather than a
 * regex written out beside the reader.
 */

/**
 * Written when a segment's whole retry window is spent with nothing landing, so the segment is
 * dropped and the next one to land carries the break.
 *
 * The only one of the six an index can be read off, which is why the bee-outage scenario asserts on
 * that index. {@link engineSkippedSegments} names two segments and neither of them is this one: it
 * names the edges of a gap rather than a segment anything was attempted for.
 */
export function segmentUploadFailed(streamId: string, index: number): string {
  return `Failed to upload segment ${index} for stream ${streamId} within the retry window; marking a discontinuity`;
}

/**
 * {@link segmentUploadFailed} as a matcher, the index and the stream as capture groups 1 and 2.
 *
 * ⚠️ The index is group 1 because the message names it first, which is the reverse of the composer's
 * own argument order. Read the group numbers off this docblock, never off the signature.
 */
export function segmentUploadFailedPattern(flags = ''): RegExp {
  const escaped = segmentUploadFailed(STREAM_SLOT, INDEX_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(String(INDEX_SLOT), '(\\d+)').replace(STREAM_SLOT, '(\\S+)'), flags);
}

/**
 * Written when segments never reached the uploader at all, because the engine could not download
 * them from the origin. One contiguous gap is one line, however many segments it spans.
 *
 * `subject` is the caller's own phrase for what went missing, `Segment 5` or
 * `3 segments from index 5`. It stays outside the fixed half on purpose: nothing parses it, and
 * pinning both shapes here would put a branch in the contract that no reader depends on.
 */
export function segmentsNeverArrived(subject: string, streamId: string): string {
  return `${subject} for stream ${streamId} never reached the uploader, marking a discontinuity`;
}

/**
 * {@link segmentsNeverArrived} as a matcher, the subject and the stream as capture groups 1 and 2.
 *
 * ⚠️ Group 1 is free text at the very start of the message, so on a text-format log line it takes
 * the line's own `[ts] [LEVEL] -` prefix with it. Nothing reads it. This pattern is counted rather
 * than captured, and the group is there only because the builder turns every placeholder into one.
 */
export function segmentsNeverArrivedPattern(flags = ''): RegExp {
  const escaped = segmentsNeverArrived(SUBJECT_SLOT, STREAM_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(SUBJECT_SLOT, '(.+)').replace(STREAM_SLOT, '(\\S+)'), flags);
}

/**
 * Written when the origin itself declared a discontinuity with `#EXT-X-DISCONTINUITY`. An encoder
 * restarting upstream produces exactly this, and nothing went wrong at the uploader.
 *
 * ⛔ The dangerous one to lose. The segment carrying the marker IS accepted and uploaded, so it
 * leaves no hole in the indices and a gapless-run check is no backstop either. Stop reading this
 * line and nothing anywhere in the suite can see an origin-declared break.
 */
export function originDeclaredDiscontinuity(streamId: string): string {
  return `Origin declared a discontinuity for stream ${streamId}, marking the next segment`;
}

/** {@link originDeclaredDiscontinuity} as a matcher, the stream as capture group 1. */
export function originDeclaredDiscontinuityPattern(flags = ''): RegExp {
  const escaped = originDeclaredDiscontinuity(STREAM_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(STREAM_SLOT, '(\\S+)'), flags);
}

/**
 * The OME puller's own report of segments it could not download, written **beside** the uploader's
 * {@link segmentsNeverArrived} for the same loss rather than instead of it.
 *
 * ⚠️ So one loss on OME puts two arming lines in the log and a reader counting arms counts two.
 * That is what the harness has counted since the counter existed, and it is recorded here rather
 * than corrected, because changing a count in the same step as moving a message leaves neither
 * provable. Correcting it is a separate change with its own evidence.
 */
export function omeSegmentLossReported(subject: string, streamId: string, cause: string): string {
  return `[OME] ${subject} lost for ${streamId} after ${cause}, marking a discontinuity`;
}

/**
 * {@link omeSegmentLossReported} as a matcher, the subject, the stream and the cause as capture
 * groups 1 to 3. Counted rather than captured, the same as its sibling above.
 */
export function omeSegmentLossReportedPattern(flags = ''): RegExp {
  const escaped = omeSegmentLossReported(SUBJECT_SLOT, STREAM_SLOT, CAUSE_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(
    escaped.replace(SUBJECT_SLOT, '(.+)').replace(STREAM_SLOT, '(\\S+)').replace(CAUSE_SLOT, '(.+)'),
    flags,
  );
}

/**
 * The engine's own counter restarting inside a broadcast, which re-anchors both the playlist
 * numbering and the dating and puts a break on the segment it lands on.
 *
 * ⛔ **The reason this is here and not an ordinary info line.** The shipped SRS webhook path
 * declares no break of its own, so on that engine the reset is the only evidence there is, and the
 * segment carries the marker on the strength of it. That made a fifth way to arm a discontinuity
 * that the harness could not count, which is exactly the blind spot the four above are spelled out
 * to prevent: six suites assert a clean broadcast armed none, and an arming the counter cannot see
 * passes them for ever.
 *
 * ⚠️ **It names no stream**, unlike the other four, because `ManifestManager` is not given one and
 * every line it writes is already anonymous. Nothing reads a stream off this: the counter counts.
 *
 * @param sequence the playlist sequence the numbering and the dating both continue from
 * @param wasAt the date that sequence would have carried had nothing restarted, as an ISO instant
 * @param nowAt the date it carries instead, which is the wall clock the engine came back at
 */
export function datingReanchored(sequence: number, wasAt: string, nowAt: string): string {
  return (
    `The engine's counter restarted at playlist sequence ${sequence}, so the dating re-anchors from ` +
    `${wasAt} to ${nowAt}, marking a discontinuity`
  );
}

/**
 * {@link datingReanchored} as a matcher, the sequence and the two instants as capture groups 1 to 3.
 * Counted rather than captured, the same as the two above.
 */
export function datingReanchoredPattern(flags = ''): RegExp {
  const escaped = datingReanchored(INDEX_SLOT, SUBJECT_SLOT, CAUSE_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(
    escaped.replace(String(INDEX_SLOT), '(\\d+)').replace(SUBJECT_SLOT, '(\\S+)').replace(CAUSE_SLOT, '(\\S+)'),
    flags,
  );
}

/** Two further numeric stand-ins, distinct from {@link INDEX_SLOT} so a message carrying three substitutes each. */
const TO_INDEX_SLOT = 717171717171;
const COUNT_SLOT = 626262626262;

/**
 * Segments the engine never posted at all, found by the uploader in the gap between the index it last
 * accounted for and the one it has just been handed. One gap is one line, however wide it is.
 *
 * ⛔ **Not {@link segmentsNeverArrived}, and the difference is who knew.** That line means the engine
 * reported a loss, which is the only kind the OME puller produces. This one means nobody reported
 * anything and the uploader read it off the numbering, which is the only kind the SRS webhook
 * produces: SRS posts each closed segment once and never retries, so everything it closed while this
 * process was dead is simply absent. Until this line existed the playlist carried that gap with no
 * break in front of it, which is a playlist promising a viewer media it does not name, and hls.js
 * stalls on one. Scenario F asserts on this family by itself, so the two wordings must stay apart.
 *
 * @param fromIndex the last index this stream accounted for, which was delivered or reported lost
 * @param toIndex the index that has just arrived, which is delivered and so is not part of the gap
 * @param count how many indexes between the two were never seen
 */
export function engineSkippedSegments(fromIndex: number, toIndex: number, streamId: string, count: number): string {
  return `The engine skipped from segment ${fromIndex} to segment ${toIndex} for stream ${streamId}, ${count} never posted, marking a discontinuity`;
}

/**
 * {@link engineSkippedSegments} as a matcher, the two indexes, the stream and the count as capture
 * groups 1 to 4, in the order the message names them and so in the composer's own argument order.
 *
 * ⚠️ Counted rather than captured today. The indexes are readable off it, and nothing reads them:
 * scenario F asserts that this family fired at all, and the width of the gap is the engine's to
 * choose rather than anything a suite can predict.
 */
export function engineSkippedSegmentsPattern(flags = ''): RegExp {
  const escaped = engineSkippedSegments(INDEX_SLOT, TO_INDEX_SLOT, STREAM_SLOT, COUNT_SLOT).replace(
    REGEX_SPECIAL,
    '\\$&',
  );
  return new RegExp(
    escaped
      .replace(String(INDEX_SLOT), '(\\d+)')
      .replace(String(TO_INDEX_SLOT), '(\\d+)')
      .replace(STREAM_SLOT, '(\\S+)')
      .replace(String(COUNT_SLOT), '(\\d+)'),
    flags,
  );
}

/**
 * `StreamCatalog` giving up on the state it resumed to, and continuing from an empty list. Written
 * only after a boot that resumed to an index it never read AND three consecutive failures to read
 * that index, so it means the earlier entries are gone rather than slow.
 *
 * ⛔ This is the discriminator the finalize-crash scenario prints. Its count of ladder finalizes is
 * guarded by "the catalog does not already say VOD", so a second finalize means either a real second
 * one or a first one the guard was blind to. Only this line separates them.
 *
 * ⚠️ Anchored on the conclusion, not on the warning. The two attempts before it carry a nearly
 * identical message and they KEPT the catalog, so a reader matching those reports a loss that never
 * happened.
 *
 * ⛔ One template literal, never split across a `+`, whatever it costs in line width. `StreamCatalog`
 * wrote it as two joined strings until this composer existed, and `tsc` keeps such a join exactly as
 * written, so the fragment spanning it was in no built file. The preflight gate greps the built code
 * for a message's fixed halves, so a split message makes it refuse a deployment that writes the line
 * perfectly. `e2e/test/deployedLogShape.test.ts` holds that case.
 */
export function catalogStateLost(index: string, reads: number): string {
  return `[StreamCatalog] State at index ${index} failed to read ${reads} times; continuing with an empty catalog — earlier entries are lost`;
}

/**
 * {@link catalogStateLost} as a matcher, the feed index and the read count as capture groups 1 and 2.
 */
export function catalogStateLostPattern(flags = ''): RegExp {
  const escaped = catalogStateLost(STREAM_SLOT, INDEX_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(STREAM_SLOT, '(\\S+)').replace(String(INDEX_SLOT), '(\\d+)'), flags);
}

/**
 * A finalize that came back after a crash, found its own recording already at the head of the
 * stream's manifest feed, and therefore published no manifest at all. Written once per rung, in
 * place of the two feed writes the ordinary path makes.
 *
 * ⛔ It is deliberately NOT a flip. `ladderFinalized` and `updatingStreamToVod` mean a broadcast
 * ended, and a reader counting either of them must not count this: the recording it names was
 * published and paid for before the crash, and a count that took this line would report the fix for
 * the double publish as the double publish itself. See scenario H.
 *
 * The SOC index is on the line because it is the evidence. It names where the surviving recording
 * sits in the feed, so an operator can fetch that playlist and see for themselves rather than infer
 * from the absence of a second publish.
 *
 * ⛔ One template literal, never split across a `+`, for the reason {@link catalogStateLost} records
 * at length: `tsc` keeps a join exactly as written, so the fragment spanning it reaches no built
 * file and the preflight gate then refuses a deployment that writes the line perfectly.
 */
export function finalizeResumed(streamId: string, index: number): string {
  return `Resuming the finalize of ${streamId} at the catalog write: its VOD manifest is already published at SOC index ${index}`;
}

/** {@link finalizeResumed} as a matcher, the stream and the SOC index as capture groups 1 and 2. */
export function finalizeResumedPattern(flags = ''): RegExp {
  const escaped = finalizeResumed(STREAM_SLOT, INDEX_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(escaped.replace(STREAM_SLOT, '(\\S+)').replace(String(INDEX_SLOT), '(\\d+)'), flags);
}

/** Free-text stand-in for the parser's own reason, which carries spaces, colons and a full stop. */
const REASON_SLOT = 'REASONSLOT';
/** A second numeric stand-in, distinct from {@link INDEX_SLOT} so a message carrying both substitutes each. */
const DECLARED_SLOT = 353535353535;

/**
 * Written once per stream when the uploader could not read how much media a segment holds and
 * published the engine's claim instead. Byte-identical to the line `StreamOrchestrator` wrote before
 * this composer existed.
 *
 * ⛔ **Two different faults share this one line, and only one of them costs the picture.** `reason` is
 * whatever `measureSegmentDuration` fell back for: timestamps that span no plausible segment, or a
 * segment holding no video packets at all. The second is task #40 and it is not a complaint about a
 * duration. A recording whose opening fragment carries only audio plays as sound over a blank picture
 * **for its whole length**, because the player fixes its codec set from the first fragment it parses
 * and never revises it. `e2e/browser/make-recording.ts` refuses to hand back such a recording, and
 * {@link videolessSegmentPattern} is the only thing that tells it one was made.
 *
 * ⚠️ Written once per stream rather than once per segment, so a reader learns that a broadcast has
 * the fault and never how many segments carried it.
 *
 * ⛔ One template literal, never split across a `+`, for the reason {@link catalogStateLost} records
 * at length: `tsc` keeps a join exactly as written, so the fragment spanning it reaches no built file
 * and the preflight gate then refuses a deployment that writes the line perfectly.
 */
export function segmentDurationUnread(streamId: string, index: number, declared: number, reason: string): string {
  return `[StreamOrchestrator] Cannot read how much media segment ${index} of ${streamId} holds, so ${declared}s is being published on the engine's word: ${reason}. Reported once per stream; see the segment_durations_unread_total counter for the rate`;
}

/**
 * The words `measureSpanTicks` fails a segment with when it holds no video packets, which is the half
 * of {@link segmentDurationUnread}'s reason that separates the fault costing a picture from the one
 * that costs only an accurate duration.
 */
const VIDEOLESS_REASON = 'holds no video packets';

/**
 * {@link segmentDurationUnread} as a matcher, **narrowed to the videoless fault**: segment index,
 * stream, declared duration and reason as capture groups 1 to 4.
 *
 * ⚠️ Anchored on the reason as well as on the warning. The same warning fires for a segment whose
 * timestamps are unusable, which is a different fault with a different consequence, and a matcher
 * that took both would refuse a perfectly watchable recording.
 */
export function videolessSegmentPattern(flags = ''): RegExp {
  const escaped = segmentDurationUnread(STREAM_SLOT, INDEX_SLOT, DECLARED_SLOT, REASON_SLOT).replace(
    REGEX_SPECIAL,
    '\\$&',
  );
  return new RegExp(
    escaped
      .replace(String(INDEX_SLOT), '(\\d+)')
      .replace(STREAM_SLOT, '(\\S+)')
      .replace(String(DECLARED_SLOT), '([\\d.]+)')
      .replace(REASON_SLOT, `([^\\n]*${VIDEOLESS_REASON}[^\\n]*)`),
    flags,
  );
}

/**
 * How much of a postage batch id {@link rungBatchRefused} carries. A whole id is 64 hex characters
 * and the four rungs' ids differ from the first one, so a prefix names which batch without filling
 * the line with it.
 */
const BATCH_ID_PREFIX_LENGTH = 8;

/**
 * Stand-in for the batch id, exactly {@link BATCH_ID_PREFIX_LENGTH} characters so the composer's own
 * shortening leaves it whole.
 *
 * ⚠️ One character longer and the pattern builder would be substituting into a stand-in the composer
 * had already cut short, so it would find nothing, leave the truncated stand-in in the literal half,
 * and match no line at all. The round-trip test is what catches that.
 */
const BATCH_SLOT = 'BATCHSLT';
/** Free-text stand-in for bee's own words, which carry spaces, a colon and a full stop. */
const BEE_ANSWER_SLOT = 'BEEANSWERSLOT';
/** A numeric stand-in for the status, distinct from the others so a message carrying two substitutes each. */
const STATUS_SLOT = 464646464646;

/**
 * The longest of bee's answer this line carries, in characters.
 *
 * Bee answers a refused upload in a few words and a JSON envelope is not much longer, so this is a
 * bound on a remote service's free text rather than a limit anything is expected to reach. A log
 * line is read in a scrollback and a whole response body would push the words after it off the end.
 */
const BEE_ANSWER_LIMIT = 300;

/**
 * Bee's answer as one line, which is what a line-oriented contract can carry.
 *
 * ⛔⛔⛔ **A newline here is the worst failure this file can produce.** The composed line would be
 * correct and the reader would find nothing, because the words that bound the answer would sit on
 * the next physical line and the pattern's capture stops at a newline. The drain suite would then
 * spend its whole four minute wait on a paid broadcast and report three causes that are all wrong:
 * a stage nobody armed, a broadcast too short to fill the batch, or a deployment that cannot write
 * the line at all. Bee 2.8.2 answers on one line, so this is the guard and not a bug being fixed.
 *
 * ⭐ In the composer rather than in the reader, because the contract is what a deployment writes and
 * a reader repairing a line it should never have been given is a contract with two definitions.
 */
function oneLine(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length > BEE_ANSWER_LIMIT ? `${collapsed.slice(0, BEE_ANSWER_LIMIT)}...` : collapsed;
}

/**
 * Written when bee refuses a segment upload with a status the retry policy will not retry, which on
 * this deployment means the rung's postage batch has no room left. Once per answer bee gives, per
 * stream, for the life of an uploader process: a filling batch answers the same way for its whole
 * ramp and that is one line, while a genuinely different answer is a different condition and gets
 * its own. ⚠️ So a reader counting these cannot read the count as a number of drained rungs. The rung then publishes less and less until it publishes nothing, and the dead-rung rule
 * drops it from the master a few segments after its last delivery.
 *
 * ⛔ **This is the only thing that tells a drained batch from a dead encoder.** Every other instrument
 * reports the two identically: the rung's uploads stop, its dropped count climbs, and the master stops
 * offering it. {@link segmentUploadFailed} fires for each dropped segment and says only that the retry
 * window is spent, which a node that went away produces just as well.
 *
 * ⚠️ **Not a classification of bee's answer, and deliberately so.** Which status family bee 2.8.2
 * answers a full batch with is recorded nowhere in this repo, and the unit tests assume 402. The
 * status and the message are reproduced verbatim so the first live drain settles that off the log
 * rather than costing a second sitting.
 *
 * ⚠️ **Written once and never re-armed by a segment that lands.** A batch that is filling refuses a
 * growing share of segments rather than all of them: measured live on 2026-09-04, four refusals in
 * about fifty seconds with segments landing in between, because a chunk is only refused when its own
 * bucket is full. The batch a rung spends is fixed for the life of the uploader process, so the only
 * thing that replaces it is a redeploy, and that is a new process writing its own first line.
 *
 * ⛔ One template literal, never split across a `+`, for the reason {@link catalogStateLost} records
 * at length: `tsc` keeps a join exactly as written, so the fragment spanning it reaches no built file
 * and the preflight gate then refuses a deployment that writes the line perfectly.
 *
 * @param batch the rung's whole postage batch id, which this shortens to its first characters
 * @param streamId the rung's own stream id, which is what scopes the line to one quality
 * @param status the HTTP status bee answered the upload with
 * @param message bee's own words for it
 */
export function rungBatchRefused(batch: string, streamId: string, status: number, message: string): string {
  const batchPrefix = batch.slice(0, BATCH_ID_PREFIX_LENGTH);
  return `Postage batch ${batchPrefix} of ${streamId} refused by bee (${status} ${oneLine(
    message,
  )}), the rung thins out as the batch fills and this is the first refusal bee answered with this status`;
}

/**
 * {@link rungBatchRefused} as a matcher: the shortened batch, the stream, the status and bee's answer
 * as capture groups 1 to 4, in the order the message names them and so in the composer's own
 * argument order.
 *
 * ⚠️ Bee's answer is captured lazily and bounded by the words after it, rather than run to the end of
 * the line the way {@link updatingStreamToVodPattern} does. It carries spaces and the line does not
 * end with it, so a greedy capture would swallow the fixed half that follows and match nothing.
 */
export function rungBatchRefusedPattern(flags = ''): RegExp {
  const escaped = rungBatchRefused(BATCH_SLOT, STREAM_SLOT, STATUS_SLOT, BEE_ANSWER_SLOT).replace(
    REGEX_SPECIAL,
    '\\$&',
  );
  return new RegExp(
    escaped
      .replace(BATCH_SLOT, '(\\S+)')
      .replace(STREAM_SLOT, '(\\S+)')
      .replace(String(STATUS_SLOT), '(\\d+)')
      .replace(BEE_ANSWER_SLOT, '([^\\n]*?)'),
    flags,
  );
}
