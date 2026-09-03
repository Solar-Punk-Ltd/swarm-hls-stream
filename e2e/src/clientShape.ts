/**
 * Whether the client a stage actually serves was built from the client sources this harness was
 * checked out with.
 *
 * ⛔⛔⛔ The gap this closes is the client-side twin of the 2026-09-01 uploader sitting, and it has
 * been open the whole time. `deploy/scripts/bench-on-host.sh` syncs this repo to the host on every
 * run and does NOT rebuild the client image, so the harness can be new while the served client is
 * weeks old. Everything under `e2e/src/browser/` parses that client's behaviour: its console lines,
 * the fetch backend it publishes on `globalThis`, the weeb-3 worker it serves. A rename on either
 * side leaves the harness reading a client that never learned about it, and the reading blames the
 * product for a silence. `uploader-log-shape.ts` closed exactly this on the upload side after it
 * cost a paid sitting. Nothing closed it on the viewer side.
 *
 * ## Why a build stamp rather than a probe
 *
 * The uploader gate greps the container's built code for the log lines it parses, which works
 * because a composed message's fixed halves survive bundling as literals. A client bundle is minified
 * and tree-shaken, so the same trick answers about the wrong thing: a symbol the harness reads off
 * `globalThis` may be renamed, inlined or eliminated by the build. So the image records what it was
 * built FROM instead, as `git rev-parse HEAD:<path>` over the two packages vite compiles into the
 * bundle, and this compares that against what the run was launched from. Content hashes, so they
 * answer "the same sources" rather than "the same commit", and a rebuild from an unchanged tree
 * still matches.
 *
 * ⚠️ It proves the served client CAME FROM these sources, not that any particular symbol survived
 * the build. That is the right question: a harness reading a client built from its own sources is
 * reading a client it agrees with, and `packages/client/test/bundle.test.ts` is what holds the build
 * itself to what it must keep.
 */

/** What `bench-on-host.sh` carries in, computed on the operator's machine where `.git` exists. */
export const EXPECT_CLIENT_TREE = 'E2E_EXPECT_CLIENT_TREE';
export const EXPECT_SHARED_TREE = 'E2E_EXPECT_SHARED_TREE';
export const EXPECT_CLIENT_DIRTY = 'E2E_EXPECT_CLIENT_DIRTY';

/** Where the client image serves its stamp, on the viewer's own origin. */
export const BUILD_STAMP_PATH = '/build-stamp.json';

/** How much of a hash a summary line prints, enough to tell two builds apart at a glance. */
const SHORT_HASH_LENGTH = 12;

/**
 * What `deploy/Dockerfile.client` writes into `dist/build-stamp.json`.
 *
 * Unexported: callers take it by inference off {@link parseClientBuildStamp} and have no reason to
 * name it, and every export here is a promise something may import.
 */
interface ClientBuildStamp {
  readonly clientTree: string;
  readonly sharedTree: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly builtAt: string;
  readonly fetchBackend: string;
  readonly exposePlayer: string;
}

/** The two tree hashes and the dirty flag, from whichever side could answer. */
export interface ClientTrees {
  readonly clientTree: string;
  readonly sharedTree: string;
  readonly dirty: boolean;
}

/**
 * Named in the refusal, so a reader knows which side to correct: a stale expectation from the run
 * script is a resync, a stale one from this checkout is a git pull.
 */
type ExpectationSource = 'the run script' | 'this checkout';

export interface ClientShapeExpectation extends ClientTrees {
  readonly source: ExpectationSource;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The stamp a client served, or null when it served none.
 *
 * ⚠️ Null covers three cases deliberately, because the fix for all three is the same redeploy: a
 * body that is not JSON, a stamp missing its client tree, and a stamp whose client tree is empty.
 * The last is what an image built by a deploy script that passes none of the build args writes, and
 * the middle one is really the first: the SPA fallback answers a missing file with the app's own
 * HTML at 200, so an unstamped client returns a page rather than a 404.
 */
export function parseClientBuildStamp(body: string): ClientBuildStamp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const stamp = parsed as Record<string, unknown>;
  if (!isNonEmptyString(stamp.clientTree)) {
    return null;
  }

  return {
    clientTree: stamp.clientTree,
    sharedTree: isNonEmptyString(stamp.sharedTree) ? stamp.sharedTree : '',
    head: isNonEmptyString(stamp.head) ? stamp.head : '',
    dirty: stamp.dirty === true,
    builtAt: isNonEmptyString(stamp.builtAt) ? stamp.builtAt : '',
    fetchBackend: isNonEmptyString(stamp.fetchBackend) ? stamp.fetchBackend : '',
    exposePlayer: isNonEmptyString(stamp.exposePlayer) ? stamp.exposePlayer : '',
  };
}

/**
 * What the served client is measured against, or null when nothing can say.
 *
 * ⛔ The run script wins over git, because it is the only side that can be right on the deployment
 * host: `bench-on-host.sh` excludes `.git` from its rsync, so a harness there has no history to ask.
 * An empty variable is an unanswered question rather than an expectation of an empty tree.
 */
export function readClientShapeExpectation(
  env: Record<string, string | undefined>,
  readGitTrees: () => ClientTrees | null,
): ClientShapeExpectation | null {
  const fromScript = env[EXPECT_CLIENT_TREE];
  if (isNonEmptyString(fromScript)) {
    return {
      clientTree: fromScript,
      sharedTree: env[EXPECT_SHARED_TREE] ?? '',
      dirty: env[EXPECT_CLIENT_DIRTY] === '1',
      source: 'the run script',
    };
  }

  const fromGit = readGitTrees();
  return fromGit === null ? null : { ...fromGit, source: 'this checkout' };
}

const NO_EXPECTATION =
  'This run cannot say which client sources it expects, so it refuses rather than passing: an ' +
  'unknown expectation is not a match. A run launched through `deploy/scripts/bench-on-host.sh` ' +
  `carries ${EXPECT_CLIENT_TREE}, ${EXPECT_SHARED_TREE} and ${EXPECT_CLIENT_DIRTY} into the ` +
  'container, and a run from a checkout reads them out of git. This one had neither, so either ' +
  'launch it through that script or run it from a checkout with its history.';

const REDEPLOY = 'Redeploy the client (`deploy/scripts/deploy.sh client`) and run again.';

function noStampRefusal(): string {
  return (
    `The client this stage serves has no readable ${BUILD_STAMP_PATH}, so it predates the build ` +
    'stamp and there is no way to tell which sources a viewer is being served. ' +
    `${REDEPLOY} ⛔ Do NOT skip this check instead, which buys a green run against a client ` +
    'nobody can identify.'
  );
}

function dirtyRefusal(expectation: ClientShapeExpectation, stamp: ClientBuildStamp): string {
  const side = stamp.dirty
    ? 'The client on this stage was BUILT from uncommitted sources'
    : `The expectation from ${expectation.source} was taken from uncommitted sources`;

  return (
    `${side}, so the tree hashes on both sides describe something other than what is running. ` +
    'They can match exactly and still mean nothing, which is why this refuses on a match. ' +
    'Please commit or stash the changes to `packages/client`, `packages/shared`, ' +
    '`deploy/Dockerfile.client` or `deploy/client-nginx.conf.template`, then redeploy the client ' +
    'and resync the harness.'
  );
}

function staleRefusal(expectation: ClientShapeExpectation, stamp: ClientBuildStamp): string {
  const rows = [
    `  - client sources: serving ${stamp.clientTree}, ${expectation.source} has ${expectation.clientTree}`,
    `  - shared sources: serving ${stamp.sharedTree}, ${expectation.source} has ${expectation.sharedTree}`,
    `  - the serving client was built at commit ${stamp.head} on ${stamp.builtAt}`,
  ].join('\n');

  return (
    'The client this stage serves is stale: it was not built from the sources this harness was ' +
    `checked out with.\n${rows}\n` +
    'Every viewer assertion is read out of that client, so a run against it measures a client ' +
    `nobody is shipping. ${REDEPLOY} ⛔ Do NOT loosen what the harness reads to match the old ` +
    'client instead, which is the tempting fix and buys a green run against dead code.'
  );
}

/** Why a stage cannot be measured, or null. */
export function clientShapeRefusal(expectation: ClientShapeExpectation | null, stampBody: string): string | null {
  if (expectation === null) {
    return NO_EXPECTATION;
  }

  const stamp = parseClientBuildStamp(stampBody);
  if (stamp === null) {
    return noStampRefusal();
  }
  if (stamp.dirty || expectation.dirty) {
    return dirtyRefusal(expectation, stamp);
  }
  if (stamp.clientTree !== expectation.clientTree || stamp.sharedTree !== expectation.sharedTree) {
    return staleRefusal(expectation, stamp);
  }

  return null;
}

/** What a passing check is worth saying, so a green preflight still reports what it proved. */
export function clientShapeSummary(expectation: ClientShapeExpectation, stamp: ClientBuildStamp | null): string {
  const short = (hash: string) => hash.slice(0, SHORT_HASH_LENGTH) || 'unknown';

  return (
    `served client built from client ${short(stamp?.clientTree ?? expectation.clientTree)} and ` +
    `shared ${short(stamp?.sharedTree ?? expectation.sharedTree)} at ${stamp?.builtAt || 'an unrecorded time'}`
  );
}
