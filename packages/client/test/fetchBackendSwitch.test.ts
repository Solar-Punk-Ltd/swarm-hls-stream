import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import {
  activeFetchBackend,
  FETCH_BACKEND_GATEWAY,
  FETCH_BACKEND_WEEB3,
  selectFetchBackend,
} from '../src/components/SwarmHlsPlayer/fetchBackend';
import {
  exposeFetchBackendForInstrumentation,
  FETCH_BACKEND_HANDLE,
  type FetchBackendSwitch,
} from '../src/components/SwarmHlsPlayer/fetchBackendTestHandle';
import type { Weeb3Module, Weeb3Node } from '../src/components/SwarmHlsPlayer/Weeb3FetchBackend';
import { Weeb3FetchBackend } from '../src/components/SwarmHlsPlayer/Weeb3FetchBackend';

const holder = globalThis as unknown as Record<string, unknown>;

/**
 * Moving the byte source without rebuilding the client.
 *
 * ## Why this exists
 *
 * A2 (PR #184) measured weeb-3 against the gateway by **rebuilding and redeploying the client between
 * arms**, because `VITE_BROWSER_FETCH_BACKEND` is baked in at build time. That puts two differences in
 * one comparison, the backend and the build, and it makes a counterbalanced live sitting impossible:
 * `AB/AB/BA/BA` inside one broadcast would need eight rebuilds.
 *
 * The gateway switch of #180 solved the same problem for gateways and the arms of #93 were run on it.
 * This is that, for the byte source.
 */
describe('moving the fetch backend at runtime', () => {
  afterEach(() => {
    selectFetchBackend(null);
    vi.unstubAllEnvs();
    delete holder[FETCH_BACKEND_HANDLE];
  });

  it('reads the build default when nothing has selected anything', () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', '');

    assert.equal(activeFetchBackend(), FETCH_BACKEND_GATEWAY);
  });

  it('reads what was selected, over the build default', () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', '');

    selectFetchBackend(FETCH_BACKEND_WEEB3);

    assert.equal(activeFetchBackend(), FETCH_BACKEND_WEEB3);
  });

  // Both directions, so an arm can go back rather than only forward.
  it('goes back to the gateway just as readily', () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', FETCH_BACKEND_WEEB3);
    selectFetchBackend(FETCH_BACKEND_GATEWAY);

    assert.equal(activeFetchBackend(), FETCH_BACKEND_GATEWAY);
  });

  it('releases the override, so the build default is reachable again', () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', FETCH_BACKEND_WEEB3);
    selectFetchBackend(FETCH_BACKEND_GATEWAY);

    selectFetchBackend(null);

    assert.equal(activeFetchBackend(), FETCH_BACKEND_WEEB3);
  });

  /**
   * ⛔⛔⛔ The failure this exists to prevent, and it is not hypothetical.
   *
   * On 2026-08-13 a gateway arm ran with a switch that silently did nothing: both arms read one node,
   * every metric agreed, and the sitting would have reported "funding makes no difference to a
   * viewer". A harness drives this through CDP where TypeScript does not exist, so `'weeb-3'` with a
   * hyphen, or a typo, or `undefined`, all arrive here as ordinary values.
   *
   * Refusing loudly is the whole point. A silent no-op produces a wrong answer that looks like a
   * result; a throw produces an arm that fails on its first fragment and says why.
   */
  it('refuses a backend it does not recognise, naming it, rather than ignoring it', () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', '');

    assert.throws(() => selectFetchBackend('weeb-3' as never), /weeb-3/);
    assert.throws(() => selectFetchBackend(undefined as never), /undefined/);

    assert.equal(activeFetchBackend(), FETCH_BACKEND_GATEWAY, 'a refused value changed the backend anyway');
  });
});

describe('publishing the fetch backend switch for a harness', () => {
  afterEach(() => {
    selectFetchBackend(null);
    vi.unstubAllEnvs();
    delete holder[FETCH_BACKEND_HANDLE];
  });

  it('publishes nothing in a build that did not ask for instrumentation', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '');

    assert.equal(exposeFetchBackendForInstrumentation(), null);
    assert.equal(holder[FETCH_BACKEND_HANDLE], undefined);
  });

  it('publishes a switch a harness can read and move', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', '');

    exposeFetchBackendForInstrumentation();
    const published = holder[FETCH_BACKEND_HANDLE] as {
      current: () => string;
      select: (backend: string) => void;
    };

    assert.equal(published.current(), FETCH_BACKEND_GATEWAY);
    published.select(FETCH_BACKEND_WEEB3);
    assert.equal(published.current(), FETCH_BACKEND_WEEB3);
    assert.equal(activeFetchBackend(), FETCH_BACKEND_WEEB3, 'the published switch moved nothing real');
  });

  it('hands back a detach that removes it', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');

    const detach = exposeFetchBackendForInstrumentation();
    detach?.();

    assert.equal(holder[FETCH_BACKEND_HANDLE], undefined);
  });

  /**
   * A remount publishes the new switch before React runs the old one's cleanup, so an unconditional
   * delete would remove the live one and leave a harness holding nothing mid-arm. Same guard, and the
   * same reason, as `gatewayTestHandle`.
   */
  it('does not remove a switch that replaced it', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');

    const stale = exposeFetchBackendForInstrumentation();
    exposeFetchBackendForInstrumentation();
    stale?.();

    assert.ok(holder[FETCH_BACKEND_HANDLE], 'the live switch was removed by a stale cleanup');
  });
});

/** A Swarm reference is 64 hex characters. Built from a repeat so it is obviously not a real one. */
const REF = 'ab'.repeat(32);

/** Swarm frames a reference's content with its length as a little-endian uint64. */
const SWARM_SPAN_BYTES = 8;

function spanPrefixed(payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(SWARM_SPAN_BYTES + payload.byteLength);
  new DataView(framed.buffer).setBigUint64(0, BigInt(payload.byteLength), true);
  framed.set(payload, SWARM_SPAN_BYTES);
  return framed;
}

/**
 * A real backend over a stand-in for the wasm node.
 *
 * ⭐ The stub is at the wasm boundary rather than at the backend, so what the handle is measured
 * against is the product's own retrieval path with its span stripping in place. A fake backend would
 * have made the byte count whatever the fake said, which is exactly the reading a harness would then
 * take to mean the node served a segment of that size.
 */
function inTabNodeAnswering(answer: Uint8Array | Error): { backend: Weeb3FetchBackend; retrieved: string[] } {
  const retrieved: string[] = [];
  const node: Weeb3Node = {
    start: () => {},
    ready: () => Promise.resolve(true),
    retrieveBytes: (address: string) => {
      retrieved.push(address);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  const module: Weeb3Module = {
    default: () => Promise.resolve(),
    Weeb3No103: function Weeb3No103(this: unknown) {
      return node;
    } as unknown as Weeb3Module['Weeb3No103'],
  };

  return { backend: new Weeb3FetchBackend(() => Promise.resolve(module)), retrieved };
}

function publishedSwitch(): FetchBackendSwitch {
  return holder[FETCH_BACKEND_HANDLE] as FetchBackendSwitch;
}

/**
 * One retrieval through the in-tab node, timed, for a harness that cannot get the player to ask.
 *
 * ## Why the handle takes a reference rather than watching the player
 *
 * Every in-tab reading this project has is taken through hls.js, which decides for itself which
 * fragment to ask for and when. That is the right subject for an ABR question and the wrong one for
 * "what does one retrieval cost", because the player's own choices are in every number. A harness that
 * names the reference gets the retrieval on its own.
 *
 * ⛔ **The bytes never cross the bridge.** A segment is most of a megabyte and CDP would serialise it
 * into the harness, which measures the harness. Only the count and the duration come back.
 */
describe('measuring one retrieval through the in-tab node', () => {
  afterEach(() => {
    selectFetchBackend(null);
    vi.unstubAllEnvs();
    delete holder[FETCH_BACKEND_HANDLE];
  });

  /**
   * ⛔⛔⛔ The span, and it is the whole reason this drives a real backend. weeb-3 hands back the
   * payload framed with its own length as a leading uint64 and a gateway does not, so a handle that
   * reported the raw answer would say every segment is eight bytes heavier than the one a gateway
   * serves, and no arm comparing the two byte sources would agree with itself.
   */
  it('answers with what the segment weighed once the span came off', async () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const { backend } = inTabNodeAnswering(spanPrefixed(new Uint8Array(2_048)));
    exposeFetchBackendForInstrumentation(backend);

    const measured = await publishedSwitch().retrieveBytes(REF);

    assert.equal(measured.byteLength, 2_048);
  });

  it('times the retrieval rather than handing back a duration of nothing', async () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const { backend } = inTabNodeAnswering(spanPrefixed(new Uint8Array(16)));
    exposeFetchBackendForInstrumentation(backend);

    const measured = await publishedSwitch().retrieveBytes(REF);

    assert.ok(Number.isFinite(measured.elapsedMs), `the retrieval was timed as ${measured.elapsedMs}`);
    assert.ok(measured.elapsedMs >= 0, 'the retrieval finished before it started');
  });

  it('asks the node for the bare reference it was given', async () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const { backend, retrieved } = inTabNodeAnswering(spanPrefixed(new Uint8Array(4)));
    exposeFetchBackendForInstrumentation(backend);

    await publishedSwitch().retrieveBytes(REF);

    assert.deepEqual(retrieved, [REF]);
  });

  /** ⛔ Never the bytes themselves, whatever the caller does with what comes back. */
  it('hands back the count and the duration and nothing else', async () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const { backend } = inTabNodeAnswering(spanPrefixed(new Uint8Array([1, 2, 3, 4])));
    exposeFetchBackendForInstrumentation(backend);

    const measured = await publishedSwitch().retrieveBytes(REF);

    assert.deepEqual(Object.keys(measured).sort(), ['byteLength', 'elapsedMs']);
  });

  /**
   * ⛔⛔ The same refusal, and the same reason, as `selectFetchBackend`'s. A harness drives this through
   * CDP where TypeScript does not exist, so a truncated reference, a whole url pasted in or an
   * `undefined` all arrive as ordinary values. The reference goes straight into a wasm call, which
   * fails naming neither itself nor what it was handed.
   */
  it('refuses a reference it does not recognise, naming it', async () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const { backend, retrieved } = inTabNodeAnswering(spanPrefixed(new Uint8Array(4)));
    exposeFetchBackendForInstrumentation(backend);

    await assert.rejects(publishedSwitch().retrieveBytes('not-a-reference'), /not-a-reference/);
    await assert.rejects(publishedSwitch().retrieveBytes(undefined as never), /undefined/);

    assert.deepEqual(retrieved, [], 'a refused reference reached the node anyway');
  });

  /**
   * ⛔ A failed retrieval has to stay failed. Folding it into a reading of zero bytes would put a
   * segment nobody served into an arm's byte count, and the arm would report the node answering.
   */
  it('lets the node own its failure rather than answering with a shape that reads as a retrieval', async () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const { backend } = inTabNodeAnswering(new Error('no peer had the chunk'));
    exposeFetchBackendForInstrumentation(backend);

    await assert.rejects(publishedSwitch().retrieveBytes(REF), /no peer had the chunk/);
  });

  /** The seam stays shut in a shipping build, and nothing behind it is touched on the way. */
  it('publishes no retrieval, and boots no node, in a build that did not ask for instrumentation', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '');
    const { backend, retrieved } = inTabNodeAnswering(spanPrefixed(new Uint8Array(4)));

    assert.equal(exposeFetchBackendForInstrumentation(backend), null);
    assert.equal(holder[FETCH_BACKEND_HANDLE], undefined);
    assert.deepEqual(retrieved, []);
  });
});
