import { introducedVersions, splitVersion } from './lockfileVersions.js';
import { describe, run } from './run.js';
import type { FactGroup } from './types.js';

/** Registry lookups are independent, and doing 200 of them one at a time is the slow way. */
const REGISTRY_CONCURRENCY = 12;

/** Under this, the owner's dependency rule treats a version as a flag rather than a routine bump. */
const FRESH_DAYS = 30;

const REGISTRY_TIMEOUT_MS = 60 * 1000;

/**
 * `unreadable` is a third state on purpose, and it is not a synonym for unsigned.
 *
 * A lookup that errors means the registry did not answer the question. Folding that into "not
 * signed" invents a security finding out of a network blip or a malformed spec, and folding it into
 * "signed" hides a real one. Neither is acceptable, so it is reported as itself.
 */
type SignatureState = 'signed' | 'unsigned' | 'unreadable';

interface VersionProvenance {
  spec: string;
  ageDays: number | null;
  signature: SignatureState;
  attested: boolean;
}

/**
 * `npm view <pkg>@<ver> dist --json` must be asked for `dist` and nothing else.
 *
 * Requesting two fields makes npm flatten the result to the top level, so `.signatures` and
 * `.attestations` come back undefined and every package in the tree reports as unsigned. That
 * produces a confidently wrong all-clear, which is why it is a named trap in the owner's rule.
 */
async function readDist(spec: string): Promise<{ signature: SignatureState; attested: boolean }> {
  const result = await run('npm', ['view', spec, 'dist', '--json'], REGISTRY_TIMEOUT_MS);
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
    return published ? Math.round((Date.now() - Date.parse(published)) / 86_400_000) : null;
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

/** Long lists are the normal case here, and pasting 120 specs into a pull request body helps nobody. */
const MAX_LISTED = 8;

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
  unattested: string;
  fresh: string;
  freshAndUnattested: string;
  /** True when something needs a decision rather than a glance: an unsigned package or a failed lookup. */
  needsAttention: boolean;
}

export function summarise(entries: readonly VersionProvenance[]): ProvenanceSummary {
  const unsigned = entries.filter((e) => e.signature === 'unsigned');
  const unreadable = entries.filter((e) => e.signature === 'unreadable');
  const unattested = entries.filter((e) => !e.attested && e.signature !== 'unreadable');
  const fresh = entries.filter((e) => e.ageDays !== null && e.ageDays < FRESH_DAYS);
  const withAge = (e: VersionProvenance) => `${e.spec} (${e.ageDays}d)`;
  const spec = (e: VersionProvenance) => e.spec;

  return {
    introduced: String(entries.length),
    unsigned: list(unsigned, spec),
    unreadable: list(unreadable, spec),
    unattested: `${unattested.length} of ${entries.length}${
      unattested.length > 0 ? `, ${list(unattested, spec)}` : ''
    }`,
    fresh: list(fresh, withAge),
    freshAndUnattested: list(
      fresh.filter((e) => !e.attested),
      withAge,
    ),
    needsAttention: unsigned.length > 0 || unreadable.length > 0,
  };
}

/**
 * Publish age, signature and SLSA provenance for every version this change introduces.
 *
 * Absent when the lockfile did not move, because the sweep costs two registry calls per version and
 * a change that adds no dependency has nothing to report. `npm audit signatures` is deliberately not
 * collected here: it reads the installed tree rather than the diff, so its count moves with whatever
 * was installed most recently and quoting it as evidence for a change is a mistake this project has
 * already made.
 */
export async function collectProvenance(base: string, head: string): Promise<FactGroup | null> {
  const baseLock = await run('git', ['show', `${base}:pnpm-lock.yaml`]);
  const headLock = await run('git', ['show', `${head}:pnpm-lock.yaml`]);
  const introduced = introducedVersions(baseLock.stdout, headLock.stdout);
  if (introduced.length === 0) {
    return null;
  }

  const summary = summarise(await provenanceFor(introduced));
  const command = describe('npm', ['view', '<pkg>@<ver>', 'dist', '--json']);

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
      { key: 'without SLSA provenance', value: summary.unattested, command },
      {
        key: `published under ${FRESH_DAYS} days ago`,
        value: summary.fresh,
        command: describe('npm', ['view', '<pkg>', 'time', '--json']),
      },
      { key: 'fresh AND unattested', value: summary.freshAndUnattested, command },
    ],
  };
}
