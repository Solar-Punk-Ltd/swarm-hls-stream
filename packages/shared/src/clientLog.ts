/**
 * Log messages the CLIENT writes to the browser console that something else parses back.
 *
 * ⛔ These are a contract, not prose. The e2e harness listens to a viewer's console through Playwright
 * and counts what it recognises, so a reworded message is a silently empty parse and an arm that
 * reports a player which asked for nothing across a run where it asked for hundreds of fragments.
 * `uploaderLog.ts` is the same idea on the upload side, and its docblocks record what a blind parse
 * has already cost this project.
 *
 * One definition, so the producer and the reader cannot drift apart. See ARCH-1.
 */

/** Regex metacharacters, escaped so a composed message is matched as the literal text it is. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Stand-ins the pattern builder substitutes capture groups for.
 *
 * Alphabetic and distinctive: they have to survive escaping unchanged and must not occur anywhere
 * else in the composed message, or the substitution would land in the literal half.
 */
const LEVEL_SLOT = 'LEVELSLOT';
const SN_SLOT = 'SNSLOT';
const RUNG_SLOT = 'RUNGSLOT';

/**
 * What a composer writes where the client could not read the value.
 *
 * ⛔ A word rather than a number, because every numeric stand-in for "unreadable" is also a legal
 * value of the thing it stands in for. A level index of -1 is hls.js's own word for automatic, and a
 * reader that took it as a level would report a rung nobody ever asked for.
 */
export const CLIENT_LOG_UNKNOWN = 'unknown';

/**
 * Written once per fragment hls.js asks the client's loader for, on either byte source.
 *
 * The one reading nothing else in this project can give: which LEVEL the player is requesting. What
 * a viewer decodes, what ABR says it would pick next and what the player's bandwidth estimate is are
 * all read off the shipped overlay, and none of them says which rung the fragments in flight belong
 * to. A player riding a rung it cannot afford and a player asking for a cheaper rung that something
 * upstream answers with the expensive one look identical in every other instrument.
 *
 * `rung` is the fragment's own playlist address rather than its url. Every segment url this client
 * plays is `<gateway>/bytes/<reference>`, and a Swarm reference names no rendition.
 *
 * ⛔⛔ **The words `master`, `ladder`, `rung` and `Restarting` must stay out of this line.** The e2e
 * harness's `openViewer` forwards any page line carrying one of them to the arm's stdout, and the arm
 * log then collapses distinct lines to sixty kinds. This message is written several times a second
 * and every copy is distinct, so a rewording that reached that filter would push every other thing the
 * client said out of the arm log. That is the failure `reportArmNarration` was written to end.
 */
export function fragmentRequested(level: number | string, sn: number | string, rung: string): string {
  return `Fragment requested: level ${level} sn ${sn} of ${rung}`;
}

/**
 * {@link fragmentRequested} as a matcher: the level, the segment number and the rung as capture
 * groups 1, 2 and 3.
 *
 * Built by running the composer on placeholders and escaping everything around them, so the literal
 * text is never written twice and a reworded message cannot leave the reader matching nothing. A
 * caller wanting every match supplies its own `g`.
 *
 * ⚠️ Every group is `\S+` rather than `\d+`, including the level. A segment number is legally the
 * word `initSegment`, and either slot is legally {@link CLIENT_LOG_UNKNOWN}. A pattern that demanded
 * digits would skip exactly the lines worth noticing and report the run as quieter than it was.
 */
export function fragmentRequestedPattern(flags = ''): RegExp {
  const escaped = fragmentRequested(LEVEL_SLOT, SN_SLOT, RUNG_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(
    escaped.replace(LEVEL_SLOT, '(\\S+)').replace(SN_SLOT, '(\\S+)').replace(RUNG_SLOT, '(\\S+)'),
    flags,
  );
}
