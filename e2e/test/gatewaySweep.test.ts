import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  counterbalancedOrder,
  FUNDED_ARM,
  gatewayArmIsComparable,
  gatewayArmOrder,
  normalizeGatewayUrl,
  readGateway,
  seedGateway,
  selectGateway,
  UNFUNDED_ARM,
} from '../src/browser/gatewaySweep.js';

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

  /**
   * ⛔ The shell driver reads this rather than deriving it. Four different burn rates once lived in
   * three scripts because a rule with two implementations gets corrected in whichever one somebody is
   * looking at, and this particular rule has already been wrong here once.
   */
  it('names the arms of a funding sitting in the same order', () => {
    assert.deepEqual(gatewayArmOrder(2), [FUNDED_ARM, UNFUNDED_ARM, FUNDED_ARM, UNFUNDED_ARM]);
    assert.deepEqual(gatewayArmOrder(4), counterbalancedOrder([FUNDED_ARM, UNFUNDED_ARM] as const, 4));
  });
});

/** Enough of a Playwright page to run the browser-side body against a globalThis this test controls. */
function pageWithSwitch(gatewaySwitch: { current: () => string; select: (url: string) => void } | undefined) {
  const holder = globalThis as unknown as Record<string, unknown>;
  return {
    evaluate: async <A, R>(fn: (arg: A) => R, arg: A): Promise<R> => {
      const had = Object.hasOwn(holder, '__swarmGatewaySwitch');
      const previous = holder.__swarmGatewaySwitch;
      if (gatewaySwitch === undefined) {
        delete holder.__swarmGatewaySwitch;
      } else {
        holder.__swarmGatewaySwitch = gatewaySwitch;
      }
      try {
        return fn(arg);
      } finally {
        if (had) {
          holder.__swarmGatewaySwitch = previous;
        } else {
          delete holder.__swarmGatewaySwitch;
        }
      }
    },
  };
}

function switchAt(url: string) {
  const state = { url, selections: [] as string[] };
  return {
    state,
    handle: {
      current: () => state.url,
      select: (next: string) => {
        state.selections.push(next);
        state.url = next.replace(/\/+$/, '');
      },
    },
  };
}

/**
 * ⛔⛔ An arm that switches gateway after playback has started bought its JOIN from the default node,
 * which is the funded one. Joining is the expensive part of a viewer's session, so an unfunded arm
 * spliced that way is diluted at exactly the phase where the difference should be largest, and it is
 * diluted TOWARDS the null. Seeding is what makes an arm the arm from its first request.
 */
describe('an arm is on its own gateway before the client runs', () => {
  it('seeds the key the client loads from, so the very first render is on the arm', async () => {
    const scripts: { fn: (arg: { key: string; value: string }) => void; arg: { key: string; value: string } }[] = [];
    const context = {
      addInitScript: async (fn: (arg: { key: string; value: string }) => void, arg: { key: string; value: string }) => {
        scripts.push({ fn, arg });
      },
    };

    await seedGateway(context as never, 'http://127.0.0.1:10087/');

    assert.equal(scripts.length, 1);
    const stored: Record<string, string> = {};
    const priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { setItem: (key: string, value: string) => void (stored[key] = value) },
    });
    try {
      scripts[0].fn(scripts[0].arg);
    } finally {
      if (priorLocalStorage) {
        Object.defineProperty(globalThis, 'localStorage', priorLocalStorage);
      } else {
        delete (globalThis as unknown as Record<string, unknown>).localStorage;
      }
    }

    // Trailing slash stripped, because that is what the client stores and what a readback compares to.
    assert.deepEqual(stored, { 'swarm-gateway-url': 'http://127.0.0.1:10087' });
  });

  /**
   * The e2e side spells the key itself, since this package does not depend on the client. This is the
   * check that keeps the copy honest: a rename in the client that missed here would leave every arm
   * seeded into a key nobody reads, and every arm would then run on the default gateway.
   */
  it('spells the key the client actually reads', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const app = readFileSync(join(root, 'packages/client/src/providers/App.tsx'), 'utf8');

    const declared = /GATEWAY_STORAGE_KEY = '([^']+)'/.exec(app);
    assert.ok(declared, 'the client no longer declares GATEWAY_STORAGE_KEY as a literal');

    const mirrored = /GATEWAY_STORAGE_KEY = '([^']+)'/.exec(
      readFileSync(join(root, 'e2e/src/browser/gatewaySweep.ts'), 'utf8'),
    );
    assert.equal(mirrored?.[1], declared[1]);
  });
});

describe('reading the arm back does not disturb the arm', () => {
  it('reports the gateway without selecting anything', async () => {
    const { state, handle } = switchAt('http://127.0.0.1:10087');

    const setup = await readGateway(pageWithSwitch(handle) as never);

    assert.deepEqual(setup, { gatewayUrl: 'http://127.0.0.1:10087', failure: null });
    // ⛔ `setGatewayUrl` resets the catalog reader and marks every manifest dirty. That is correct for
    // a mid-stream switch and is a disturbance a seeded arm has no reason to pay.
    assert.deepEqual(state.selections, []);
  });

  it('fails the arm when the build published no switch at all', async () => {
    const setup = await readGateway(pageWithSwitch(undefined) as never);

    assert.equal(setup.gatewayUrl, null);
    assert.match(setup.failure ?? '', /VITE_EXPOSE_PLAYER/);
  });

  it('still moves the player when a run asks it to', async () => {
    const { state, handle } = switchAt('http://127.0.0.1:10077');

    const setup = await selectGateway(pageWithSwitch(handle) as never, 'http://127.0.0.1:10087');

    assert.deepEqual(state.selections, ['http://127.0.0.1:10087']);
    assert.equal(setup.gatewayUrl, 'http://127.0.0.1:10087');
  });
});
