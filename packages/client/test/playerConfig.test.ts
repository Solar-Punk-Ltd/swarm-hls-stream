import Hls from 'hls.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import {
  buildPlayerConfig,
  LIVE_MAX_LATENCY_DURATION_S,
  LIVE_SYNC_DURATION_S,
} from '../src/components/SwarmHlsPlayer/playerConfig';

const CLIENT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLAYER_SOURCE = join(CLIENT_ROOT, 'src/components/SwarmHlsPlayer/SwarmHlsPlayer.tsx');

/** Loaders of the right shape, so a config can be built without importing the real ones. */
const NO_LOADERS = { pLoader: undefined, fLoader: undefined };

/**
 * What `buildPlayerConfig` returns, with the loaders taken back off, which is the tuning the player
 * is actually constructed with.
 *
 * Not `HLS_TUNING`. That is the constant this module builds from, and reading it here left the one
 * step between the constant and the player untested: a `buildPlayerConfig` that stopped spreading
 * the tuning shipped every value on the hls.js default, `maxLiveSyncPlaybackRate` back at exactly 1
 * and the catch-up silently gone, with all 102 tests green. hls.js does not throw on a config that
 * merely omits these keys, so `new Hls(...)` did not catch it either.
 */
const { pLoader: _pLoader, fLoader: _fLoader, ...SHIPPED_TUNING } = buildPlayerConfig(NO_LOADERS);

/**
 * The numbers that decide how the stream feels, asserted as the values that ship rather than
 * against the constants they are built from.
 *
 * Comparing `HLS_TUNING.liveSyncDuration` to `LIVE_SYNC_DURATION_S` would pass whatever either one
 * became, including the two decoupled, which is exactly the state that produces a player throwing
 * from its constructor on every mount. So the literals are written out here, and the config is
 * additionally handed to a real `new Hls(...)`, which is the only thing that knows its own rules.
 */
describe('SwarmHlsPlayer hls.js tuning', () => {
  it('ships the numbers it means to', () => {
    assert.deepEqual(
      { ...SHIPPED_TUNING },
      {
        // 6 from the sweep of 2026-08-03: 105 samples on the deployment host put the largest
        // edge-to-fetchable delay at 2.88s against a 1.0s segment, and this is that floor plus the
        // client's poll cadence plus one segment of margin. It was 10. `HLS_FRAGMENT` defaults to
        // 1.0 for this exact number, and a deployment running longer segments has to raise both.
        liveSyncDuration: 6,
        // Derived as twice the above rather than written, so it moves with it. hls.js throws from
        // the constructor when this is at or below `liveSyncDuration`.
        liveMaxLatencyDuration: 12,
        maxLiveSyncPlaybackRate: 1.1,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 62914560,
        maxBufferHole: 1,
      },
    );
  });

  it('enables catch-up, which the hls.js default of exactly 1 disables', () => {
    assert.equal(
      Hls.DefaultConfig.maxLiveSyncPlaybackRate,
      1,
      'the default this overrides has moved, so the reading behind LAT-2 needs taking again',
    );
    assert.ok(SHIPPED_TUNING.maxLiveSyncPlaybackRate! > 1);
  });

  // Past roughly 1.1 browsers stop pitch-correcting transparently, and a viewer hearing the recovery
  // is worse than the couple of seconds it recovers.
  it('keeps the catch-up rate inaudible', () => {
    assert.ok(SHIPPED_TUNING.maxLiveSyncPlaybackRate! <= 1.1);
  });

  /**
   * hls.js runs two separate mechanisms off these numbers and neither one knows about the other, so
   * a pair that looks ordinary can leave a band of latency where a viewer gets neither.
   *
   * Both formulas are transcribed from hls.js 1.6.15 rather than described, because describing them
   * is how the gap got there: the ceiling was set to three times the target on the belief that
   * catch-up ran the whole way up to it, and it stops at `targetLatency + targetduration` past the
   * target instead, which left 22s to 30s with the rate pinned back at 1 and no seek coming.
   */
  describe('catch-up and the live-edge seek meet, whatever the playlist target duration is', () => {
    /** `LatencyController.onTimeupdate`, dist/hls.js:33541: the latency at which nudging stops. */
    function catchUpCeilingS(config: typeof SHIPPED_TUNING, targetDurationS: number): number {
      const targetLatencyS = config.liveSyncDuration!;
      return targetLatencyS + Math.min(config.liveMaxLatencyDuration!, targetLatencyS + targetDurationS);
    }

    /** `StreamController.synchronizeToLiveEdge`, dist/hls.js:34895: the latency at which it seeks. */
    function seekThresholdS(config: typeof SHIPPED_TUNING): number {
      return config.liveMaxLatencyDuration!;
    }

    // This side of the system does not choose the target duration: it is whatever the uploader's
    // segment length makes it, and it can change without the client being rebuilt.
    const TARGET_DURATIONS_S = [0.5, 1, 2, 4, 6, 10];

    for (const targetDurationS of TARGET_DURATIONS_S) {
      it(`leaves no dead band at a ${targetDurationS}s target duration`, () => {
        assert.ok(
          seekThresholdS(SHIPPED_TUNING) <= catchUpCeilingS(SHIPPED_TUNING, targetDurationS),
          `catch-up stops at ${catchUpCeilingS(SHIPPED_TUNING, targetDurationS)}s of latency and the seek only ` +
            `fires past ${seekThresholdS(SHIPPED_TUNING)}s, so a viewer in between gets neither`,
        );
      });
    }

    it('is a check the previous ceiling of 30s fails, so the ones above are not vacuous', () => {
      const previous = { ...SHIPPED_TUNING, liveMaxLatencyDuration: 30 };

      assert.ok(seekThresholdS(previous) > catchUpCeilingS(previous, 2));
    });
  });

  // Not a restatement of the test above. hls.js validates this pair in its constructor and throws,
  // so a ceiling that slipped to or below the sync target would take every mount of the player with
  // it, in the browser only, where no test in this suite runs.
  it('is a config hls.js will accept, which its constructor is the only judge of', () => {
    const player = new Hls(buildPlayerConfig(NO_LOADERS));

    player.destroy();
  });

  it('is rejected by that same constructor once the ceiling stops clearing the target', () => {
    // Proves the test above can fail. Without it, `new Hls` not throwing is equally consistent with
    // hls.js having dropped the check.
    assert.throws(
      () => new Hls({ ...buildPlayerConfig(NO_LOADERS), liveMaxLatencyDuration: LIVE_SYNC_DURATION_S }),
      /liveMaxLatencyDuration/,
    );
  });

  it('holds a buffer deeper than the latency it tolerates, so a seek is not into empty buffer', () => {
    assert.ok(SHIPPED_TUNING.maxBufferLength! >= LIVE_MAX_LATENCY_DURATION_S);
    assert.ok(SHIPPED_TUNING.maxMaxBufferLength! >= SHIPPED_TUNING.maxBufferLength!);
  });

  it('carries the loaders through, since a config without them fetches from an origin that is not there', () => {
    const loaders = { pLoader: class {}, fLoader: class {} } as unknown as typeof NO_LOADERS;

    const config = buildPlayerConfig(loaders);

    assert.equal(config.pLoader, loaders.pLoader);
    assert.equal(config.fLoader, loaders.fLoader);
  });

  /**
   * The seam a rendering test would cover. Nothing in this package can mount a React tree, so what
   * is checked instead is that the component asks this module for its config rather than carrying
   * its own copy of these numbers, which is the state this file was extracted from.
   */
  describe('the player component is wired to it', () => {
    const source = readFileSync(PLAYER_SOURCE, 'utf8');

    it('builds its hls.js config here', () => {
      assert.match(source, /new Hls\(buildPlayerConfig\(/);
    });

    for (const key of Object.keys(SHIPPED_TUNING)) {
      it(`does not set ${key} of its own`, () => {
        assert.doesNotMatch(source, new RegExp(`\\b${key}\\s*:`));
      });
    }
  });
});
