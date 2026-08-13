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
} from '../src/components/SwarmHlsPlayer/fetchBackendTestHandle';

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
