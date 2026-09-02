import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABR_BANDWIDTH_FACTOR,
  ABR_BANDWIDTH_UP_FACTOR,
  estimateNeededToClimbKbps,
  isRungAffordable,
} from '../src/abrTuning.js';

/**
 * The rules the e2e quality report reads to say which rungs a cap left within reach.
 *
 * The 2026-09-02 report called 720p affordable under a 2800 kbps cap because 2800 <= 2800, and the
 * player never took it: hls.js wants the rung under 95% of what it measures. These pin the rule the
 * player actually applies, so the report cannot drift back to plain arithmetic.
 */
describe('which rungs a player may take', () => {
  it('holds hls.js defaults, so the client and the harness read one pair of numbers', () => {
    assert.equal(ABR_BANDWIDTH_FACTOR, 0.95);
    assert.equal(ABR_BANDWIDTH_UP_FACTOR, 0.7);
  });

  it('refuses a rung cut at exactly the bandwidth, because the player wants 5% spare', () => {
    assert.equal(isRungAffordable(2800, 2800), false);
  });

  it('admits a rung that sits under 95% of the bandwidth', () => {
    assert.equal(isRungAffordable(1200, 2800), true);
    assert.equal(isRungAffordable(2659, 2800), true);
    assert.equal(isRungAffordable(2660, 2800), false);
  });

  it('needs the estimate over the rung divided by 0.7 before climbing to it', () => {
    assert.equal(estimateNeededToClimbKbps(2800), 4000);
    assert.equal(estimateNeededToClimbKbps(1200), 1715);
    assert.equal(estimateNeededToClimbKbps(700), 1000);
  });
});
