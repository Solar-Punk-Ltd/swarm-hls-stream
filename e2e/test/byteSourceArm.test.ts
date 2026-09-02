import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { type Page } from 'playwright-core';

import { openByteSourceArmSession } from '../src/browser/byteSourceArm.js';
import { type ProofWindow } from '../src/browser/fetchBackendSweep.js';

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
/**
 * Generous on purpose. The arm-open measures real wall time against this budget, and a unit test
 * on a loaded machine can lose 100ms to the event loop before the fake even runs: at 40ms this
 * suite flaked exactly that way (2026-08-27). The fairness guard itself is exercised where a test
 * controls the clock it measures, not here.
 */
const TEST_SETTLE_MS = 10_000;

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

/** ⛔ `playbackStartedAtMs` is an option so a test can assert against the instant it handed in. */
const openArm = (
  source: 'weeb3' | 'gateway' | null,
  {
    settleMs = TEST_SETTLE_MS,
    proofWindow,
    playbackStartedAtMs = Date.now(),
  }: { settleMs?: number; proofWindow?: ProofWindow; playbackStartedAtMs?: number } = {},
) => openByteSourceArmSession({ page: fakePage(), source, playbackStartedAtMs, settleMs, proofWindow });

/**
 * The settle the window tests below open their arms with.
 *
 * Shorter than {@link TEST_SETTLE_MS} because these ask WHICH instant was recorded rather than
 * whether the fairness guard fires, and an arm-open sleeps out its whole settle in real time. A
 * second is ten times the event-loop delay that flaked this suite at 40ms, and an arm that lost more
 * than that throws by name rather than reading as a pass.
 */
const WINDOW_SETTLE_MS = 1_000;

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

/**
 * ⛔⛔⛔ Which instant an arm is proved from, and why a recording needs a different one.
 *
 * A finite recording is fetched whole in its first seconds, and a gateway arm has no node to boot,
 * so nothing about its settle is waiting for anything. Proved from the settle's end, every healthy
 * gateway playback arm refused for making no `/bytes/` request inside its window, which is what made
 * V4 the only red of the sitting of 2026-09-03 on a complete recording. A weeb-3 arm keeps the
 * settle-end window: the segments it fetched before the switch came from the gateway by design, and
 * judging it from playback start would refuse it for reading the gateway it was told to read.
 */
describe('which instant an arm is proved from', () => {
  it('proves a live arm from the end of its settle, which is what every driver had', async () => {
    installSwitch();
    const playbackStartedAtMs = Date.now();
    const session = await openArm('weeb3', { settleMs: WINDOW_SETTLE_MS, playbackStartedAtMs });

    assert.equal(session.arm?.proofWindow, 'after-settle');
    assert.ok(
      session.arm!.windowStartedAtMs >= playbackStartedAtMs + WINDOW_SETTLE_MS,
      "the window opened before the settle ended, so a booting node's gateway reads would be counted",
    );
  });

  /** ⭐ The settle still happens. All that moves is the instant the request log is read from. */
  it('proves a recording arm from playback start, while still settling for the same wall clock', async () => {
    installSwitch({ lands: 'gateway' });
    const playbackStartedAtMs = Date.now();
    const session = await openArm('gateway', {
      settleMs: WINDOW_SETTLE_MS,
      proofWindow: 'from-playback-start',
      playbackStartedAtMs,
    });

    assert.equal(session.arm?.proofWindow, 'from-playback-start');
    assert.equal(session.arm?.windowStartedAtMs, playbackStartedAtMs);
    assert.ok(
      session.arm!.settledForMs >= WINDOW_SETTLE_MS,
      'the arm returned before its settle was spent, so the two byte sources hold players of different ages',
    );
  });

  /** The whole point: the segments a player pulled in its first seconds now prove the arm. */
  it('accepts a gateway arm whose only segments were fetched before the settle ended', async () => {
    installSwitch({ lands: 'gateway' });
    const session = await openArm('gateway', { settleMs: WINDOW_SETTLE_MS, proofWindow: 'from-playback-start' });

    session.proveBytesCameFromIt([{ url: SEGMENT, startedAtMs: session.arm!.windowStartedAtMs + 5 }]);
  });
});
