import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  gatewayLessArmOrder,
  HYBRID_VIEWER,
  NATIVE_VIEWER,
  viewerConditionFromEnv,
} from '../src/browser/viewerConditions.js';

describe('gatewayLessArmOrder', () => {
  it('runs two arms per round, one of each condition', () => {
    const order = gatewayLessArmOrder(3);

    assert.equal(order.length, 6);
    assert.equal(order.filter((c) => c === NATIVE_VIEWER).length, 3);
    assert.equal(order.filter((c) => c === HYBRID_VIEWER).length, 3);
  });

  it('counterbalances, so neither condition always goes first', () => {
    const order = gatewayLessArmOrder(4);
    const firstOfEachRound = [order[0], order[2], order[4], order[6]];

    assert.ok(
      firstOfEachRound.includes(NATIVE_VIEWER) && firstOfEachRound.includes(HYBRID_VIEWER),
      `both conditions must lead a round, got ${firstOfEachRound.join(' ')}`,
    );
  });

  it('opens with the gateway-less condition, which is the one the sitting is for', () => {
    assert.equal(gatewayLessArmOrder(1)[0], NATIVE_VIEWER);
  });
});

describe('viewerConditionFromEnv', () => {
  it('accepts each condition by name', () => {
    assert.equal(viewerConditionFromEnv('native'), NATIVE_VIEWER);
    assert.equal(viewerConditionFromEnv('weeb3'), HYBRID_VIEWER);
  });

  it('⛔ throws on a name it does not know rather than defaulting, so a typo cannot silently run one condition twice', () => {
    assert.throws(() => viewerConditionFromEnv('weeb-3'), /not a viewer condition/);
    assert.throws(() => viewerConditionFromEnv('gateway'), /not a viewer condition/);
    assert.throws(() => viewerConditionFromEnv(undefined), /not a viewer condition/);
  });
});
