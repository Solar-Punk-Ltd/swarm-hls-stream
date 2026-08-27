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
