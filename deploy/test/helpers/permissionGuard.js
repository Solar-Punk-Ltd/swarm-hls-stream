/**
 * Whether making a path read-only actually stops whoever is running the tests from writing it.
 *
 * It does for an ordinary user and it does not for root, which ignores the permission bits entirely.
 * A case that chmods a path and then asserts a refusal therefore has nothing to observe as root: the
 * write succeeds, no refusal is printed, and the assertion fails on a script that is behaving
 * correctly.
 *
 * ⛔ Reach for this LAST. A refusal that is reachable another way should be reached another way, and
 * this suite already has two levers that work whatever the account: stub the external tool the script
 * calls so it exits non-zero, or point the path somewhere that cannot be opened for writing at all.
 * Both keep the case running on the verification box, and a skip does not. This is for the writes
 * with no lever left, which here means a shell redirect onto a path the script has already read.
 */
export function unwritableIsEnforceable(effectiveUserId) {
  return effectiveUserId !== 0;
}

/** Why a case stood down, non-empty because node:test skips on a truthy `skip` and '' would run it. */
const NO_REFUSAL_TO_OBSERVE =
  'runs as root, which ignores the permission bits this case makes the path unwritable with, so there is no refusal to observe';

/**
 * The skip decision for one effective user id: `false` runs the case, a string skips it with a reason.
 *
 * A function of the id rather than only the constant below, so both answers can be asserted on one
 * machine. The constant is read on a laptop that is never root and on a box that always is, and
 * neither can exercise the other's branch.
 */
export function skipReasonFor(effectiveUserId) {
  return unwritableIsEnforceable(effectiveUserId) ? false : NO_REFUSAL_TO_OBSERVE;
}

/**
 * Pass as a node:test `skip` option on a case that has no refusal to observe without permission bits.
 *
 * Skipped rather than silently passed: a case whose precondition is missing must never count as
 * evidence, so the box's count visibly drops there and stays whole everywhere else.
 *
 * ⛔ The verification box runs each job in a container with no `--user`, so jobs run as root. This is
 * the fourth place in this repository that assumed otherwise, after Docker detection, Chrome refusing
 * as root, and fourteen cases in packages/cli. The cli helper is the same three lines for the same
 * reason, kept separate only because that package's tests run through tsx and these run under plain
 * node. Change one and read the other.
 */
export const SKIP_WITHOUT_PERMISSION_ENFORCEMENT = skipReasonFor(process.geteuid?.());
