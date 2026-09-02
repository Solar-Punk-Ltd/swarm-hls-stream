import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { type Page } from 'playwright-core';

import {
  armBytesCameFromItsSource,
  byteSourceArmIsComparable,
  byteSourceArmOrder,
  GATEWAY_BYTES,
  retrieveThroughInTabNode,
  type TimedRequest,
  WEEB3_BYTES,
} from '../src/browser/fetchBackendSweep.js';

/**
 * That a byte-source arm is the condition it claims, judged on what the network did.
 *
 * ⛔⛔⛔ The failure this guards is worse here than in the gateway sitting. There, a dead switch left
 * both arms on one node and the report said funding does not matter. Here a dead switch leaves both
 * arms reading the gateway, and the report says **an in-tab Swarm node holds a live edge exactly as
 * well as a gateway does** — the most attractive possible headline, produced by nothing happening.
 */

const WINDOW_OPENED_AT = 1_000_000;

const at = (startedAtMs: number, url: string): TimedRequest => ({ url, startedAtMs });

/** The chunk name Vite emitted in A2, hash and all, so the matcher is tested against a real filename. */
const WASM = at(WINDOW_OPENED_AT - 30_000, 'http://127.0.0.1:10074/assets/weeb_3_bg-CGW4ecJL.wasm');

const segment = (startedAtMs: number): TimedRequest =>
  at(startedAtMs, 'http://127.0.0.1:10077/bytes/9c1f4a2b3d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8');

describe('an arm is the byte source it claims to be', () => {
  it('accepts an arm the client says it moved', () => {
    const verdict = byteSourceArmIsComparable({ byteSource: WEEB3_BYTES, failure: null }, WEEB3_BYTES);

    assert.equal(verdict, null);
  });

  /**
   * ⛔ The whole reason the readback exists. Counting this arm would file a gateway's numbers under
   * the in-tab node, which is not a weaker result, it is the opposite result.
   */
  it('excludes an arm that stayed on the gateway', () => {
    const verdict = byteSourceArmIsComparable({ byteSource: GATEWAY_BYTES, failure: null }, WEEB3_BYTES);

    assert.match(verdict ?? '', /wrong condition/);
    assert.match(verdict ?? '', /weeb3/);
    assert.match(verdict ?? '', /gateway/);
  });

  it('excludes an arm whose client publishes no switch at all', () => {
    const verdict = byteSourceArmIsComparable(
      { byteSource: null, failure: 'no byte-source switch at globalThis.__swarmFetchBackendSwitch' },
      WEEB3_BYTES,
    );

    assert.match(verdict ?? '', /no byte-source switch/);
  });

  /** `selectFetchBackend` throws on an unknown value, and a driver typo has to name itself. */
  it('excludes an arm the client refused outright', () => {
    const verdict = byteSourceArmIsComparable(
      { byteSource: null, failure: 'the client refused the byte source "weeb-3": Error: unknown fetch backend' },
      WEEB3_BYTES,
    );

    assert.match(verdict ?? '', /refused/);
  });
});

describe('an arm is judged on where its bytes came from, not on what it believes', () => {
  it('accepts a gateway arm that fetched segments from the gateway', () => {
    const verdict = armBytesCameFromItsSource(
      [WASM, segment(WINDOW_OPENED_AT + 1), segment(WINDOW_OPENED_AT + 500)],
      GATEWAY_BYTES,
      WINDOW_OPENED_AT,
    );

    assert.equal(verdict, null);
  });

  /**
   * A gateway arm that fetched nothing is not a gateway reading. It is a browser that failed to play,
   * and its latency and stall columns would be filed as what a gateway gives a viewer.
   */
  it('excludes a gateway arm that fetched no segments at all', () => {
    const verdict = armBytesCameFromItsSource([segment(WINDOW_OPENED_AT - 10_000)], GATEWAY_BYTES, WINDOW_OPENED_AT);

    assert.match(verdict ?? '', /no \/bytes\/ request at all/);
  });

  it('accepts a weeb-3 arm that fetched the wasm and no segments', () => {
    const verdict = armBytesCameFromItsSource([WASM], WEEB3_BYTES, WINDOW_OPENED_AT);

    assert.equal(verdict, null);
  });

  /**
   * ⛔ The window is what makes the log decisive. A weeb-3 arm reads through the gateway for the
   * whole time its node is booting, by design, and judging it on its entire log would refuse every
   * arm the harness is capable of producing.
   */
  it('ignores the gateway segments a weeb-3 arm fetched while its node was still booting', () => {
    const verdict = armBytesCameFromItsSource(
      [WASM, segment(WINDOW_OPENED_AT - 20_000), segment(WINDOW_OPENED_AT - 1)],
      WEEB3_BYTES,
      WINDOW_OPENED_AT,
    );

    assert.equal(verdict, null);
  });

  it('excludes a weeb-3 arm that went on reading the gateway inside its window, and counts them', () => {
    const verdict = armBytesCameFromItsSource(
      [WASM, segment(WINDOW_OPENED_AT), segment(WINDOW_OPENED_AT + 900), segment(WINDOW_OPENED_AT + 1800)],
      WEEB3_BYTES,
      WINDOW_OPENED_AT,
    );

    assert.match(verdict ?? '', /3 \/bytes\/ request/);
    assert.match(verdict ?? '', /did not all come from the node/);
  });

  /**
   * ⛔⛔⛔ The one that matters most, and the one a zero cannot distinguish on its own.
   *
   * "No gateway served this arm" and "this arm fetched nothing whatsoever" are the same number in the
   * request log, and the first is the headline the sitting is booked to produce. Without the wasm as
   * a witness, a client that never loaded the backend at all would file the best possible result.
   */
  it('excludes a weeb-3 arm whose zero is because no node ever loaded', () => {
    const verdict = armBytesCameFromItsSource(
      [at(WINDOW_OPENED_AT - 5_000, 'http://127.0.0.1:10074/assets/index-BQrf19xz.js')],
      WEEB3_BYTES,
      WINDOW_OPENED_AT,
    );

    assert.match(verdict ?? '', /never fetched the weeb-3 wasm/);
    assert.match(verdict ?? '', /no video at all/);
  });

  /**
   * ⭐ Deliberate, and the line between a condition check and an outcome check.
   *
   * An in-tab node that cannot hold a live edge is the answer this sitting exists to find. A gate
   * that also refused arms which played badly would discard every negative result and report only
   * the runs where the node kept up, which is a filter dressed as a control.
   */
  it('accepts a weeb-3 arm that engaged its node and stalled from end to end', () => {
    const verdict = armBytesCameFromItsSource([WASM], WEEB3_BYTES, WINDOW_OPENED_AT);

    assert.equal(verdict, null, 'a real arm with a bad result was refused as though it were the wrong condition');
  });
});

describe('the order of a byte-source sitting', () => {
  it('gives each condition the same number of arms and of first positions', () => {
    const order = byteSourceArmOrder(4);
    const firsts = [0, 2, 4, 6].map((index) => order[index]);

    assert.equal(order.length, 8);
    assert.equal(order.filter((arm) => arm === WEEB3_BYTES).length, 4);
    assert.equal(firsts.filter((arm) => arm === WEEB3_BYTES).length, 2);
  });

  it('pays the seam once over four rounds, which is the fewest a balanced order allows', () => {
    const order = byteSourceArmOrder(4);
    const seams = order.filter((arm, index) => index > 0 && arm === order[index - 1]).length;

    assert.equal(seams, 1);
  });
});

/**
 * One retrieval driven through the client's own in-tab path.
 *
 * ⛔ Every failure comes back as a named sentence rather than a throw, so a probe that meets an older
 * deployed client loses one row legibly instead of dying part way through a sitting with an artifact
 * already half written.
 */
describe('a retrieval through the node in the tab', () => {
  const RETRIEVAL_HANDLE = '__swarmFetchBackendSwitch';
  const REF = 'a'.repeat(64);

  /** Runs the page function against this process's own globals, which is all this call touches. */
  const fakePage = (): Page =>
    ({ evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg)) } as unknown as Page);

  const installSwitch = (retrieveBytes: unknown): void => {
    (globalThis as Record<string, unknown>)[RETRIEVAL_HANDLE] = { retrieveBytes };
  };

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[RETRIEVAL_HANDLE];
  });

  it('reports what the node returned', async () => {
    installSwitch(() => Promise.resolve({ byteLength: 224_848, elapsedMs: 2_512 }));

    assert.deepEqual(await retrieveThroughInTabNode(fakePage(), REF), {
      byteLength: 224_848,
      elapsedMs: 2_512,
      failure: null,
    });
  });

  /**
   * ⛔ Passed as an argument rather than closed over. `page.evaluate` serialises its body, so a
   * reference captured from the harness's scope is simply absent in the page, and a run would either
   * die or fetch nothing while looking like it asked.
   */
  it('hands the reference it was given to the client', async () => {
    const asked: string[] = [];
    installSwitch((ref: string) => {
      asked.push(ref);
      return Promise.resolve({ byteLength: 1, elapsedMs: 1 });
    });

    await retrieveThroughInTabNode(fakePage(), REF);

    assert.deepEqual(asked, [REF]);
  });

  it('names the missing switch rather than throwing when the client exposes no player', async () => {
    const retrieval = await retrieveThroughInTabNode(fakePage(), REF);

    assert.equal(retrieval.byteLength, null);
    assert.match(String(retrieval.failure), /VITE_EXPOSE_PLAYER/);
  });

  /** A client built before this interface landed publishes the switch and not the call on it. */
  it('names an older client that publishes a switch without the retrieval on it', async () => {
    installSwitch(undefined);

    assert.match(String((await retrieveThroughInTabNode(fakePage(), REF)).failure), /retrieveBytes/);
  });

  /** A refusal is a reading. H3 predicts capped retrievals rejecting quickly, so it has to survive. */
  it("carries the node's own error back when the retrieval is refused", async () => {
    installSwitch(() => Promise.reject(new Error('all peers over their reserve')));

    const retrieval = await retrieveThroughInTabNode(fakePage(), REF);

    assert.equal(retrieval.byteLength, null);
    assert.match(String(retrieval.failure), /all peers over their reserve/);
  });
});
