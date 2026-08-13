import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { counterbalancedOrder, gatewayArmIsComparable, normalizeGatewayUrl } from '../src/browser/gatewaySweep.js';

/**
 * That a gateway arm is the condition it claims, and that the order cannot fake a result.
 *
 * ⛔⛔⛔ The failure this guards is the worst one available to this sitting. A switch that silently
 * does nothing leaves both arms reading the same node, every metric agrees, and the report says
 * **"funding makes no difference to a viewer"**. That is a wrong answer rather than a missing one,
 * and it is exactly what an optimist expects to see, so nothing about it would look suspicious.
 */

const FUNDED = 'http://127.0.0.1:10077';
const UNFUNDED = 'http://127.0.0.1:10087';

describe('an arm is the gateway it claims to be', () => {
  it('accepts an arm that landed where it was sent', () => {
    const verdict = gatewayArmIsComparable({ gatewayUrl: UNFUNDED, failure: null }, UNFUNDED);

    assert.equal(verdict, null);
  });

  /**
   * ⛔ The whole reason the readback exists. Counting this arm would put the funded node's numbers
   * in the unfunded column, which is not a weaker result, it is the opposite result.
   */
  it('excludes an arm that stayed on the other gateway', () => {
    const verdict = gatewayArmIsComparable({ gatewayUrl: FUNDED, failure: null }, UNFUNDED);

    assert.match(verdict ?? '', /wrong condition/);
    assert.match(verdict ?? '', /10087/);
    assert.match(verdict ?? '', /10077/);
  });

  it('excludes an arm the client could not be asked about at all', () => {
    const verdict = gatewayArmIsComparable(
      { gatewayUrl: null, failure: 'no gateway switch at globalThis.__swarmGatewaySwitch' },
      UNFUNDED,
    );

    assert.match(verdict ?? '', /no gateway switch/);
  });

  it('excludes an arm that reported no gateway, rather than assuming the request took', () => {
    const verdict = gatewayArmIsComparable({ gatewayUrl: null, failure: null }, UNFUNDED);

    assert.match(verdict ?? '', /no gateway at all/);
  });

  /** `setGatewayUrl` strips trailing slashes, so a readback of the normalised form is not a mismatch. */
  it('does not call a trailing slash a different gateway', () => {
    const verdict = gatewayArmIsComparable({ gatewayUrl: UNFUNDED, failure: null }, `${UNFUNDED}/`);

    assert.equal(verdict, null);
    assert.equal(normalizeGatewayUrl(`${UNFUNDED}///`), UNFUNDED);
  });
});

/** Two arms of one condition back to back, which is what a drift or a load spike can hide in. */
function seams(order: readonly string[]): number {
  return order.filter((arm, index) => index > 0 && order[index - 1] === arm).length;
}

/**
 * ⛔⛔ AN EARLIER VERSION OF THIS SUITE ASSERTED ZERO SEAMS, AND ZERO IS NOT AVAILABLE.
 *
 * A seam-free order means every round runs the same way round, `ABABAB`, which puts one condition
 * first in every round. Any drift inside a round then lands on it systematically and reads as the
 * condition, which is the confound counterbalancing exists to remove and is the worse of the two.
 * The test failed, and the claim was wrong rather than the code.
 *
 * ⭐ So the real question is which position-balanced order has fewest seams, and these hold the
 * answer rather than a slogan.
 */
describe('the arm order cannot fake a result', () => {
  it('runs two rounds forward then two reversed', () => {
    assert.deepEqual(counterbalancedOrder(['A', 'B'], 4), ['A', 'B', 'A', 'B', 'B', 'A', 'B', 'A']);
  });

  it('pays the seam once over four rounds, where the alternatives pay it two or three times', () => {
    const chosen = counterbalancedOrder(['A', 'B'], 4);

    assert.equal(seams(chosen), 1);
    // The naive counterbalance, AB/BA/AB/BA, and the order this file used before the arithmetic
    // was checked, AB/BA/BA/AB. Both are balanced and both seam more often.
    assert.equal(seams(['A', 'B', 'B', 'A', 'A', 'B', 'B', 'A']), 3);
    assert.equal(seams(['A', 'B', 'B', 'A', 'B', 'A', 'A', 'B']), 2);
  });

  it('gives both conditions the same number of arms', () => {
    for (const rounds of [1, 2, 3, 4, 5, 8]) {
      const order = counterbalancedOrder(['A', 'B'], rounds);

      assert.equal(order.length, rounds * 2);
      assert.equal(
        order.filter((arm) => arm === 'A').length,
        order.filter((arm) => arm === 'B').length,
        `unbalanced at ${rounds} rounds: ${order.join('')}`,
      );
    }
  });

  /**
   * Position within a round is the other half of the counterbalance: if one condition always went
   * first, any drift inside a round would land on it systematically and read as the condition.
   */
  it('gives both conditions the same number of first positions', () => {
    const order = counterbalancedOrder(['A', 'B'], 4);

    const firsts = order.filter((_, index) => index % 2 === 0);
    assert.equal(firsts.filter((arm) => arm === 'A').length, 2);
    assert.equal(firsts.filter((arm) => arm === 'B').length, 2);
  });
});
