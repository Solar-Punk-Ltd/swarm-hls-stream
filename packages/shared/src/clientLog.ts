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
const OUTCOME_SLOT = 'OUTCOMESLOT';
const ELAPSED_SLOT = 'ELAPSEDSLOT';

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
 *
 * ⭐ The guard over that is the fixed wording, which is all a test can hold. Of the interpolated values
 * only the rung is not a number, and by construction it cannot spell any of the four either: a
 * `swarm://` address is hex, and a preview playlist's blob url is a UUID. ⚠️ That blob url also carries
 * the page origin, so a viewer served from a host named after one of those words would forward every
 * line it wrote.
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

/** The bytes arrived and were handed to the player. */
export const FRAGMENT_LOADED = 'loaded';
/** The attempt failed. The byte source said no, or said nothing this client could use. */
export const FRAGMENT_ERRORED = 'errored';
/** The player stopped wanting this fragment before it arrived, on a level switch, a seek or a teardown. */
export const FRAGMENT_ABORTED = 'aborted';
/** The transport gave up waiting. Reachable on the gateway path only, which is the only one with a clock. */
export const FRAGMENT_TIMED_OUT = 'timeout';

/**
 * How one attempt at one fragment ended.
 *
 * A closed set, and closed on the CLIENT's side rather than the reader's: the client always knows which
 * of the four it is, because each one is a different callback. A reader is deliberately more tolerant,
 * so a word added here reaches a report as itself rather than being dropped on the way.
 */
export type FragmentOutcome =
  | typeof FRAGMENT_LOADED
  | typeof FRAGMENT_ERRORED
  | typeof FRAGMENT_ABORTED
  | typeof FRAGMENT_TIMED_OUT;

/**
 * Written once per fragment attempt, when that attempt stops being in flight, on either byte source.
 *
 * The other half of {@link fragmentRequested}, and the half that says what happened next. What only this
 * line can give is whether each attempt succeeded and what it cost. ⛔ It is NOT what separates six
 * fragments from one fragment asked for six times, which is the question a squeezed viewer's capped
 * stretch left open on 2026-09-01: the request line's own segment numbers answer that, and pairing the
 * two lines on level and segment number cannot, because a retry repeats that key by construction. The
 * pairing is a check that the two halves are describing the same fragments, and nothing beyond it.
 *
 * `elapsedMs` is a monotonic difference from the `load` call to this line, held per loader instance
 * because hls.js builds one loader per fragment.
 *
 * ⛔⛔ **The words `master`, `ladder`, `rung` and `Restarting` must stay out of this line**, for the
 * reason spelled out on {@link fragmentRequested}: the e2e harness forwards any page line carrying one
 * of them to the arm's stdout, and this message is written as often as that one. ⭐ It names no rung
 * for the same reason it needs none: the request line beside it already did.
 */
export function fragmentSettled(
  level: number | string,
  sn: number | string,
  // ⭐ The stand-ins are in the signature rather than cast in at the pattern builder, so a caller can
  // pass one of the four outcomes and nothing else. `level` and `sn` need no such narrowing: any string
  // is legal there, including {@link CLIENT_LOG_UNKNOWN}.
  outcome: FragmentOutcome | typeof OUTCOME_SLOT,
  elapsedMs: number | typeof ELAPSED_SLOT,
): string {
  // ⚠️ The unit is spaced off the number. Written `217ms` the elapsed group would have to be matched by
  // backtracking out of its own unit, and a value that was not a number would read as `laterms`.
  return `Fragment settled: level ${level} sn ${sn} ${outcome} after ${elapsedMs} ms`;
}

/**
 * {@link fragmentSettled} as a matcher: the level, the segment number, the outcome and the elapsed as
 * capture groups 1, 2, 3 and 4.
 *
 * Built the same way {@link fragmentRequestedPattern} is, and every group is `\S+` for the same reason.
 * ⚠️ That includes the elapsed, and it stays that way even though the client writes a rounded difference
 * on a monotonic clock and so should never produce anything but digits. A pattern that insisted would
 * drop the WHOLE line on any environment that surprised it, losing the outcome along with the duration.
 * The reader parses the number and says so where it cannot.
 */
export function fragmentSettledPattern(flags = ''): RegExp {
  const escaped = fragmentSettled(LEVEL_SLOT, SN_SLOT, OUTCOME_SLOT, ELAPSED_SLOT).replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(
    escaped
      .replace(LEVEL_SLOT, '(\\S+)')
      .replace(SN_SLOT, '(\\S+)')
      .replace(OUTCOME_SLOT, '(\\S+)')
      .replace(ELAPSED_SLOT, '(\\S+)'),
    flags,
  );
}
