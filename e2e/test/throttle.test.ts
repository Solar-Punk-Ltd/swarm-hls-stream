import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  kbpsAsBytesPerSecond,
  MIN_RUNGS_FOR_A_STEP_DOWN,
  tallestAffordableRung,
  throttleKbpsFor,
} from '../src/browser/throttle.js';
import { type LadderRung } from '../src/config.js';

/** The ladder `DEFAULT_LADDER_SPEC` declares, which is what a documented install runs. */
const SHIPPED: LadderRung[] = [
  { name: '1080p', width: 1920, height: 1080, kbps: 5000 },
  { name: '720p', width: 1280, height: 720, kbps: 2800 },
  { name: '480p', width: 854, height: 480, kbps: 1200 },
  { name: '360p', width: 640, height: 360, kbps: 700 },
];

describe('the bandwidth that makes the upper rungs unaffordable', () => {
  /**
   * ⭐ Both halves of V2 depend on this one number. Below it and the lowest rung starves too, so the
   * "kept playing" assertion fails for the harness's reasons. Above it and the top rung stays
   * affordable, so a correct player has no reason to step down and the case fails a working product.
   */
  it('is the second lowest rung, so everything above it starves and the bottom still plays', () => {
    assert.equal(throttleKbpsFor(SHIPPED), 1200);
  });

  /** The spec is written top down and could be written any way, so the order must not decide this. */
  it('reads the ladder by bitrate rather than by the order it was declared in', () => {
    assert.equal(throttleKbpsFor([...SHIPPED].reverse()), 1200);
  });

  /**
   * ⛔ A single-rendition stack has nowhere to step. A player that stays where it is has behaved
   * perfectly, so a suite that ran here would either fail a correct player or pass by asserting
   * nothing, and both are worse than refusing.
   */
  it('refuses a ladder with nowhere to step', () => {
    assert.throws(() => throttleKbpsFor(SHIPPED.slice(0, MIN_RUNGS_FOR_A_STEP_DOWN - 1)), /nowhere to go/);
  });

  it('leaves exactly one step on the shortest ladder that has one', () => {
    const twoRung = [SHIPPED[0], SHIPPED[3]];

    assert.equal(throttleKbpsFor(twoRung), 5000, 'the top rung of a two rung ladder is its second lowest');
  });
});

describe('which rung a given bandwidth can carry', () => {
  it('is the tallest whose declared bitrate fits inside it', () => {
    assert.equal(tallestAffordableRung(SHIPPED, 1200)?.name, '480p');
    assert.equal(tallestAffordableRung(SHIPPED, 2800)?.name, '720p');
  });

  /** A link under the bottom rung carries no rung at all, which is a starved viewer rather than 360p. */
  it('is nothing at all below the bottom rung', () => {
    assert.equal(tallestAffordableRung(SHIPPED, 100), null);
  });
});

describe('the units the debug protocol wants', () => {
  /** ⛔ CDP takes BYTES per second and a ladder declares KILOBITS. Off by eight is a throttle that is not one. */
  it('turns declared kilobits per second into bytes per second', () => {
    assert.equal(kbpsAsBytesPerSecond(1200), 150_000);
    assert.equal(kbpsAsBytesPerSecond(700), 87_500);
  });
});
