import type { PublisherRoute } from './harness/publishers.js';

/**
 * Does the stage publish each rung through the node its configuration says it does?
 *
 * ## ⛔⛔⛔ Why this is a gate
 *
 * Every rung of the ladder was published through one shared Bee node, for the whole life of the
 * project up to 2026-08-31. Nothing refused it and nothing reported it: the stage transcoded four
 * renditions, four feeds advanced, four playlists were written, and the only difference from a split
 * stage was upstream of everything anyone measured. A note recording that the split had never
 * happened sat in memory and was read as a caveat on the numbers rather than as the reason the
 * numbers were wrong, and eleven live arms were scored against viewer behaviour while the shared
 * publisher was the constraint.
 *
 * A threshold you wrote down is not a control. So: the deployment declares a shape in
 * BEE_PUBLISHERS, the uploader reports the shape it is running on `/health`, and a sitting does not
 * start unless the two agree. The verdict lives here rather than in the suite because nothing under
 * `suites/` runs in CI, and its rules are covered by `test/publisherRouting.test.ts`.
 *
 * ## What is compared, and what is not
 *
 * Rung names, and each node's `host:port`. Never whole url strings: the live url has had any userinfo
 * removed and its query redacted before it reaches the wire, so it is not always byte-identical to
 * what was configured, while `host:port` survives both and is what decides which node a rung pays
 * through.
 *
 * Batch ids are not compared either. The live one is truncated to eight characters by design, and the
 * uploader already refuses to start on a batch that is malformed, full, expired or unusable.
 */
export interface RoutingFacts {
  /** BEE_PUBLISHERS exactly as the deployment's env file has it. Empty means an unsplit deployment. */
  declared: string;
  abrEnabled: boolean;
  /** Rung names from ABR_LADDER, or from the default both sides fall back to. */
  abrRungs: readonly string[];
  /** What `/health` reported, or undefined from a build that predates the field. */
  live: readonly PublisherRoute[] | undefined;
}

/**
 * What `BeePublisherPool.single` names the one publisher of an unsplit deployment. Not a rung: every
 * rung. Mirrors `SINGLE_PUBLISHER` in `packages/stream-uploader/src/libs/BeePublisherPool.ts`.
 */
const SINGLE_PUBLISHER = 'all';

interface DeclaredEntry {
  rung: string;
  url: string;
}

/** Null when the stage may run. A string is the refusal, written to be acted on without a lookup. */
export function publisherRoutingRefusal(facts: RoutingFacts): string | null {
  const { declared, abrEnabled, abrRungs, live } = facts;

  if (live === undefined || live.length === 0) {
    return (
      'the uploader did not report its publisher routing on /health. That is not a deployment with ' +
      'no publishers, it is a deployment that cannot say which node carries which rung, and the two ' +
      'must not be read the same way. `publishers` was added to the health body when the per-rung ' +
      'split landed, so this is a build from before it: redeploy the uploader.'
    );
  }

  const isUnsplitLive = live.length === 1 && live[0].rung === SINGLE_PUBLISHER;

  if (declared.trim() === '') {
    if (isUnsplitLive) {
      return null;
    }
    return (
      `BEE_PUBLISHERS is empty in the deployment's env, but the uploader is running ${nodeCount(live)} ` +
      `node(s) across ${live.length} rung(s): ${describeRouting(live)}. The container is therefore ` +
      'running an environment the env file no longer describes, so the next deploy or restart will ' +
      'silently change which node each rung pays through. Put the running routing back into ' +
      'BEE_PUBLISHERS, or restart the uploader to adopt the file.'
    );
  }

  let entries: DeclaredEntry[];
  try {
    entries = readDeclaration(declared);
  } catch (error) {
    return `BEE_PUBLISHERS cannot be read: ${(error as Error).message}`;
  }

  if (!abrEnabled) {
    return (
      `BEE_PUBLISHERS declares ${entries.length} per-rung node(s) but ABR_ENABLED is false, so there ` +
      'is no ladder to map them onto. The uploader refuses to start in this state. Either turn the ' +
      'ladder on for this profile or clear BEE_PUBLISHERS.'
    );
  }

  if (isUnsplitLive) {
    return (
      `BEE_PUBLISHERS declares ${nodeCount(entries)} node(s) for ${entries.length} rung(s), and the ` +
      'uploader is running one node for every rung. This is the failure that reads as nothing at all: ' +
      'the ladder still transcodes, four feeds still advance, and every measurement taken off the ' +
      'stage looks exactly like a split one while a single node carries the whole upload rate. ' +
      'The container predates the current env file, so restart the uploader to adopt it: ' +
      '`deploy/scripts/deploy.sh --profile=<profile> stream-uploader`.'
    );
  }

  const declaredRungs = new Set(entries.map((entry) => entry.rung));
  const liveRungs = new Set(live.map((route) => route.rung));

  const missing = [...declaredRungs].filter((rung) => !liveRungs.has(rung));
  if (missing.length > 0) {
    return (
      `rung(s) ${missing.join(', ')} are declared but not live. BEE_PUBLISHERS names them and the ` +
      `uploader is routing ${[...liveRungs].join(', ')}, so the container is running an older ` +
      'environment. Restart the uploader to adopt the env file.'
    );
  }

  const unexpected = [...liveRungs].filter((rung) => !declaredRungs.has(rung));
  if (unexpected.length > 0) {
    return (
      `rung(s) ${unexpected.join(', ')} are live but not declared. The uploader is routing them and ` +
      'BEE_PUBLISHERS does not name them, so the env file is behind the container and the next ' +
      'restart will drop them onto whichever node the fallback picks.'
    );
  }

  const declaredHostOf = new Map(
    entries.map((entry) => [entry.rung, hostOf(entry.url, `BEE_PUBLISHERS ${entry.rung}`)]),
  );
  for (const route of live) {
    const declaredHost = declaredHostOf.get(route.rung);
    const liveHost = hostOf(route.url, `the live route for ${route.rung}`);
    if (declaredHost !== liveHost) {
      return (
        `rung ${route.rung} is declared on ${declaredHost} and is running on ${liveHost}. It is ` +
        'therefore spending a postage batch that was not sized for it, and the rung that should be ' +
        'on that node is spending one sized for this one. Restart the uploader to adopt the env file.'
      );
    }
  }

  const unrouted = abrRungs.filter((rung) => !liveRungs.has(rung));
  if (unrouted.length > 0) {
    return (
      `ABR_LADDER has rung(s) ${unrouted.join(', ')} that nothing routes. The uploader refuses to ` +
      'start with a BEE_PUBLISHERS that does not cover the ladder, so this is a ladder that has ' +
      'grown since the container started. Restart the uploader, or add the rung to BEE_PUBLISHERS.'
    );
  }

  return null;
}

/** One line naming every rung, its node and its batch, for the run log whether or not it refuses. */
export function describeRouting(live: readonly PublisherRoute[]): string {
  const routes = live.map((route) => `${route.rung}→${route.url} [${route.batch}]`).join(', ');
  return `${nodeCount(live)} node(s): ${routes}`;
}

function nodeCount(routes: readonly { url: string }[]): number {
  return new Set(routes.map((route) => route.url)).size;
}

/**
 * Rung and url out of each `rung@url<batch>` entry, and nothing else.
 *
 * Deliberately a reader for comparison and never a validator. `parsePublisherSpecs` in the uploader
 * is the validator, it runs at startup, and it refuses the process rather than the run, so a second
 * copy of its rules here would be one more thing to keep in step for no gain. Split on the **first**
 * `@` and the **last** bracket, which is what the uploader does, so a url carrying userinfo or a port
 * survives intact.
 */
function readDeclaration(declared: string): DeclaredEntry[] {
  return declared
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('@');
      const open = entry.endsWith('>') ? entry.lastIndexOf('<') : entry.lastIndexOf('#');
      const close = entry.endsWith('>') ? entry.length - 1 : entry.length;
      if (at <= 0 || open <= at + 1 || open >= close - 1) {
        throw new Error(`entry "${entry}" is not rung@url<batch>`);
      }
      return { rung: entry.slice(0, at), url: entry.slice(at + 1, open) };
    });
}

/** `host:port`, which is unaffected by the credential stripping the live url has already had. */
function hostOf(url: string, subject: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(`${subject} is not a url: "${url}"`);
  }
}
