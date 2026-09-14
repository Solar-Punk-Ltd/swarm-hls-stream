import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { unwritableIsEnforceable } from './helpers/permissionGuard.js';

/**
 * That the guard reads the right way round.
 *
 * It decides whether fourteen cases across three files run or are skipped, and an inverted condition
 * would skip all of them on every machine while the suite stayed green. That is the one failure this
 * guard could introduce that is worse than the problem it solves: a green that has stopped proving
 * anything. Nothing else would notice, because a skip is not a failure.
 *
 * Both branches are asserted here rather than only observed, because the machine that runs this is
 * never root and the root branch would otherwise be exercised for the first time on the verification
 * box, where a mistake reads as the box being wrong again.
 */
describe('the permission guard', () => {
  it('lets a case run for an ordinary user, whose writes the bits really do stop', () => {
    assert.equal(unwritableIsEnforceable(501), true);
    assert.equal(unwritableIsEnforceable(1000), true);
  });

  it('stops a case for root, which ignores the bits the case relies on', () => {
    assert.equal(unwritableIsEnforceable(0), false);
  });

  it('lets a case run where there is no such id to read, rather than skipping on a missing answer', () => {
    // `process.geteuid` is absent on Windows. Treating that as root would skip silently on a platform
    // where the cases may be perfectly valid, so the unknown case runs and is allowed to fail loudly.
    assert.equal(unwritableIsEnforceable(undefined), true);
  });
});
