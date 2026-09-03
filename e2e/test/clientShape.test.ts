import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ClientShapeExpectation,
  clientShapeRefusal,
  clientShapeSummary,
  EXPECT_CLIENT_DIRTY,
  EXPECT_CLIENT_TREE,
  EXPECT_SHARED_TREE,
  parseClientBuildStamp,
  readClientShapeExpectation,
} from '../src/clientShape.js';

/**
 * ⛔ Every case here is the client-side twin of the 2026-09-01 uploader sitting. `bench-on-host.sh`
 * syncs the harness checkout to the host on every run and never rebuilds the client image, so the
 * harness can parse a client that is weeks older than itself and nothing notices.
 */

const CLIENT_TREE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHARED_TREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HEAD = 'cccccccccccccccccccccccccccccccccccccccc';

const EXPECTED: ClientShapeExpectation = {
  clientTree: CLIENT_TREE,
  sharedTree: SHARED_TREE,
  dirty: false,
  source: 'the run script',
};

function stamp(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    clientTree: CLIENT_TREE,
    sharedTree: SHARED_TREE,
    head: HEAD,
    dirty: false,
    builtAt: '2026-09-03T10:00:00Z',
    fetchBackend: '',
    exposePlayer: '',
    ...overrides,
  });
}

describe('reading the stamp a served client carries', () => {
  it('reads back everything the image wrote', () => {
    const parsed = parseClientBuildStamp(stamp());

    assert.equal(parsed?.clientTree, CLIENT_TREE);
    assert.equal(parsed?.sharedTree, SHARED_TREE);
    assert.equal(parsed?.head, HEAD);
    assert.equal(parsed?.dirty, false);
    assert.equal(parsed?.builtAt, '2026-09-03T10:00:00Z');
  });

  /**
   * The SPA fallback answers a missing file with the app's own HTML at 200, so an unstamped client
   * does not 404, it returns a page. That has to read as no stamp rather than as a parse crash.
   */
  it('treats the app index answering instead of a stamp as no stamp', () => {
    assert.equal(parseClientBuildStamp('<!doctype html><html><body>app</body></html>'), null);
  });

  it('treats an empty body as no stamp', () => {
    assert.equal(parseClientBuildStamp(''), null);
  });

  /** An image built by a deploy script that passes none of the args writes exactly this. */
  it('treats a stamp with an empty client tree as no stamp', () => {
    assert.equal(parseClientBuildStamp(stamp({ clientTree: '' })), null);
  });

  /**
   * ⭐ The stamp is going to grow. A gate that refused an unknown key would turn every future
   * addition into a redeploy of every stage before the suite could run at all.
   */
  it('accepts a stamp carrying keys this harness has never heard of', () => {
    const parsed = parseClientBuildStamp(stamp({ ladderRungs: 4, builtBy: 'someone' }));

    assert.equal(parsed?.clientTree, CLIENT_TREE);
  });
});

describe('where the expectation comes from', () => {
  const fromGit = () => ({ clientTree: 'g'.repeat(40), sharedTree: 'h'.repeat(40), dirty: false });

  /**
   * ⛔ The run script wins, because it is the only side that can be right on the host: the rsync
   * excludes `.git`, so a harness there has no history to ask and a git answer would be absent
   * rather than wrong.
   */
  it('prefers what the run script measured on the operator machine', () => {
    const expectation = readClientShapeExpectation(
      { [EXPECT_CLIENT_TREE]: CLIENT_TREE, [EXPECT_SHARED_TREE]: SHARED_TREE, [EXPECT_CLIENT_DIRTY]: '0' },
      fromGit,
    );

    assert.equal(expectation?.clientTree, CLIENT_TREE);
    assert.equal(expectation?.source, 'the run script');
  });

  it('falls back to this checkout own git when the run script said nothing', () => {
    const expectation = readClientShapeExpectation({}, fromGit);

    assert.equal(expectation?.clientTree, 'g'.repeat(40));
    assert.equal(expectation?.source, 'this checkout');
  });

  /** An empty variable is an unanswered question, not an expectation of an empty tree. */
  it('treats a blank run-script value as absent', () => {
    const expectation = readClientShapeExpectation(
      { [EXPECT_CLIENT_TREE]: '', [EXPECT_SHARED_TREE]: '', [EXPECT_CLIENT_DIRTY]: '0' },
      fromGit,
    );

    assert.equal(expectation?.source, 'this checkout');
  });

  it('takes a dirty run-script flag as dirty', () => {
    const expectation = readClientShapeExpectation(
      { [EXPECT_CLIENT_TREE]: CLIENT_TREE, [EXPECT_SHARED_TREE]: SHARED_TREE, [EXPECT_CLIENT_DIRTY]: '1' },
      fromGit,
    );

    assert.equal(expectation?.dirty, true);
  });

  it('has no expectation when neither side can answer', () => {
    assert.equal(
      readClientShapeExpectation({}, () => null),
      null,
    );
  });
});

describe('refusing a stage whose served client is not this checkout', () => {
  it('passes a client built from the sources this harness was checked out with', () => {
    assert.equal(clientShapeRefusal(EXPECTED, stamp()), null);
  });

  /**
   * ⛔⛔ An unknown expectation is the case that must NOT pass. It is what a run launched outside
   * both paths looks like, and passing it would leave the gate green on every stage it cannot judge,
   * which is the vacuous-green failure this repo has paid for elsewhere.
   */
  it('refuses when it has no expectation to measure against', () => {
    const refusal = clientShapeRefusal(null, stamp());

    assert.ok(refusal, 'a run with no expectation was measured against nothing and passed');
    assert.match(refusal, /E2E_EXPECT_CLIENT_TREE/);
    assert.match(refusal, /bench-on-host\.sh/);
  });

  it('refuses a client serving no stamp, and names redeploying it as the fix', () => {
    const refusal = clientShapeRefusal(EXPECTED, '<!doctype html>');

    assert.ok(refusal);
    assert.match(refusal, /predates/);
    assert.match(refusal, /deploy\.sh/);
    assert.match(refusal, /client/);
  });

  it('refuses a stale client bundle', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ clientTree: 'd'.repeat(40) }));

    assert.ok(refusal, 'a client built from other sources was accepted');
    assert.match(refusal, /stale/);
  });

  /**
   * ⛔ The shared package is compiled into the bundle by vite, so a change there reaches a viewer
   * with the client sources untouched. Reading only the client tree would miss half the drift.
   */
  it('refuses a client built against a stale shared package', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ sharedTree: 'd'.repeat(40) }));

    assert.ok(refusal, 'a bundle compiled from other shared sources was accepted');
    assert.match(refusal, /stale/);
  });

  /** A refusal that does not print both hashes cannot be acted on without a second investigation. */
  it('prints what it found beside what it wanted, with the head and the build time', () => {
    const refusal = String(clientShapeRefusal(EXPECTED, stamp({ clientTree: 'd'.repeat(40) })));

    assert.match(refusal, new RegExp('d'.repeat(40)), 'the served hash is not in the refusal');
    assert.match(refusal, new RegExp(CLIENT_TREE), 'the wanted hash is not in the refusal');
    assert.match(refusal, new RegExp(HEAD), 'the head the client was built at is not in the refusal');
    assert.match(refusal, /2026-09-03T10:00:00Z/, 'the build time is not in the refusal');
  });

  /**
   * ⛔ A tree hash names a commit, so a build from uncommitted sources carries a hash describing
   * something other than what was built. The hashes can match exactly and mean nothing.
   */
  it('refuses a client built from uncommitted sources even when the hashes agree', () => {
    const refusal = clientShapeRefusal(EXPECTED, stamp({ dirty: true }));

    assert.ok(refusal, 'a build from uncommitted sources was accepted on a matching hash');
    assert.match(refusal, /uncommitted/);
  });

  it('refuses when the harness itself was synced from uncommitted sources', () => {
    const refusal = clientShapeRefusal({ ...EXPECTED, dirty: true }, stamp());

    assert.ok(refusal, 'an expectation from uncommitted sources was treated as an expectation');
    assert.match(refusal, /uncommitted/);
  });

  it('names committing or stashing as the fix for a dirty build', () => {
    assert.match(String(clientShapeRefusal(EXPECTED, stamp({ dirty: true }))), /commit or stash/);
  });
});

describe('what a passing gate reports', () => {
  it('names both trees and when the client was built', () => {
    const summary = clientShapeSummary(EXPECTED, parseClientBuildStamp(stamp()));

    assert.match(summary, new RegExp(CLIENT_TREE.slice(0, 12)));
    assert.match(summary, new RegExp(SHARED_TREE.slice(0, 12)));
    assert.match(summary, /2026-09-03T10:00:00Z/);
  });
});
