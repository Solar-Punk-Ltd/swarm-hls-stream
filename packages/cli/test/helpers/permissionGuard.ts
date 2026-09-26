/**
 * Whether making a file read-only actually makes it unwritable for whoever is running the tests.
 *
 * It does for an ordinary user and it does not for root, which ignores the permission bits entirely.
 * A case that chmods a path and then asserts a refusal therefore has nothing to observe as root: the
 * write succeeds, no error is raised, and the assertion fails on a service that is behaving
 * correctly.
 *
 * ⚠️ `access(2)` answers for the REAL uid and gid rather than the effective ones, which is the
 * classic footgun and the reason Node's own documentation warns against `access` before `open`.
 * Inside a container both are 0 so the two readings agree, and this predicate takes the effective id
 * because that is what decides whether a write succeeds. Under a setuid binary or a dropped-privilege
 * path the two diverge and this would need saying again more carefully. Nothing here runs that way.
 */
export function unwritableIsEnforceable(effectiveUserId: number | undefined): boolean {
  return effectiveUserId !== 0;
}

/**
 * Why a case stood down, carried into the report so a skip is never read as a pass.
 *
 * Named rather than written at the one call site because `test/permissionGuard.test.ts` asserts it is
 * non-empty: node:test skips on a truthy `skip`, so an empty reason would quietly run the case again.
 */
const NO_REFUSAL_TO_OBSERVE =
  'runs as root, which ignores the permission bits this case makes the path unwritable with, so there is no refusal to observe';

/**
 * The skip decision for one effective user id: `false` runs the case, a string skips it with a reason.
 *
 * A function of the id rather than only the constant below, so both answers can be asserted on one
 * machine. The constant is read on a laptop that is never root and on a machine that always is, and
 * neither can exercise the other's branch.
 */
export function skipReasonFor(effectiveUserId: number | undefined): string | false {
  return unwritableIsEnforceable(effectiveUserId) ? false : NO_REFUSAL_TO_OBSERVE;
}

/**
 * Pass as a node:test `skip` option on any case that relies on a permission refusal.
 *
 * Skipped rather than silently passed on purpose: a case whose precondition is missing must never be
 * counted as evidence, so the count visibly drops there and stays whole everywhere else.
 *
 * ⛔ Why this exists. Some test runs happen in a container with no `--user`, so jobs run
 * as the image's default, root. Fourteen cases here failed there with "Missing expected exception"
 * while passing on GitHub's runners and on every laptop, and `pnpm -r test` stops at the first
 * failing package, so `packages/cli` failing took the deploy and stream-uploader suites down with it
 * and the run reported red having tested almost nothing.
 *
 * ⛔ Not a seam, deliberately. `assertEnvKeyWritable` calls the real `accessSync`, and as root a
 * read-only file genuinely is writable, so the check is correct and it is the test's premise that is
 * false. Injecting a filesystem would replace a real check with a proof that the code calls a
 * function, which is worth less than the case that is here.
 */
export const SKIP_WITHOUT_PERMISSION_ENFORCEMENT: string | false = skipReasonFor(process.geteuid?.());
