import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { countAdvisoryFindings, missingTotalsVerdict } from '../src/collectChecks.js';
import { totalLines } from '../src/collectDiff.js';
import { distArgs, summarise, type VersionProvenance } from '../src/collectProvenance.js';
import { formatFacts, hasFailure } from '../src/formatFacts.js';
import { introducedVersions, lockfileVersions, splitVersion } from '../src/lockfileVersions.js';
import { formatSuiteCounts, parseSuiteCounts } from '../src/parseSuiteCounts.js';
import { mutationApplicability, surfacesTouched } from '../src/surfaces.js';
import type { GateFacts } from '../src/types.js';
import { packagesMissingTotals, packagesWithTests } from '../src/workspacePackages.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The directories under `parent`, read from disk so a package added later is checked too. */
function directoriesUnder(parent: string): string[] {
  return readdirSync(join(REPO_ROOT, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

/** Read here rather than through the package, so the tests do not grade the package with its own answer. */
function manifestHasTestScript(dir: string): boolean {
  const path = join(REPO_ROOT, dir, 'package.json');
  if (!existsSync(path)) {
    return false;
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> };
  return typeof manifest.scripts?.test === 'string';
}

/**
 * The `packages` list of `pnpm-workspace.yaml`, read line by line because the package has no YAML
 * dependency. It stops at the first line that is not a list item, which is where the list ends.
 */
function workspaceEntries(): string[] {
  const lines = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.indexOf('packages:');
  assert.notEqual(start, -1, 'pnpm-workspace.yaml has no packages list');
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+['"]?([^'"]+?)['"]?\s*$/.exec(line);
    if (!item) {
      break;
    }
    entries.push(item[1]);
  }
  return entries;
}

describe('parseSuiteCounts', () => {
  it('reads the TAP totals every node:test package prints', () => {
    // Deliberately NOT a full-pass suite. When tests and passed are equal, swapping which capture
    // group feeds which field is invisible, and a fixture that cannot see that swap pins nothing.
    const output = [
      'packages/cli test: # tests 40',
      'packages/cli test: # pass 37',
      'packages/cli test: # fail 3',
    ].join('\n');

    assert.deepEqual(parseSuiteCounts(output), [{ packageName: 'packages/cli', tests: 40, passed: 37, failed: 3 }]);
  });

  it('reads vitest, which never prints the TAP totals', () => {
    // Without this the one package not on node:test vanishes from the artifact, and a reader sees
    // four packages where the workspace has five with nothing saying which is missing.
    const output = 'packages/client test:       Tests  25 passed (27)';

    assert.deepEqual(parseSuiteCounts(output), [{ packageName: 'packages/client', tests: 27, passed: 25, failed: 0 }]);
  });

  it('keeps every package separate across an interleaved run', () => {
    const output = [
      'packages/cli test: # tests 40',
      'packages/audit-gate test: # tests 38',
      'packages/cli test: # pass 40',
      'packages/audit-gate test: # pass 38',
    ].join('\n');

    assert.deepEqual(
      parseSuiteCounts(output).map((c) => `${c.packageName}:${c.tests}`),
      ['packages/cli:40', 'packages/audit-gate:38'],
    );
  });

  it('renders passed before total, and says nothing about failures when there are none', () => {
    const clean = formatSuiteCounts([{ packageName: 'pkg', tests: 10, passed: 10, failed: 0 }]);
    assert.equal(clean, 'pkg 10/10');

    const broken = formatSuiteCounts([{ packageName: 'pkg', tests: 10, passed: 8, failed: 2 }]);
    assert.equal(broken, 'pkg 8/10 (2 FAILED)');
  });

  it('omits a package that printed no total instead of reporting it as zero tests', () => {
    assert.deepEqual(parseSuiteCounts('packages/silent test: some unrelated line'), []);
    assert.equal(formatSuiteCounts([]), 'no package reported a total');
  });
});

describe('lockfileVersions', () => {
  it('collapses pnpm peer suffixes, since provenance is a property of the published version', () => {
    const lock = [
      '  /@babel/core@7.29.7:',
      '  /@babel/helper-module-transforms@7.29.7(@babel/core@7.29.7):',
      '  /@babel/helper-module-transforms@7.29.7:',
    ].join('\n');

    assert.deepEqual(lockfileVersions(lock), ['@babel/core@7.29.7', '@babel/helper-module-transforms@7.29.7']);
  });

  it('strips the quotes pnpm puts round every scoped package, before stripping peers', () => {
    // Handling these in the wrong order leaves the peer suffix attached, because the closing paren is
    // no longer at the end of the string, and every resulting spec then fails to resolve at the
    // registry. The first version did exactly that and reported 85 unsigned against a real 0.
    const lock = [
      "  '@babel/helper-module-transforms@7.29.7(@babel/core@7.29.7)':",
      "  '@stryker-mutator/core@9.6.1':",
      '  express@5.2.1:',
    ].join('\n');

    assert.deepEqual(lockfileVersions(lock), [
      '@babel/helper-module-transforms@7.29.7',
      '@stryker-mutator/core@9.6.1',
      'express@5.2.1',
    ]);
  });

  it('returns a sorted list, so two runs of the same lockfile compare equal', () => {
    // Insertion order follows the file. Without the sort, a lockfile that lists express first and a
    // reordering of the same set produce different artifacts for an identical dependency tree.
    const lock = ['  express@5.2.1:', '  /@babel/core@7.29.7:', '  axios@0.33.0:'].join('\n');

    assert.deepEqual(lockfileVersions(lock), ['@babel/core@7.29.7', 'axios@0.33.0', 'express@5.2.1']);
  });

  it('ignores the settings block, which is indented the same but is not a package', () => {
    const lock = ['  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '  express@5.2.1:'].join('\n');

    assert.deepEqual(lockfileVersions(lock), ['express@5.2.1']);
  });

  it('reports only what the head lockfile added, not what it removed', () => {
    const base = ['  /express@5.2.1:', '  /removed@1.0.0:'].join('\n');
    const head = ['  /express@5.2.1:', '  /@stryker-mutator/core@9.6.1:'].join('\n');

    assert.deepEqual(introducedVersions(base, head), ['@stryker-mutator/core@9.6.1']);
  });

  it('splits a scoped package on the last @, not the first', () => {
    assert.deepEqual(splitVersion('@stryker-mutator/core@9.6.1'), {
      name: '@stryker-mutator/core',
      version: '9.6.1',
    });
    assert.deepEqual(splitVersion('express@5.2.1'), { name: 'express', version: '5.2.1' });
  });

  it('leaves a spec with no version separator alone rather than emptying its name', () => {
    // The `@` at index 0 is the scope marker, not a separator. Treating it as one yields an empty
    // package name, and every registry lookup for it fails open.
    assert.deepEqual(splitVersion('@scopeonly'), { name: '@scopeonly', version: '' });
  });
});

describe('packagesMissingTotals', () => {
  it('names a package that ran and reported nothing', () => {
    // The uploader's test script sends node's TAP reporter, which carries the totals, to
    // `.test-summary.tap` and only the dot reporter to stdout, so its TAP totals never reach pnpm's
    // output. Without this the artifact listed five packages where the workspace had six and nothing
    // said which was gone.
    const expected = ['deploy', 'packages/cli', 'packages/stream-uploader'];
    const reported = ['deploy', 'packages/cli'];

    assert.deepEqual(packagesMissingTotals(expected, reported), ['packages/stream-uploader']);
  });

  it('is empty when every package reported', () => {
    assert.deepEqual(packagesMissingTotals(['a', 'b'], ['b', 'a']), []);
  });
});

describe('packagesWithTests', () => {
  it('expects a total from e2e and deploy as well as from every package under packages/', () => {
    const expected = packagesWithTests(REPO_ROOT);
    const wanted = ['deploy', 'e2e', ...directoriesUnder('packages').filter(manifestHasTestScript)];

    const notExpected = wanted.filter((dir) => !expected.includes(dir));
    assert.deepEqual(notExpected, []);
  });

  it('expects exactly the members pnpm-workspace.yaml lists that have a test script', () => {
    // The standalone list is a literal, and it already went stale once: e2e joined the workspace the
    // day after the list was written, and its total was never expected. This reads the file pnpm reads.
    const members = workspaceEntries().flatMap((entry) => {
      if (entry.endsWith('/*')) {
        return directoriesUnder(entry.slice(0, -2));
      }
      assert.doesNotMatch(entry, /[*?{[!]/, `a workspace entry this check cannot read: ${entry}`);
      return [entry];
    });
    assert.notEqual(members.length, 0);

    assert.deepEqual(packagesWithTests(REPO_ROOT), members.filter(manifestHasTestScript).sort());
  });

  it('expects e2e under the name pnpm -r test prefixes its lines with', () => {
    // pnpm -r printed e2e's lines as `e2e <script>: ...` on 2026-09-24. An expected name that differed
    // from that prefix would put e2e in the missing row on every run, however cleanly it reported.
    const [e2e] = parseSuiteCounts('e2e test: # tests 12').map((count) => count.packageName);

    assert.ok(packagesWithTests(REPO_ROOT).includes(e2e), `no expected package is named ${e2e}`);
  });
});

describe('missingTotalsVerdict', () => {
  const withRowFor = (missing: string[]): GateFacts => ({
    base: 'main',
    head: 'abc1234',
    headSupplied: false,
    groups: [
      {
        title: 'Checks',
        facts: [
          {
            key: 'packages that reported no total',
            value: missing.join(', '),
            command: 'pnpm verify',
            ...missingTotalsVerdict(missing),
          },
        ],
      },
    ],
    authorMeasured: [],
  });

  it('keeps the exit code out of it when exactly the uploader is missing, the failure TEST-27 accepts', () => {
    assert.deepEqual(missingTotalsVerdict(['packages/stream-uploader']), { failed: true, known: true });
    assert.equal(hasFailure(withRowFor(['packages/stream-uploader'])), false);
  });

  it('fails the run when e2e alone is missing, which nothing has accepted', () => {
    // Every missing set used to be known, so a package newly losing its total never moved the exit code.
    assert.deepEqual(missingTotalsVerdict(['e2e']), { failed: true, known: false });
    assert.equal(hasFailure(withRowFor(['e2e'])), true);
  });

  it('fails the run when e2e is missing beside the uploader', () => {
    assert.deepEqual(missingTotalsVerdict(['e2e', 'packages/stream-uploader']), { failed: true, known: false });
    assert.equal(hasFailure(withRowFor(['e2e', 'packages/stream-uploader'])), true);
  });
});

describe('countAdvisoryFindings', () => {
  it('sums the severity buckets', () => {
    const report = JSON.stringify({ metadata: { vulnerabilities: { low: 1, high: 3, critical: 0 } } });

    assert.deepEqual(countAdvisoryFindings(report), { value: '4', failed: false });
  });

  it('refuses to report zero for a run that never reached the registry', () => {
    // Verbatim what pnpm audit --json writes on ECONNREFUSED. It is valid JSON with no counts, so
    // defaulting the missing map to {} sums to zero and prints a clean line under the audit gate's
    // own pass message. The sibling audit-gate package throws on this exact input.
    const report = JSON.stringify({ error: { code: 'ECONNREFUSED', message: 'request failed' } });

    const result = countAdvisoryFindings(report);
    assert.equal(result.failed, true);
    assert.match(result.value, /did not run/);
  });

  it('reports unparseable output as a failure rather than as zero findings', () => {
    const result = countAdvisoryFindings('ELIFECYCLE  command failed');
    assert.equal(result.failed, true);
    assert.match(result.value, /could not parse/);
  });
});

describe('totalLines', () => {
  it('counts additions and removals across files', () => {
    assert.equal(totalLines('10\t5\ta.ts\n3\t2\tb.ts\n'), 20);
  });

  it('skips a binary file, whose counts are dashes rather than numbers', () => {
    assert.equal(totalLines('10\t5\ta.ts\n-\t-\timage.png\n'), 15);
  });
});

describe('surfacesTouched', () => {
  it('counts each path once, under the first surface that claims it', () => {
    assert.deepEqual(surfacesTouched(['packages/x/test/a.config.ts']), ['tests']);
  });

  it('classifies every surface in the catalogue, not only the ones a diff usually hits', () => {
    // Three of the seven matchers were entirely unexercised, so replacing any of them with a
    // constant false went unnoticed.
    assert.deepEqual(surfacesTouched(['.github/workflows/ci.yml']), ['ci']);
    assert.deepEqual(surfacesTouched(['deploy/scripts/clean.sh']), ['deploy']);
    assert.deepEqual(surfacesTouched(['engines/srs/srs.conf.template']), ['deploy']);
    assert.deepEqual(surfacesTouched(['nodes/docker-compose.yml']), ['deploy']);
    assert.deepEqual(surfacesTouched(['packages/x/src/a.ts']), ['src']);
    assert.deepEqual(surfacesTouched(['docs/reviews/review-gate.md']), ['protocol']);
    assert.deepEqual(surfacesTouched(['README.md']), ['docs']);
    assert.deepEqual(surfacesTouched(['packages/client/index.html']), ['client-assets']);
  });

  it('classifies the dotfiles and manifests that used to land nowhere', () => {
    // 14 tracked files matched no surface at all, and the surface count is what the diff ceiling
    // binds on, so a path in no bucket quietly made the cap read lower than it is.
    for (const path of ['.prettierrc', '.nvmrc', '.dockerignore', '.env.sample', 'packages/x/package.json']) {
      assert.deepEqual(surfacesTouched([path]), ['config'], path);
    }
  });

  it('reports an unrecognised path as unclassified rather than dropping it', () => {
    assert.deepEqual(surfacesTouched(['some/unknown/thing.xyz']), ['unclassified']);
  });

  it('returns surfaces in catalogue order regardless of the order the paths arrive in', () => {
    const paths = ['package.json', 'docs/reviews/review-gate.md', 'packages/x/src/a.ts'];

    assert.deepEqual(surfacesTouched(paths), ['protocol', 'src', 'config']);
  });
});

describe('mutationApplicability', () => {
  it('applies when the covered package changes', () => {
    assert.deepEqual(mutationApplicability(['packages/stream-uploader/src/engines/ome.ts']), {
      state: 'applies',
      uncovered: [],
    });
  });

  it('applies on a test-only change, because mutation measures the tests', () => {
    assert.equal(mutationApplicability(['packages/stream-uploader/test/OmeEngine.test.ts']).state, 'applies');
  });

  it('names the uncovered source when a diff spans the covered package and another', () => {
    // A bare "applies" let a reviewer run the check, get a real score, and read it as covering the
    // whole change when half the changed source had no harness at all.
    const result = mutationApplicability([
      'packages/stream-uploader/src/engines/ome.ts',
      'packages/cli/src/stampBuy.ts',
    ]);

    assert.equal(result.state, 'applies');
    assert.deepEqual(result.uncovered, ['packages/cli/src/stampBuy.ts']);
  });

  it('reports unavailable, not not-applicable, for a package with no harness', () => {
    // The two must not collapse: "no runner exists" is a gap that is owed, and "there is no source"
    // is a check that was never due. Reporting the first as the second reads as coverage.
    assert.equal(mutationApplicability(['packages/cli/src/stampBuy.ts']).state, 'unavailable');
  });

  it('does not treat a sibling package as the covered one on a bare prefix match', () => {
    assert.equal(mutationApplicability(['packages/stream-uploader-legacy/src/x.ts']).state, 'unavailable');
  });

  it('applies when only packages/shared changes, because pnpm mutate reaches it too', () => {
    // stryker.config.json has mutated packages/shared since 2026-08-11, and a shared-only change still
    // read as unavailable, which told a reviewer there was no harness when there was one.
    assert.deepEqual(mutationApplicability(['packages/shared/src/publishKey.ts']), { state: 'applies', uncovered: [] });
  });

  it('names only the client path when a change spans the uploader, shared and the client', () => {
    // The client has a harness of its own, pnpm mutate:client, which this fact has never counted.
    const result = mutationApplicability([
      'packages/stream-uploader/src/engines/ome.ts',
      'packages/shared/src/publishKey.ts',
      'packages/client/src/App.tsx',
    ]);

    assert.equal(result.state, 'applies');
    assert.deepEqual(result.uncovered, ['packages/client/src/App.tsx']);
  });

  it('counts as covered exactly the packages the mutate globs of stryker.config.json name', () => {
    // The covered list is a literal, and it already went stale once: shared joined the config ten days
    // after the list was written and nothing noticed. This reads the config pnpm mutate runs.
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'stryker.config.json'), 'utf8')) as { mutate: string[] };
    const packageOf = (glob: string): string => {
      const segments = glob.split('/');
      const packageEnd = segments.findIndex((s) => s === 'src' || /[*?{[]/.test(s));
      return segments.slice(0, packageEnd).join('/');
    };
    const named = new Set(config.mutate.filter((glob) => !glob.startsWith('!')).map(packageOf));
    assert.notEqual(named.size, 0);

    for (const dir of named) {
      assert.deepEqual(mutationApplicability([`${dir}/src/sample.ts`]), { state: 'applies', uncovered: [] }, dir);
    }
    for (const dir of directoriesUnder('packages').filter((d) => !named.has(d))) {
      assert.equal(mutationApplicability([`${dir}/src/sample.ts`]).state, 'unavailable', dir);
    }
  });

  it('agrees with surfacesTouched that deploy tests are the deploy surface, not source', () => {
    // The two functions live in one file and disagreed about this exact path.
    assert.deepEqual(surfacesTouched(['deploy/test/clean.test.js']), ['deploy']);
    assert.equal(mutationApplicability(['deploy/test/clean.test.js']).state, 'not-applicable');
  });

  it('is not applicable when nothing under src or test changed', () => {
    assert.equal(mutationApplicability(['docs/reviews/review-gate.md', 'package.json']).state, 'not-applicable');
  });
});

describe('distArgs', () => {
  it('requests dist and nothing else', () => {
    // Asking npm for two fields flattens the response to the top level, so .signatures and
    // .attestations come back undefined and every package reports as unsigned. It is a named trap in
    // the owner's dependency rule, and nothing but this test stands between an edit and it.
    assert.deepEqual(distArgs('express@5.2.1'), ['view', 'express@5.2.1', 'dist', '--json']);
    assert.equal(distArgs('express@5.2.1').filter((a) => !a.startsWith('--') && a !== 'view').length, 2);
  });
});

describe('provenance summary', () => {
  const entry = (
    spec: string,
    signature: 'signed' | 'unsigned' | 'unreadable',
    attested: boolean,
    ageDays: number | null = 400,
  ): VersionProvenance => ({ spec, ageDays, signature, attested });

  it('reports the number of versions it looked at', () => {
    assert.equal(summarise([entry('a@1.0.0', 'signed', true), entry('b@1.0.0', 'signed', true)]).introduced, '2');
  });

  it('keeps a failed registry lookup apart from an unsigned package', () => {
    // Folding the two together invents a security finding out of a network blip, which is what the
    // first version did on every spec its own parser had mangled.
    const summary = summarise([entry('a@1.0.0', 'unreadable', false), entry('b@1.0.0', 'signed', true)]);

    assert.equal(summary.unsigned, 'none');
    assert.match(summary.unreadable, /a@1\.0\.0/);
    assert.equal(summary.needsAttention, true);
  });

  it('reports a publish date it could not read, rather than counting it as not fresh', () => {
    // readDist got a third state for exactly this reason and readAgeDays did not, so a rate-limited
    // age lookup printed "published under 30 days ago | none": a clean all-clear on check one of the
    // dependency rule, for a version whose date was never read.
    const summary = summarise([entry('unread@1.0.0', 'signed', true, null)]);

    assert.match(summary.ageUnknown, /unread@1\.0\.0/);
    assert.equal(summary.fresh, 'none');
    assert.equal(summary.needsAttention, true);
  });

  it('divides by what it actually read, not by the whole set', () => {
    // 1 of 5 implies the other four were checked and found attested, when two were never read.
    const summary = summarise([
      entry('ok1@1.0.0', 'signed', true),
      entry('ok2@1.0.0', 'signed', true),
      entry('bare@1.0.0', 'signed', false),
      entry('gone1@1.0.0', 'unreadable', false),
      entry('gone2@1.0.0', 'unreadable', false),
    ]);

    assert.match(summary.unattested, /^1 of 3 read, /);
  });

  it('says nothing extra when every read version is attested', () => {
    assert.equal(summarise([entry('a@1.0.0', 'signed', true)]).unattested, '0 of 1 read');
  });

  it('says how many it dropped rather than presenting a truncated list as the whole set', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`p${i}@1.0.0`, 'unsigned', false));

    assert.equal(summarise(many).unsigned.endsWith(', and 4 more'), true);
  });

  it('does not claim a remainder when the list is complete', () => {
    const few = Array.from({ length: 3 }, (_, i) => entry(`p${i}@1.0.0`, 'unsigned', false));

    assert.equal(summarise(few).unsigned, '3: p0@1.0.0, p1@1.0.0, p2@1.0.0');
  });

  it('treats exactly two weeks as not fresh, the window of the owner dependency rule', () => {
    assert.equal(summarise([entry('boundary@1.0.0', 'signed', true, 14)]).fresh, 'none');
    assert.match(summarise([entry('boundary@1.0.0', 'signed', true, 13)]).fresh, /boundary@1\.0\.0 \(13d\)/);
  });

  it('builds the fresh row from age, not from signature state', () => {
    const summary = summarise([entry('young@1.0.0', 'signed', true, 3), entry('old-bare@1.0.0', 'unsigned', false)]);

    assert.match(summary.fresh, /young@1\.0\.0/);
    assert.doesNotMatch(summary.fresh, /old-bare/);
  });

  it('flags the fresh and unattested intersection, which is the one that matters', () => {
    const summary = summarise([
      entry('fresh-attested@1.0.0', 'signed', true, 3),
      entry('fresh-bare@1.0.0', 'signed', false, 5),
      entry('old-bare@1.0.0', 'signed', false, 400),
    ]);

    assert.match(summary.freshAndUnattested, /fresh-bare@1\.0\.0 \(5d\)/);
    assert.doesNotMatch(summary.freshAndUnattested, /old-bare/);
    assert.equal(summary.needsAttention, false);
  });
});

describe('formatFacts', () => {
  const facts: GateFacts = {
    base: 'feat/ai-hardening',
    head: 'abc1234',
    headSupplied: false,
    groups: [{ title: 'Checks', facts: [{ key: 'pnpm verify', value: 'exit 0', command: 'pnpm verify' }] }],
    authorMeasured: [{ key: 'mutation score', value: '50.76', method: 'pnpm mutate at concurrency 4' }],
  };

  it('carries the command beside every value, under the documented header', () => {
    const rendered = formatFacts(facts);
    assert.match(rendered, /^\| Fact \| Value \| Command \|$/m);
    assert.match(rendered, /\| pnpm verify \| exit 0 \| `pnpm verify` \|/);
  });

  it('names the head it measured, so a block pasted from an earlier commit is detectable', () => {
    assert.match(formatFacts(facts), /Head under measurement: `abc1234`/);
    assert.doesNotMatch(formatFacts(facts), /supplied on the command line/);
    assert.match(formatFacts({ ...facts, headSupplied: true }), /supplied on the command line/);
  });

  it('names the author-measured rows as unverifiable rather than leaving them to be reproduced', () => {
    const rendered = formatFacts(facts);
    assert.match(rendered, /Author-measured, not reproduced/);
    assert.match(rendered, /UNVERIFIABLE is the correct verdict/);
    assert.match(rendered, /\| mutation score \| 50\.76 \|/);
  });

  it('escapes every pipe in a value, not only the first', () => {
    const withPipes: GateFacts = {
      ...facts,
      groups: [{ title: 'Checks', facts: [{ key: 'k', value: 'a | b | c', command: 'cmd' }] }],
    };

    assert.match(formatFacts(withPipes), /\| k \| a \\\| b \\\| c \| `cmd` \|/);
  });

  it('marks a failed fact and reports the failure to the caller', () => {
    const failing: GateFacts = {
      ...facts,
      groups: [
        { title: 'Checks', facts: [{ key: 'pnpm verify', value: 'exit 1', command: 'pnpm verify', failed: true }] },
      ],
    };

    assert.match(formatFacts(failing), /\*\*exit 1\*\*/);
    assert.equal(hasFailure(failing), true);
    assert.equal(hasFailure(facts), false);
  });

  it('finds a failure in any group, not only when every group has one', () => {
    // index.ts always builds two or three groups. Every earlier fixture had exactly one, where
    // `some` and `every` are the same function, so a swap between them passed the whole suite.
    const secondGroupFails: GateFacts = {
      ...facts,
      groups: [
        { title: 'Diff', facts: [{ key: 'files changed', value: '3', command: 'git diff' }] },
        { title: 'Checks', facts: [{ key: 'pnpm verify', value: 'exit 1', command: 'pnpm verify', failed: true }] },
      ],
    };

    assert.equal(hasFailure(secondGroupFails), true);
  });

  it('keeps a known failure out of the exit code while still showing it', () => {
    // Otherwise the command returns the same non-zero on every run for a registered defect, and a
    // new failure becomes indistinguishable from the one already being lived with.
    const known: GateFacts = {
      ...facts,
      groups: [
        {
          title: 'Checks',
          facts: [{ key: 'no total', value: '1: pkg', command: 'pnpm verify', failed: true, known: true }],
        },
      ],
    };

    assert.equal(hasFailure(known), false);
    assert.match(formatFacts(known), /\*\*1: pkg\*\* \(known, see the register\)/);
  });
});
