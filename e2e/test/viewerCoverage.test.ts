import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATEWAY_BYTES, WEEB3_BYTES } from '../src/browser/fetchBackendSweep.js';
import {
  readViewerExpectation,
  requireByteSource,
  viewerCoverageRefusal,
  viewerGate,
  viewerSkipReason,
} from '../src/viewerCoverage.js';

/**
 * That a run says whether a real browser watched anything, and cannot leave it ambiguous.
 *
 * ⛔ The same defect `abrCoverage` exists for, one layer over. A viewer suite gated on a browser this
 * deployment cannot launch reports as `# tests 0`, `# fail 0`, `# skipped 0`, exit 0. So the summary
 * of a run where nobody watched the broadcast is character-for-character the summary of one where a
 * real Chrome played it for four minutes, and the difference is the only evidence this project has
 * about what a viewer gets.
 *
 * ⭐ The byte source is part of the declaration and not a detail. An unset `BROWSER_FETCH_BACKEND`
 * means "whatever the build defaults to", and a viewer verdict filed against a condition nobody chose
 * is a reading of an unknown arm. `byteSourceFromEnv` already refuses a typo, so what is left here is
 * refusing the silence.
 */

describe('reading what a run says it covers', () => {
  it('reads an unset variable as a run that has not said', () => {
    assert.equal(readViewerExpectation(''), 'undeclared');
    assert.equal(readViewerExpectation('   '), 'undeclared');
  });

  it('accepts the same words ABR_ENABLED accepts, so there is one vocabulary', () => {
    assert.equal(readViewerExpectation('true'), 'browser');
    assert.equal(readViewerExpectation('1'), 'browser');
    assert.equal(readViewerExpectation('false'), 'none');
    assert.equal(readViewerExpectation('0'), 'none');
  });

  /** A typo read as undeclared would silently demote the operator who was being careful. */
  it('refuses a spelling it does not know rather than reading it as undeclared', () => {
    assert.throws(() => readViewerExpectation('yes'), /E2E_EXPECT_BROWSER/);
  });
});

describe('whether a run may proceed', () => {
  it('lets a declared browser run with a named byte source through', () => {
    assert.equal(viewerCoverageRefusal({ expectation: 'browser', backend: WEEB3_BYTES }), null);
    assert.equal(viewerCoverageRefusal({ expectation: 'browser', backend: GATEWAY_BYTES }), null);
  });

  it('lets a run that declared itself browser-less through, because it said so', () => {
    assert.equal(viewerCoverageRefusal({ expectation: 'none', backend: null }), null);
  });

  /**
   * ⛔ The whole point. A skipped viewer suite reaches no column, so an undeclared run has to stop
   * here rather than print a summary that says nothing about whether anyone watched.
   */
  it('stops an undeclared run rather than skipping the viewer suites silently', () => {
    const refusal = viewerCoverageRefusal({ expectation: 'undeclared', backend: null });

    assert.match(String(refusal), /E2E_EXPECT_BROWSER/);
  });

  it('stops an undeclared run even when a byte source was named, because the run still did not say', () => {
    assert.notEqual(viewerCoverageRefusal({ expectation: 'undeclared', backend: WEEB3_BYTES }), null);
  });

  /**
   * An unset byte source is not a missing detail, it is an unnamed condition: the run would file a
   * viewer verdict against whatever the build happens to default to.
   */
  it('stops a browser run that never named the byte source it is a reading of', () => {
    const refusal = viewerCoverageRefusal({ expectation: 'browser', backend: null });

    assert.match(String(refusal), /BROWSER_FETCH_BACKEND/);
  });

  it('names both conditions when it refuses, so the fix does not need the source', () => {
    const refusal = String(viewerCoverageRefusal({ expectation: 'browser', backend: null }));

    assert.match(refusal, new RegExp(WEEB3_BYTES));
    assert.match(refusal, new RegExp(GATEWAY_BYTES));
  });
});

describe('why a suite skipped', () => {
  it('gives a browser-less run a reason a reader can act on', () => {
    assert.match(String(viewerSkipReason('none')), /E2E_EXPECT_BROWSER/);
  });

  it('does not skip a declared browser run', () => {
    assert.equal(viewerSkipReason('browser'), false);
  });

  /**
   * An undeclared run never reaches a skip decision, because the refusal above stopped it. Returning
   * a skip here would be the gate's own defect: the run would go quiet exactly where it must not.
   */
  it('does not skip an undeclared run, which the refusal has already stopped', () => {
    assert.equal(viewerSkipReason('undeclared'), false);
  });
});

describe('the gate a viewer suite opens with', () => {
  it('lets a declared browser run through with nothing to skip', () => {
    assert.equal(viewerGate('browser', WEEB3_BYTES), false);
  });

  it('hands a declared browser-less run its reason, rather than throwing at it', () => {
    assert.match(String(viewerGate('none', null)), /E2E_EXPECT_BROWSER/);
  });

  /**
   * ⛔ Thrown rather than returned as a skip. A throw at module scope fails the file and the run,
   * where a skip would reach no column at all, which is the defect this module exists for.
   */
  it('throws on an undeclared run, so the file fails during import', () => {
    assert.throws(() => viewerGate('undeclared', null), /E2E_EXPECT_BROWSER/);
  });

  it('throws on a browser run with no byte source, before a broadcast is published', () => {
    assert.throws(() => viewerGate('browser', null), /BROWSER_FETCH_BACKEND/);
  });
});

describe('the byte source a running case reads', () => {
  it('gives back the condition the run named', () => {
    assert.equal(requireByteSource(GATEWAY_BYTES), GATEWAY_BYTES);
  });

  /** A case reaching this has got past the gate with no condition, which is the gate's own defect. */
  it('refuses to file a verdict against a condition nobody named', () => {
    assert.throws(() => requireByteSource(null), /gate/);
  });
});
