import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readSegmentExpectation } from '../src/segmentLength.js';

/**
 * The two viewer types this project ships want OPPOSITE segment lengths, so a run has to say which.
 *
 * ⭐⭐⭐ Measured 2026-08-16 by the sibling repo `swarm-stream-loadlab`, in
 * `docs/measurements/2026-08-16-a-stock-tab-holds-realtime-on-two-second-segments.md`. A stock
 * weeb-3 tab holds **1.000x of realtime on 2s segments** with about 90s of buffer ahead of the
 * playhead, and **0.426x on 0.5s** with 0.5 to 3.5s of buffer, which is a viewer falling behind for
 * as long as it is open. The mechanism is arithmetic rather than tuning: weeb-3 admits roughly one
 * segment per second whatever its peer count, so a 0.5s profile needs two admissions a second
 * against a ceiling near one and can never catch up.
 *
 * The gateway path measures the opposite optimum over 21 funded arms, 0.5s beating 2s on
 * capture-to-fetchable latency at 1.55s against 3.88s. So there is no single right number, and a run
 * that does not name one is a run whose report cannot be read.
 *
 * The parser is here rather than in the preflight because nothing under `suites/` runs in CI.
 */
describe('reading the segment length a run says it needs', () => {
  it('treats an unset variable as undeclared rather than guessing either way', () => {
    assert.equal(readSegmentExpectation(''), 'undeclared');
  });

  it('reads a whole number of seconds, which is what the in-browser profile needs', () => {
    assert.equal(readSegmentExpectation('2'), 2);
  });

  it('reads a fractional second, which is what the gateway control needs', () => {
    assert.equal(readSegmentExpectation('0.5'), 0.5);
  });

  it('ignores surrounding whitespace, which an env file makes easy to leave behind', () => {
    assert.equal(readSegmentExpectation('  2  '), 2);
  });

  /**
   * The one spelling that waives the check, and it has to be a word rather than an absence. A run
   * against a stage this cannot read is legitimate, and it declares itself once the way
   * `E2E_EXPECT_ABR=false` does.
   */
  it('reads the word that declares a run does not pin a segment length', () => {
    assert.equal(readSegmentExpectation('any'), 'any');
  });

  it('refuses a value no arithmetic can use rather than falling back to undeclared', () => {
    assert.throws(() => readSegmentExpectation('two'), /E2E_EXPECT_SEGMENT_S/);
  });

  /**
   * `parseFloat` stops at the first character it cannot use, so `2s` would read as 2 and `0x2` as 0.
   * The second is the one that matters: a zero-length segment and an unparseable one would become
   * the same declaration, and every later division by it is an infinity.
   */
  it('refuses a number with a unit stuck to it rather than parsing the prefix', () => {
    assert.throws(() => readSegmentExpectation('2s'), /E2E_EXPECT_SEGMENT_S/);
  });

  it('refuses zero and negatives, which no segment can be', () => {
    assert.throws(() => readSegmentExpectation('0'), /E2E_EXPECT_SEGMENT_S/);
    assert.throws(() => readSegmentExpectation('-2'), /E2E_EXPECT_SEGMENT_S/);
  });
});
