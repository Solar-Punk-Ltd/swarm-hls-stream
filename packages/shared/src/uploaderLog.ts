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
