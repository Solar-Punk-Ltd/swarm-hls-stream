import { collectChecks } from './collectChecks.js';
import { collectDiff } from './collectDiff.js';
import { collectProvenance } from './collectProvenance.js';
import { formatFacts, hasFailure } from './formatFacts.js';
import { run } from './run.js';
import type { GateFacts } from './types.js';

const DEFAULT_BASE = 'feat/ai-hardening';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function resolveHead(): Promise<string> {
  const explicit = argValue('--head');
  if (explicit) {
    return explicit;
  }
  const result = await run('git', ['rev-parse', '--short', 'HEAD']);
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const base = argValue('--base') ?? DEFAULT_BASE;
  const head = await resolveHead();

  // The diff is collected first because it is fast and it decides whether the slow ones are owed.
  const diff = await collectDiff(base, head);
  const repoRoot = process.cwd();
  const [checks, provenance] = await Promise.all([collectChecks(repoRoot), collectProvenance(base, head)]);

  const facts: GateFacts = {
    base,
    head,
    groups: [diff, checks, ...(provenance ? [provenance] : [])],
    authorMeasured: [],
  };

  console.log(formatFacts(facts));

  if (hasFailure(facts)) {
    // A non-zero exit here means a collected check failed, not that collection failed. The artifact
    // is still printed above, because a reviewer needs to see which row it was.
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`Gate facts could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
