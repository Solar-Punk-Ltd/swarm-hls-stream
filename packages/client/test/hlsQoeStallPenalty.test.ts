import type Hls from 'hls.js';
import { ErrorDetails, ErrorTypes, Events } from 'hls.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { attachQoeTracking, type QoeMetrics } from '../src/components/SwarmHlsPlayer/overlays/qoe/useHlsQoeMetrics';
import { LIVE_SYNC_DURATION_S } from '../src/components/SwarmHlsPlayer/playerConfig';

/**
 * How often `attachQoeTracking` polls the player for the numbers it cannot get from an event.
 *
 * Written out rather than imported, for the reason `clientTuning.ts` records: importing the constant
 * would assert it against itself, and this test is here to catch the poll going away.
 */
const POLL_INTERVAL_MS = 500;

/**
 * The two objects the tracker sits between, plus a way to drive them.
 *
 * `attachQoeTracking` runs `video instanceof HTMLVideoElement` inside its poll, and the client's
 * vitest environment is `node`, where that global does not exist. Defined as a class nothing here is
 * an instance of, so the branch is reached and skipped rather than throwing.
 */
function makeTrackedPlayer(targetLatency: number | null = LIVE_SYNC_DURATION_S) {
  const mediaListeners = new Map<string, () => void>();
  const video = {
    addEventListener: (type: string, listener: () => void) => mediaListeners.set(type, listener),
    removeEventListener: (type: string) => mediaListeners.delete(type),
  };

  const hlsListeners = new Map<string, (event: string, data: unknown) => void>();
  const hls = {
    latency: 6.4,
    targetLatency,
    on: (event: string, listener: (event: string, data: unknown) => void) => hlsListeners.set(event, listener),
    off: (event: string) => hlsListeners.delete(event),
  };

  let latest: QoeMetrics | null = null;
  const detach = attachQoeTracking(video as unknown as HTMLMediaElement, hls as unknown as Hls, (metrics) => {
    latest = metrics;
  });

  return {
    detach,
    metrics: (): QoeMetrics => {
      assert.ok(latest, 'the tracker never reported any metrics');
      return latest;
    },
    poll: () => vi.advanceTimersByTime(POLL_INTERVAL_MS),
    setTargetLatency: (value: number | null) => {
      hls.targetLatency = value;
    },
    raise: (details: ErrorDetails, fatal: boolean) => {
      const listener = hlsListeners.get(Events.ERROR);
      assert.ok(listener, 'the tracker never subscribed to hls.js errors');
      listener(Events.ERROR, { fatal, type: ErrorTypes.MEDIA_ERROR, details });
    },
    fragLoaded: (loadedBytes: number, durationSec: number) => {
      const listener = hlsListeners.get(Events.FRAG_LOADED);
      assert.ok(listener, 'the tracker never subscribed to FRAG_LOADED');
      listener(Events.FRAG_LOADED, { frag: { duration: durationSec, stats: { loaded: loadedBytes } } });
    },
    levelSwitched: () => {
      const listener = hlsListeners.get(Events.LEVEL_SWITCHED);
      assert.ok(listener, 'the tracker never subscribed to LEVEL_SWITCHED');
      listener(Events.LEVEL_SWITCHED, {});
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { HTMLVideoElement?: unknown }).HTMLVideoElement = class {};
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, 'HTMLVideoElement');
});

/**
 * The defect this exists for, measured out of hls.js 1.6.15's own `LatencyController`:
 *
 *   maxLiveSyncOnStallIncrease = targetduration
 *   return targetLatency + Math.min(stallCount * config.liveSyncOnStallIncrease, maxLiveSyncOnStallIncrease)
 *
 * `liveSyncOnStallIncrease` defaults to 1 and `stallCount` falls back to zero only when a fresh
 * manifest loads. So **one** non-fatal stall moves the viewer's latency target up by as much as a
 * target duration and leaves it there for the rest of the broadcast, and the catch-up that exists to
 * pull latency back down measures itself against the moved target and stops firing.
 *
 * It cost a real measurement: the 1080p ABA of 2026-08-07 ran two identical control arms that came
 * back 0.92s apart, which the write-up called an unexplained drift in the sitting. One arm had
 * stalled at its join. Every instrument in that run reported zero rebuffers, zero stalled samples and
 * zero fatal errors, because a stall is none of those things.
 */
describe('a stall moves the latency target, and nothing used to say so', () => {
  it('reports the target the player is actually steering to, not the configured one', () => {
    const player = makeTrackedPlayer(LIVE_SYNC_DURATION_S + 1);

    player.poll();

    assert.equal(player.metrics().liveTargetLatencySec, LIVE_SYNC_DURATION_S + 1);
  });

  it('counts a stall the player called non-fatal, which is every stall', () => {
    const player = makeTrackedPlayer();

    player.raise(ErrorDetails.BUFFER_STALLED_ERROR, false);

    assert.equal(player.metrics().bufferStallCount, 1);
  });

  // The control. Counting every non-fatal error would report a number that moves for reasons that
  // cost the viewer nothing, and a stall would stop being the thing the count names.
  // Polled either side of the error rather than only before it, so the reading under assertion is
  // taken after the error rather than from a snapshot that predates it.
  it('leaves a non-fatal error that is not a stall out of the count', () => {
    const player = makeTrackedPlayer();

    player.poll();
    player.raise(ErrorDetails.FRAG_LOAD_ERROR, false);
    player.poll();

    assert.equal(player.metrics().bufferStallCount, 0);
  });

  // A stall is still an error, and the existing fatal counter is what a reader checks for severity.
  it('keeps a stall out of the fatal error count', () => {
    const player = makeTrackedPlayer();

    player.raise(ErrorDetails.BUFFER_STALLED_ERROR, false);

    assert.equal(player.metrics().fatalErrorCount, 0);
  });

  it('says nothing about the target when the player has not computed one yet', () => {
    const player = makeTrackedPlayer(null);

    player.poll();

    assert.equal(player.metrics().liveTargetLatencySec, null);
  });

  it('follows the target up when a stall moves it mid-session', () => {
    const player = makeTrackedPlayer();

    player.poll();
    const before = player.metrics().liveTargetLatencySec;
    player.raise(ErrorDetails.BUFFER_STALLED_ERROR, false);
    player.setTargetLatency(LIVE_SYNC_DURATION_S + 1);
    player.poll();

    assert.equal(before, LIVE_SYNC_DURATION_S);
    assert.equal(player.metrics().liveTargetLatencySec, LIVE_SYNC_DURATION_S + 1);
  });

  it('stops reading a player it has been detached from', () => {
    const player = makeTrackedPlayer();

    player.poll();
    player.detach();
    player.setTargetLatency(LIVE_SYNC_DURATION_S + 1);
    player.poll();

    assert.equal(player.metrics().liveTargetLatencySec, LIVE_SYNC_DURATION_S);
  });
});

describe('delivered bitrate follows the rung, not a blend of the rung just left', () => {
  it('clears the sample window on a level switch so the average is the new rung within one fragment', () => {
    const player = makeTrackedPlayer();

    // Three fragments of a high rung, about 8 Mbps each: 2 MB over a 2s fragment.
    player.fragLoaded(2_000_000, 2);
    player.fragLoaded(2_000_000, 2);
    player.fragLoaded(2_000_000, 2);
    assert.equal(player.metrics().bitrateKbps, 8000, 'the high rung sets the delivered bitrate');

    // A down-switch, then one fragment of a roughly 700 kbps rung: 175 KB over 2s.
    player.levelSwitched();
    player.fragLoaded(175_000, 2);

    assert.equal(
      player.metrics().bitrateKbps,
      700,
      'a switch must not leave the old rung blended into the delivered bitrate',
    );
  });
});
