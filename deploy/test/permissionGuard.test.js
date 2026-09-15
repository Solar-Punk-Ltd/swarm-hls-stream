import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SKIP_WITHOUT_PERMISSION_ENFORCEMENT,
  skipReasonFor,
  unwritableIsEnforceable,
} from './helpers/permissionGuard.js';

/**
 * That the guard reads the right way round, and that the value the cases read says what it says.
 *
 * ⛔⛔ An inverted condition skips every case that uses this on every machine while the suite stays
 * green, and a skip is not a failure so nothing else would notice. The exported constant is asserted
 * as well as the predicate behind it, because the cases read the constant: a cross-provider review on
 * 2026-09-14 found exactly that gap in the equivalent helper in packages/cli, where three green cases
 * sat in front of an export nothing touched.
 */
describe('the deploy suite permission guard', () => {
  it('lets a case run for an ordinary user, whose writes the bits really do stop', () => {
    assert.equal(unwritableIsEnforceable(501), true);
    assert.equal(unwritableIsEnforceable(1000), true);
  });

  it('stops a case for root, which ignores the bits the case relies on', () => {
    assert.equal(unwritableIsEnforceable(0), false);
  });

  it('lets a case run where there is no such id to read, rather than skipping on a missing answer', () => {
    assert.equal(unwritableIsEnforceable(undefined), true);
  });

  it('skips exactly where this machine cannot enforce a permission bit, and nowhere else', () => {
    const runningAsRoot = process.geteuid?.() === 0;

    assert.equal(
      SKIP_WITHOUT_PERMISSION_ENFORCEMENT === false,
      !runningAsRoot,
      runningAsRoot
        ? 'running as root and the case was not stood down, so it will fail on a script that is behaving correctly'
        : 'running as an ordinary user and the case was stood down, so its coverage has silently gone',
    );
  });

  it('carries a reason rather than a bare true, so a skip says why in the report', () => {
    const reason = skipReasonFor(0);

    assert.equal(typeof reason, 'string');
    assert.ok(reason.length > 0, 'an empty reason is falsy, so the case would run after all');
  });
});
