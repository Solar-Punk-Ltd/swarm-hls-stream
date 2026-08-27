import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { type Page } from 'playwright-core';

import { openByteSourceArmSession } from '../src/browser/byteSourceArm.js';

/**
 * That opening a byte-source arm and proving it cannot come apart.
 *
 * ⛔⛔⛔ They came apart for the whole life of the corpus. The pair was inline in `watch.ts` and
 * nowhere else, so `crash.ts` and `buffer-sweep.ts` read `BROWSER_FETCH_BACKEND` never, ran on the
 * gateway, and looked exactly like runs configured to use the gateway. Every crash-recovery reading
 * this project has is a gateway reading, whatever the run was labelled.
 *
 * The half that matters is the proof. A weeb-3 arm's headline is zero gateway reads, and a client
 * that never loaded a node at all produces the same zero, so an arm without its proof is not a weaker
 * result: it is an unfalsifiable one.
 */

/** The client-side switch the arm setup talks to, as the real client exposes it. */
const HANDLE = '__swarmFetchBackendSwitch';
const WASM = 'https://example.test/assets/weeb_3_bg-CGW4ecJL.wasm';
const SEGMENT = 'http://gw.test:1633/bytes/abc';

/** Runs the page function against this process's own globals, which is all the arm setup touches. */
const fakePage = (): Page =>
  ({ evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg)) } as unknown as Page);

function installSwitch({ prewarms = true, lands = 'weeb3' }: { prewarms?: boolean; lands?: string } = {}): void {
  (globalThis as Record<string, unknown>)[HANDLE] = {
    prewarm: () => (prewarms ? Promise.resolve() : Promise.reject(new Error('no peers'))),
    select: () => undefined,
    current: () => lands,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
});

const openArm = (source: 'weeb3' | 'gateway' | null) =>
  openByteSourceArmSession({ page: fakePage(), source, playbackStartedAtMs: Date.now(), settleMs: 40 });

describe('a run that asked for no byte source', () => {
  it('reports no arm, so a report cannot claim a condition the run did not set', async () => {
    assert.equal((await openArm(null)).arm, undefined);
  });

  /** So every driver can call the proof unconditionally instead of guarding it and forgetting to. */
  it('proves nothing and throws nothing, even over a log that would damn a weeb-3 arm', async () => {
    const session = await openArm(null);

    session.proveBytesCameFromIt([{ url: SEGMENT, startedAtMs: Date.now() + 10_000 }]);
  });
});

describe('a run that asked for the in-tab node', () => {
  it('reports the arm the client landed on', async () => {
    installSwitch();

    const session = await openArm('weeb3');

    assert.equal(session.arm?.requested, 'weeb3');
    assert.equal(session.arm?.reported, 'weeb3');
  });

  it('refuses to open at all when the node cannot reach the network', async () => {
    installSwitch({ prewarms: false });

    await assert.rejects(openArm('weeb3'), /did not reach the network/);
  });

  it('refuses to open when the client landed somewhere else', async () => {
    installSwitch({ lands: 'gateway' });

    await assert.rejects(openArm('weeb3'), /not the condition it claims/);
  });

  it('passes an arm that loaded the wasm and read no segments through the gateway', async () => {
    installSwitch();
    const session = await openArm('weeb3');

    session.proveBytesCameFromIt([{ url: WASM, startedAtMs: session.arm!.windowStartedAtMs + 5 }]);
  });

  /** The zero that is a defect rather than a result: no node ever loaded, so nothing was measured. */
  it('throws on the arm whose zero is because no node ever loaded', async () => {
    installSwitch();
    const session = await openArm('weeb3');

    assert.throws(() => session.proveBytesCameFromIt([]), /not the condition it claims/);
  });

  it('throws on an arm that went on reading the gateway inside its own window', async () => {
    installSwitch();
    const session = await openArm('weeb3');

    assert.throws(
      () =>
        session.proveBytesCameFromIt([
          { url: WASM, startedAtMs: session.arm!.windowStartedAtMs + 1 },
          { url: SEGMENT, startedAtMs: session.arm!.windowStartedAtMs + 2 },
        ]),
      /not the condition it claims/,
    );
  });

  /** An arm reads through the gateway while its node boots, so the window is what is judged. */
  it('ignores the gateway reads that happened before the window opened', async () => {
    installSwitch();
    const session = await openArm('weeb3');

    session.proveBytesCameFromIt([
      { url: SEGMENT, startedAtMs: session.arm!.windowStartedAtMs - 1_000 },
      { url: WASM, startedAtMs: session.arm!.windowStartedAtMs + 1 },
    ]);
  });
});
