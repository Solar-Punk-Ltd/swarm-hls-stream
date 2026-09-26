import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SKIP_WITHOUT_PERMISSION_ENFORCEMENT,
  skipReasonFor,
  unwritableIsEnforceable,
} from './helpers/permissionGuard.js';

/**
 * That the guard reads the right way round.
 *
 * It decides whether fourteen cases across three files run or are skipped, and an inverted condition
 * would skip all of them on every machine while the suite stayed green. That is the one failure this
 * guard could introduce that is worse than the problem it solves: a green that has stopped proving
 * anything. Nothing else would notice, because a skip is not a failure.
 *
 * Both branches are asserted here rather than only observed, because the machine that runs this is
 * never root and the root branch would otherwise be exercised for the first time on a machine running
 * as root, where a mistake would read as a fault of that machine.
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

/**
 * That the value the fourteen cases actually read says what the predicate above says.
 *
 * ⛔⛔ The cases do not call `unwritableIsEnforceable`. They read the exported constant, and until
 * this block existed nothing did. Three green cases in front of an untested export is a guard on the
 * wrong side of its own seam: replace the constant with an unconditional reason string and all
 * fourteen stand down on every machine while every case here still passes. A cross-provider review
 * on 2026-09-14 found that gap, after the session that wrote the guard had claimed in writing that
 * these cases closed it.
 *
 * ⭐ The rule worth carrying out of it: test the value the callers read, not the function behind it.
 */
describe('the decision the fourteen cases read', () => {
  it('skips exactly where this machine cannot enforce a permission bit, and nowhere else', () => {
    const runningAsRoot = process.geteuid?.() === 0;

    // Deliberately not a fixed expected value. This case has to mean the same thing on a laptop, on
    // GitHub's runners and on a machine where tests run as root, and those differ in the one input
    // that decides the answer, so the machine's own id is the only honest expectation to write.
    assert.equal(
      SKIP_WITHOUT_PERMISSION_ENFORCEMENT === false,
      !runningAsRoot,
      runningAsRoot
        ? 'running as root and the fourteen cases were not stood down, so each will fail on a service that is behaving correctly'
        : 'running as an ordinary user and the fourteen cases were stood down, so the coverage they provide has silently gone',
    );
  });

  it('carries a reason rather than a bare true, so a skip says why in the report', () => {
    const reason = skipReasonFor(0);

    assert.equal(typeof reason, 'string');
    // node:test skips on a TRUTHY `skip`, so an empty reason runs the case while looking like a
    // deliberate skip in the source. The length is the assertion, not the wording.
    assert.ok(
      typeof reason === 'string' && reason.length > 0,
      'an empty reason is falsy, so the case would run after all',
    );
  });
});
