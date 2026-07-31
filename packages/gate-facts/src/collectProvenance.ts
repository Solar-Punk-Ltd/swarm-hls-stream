import { introducedVersions, splitVersion } from './lockfileVersions.js';
import { describe, run } from './run.js';
import { CollectionError, type FactGroup } from './types.js';

/** Registry lookups are independent, and doing 200 of them one at a time is the slow way. */
const REGISTRY_CONCURRENCY = 12;

/** Under this, the owner's dependency rule treats a version as a flag rather than a routine bump. */
const FRESH_DAYS = 30;

const REGISTRY_TIMEOUT_MS = 60 * 1000;

/** Long lists are the normal case here, and pasting 120 specs into a pull request body helps nobody. */
const MAX_LISTED = 8;

/**
 * `unreadable` is a third state on purpose, and it is not a synonym for unsigned.
 *
 * A lookup that errors means the registry did not answer the question. Folding that into "not
 * signed" invents a security finding out of a network blip, and folding it into "signed" hides a
 * real one. Neither is acceptable, so it is reported as itself.
 */
export type SignatureState = 'signed' | 'unsigned' | 'unreadable';

/** Age gets the same treatment, for the same reason. `null` means the date was never read. */
export interface VersionProvenance {
  spec: string;
  ageDays: number | null;
  signature: SignatureState;
  attested: boolean;
}

/**
 * The arguments for the provenance lookup, exported so a test can pin them.
 *
 * `dist` must be the ONLY field requested. Asking for two makes npm flatten the result to the top
 * level, so `.signatures` and `.attestations` come back undefined and every package in the tree
 * reports as unsigned. That is a named trap in the owner's dependency rule, and nothing but this
 * constant and its test stands between a future edit and reintroducing it.
 */
export function distArgs(spec: string): string[] {
  return ['view', spec, 'dist', '--json'];
}

async function readDist(spec: string): Promise<{ signature: SignatureState; attested: boolean }> {
  const result = await run('npm', distArgs(spec), REGISTRY_TIMEOUT_MS);
  try {
    const dist = JSON.parse(result.stdout) as {
      signatures?: unknown[];
      attestations?: { provenance?: unknown };
    };
    return {
      signature: Array.isArray(dist.signatures) && dist.signatures.length > 0 ? 'signed' : 'unsigned',
      attested: dist.attestations?.provenance !== undefined,
    };
  } catch {
    return { signature: 'unreadable', attested: false };
  }
}

async function readAgeDays(name: string, version: string): Promise<number | null> {
  const result = await run('npm', ['view', name, 'time', '--json'], REGISTRY_TIMEOUT_MS);
  try {
    const times = JSON.parse(result.stdout) as Record<string, string>;
    const published = times[version];
    if (!published) {
      return null;
    }
    const days = Math.round((Date.now() - Date.parse(published)) / 86_400_000);
    // An unparseable date yields NaN, which loses every comparison and would drop the version out of
    // the fresh bucket while reporting nothing. Unknown is a state, not a number.
    return Number.isFinite(days) ? days : null;
  } catch {
    return null;
  }
}

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  }
  return results;
}

async function provenanceFor(specs: readonly string[]): Promise<VersionProvenance[]> {
  return inBatches(specs, REGISTRY_CONCURRENCY, async (spec) => {
    const { name, version } = splitVersion(spec);
    const [ageDays, dist] = await Promise.all([readAgeDays(name, version), readDist(spec)]);
    return { spec, ageDays, ...dist };
  });
}

function list(entries: readonly VersionProvenance[], label: (e: VersionProvenance) => string): string {
  if (entries.length === 0) {
    return 'none';
  }
  const shown = entries.slice(0, MAX_LISTED).map(label);
  const remainder = entries.length - shown.length;
  // Say what was dropped. A truncated list that does not admit it reads as the whole set.
  return `${entries.length}: ${shown.join(', ')}${remainder > 0 ? `, and ${remainder} more` : ''}`;
}

export interface ProvenanceSummary {
  introduced: string;
  unsigned: string;
  unreadable: string;
  ageUnknown: string;
  unattested: string;
  fresh: string;
  freshAndUnattested: string;
  /** True when something was not measured or came back bad, either of which needs a decision. */
  needsAttention: boolean;
}

export function summarise(entries: readonly VersionProvenance[]): ProvenanceSummary {
  const unsigned = entries.filter((e) => e.signature === 'unsigned');
  const unreadable = entries.filter((e) => e.signature === 'unreadable');
  const ageUnknown = entries.filter((e) => e.ageDays === null);
  const readable = entries.filter((e) => e.signature !== 'unreadable');
  const unattested = readable.filter((e) => !e.attested);
  const fresh = entries.filter((e) => e.ageDays !== null && e.ageDays < FRESH_DAYS);
  const withAge = (e: VersionProvenance) => `${e.spec} (${e.ageDays}d)`;
  const spec = (e: VersionProvenance) => e.spec;

  return {
    introduced: String(entries.length),
    unsigned: list(unsigned, spec),
    unreadable: list(unreadable, spec),
    ageUnknown: list(ageUnknown, spec),
    // Denominator counts only what was read. Dividing by the whole set implies the difference was
    // checked and found attested, when it was never checked at all.
    unattested: `${unattested.length} of ${readable.length} read${
      unattested.length > 0 ? `, ${list(unattested, spec)}` : ''
    }`,
    fresh: list(fresh, withAge),
    freshAndUnattested: list(
      fresh.filter((e) => !e.attested),
      withAge,
    ),
    needsAttention: unsigned.length > 0 || unreadable.length > 0 || ageUnknown.length > 0,
  };
}

/** Neither of these is collected here, and both are still owed on any lockfile change. */
export const UNCOLLECTED_DEPENDENCY_CHECKS =
  '`npm audit signatures` (reads the installed tree, not the diff) and `gh api /advisories?type=malware`';

/**
 * Publish age, signature and SLSA provenance for every version this change introduces.
 *
 * Returns null when the lockfile did not move. A failed read is a thrown `CollectionError` rather
 * than a null, because "no dependency changed" and "I could not tell" must not render the same.
 *
 * This covers two of the owner's four dependency checks. The other two are named in the artifact
 * rather than left out silently, because a section that lists some checks reads as listing all of
 * them, and the auditor is told not to re-derive what the block already emits.
 */
export async function collectProvenance(base: string, head: string): Promise<FactGroup | null> {
  const lockAt = async (ref: string): Promise<string> => {
    const result = await run('git', ['show', `${ref}:pnpm-lock.yaml`]);
    if (result.exitCode !== 0) {
      throw new CollectionError(
        describe('git', ['show', `${ref}:pnpm-lock.yaml`]),
        result.stderr.trim() || `exit ${result.exitCode}`,
      );
    }
    return result.stdout;
  };

  const baseLock = await lockAt(base);
  const headLock = await lockAt(head);
  if (baseLock === headLock) {
    // The group is absent only when the lockfile is untouched. A lockfile that moved and introduced
    // nothing is a different fact and gets a row saying so, because an absent group and a clean one
    // would otherwise read the same.
    return null;
  }

  const introduced = introducedVersions(baseLock, headLock);
  if (introduced.length === 0) {
    return {
      title: 'Provenance of introduced versions',
      facts: [
        {
          key: 'versions introduced',
          value: '0, though the lockfile did change. Nothing new resolved, so there is nothing to check.',
          command: describe('git', ['diff', `${base}..${head}`, '--', 'pnpm-lock.yaml']),
        },
      ],
    };
  }

  const summary = summarise(await provenanceFor(introduced));
  const command = describe('npm', distArgs('<pkg>@<ver>'));

  return {
    title: 'Provenance of introduced versions',
    facts: [
      {
        key: 'versions introduced',
        value: summary.introduced,
        command: describe('git', ['show', `${head}:pnpm-lock.yaml`]),
      },
      { key: 'unsigned', value: summary.unsigned, command, failed: summary.unsigned !== 'none' },
      { key: 'registry lookup failed', value: summary.unreadable, command, failed: summary.unreadable !== 'none' },
      {
        key: 'publish date not read',
        value: summary.ageUnknown,
        command: describe('npm', ['view', '<pkg>', 'time', '--json']),
        failed: summary.ageUnknown !== 'none',
      },
      { key: 'without SLSA provenance', value: summary.unattested, command },
      {
        key: `published under ${FRESH_DAYS} days ago`,
        value: summary.fresh,
        command: describe('npm', ['view', '<pkg>', 'time', '--json']),
      },
      { key: 'fresh AND unattested', value: summary.freshAndUnattested, command },
      {
        key: 'NOT collected here, still owed',
        value: UNCOLLECTED_DEPENDENCY_CHECKS,
        command: 'run both by hand on any lockfile change',
      },
    ],
  };
}
