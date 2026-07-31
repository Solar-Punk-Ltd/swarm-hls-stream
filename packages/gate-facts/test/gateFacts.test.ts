import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarise } from '../src/collectProvenance.js';
import { formatFacts, hasFailure } from '../src/formatFacts.js';
import { introducedVersions, lockfileVersions, splitVersion } from '../src/lockfileVersions.js';
import { formatSuiteCounts, parseSuiteCounts } from '../src/parseSuiteCounts.js';
import { mutationApplicability, surfacesTouched } from '../src/surfaces.js';
import type { GateFacts } from '../src/types.js';
import { packagesMissingTotals } from '../src/workspacePackages.js';

describe('parseSuiteCounts', () => {
  it('reads the TAP totals every node:test package prints', () => {
    const output = [
      'packages/cli test: # tests 40',
      'packages/cli test: # pass 40',
      'packages/cli test: # fail 0',
      'packages/stream-uploader test: # tests 294',
      'packages/stream-uploader test: # pass 294',
      'packages/stream-uploader test: # fail 0',
    ].join('\n');

    assert.deepEqual(parseSuiteCounts(output), [
      { packageName: 'packages/cli', tests: 40, passed: 40, failed: 0 },
      { packageName: 'packages/stream-uploader', tests: 294, passed: 294, failed: 0 },
    ]);
  });

  it('reads vitest, which never prints the TAP totals', () => {
    // Without this the one package not on node:test vanishes from the artifact, and a reader sees
    // four packages where the workspace has five with nothing saying which is missing.
    const output = 'packages/client test:       Tests  27 passed (27)';

    assert.deepEqual(parseSuiteCounts(output), [{ packageName: 'packages/client', tests: 27, passed: 27, failed: 0 }]);
  });

  it('keeps a failure count rather than reporting the run as clean', () => {
    const output = ['pkg test: # tests 10', 'pkg test: # pass 8', 'pkg test: # fail 2'].join('\n');

    const [counts] = parseSuiteCounts(output);
    assert.equal(counts.failed, 2);
    assert.match(formatSuiteCounts([counts]), /2 FAILED/);
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
    // The shape a real pnpm lockfile writes. Handling these in the wrong order leaves the peer
    // suffix attached, because the closing paren is no longer at the end of the string, and every
    // resulting spec then fails to resolve at the registry. The first version of this parser did
    // exactly that and reported 85 unsigned and 135 versions where the truth was 0 and 108.
    const lock = [
      "  '@babel/code-frame@7.29.7':",
      "  '@babel/helper-module-transforms@7.29.7(@babel/core@7.29.7)':",
      "  '@stryker-mutator/core@9.6.1':",
      '  express@5.2.1:',
    ].join('\n');

    assert.deepEqual(lockfileVersions(lock), [
      '@babel/code-frame@7.29.7',
      '@babel/helper-module-transforms@7.29.7',
      '@stryker-mutator/core@9.6.1',
      'express@5.2.1',
    ]);
  });

  it('ignores the settings block, which is indented the same but is not a package', () => {
    const lock = ['  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '  express@5.2.1:'].join('\n');

    assert.deepEqual(lockfileVersions(lock), ['express@5.2.1']);
  });

  it('reports only what the head lockfile added', () => {
    const base = '  /express@5.2.1:';
    const head = ['  /express@5.2.1:', '  /@stryker-mutator/core@9.6.1:'].join('\n');

    assert.deepEqual(introducedVersions(base, head), ['@stryker-mutator/core@9.6.1']);
  });

  it('splits a scoped package on the last @, not the first', () => {
    // Splitting on the first gives an empty name and "stryker-mutator/core@9.6.1" as the version,
    // which then makes every registry lookup for a scoped package fail open as unsigned.
    assert.deepEqual(splitVersion('@stryker-mutator/core@9.6.1'), {
      name: '@stryker-mutator/core',
      version: '9.6.1',
    });
    assert.deepEqual(splitVersion('express@5.2.1'), { name: 'express', version: '5.2.1' });
  });
});

describe('packagesMissingTotals', () => {
  it('names a package that ran and reported nothing', () => {
    // The uploader runs with --test-force-exit, which calls process.exit() and truncates pending
    // stdout writes to a pipe, so its summary never survives pnpm's aggregation. Without this the
    // artifact listed five packages where the workspace has six and nothing said which was gone.
    const expected = ['deploy', 'packages/cli', 'packages/stream-uploader'];
    const reported = ['deploy', 'packages/cli'];

    assert.deepEqual(packagesMissingTotals(expected, reported), ['packages/stream-uploader']);
  });

  it('is empty when every package reported', () => {
    assert.deepEqual(packagesMissingTotals(['a', 'b'], ['b', 'a']), []);
  });
});

describe('provenance summary', () => {
  const entry = (spec: string, signature: 'signed' | 'unsigned' | 'unreadable', attested: boolean, ageDays = 400) => ({
    spec,
    ageDays,
    signature,
    attested,
  });

  it('keeps a failed registry lookup apart from an unsigned package', () => {
    // Folding the two together invents a security finding out of a network blip, which is what the
    // first version did on every spec its own parser had mangled.
    const summary = summarise([entry('a@1.0.0', 'unreadable', false), entry('b@1.0.0', 'signed', true)]);

    assert.equal(summary.unsigned, 'none');
    assert.match(summary.unreadable, /a@1\.0\.0/);
    assert.equal(summary.needsAttention, true);
  });

  it('does not count a package it could not read as lacking provenance', () => {
    const summary = summarise([entry('a@1.0.0', 'unreadable', false)]);

    assert.match(summary.unattested, /^0 of 1/);
  });

  it('says how many it dropped rather than presenting a truncated list as the whole set', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`p${i}@1.0.0`, 'unsigned', false));

    assert.match(summarise(many).unsigned, /^12: .*, and 4 more$/);
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

describe('surfacesTouched', () => {
  it('counts each path once, under the first surface that claims it', () => {
    assert.deepEqual(surfacesTouched(['packages/x/test/a.config.ts']), ['tests']);
  });

  it('separates the protocol documents from ordinary docs', () => {
    assert.deepEqual(surfacesTouched(['docs/reviews/review-gate.md', 'README.md']), ['protocol', 'docs']);
  });

  it('reports the surfaces of the change that introduced the ceiling', () => {
    const paths = [
      'docs/reviews/review-gate.md',
      'package.json',
      'pnpm-lock.yaml',
      '.gitignore',
      'stryker.config.json',
    ];

    assert.deepEqual(surfacesTouched(paths), ['protocol', 'config']);
  });
});

describe('mutationApplicability', () => {
  it('applies when the covered package changes', () => {
    assert.equal(mutationApplicability(['packages/stream-uploader/src/engines/ome.ts']), 'applies');
  });

  it('applies on a test-only change, because mutation measures the tests', () => {
    assert.equal(mutationApplicability(['packages/stream-uploader/test/OmeEngine.test.ts']), 'applies');
  });

  it('reports unavailable, not not-applicable, for a package with no harness', () => {
    // The two must not collapse: "no runner exists" is a gap that is owed, and "there is no source"
    // is a check that was never due. Reporting the first as the second reads as coverage.
    assert.equal(mutationApplicability(['packages/cli/src/stampBuy.ts']), 'unavailable');
  });

  it('is not applicable when nothing under src or test changed', () => {
    assert.equal(mutationApplicability(['docs/reviews/review-gate.md', 'package.json']), 'not-applicable');
  });
});

describe('formatFacts', () => {
  const facts: GateFacts = {
    base: 'feat/ai-hardening',
    head: 'abc1234',
    groups: [{ title: 'Checks', facts: [{ key: 'pnpm verify', value: 'exit 0', command: 'pnpm verify' }] }],
    authorMeasured: [{ key: 'mutation score', value: '50.76', method: 'pnpm mutate at concurrency 4' }],
  };

  it('carries the command beside every value', () => {
    assert.match(formatFacts(facts), /\| pnpm verify \| exit 0 \| `pnpm verify` \|/);
  });

  it('names the author-measured rows as unverifiable rather than leaving them to be reproduced', () => {
    const rendered = formatFacts(facts);
    assert.match(rendered, /Author-measured, not reproduced/);
    assert.match(rendered, /UNVERIFIABLE is the correct verdict/);
    assert.match(rendered, /\| mutation score \| 50\.76 \|/);
  });

  it('escapes a pipe in a value, which would otherwise split the cell and drop the command', () => {
    const withPipe: GateFacts = {
      ...facts,
      groups: [{ title: 'Checks', facts: [{ key: 'k', value: 'a | b', command: 'cmd' }] }],
    };

    assert.match(formatFacts(withPipe), /\| k \| a \\\| b \| `cmd` \|/);
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
});
