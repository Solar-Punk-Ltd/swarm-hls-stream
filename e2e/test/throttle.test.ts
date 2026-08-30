import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  kbpsAsBytesPerSecond,
  MIN_RUNGS_FOR_A_STEP_DOWN,
  nowhereToStepRefusal,
  tallestAffordableRung,
  throttleKbpsBelow,
} from '../src/browser/throttle.js';
import { type LadderRung } from '../src/config.js';

/** The ladder `DEFAULT_LADDER_SPEC` declares, which is what a documented install runs. */
const SHIPPED: LadderRung[] = [
  { name: '1080p', width: 1920, height: 1080, kbps: 5000 },
  { name: '720p', width: 1280, height: 720, kbps: 2800 },
  { name: '480p', width: 854, height: 480, kbps: 1200 },
  { name: '360p', width: 640, height: 360, kbps: 700 },
];

describe('the bandwidth that makes the rung a viewer is on unaffordable', () => {
  /**
   * ⭐ Both halves of V2 depend on this one number. Below the next rung down and that rung starves
   * too, so the "kept playing" assertion fails for the harness's reasons. Above the rung being
   * played and the viewer has no reason to move, so the case fails a working product.
   */
  it('is the next rung down, so that one still plays and the current one no longer fits', () => {
    assert.equal(throttleKbpsBelow(SHIPPED, 1080), 2800);
    assert.equal(throttleKbpsBelow(SHIPPED, 720), 1200);
    assert.equal(throttleKbpsBelow(SHIPPED, 480), 700);
  });

  /**
   * ⛔⛔ The case that cost a paid arm on 2026-08-30. The gateway profile settled its viewer on 360p,
   * the BOTTOM rung, before anything was capped. A cap taken from the ladder in the abstract left
   * 360p affordable, the player correctly stayed, and V2 reported "a ladder nobody descends".
   */
  it('is nothing at all for a viewer already on the bottom rung', () => {
    assert.equal(throttleKbpsBelow(SHIPPED, 360), null);
  });

  /** The spec is written top down and could be written any way, so the order must not decide this. */
  it('reads the ladder by bitrate rather than by the order it was declared in', () => {
    assert.equal(throttleKbpsBelow([...SHIPPED].reverse(), 1080), 2800);
  });

  /** A cap derived by guessing which rung is playing is a cap nobody chose. */
  it('refuses a rung the ladder does not declare', () => {
    assert.throws(() => throttleKbpsBelow(SHIPPED, 1440), /would be a cap nobody chose/);
  });
});

describe('whether this viewer can be asked the question at all', () => {
  it('lets a viewer above the bottom rung through', () => {
    assert.equal(nowhereToStepRefusal(SHIPPED, 720), null);
  });

  /**
   * ⛔ Refused rather than failed. There is no bandwidth that would give this viewer somewhere to go,
   * so the question cannot be put to them, and failing them reports a property of the BYTE SOURCE as
   * a defect in the ladder.
   */
  it('refuses a viewer already on the bottom rung, and says whose property that is', () => {
    const refusal = String(nowhereToStepRefusal(SHIPPED, 360));

    assert.match(refusal, /bottom of the ladder/);
    assert.match(refusal, /property of the byte source/);
  });

  /**
   * ⛔ A single-rendition stack has nowhere to step. A player that stays where it is has behaved
   * perfectly, so a suite that ran here would either fail a correct player or pass by asserting
   * nothing.
   */
  it('refuses a ladder with nowhere to step', () => {
    const single = SHIPPED.slice(0, MIN_RUNGS_FOR_A_STEP_DOWN - 1);

    assert.match(String(nowhereToStepRefusal(single, 1080)), /no question here to answer/);
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
