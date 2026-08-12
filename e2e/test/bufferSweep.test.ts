import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { armIsComparable, type ArmSetup } from '../src/browser/bufferSweep.js';

function armThatTook(over: Partial<ArmSetup> = {}): ArmSetup {
  return {
    targetLatencyS: 3,
    maxLatencyS: 6,
    targetDurationS: 1,
    stallCountAtStart: 0,
    failure: null,
    ...over,
  };
}

/**
 * What the sweep is allowed to count.
 *
 * The reason this is a function rather than a comment in the runner is that a sweep which quietly
 * counts a contaminated arm reports a clean result it never measured, and by then the broadcast has
 * been paid for. Every rejection here corresponds to a way an arm can look fine and mean nothing.
 */
describe('deciding whether an arm can be counted', () => {
  it('counts an arm that took its target on a clean player', () => {
    assert.equal(armIsComparable(armThatTook(), 1), null);
  });

  it('rejects an arm the player never accepted', () => {
    const reason = armIsComparable(armThatTook({ targetLatencyS: null }), 1);

    assert.match(reason ?? '', /nothing says the arm took/);
  });

  it('passes a setup failure straight through rather than judging around it', () => {
    const reason = armIsComparable(armThatTook({ failure: 'no player at globalThis.__swarmHlsPlayer' }), 1);

    assert.equal(reason, 'no player at globalThis.__swarmHlsPlayer');
  });

  /**
   * hls.js carries `stallCount` on the player instance and adds it to every target it computes, so an
   * arm that starts with one inherited from its predecessor is measuring the arm before it.
   * `hls.targetLatency = x` is supposed to zero it, and this is what notices when it did not.
   */
  it('rejects an arm still carrying the previous arm stall penalty', () => {
    const reason = armIsComparable(armThatTook({ stallCountAtStart: 2 }), 1);

    assert.match(reason ?? '', /carries the previous arm/);
  });

  /**
   * The penalty ceiling is `#EXT-X-TARGETDURATION`, which the uploader keeps as a running maximum of
   * `ceil()` that never falls. One force-closed segment raises it for the rest of the broadcast, so
   * arms either side of that moment are measured under different ceilings.
   */
  it('rejects an arm measured under a ceiling that moved mid-sitting', () => {
    const reason = armIsComparable(armThatTook({ targetDurationS: 3 }), 1);

    assert.match(reason ?? '', /EXT-X-TARGETDURATION moved from 1 to 3/);
  });

  it('does not reject on a ceiling it never saw, since an unknown is not a mismatch', () => {
    assert.equal(armIsComparable(armThatTook({ targetDurationS: null }), 1), null);
    assert.equal(armIsComparable(armThatTook(), null), null);
  });

  /**
   * A player that reports no stall count at all is a player this cannot vet, and rejecting on that
   * would drop every arm. It is allowed through deliberately, which is worth an assertion so the
   * decision is visible rather than an accident of the condition's shape.
   */
  it('allows an arm whose player reported no stall count', () => {
    assert.equal(armIsComparable(armThatTook({ stallCountAtStart: null }), 1), null);
  });
});
