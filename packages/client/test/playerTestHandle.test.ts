import type Hls from 'hls.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { exposePlayerForInstrumentation, PLAYER_HANDLE } from '../src/components/SwarmHlsPlayer/playerTestHandle';

/** Only identity matters here, so a marker stands in for a player rather than a mock of one. */
function playerStub(name: string): Hls {
  return { name } as unknown as Hls;
}

function handle(): unknown {
  return (globalThis as unknown as Record<string, unknown>)[PLAYER_HANDLE];
}

/**
 * The seam a buffer sweep drives the player through.
 *
 * Both directions of the flag are asserted, because the whole argument for a build-time flag over a
 * runtime one is that a production bundle carries nothing at all. A test that only proves the handle
 * appears would leave the half that matters for shipping unchecked.
 */
describe('the instrumentation handle', () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[PLAYER_HANDLE];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as unknown as Record<string, unknown>)[PLAYER_HANDLE];
  });

  it('publishes nothing at all when the flag is unset, which is how it ships', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '');

    const detach = exposePlayerForInstrumentation(playerStub('shipped'));

    assert.equal(detach, null);
    assert.equal(handle(), undefined);
    assert.equal(PLAYER_HANDLE in globalThis, false);
  });

  it('publishes the player when the flag is set', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const player = playerStub('measured');

    const detach = exposePlayerForInstrumentation(player);

    assert.equal(handle(), player);
    assert.notEqual(detach, null);
  });

  it('takes the player away again on detach', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');

    exposePlayerForInstrumentation(playerStub('measured'))?.();

    assert.equal(PLAYER_HANDLE in globalThis, false);
  });

  /**
   * React publishes a remounted player before it runs the previous one's cleanup, so an
   * unconditional delete would remove the live player and leave a harness reading nothing partway
   * through an arm. The player restarts itself on a fatal parsing error, so this is an ordinary path
   * during a broadcast rather than a corner case.
   */
  it('leaves a newer player alone when an older one detaches after it', () => {
    vi.stubEnv('VITE_EXPOSE_PLAYER', '1');
    const older = playerStub('older');
    const newer = playerStub('newer');

    const detachOlder = exposePlayerForInstrumentation(older);
    exposePlayerForInstrumentation(newer);
    detachOlder?.();

    assert.equal(handle(), newer);
  });
});
