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

async function main(): Promise<void> {
  const base = argValue('--base') ?? DEFAULT_BASE;
  const supplied = argValue('--head');
  // Resolved rather than echoed, so the artifact names a commit and not a branch that has since moved.
  const resolved = await run('git', ['rev-parse', '--short', supplied ?? 'HEAD']);
  if (resolved.exitCode !== 0) {
    throw new Error(`could not resolve ${supplied ?? 'HEAD'}: ${resolved.stderr.trim()}`);
  }
  const head = resolved.stdout.trim();

  // The diff is collected first because it is fast and it decides whether the slow ones are owed.
  const diff = await collectDiff(base, head);
  const [checks, provenance] = await Promise.all([collectChecks(process.cwd()), collectProvenance(base, head)]);

  const facts: GateFacts = {
    base,
    head,
    headSupplied: supplied !== undefined,
    groups: [diff, checks, ...(provenance ? [provenance] : [])],
    authorMeasured: [],
  };

  console.log(formatFacts(facts));

  if (hasFailure(facts)) {
    // A non-zero exit here means a collected check failed for a reason not already registered. The
    // artifact is still printed above, because a reviewer needs to see which row it was.
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // A collector that could not measure must never fall through to a clean-looking artifact. Nothing
  // is printed, and the exit code says so.
  console.error(`Gate facts could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
