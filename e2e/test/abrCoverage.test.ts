import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { abrCoverageRefusal, readAbrExpectation } from '../src/abrCoverage.js';

/**
 * The gate that stops an ABR run from reporting green having tested no ladder.
 *
 * ⛔ Measured 2026-08-27, on the two ABR suites as merged. With `ABR_ENABLED` off, which is the
 * shipped default and the state of every profile on the bench host, `node --test` reports
 * `# tests 0`, `# fail 0`, `# skipped 0` and exits 0. The seven ABR cases land in no column at all,
 * not even the skipped one, so a full run's summary is indistinguishable from one that covered them.
 *
 * The decision this encodes is that a run must be unambiguous about what it covered, and that the
 * only way to be sure is to refuse the ambiguous case rather than to print a warning nobody reads.
 * A single-rendition deployment is still a legitimate thing to run, so it declares itself once with
 * `E2E_EXPECT_ABR=false` and is never asked again.
 */
describe('reading what the operator declared this run is for', () => {
  it('treats an unset variable as undeclared rather than guessing either way', () => {
    assert.equal(readAbrExpectation(''), 'undeclared');
  });

  it('reads the two spellings of yes the rest of the suite already accepts', () => {
    assert.equal(readAbrExpectation('true'), 'ladder');
    assert.equal(readAbrExpectation('1'), 'ladder');
  });

  it('reads the two spellings of no, so a single-rendition run can say so', () => {
    assert.equal(readAbrExpectation('false'), 'single');
    assert.equal(readAbrExpectation('0'), 'single');
  });

  it('ignores surrounding whitespace, which an env file makes easy to leave behind', () => {
    assert.equal(readAbrExpectation('  true  '), 'ladder');
  });

  /**
   * The whole point of the gate is that an unclear run stops. Reading a typo as undeclared would
   * turn an operator who did declare into one who did not, and reading it as a no would waive the
   * gate on the exact run that was meant to exercise the ladder.
   */
  it('refuses a value it does not know rather than falling back to undeclared', () => {
    assert.throws(() => readAbrExpectation('yes'), /E2E_EXPECT_ABR/);
  });
});

describe('refusing a run whose ABR coverage is not what it looks like', () => {
  const LADDER = ['1080p', '720p', '480p', '360p'];

  it('passes an ABR run that was asked for and got a ladder', () => {
    assert.equal(abrCoverageRefusal({ expectation: 'ladder', enabled: true, rungs: LADDER }), null);
  });

  it('passes a single-rendition run that declared itself', () => {
    assert.equal(abrCoverageRefusal({ expectation: 'single', enabled: false, rungs: [] }), null);
  });

  /**
   * No friction where there is no gap. The ladder is under test whether or not anybody said so, so
   * the summary already tells the truth and there is nothing for the gate to protect.
   */
  it('passes an undeclared run that is testing the ladder anyway', () => {
    assert.equal(abrCoverageRefusal({ expectation: 'undeclared', enabled: true, rungs: LADDER }), null);
  });

  it('refuses the silent gap: nothing declared and no ladder to test', () => {
    const refusal = abrCoverageRefusal({ expectation: 'undeclared', enabled: false, rungs: [] });

    assert.match(String(refusal), /E2E_EXPECT_ABR/);
  });

  it('refuses a run that asked for the ladder and would not have got one', () => {
    const refusal = abrCoverageRefusal({ expectation: 'ladder', enabled: false, rungs: [] });

    assert.match(String(refusal), /ABR_ENABLED/);
  });

  /**
   * The opposite mistake, and the more expensive one. A run declared single-rendition against a
   * stack that transcodes four rungs is measuring a ladder while its report says it measured one
   * stream, which is a wrong number rather than a missing one.
   */
  it('refuses a run that declared single-rendition against a stack running a ladder', () => {
    const refusal = abrCoverageRefusal({ expectation: 'single', enabled: true, rungs: LADDER });

    assert.match(String(refusal), /ladder/);
  });

  /**
   * Both ABR suites assert `abrRungs.length > 1` in their own setup, so a one-rung ladder fails them
   * anyway. Catching it here turns a timeout most of the way through a paid sitting into a refusal
   * before the first frame is published.
   */
  it('refuses a one-rung ladder, which cannot show a rung going missing', () => {
    const refusal = abrCoverageRefusal({ expectation: 'ladder', enabled: true, rungs: ['720p'] });

    assert.match(String(refusal), /ABR_LADDER/);
  });

  it('refuses a one-rung ladder even undeclared, because that is a broken config either way', () => {
    assert.notEqual(abrCoverageRefusal({ expectation: 'undeclared', enabled: true, rungs: ['720p'] }), null);
  });

  it('refuses ABR on with no ladder at all, rather than reading it as single-rendition', () => {
    assert.notEqual(abrCoverageRefusal({ expectation: 'ladder', enabled: true, rungs: [] }), null);
  });
});
