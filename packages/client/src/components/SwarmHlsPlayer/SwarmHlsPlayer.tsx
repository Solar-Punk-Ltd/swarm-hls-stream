import React, { useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';
import Hls, { ErrorDetails, ErrorTypes, Events } from 'hls.js';

import { MEDIA_TYPE_VIDEO, MediaType, Rendition } from '@/types/stream';

import { QoeOverlay } from './overlays/qoe/QoeOverlay';
import { attachQoeTracking, initialMetrics, QoeMetrics } from './overlays/qoe/useHlsQoeMetrics';
import { CustomFragmentLoader, CustomManifestLoader, manifestFetcher } from './CustomManifestLoader';
import { ManifestStateManager } from './ManifestState';
import { buildSwarmUri } from './playlist';

import './SwarmHlsPlayer.scss';

/** Pins playback to a named rung; `AUTO_LEVEL` hands the choice back to hls.js's ABR. */
export const AUTO_LEVEL = 'auto';

// TODO Consider switching to React.MediaHTMLAttributes<HTMLMediaElement> to support <audio> as well
/**
 * The settings this component lets a caller retune.
 *
 * Deliberately narrower than `Partial<HlsConfig>`: that type also advertises `xhrSetup`, `loader`,
 * `abrController` and friends, none of which survive the serialisation below, so promising them
 * would let a caller write code that compiles and silently never runs.
 */
export interface HlsTuning {
  liveSyncDuration?: number;
  liveMaxLatencyDuration?: number;
  maxBufferLength?: number;
  maxMaxBufferLength?: number;
  maxBufferSize?: number;
  maxBufferHole?: number;
  abrEwmaFastLive?: number;
  abrEwmaSlowLive?: number;
  abrEwmaDefaultEstimate?: number;
  abrBandWidthFactor?: number;
  abrBandWidthUpFactor?: number;
  maxStarvationDelay?: number;
  capLevelToPlayerSize?: boolean;
  testBandwidth?: boolean;
}

/**
 * How this player is tuned for a Swarm-backed live stream.
 *
 * Exported so a caller can start from these numbers and override only what it needs, rather than
 * rediscover them. They are deliberately not hls.js's own defaults.
 *
 * The one worth knowing about is `liveSyncDuration`. It is a latency *target*: hls.js parks the
 * playhead that many seconds behind the live edge (`latency-controller.ts`, `targetLatency` then
 * `liveSyncPosition = liveEdge - targetLatency`), and that distance is the same at any segment
 * length. hls.js's own default is `liveSyncDurationCount: 3`, a count multiplied by the playlist's
 * target duration, which does track segment length. Setting one of these forbids the other:
 * `mergeConfig` throws on a config carrying both.
 *
 * What this has to be checked against is not segment length but the engine's **playlist window**,
 * because `liveSyncPosition` is clamped to `edge - levelDetails.totalduration`. A target as long as
 * the window parks the playhead on the oldest fragment, at the eviction boundary. The two engines
 * express that window differently, so the margin differs: SRS's `hls_window` is a duration and
 * holds regardless of fragment length, while OME's is `SegmentCount x SegmentDuration`, which at
 * its defaults is 5 x 2s = 10s, exactly this value.
 */
export const DEFAULT_HLS_TUNING: Readonly<HlsTuning> = Object.freeze({
  liveSyncDuration: 10,
  liveMaxLatencyDuration: 30,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  maxBufferSize: 60 * 1024 * 1024, // 60MB
  maxBufferHole: 1,

  // --- ABR ---
  //
  // hls.js computes throughput as `bytes / (loading.end - loading.first)`. Over a CDN that is a
  // measurement of a pipe. Over Swarm it is not: a 2s 1080p segment is a few hundred chunks fanned
  // out across neighbourhoods, and the elapsed time is dominated by retrieval latency rather than
  // by any rate. Consecutive samples therefore swing hard, and hls.js's default half-lives turn
  // that swing into level flapping — so both are lengthened well past them (3 and 9).
  abrEwmaFastLive: 9,
  abrEwmaSlowLive: 27,

  // Where a cold session starts, since there is nothing measured yet. hls.js seeds 500 kbps, which
  // with this ladder parks every viewer on the bottom rung and then needs a long stretch of EWMA to
  // climb out. Starting mid-ladder and letting the buffer loop pull down is the better trade here,
  // because buffer occupancy is a real signal on Swarm and measured throughput largely is not.
  // This number is a starting guess, and is exactly what the POC exists to replace.
  abrEwmaDefaultEstimate: 2_000_000,

  // hls.js's startup probe fetches the first fragment at a low level to measure throughput. That
  // measurement is retrieval latency here, so it produces a number that is not bandwidth; the
  // seeded estimate above is the more honest input.
  testBandwidth: false,

  // Do not pull 1080p into a 400px box. Cheap, and it matters most on the small screens the ladder
  // exists for.
  capLevelToPlayerSize: true,

  // Restated at hls.js's own defaults rather than changed. They are here to be swept from a caller
  // during the POC without editing this file; there is no evidence yet for moving them.
  abrBandWidthFactor: 0.95,
  abrBandWidthUpFactor: 0.7,
  maxStarvationDelay: 4,
});

/**
 * A tuning override, reduced to the values it can actually apply and the ones it can survive.
 *
 * Restricted to the keys above for a reason that is not tidiness: `mergeConfig` refuses a config
 * carrying both `liveSyncDuration` and `liveSyncDurationCount`, and these defaults always supply
 * the first, so letting the second through would throw inside the effect and take the tree down.
 *
 * Non-finite numbers are dropped rather than passed through, because `JSON` turns `NaN` and
 * `Infinity` into `null`, and a `null` here does not fall back to the default, it replaces it.
 * `maxBufferLength: null` reaches hls.js as `Math.max(null, …)`, which is zero, and a player that
 * buffers nothing stalls forever. `Number(searchParams.get('buf'))` on bad input hits exactly this.
 * Booleans have no such hazard and survive the round trip as themselves.
 *
 * Sorted, so a config assembled in a different key order is still the same config and does not
 * tear the player down and rebuild it mid-playback.
 */
function tuningKey(tuning: HlsTuning): string {
  const tunable = new Set(Object.keys(DEFAULT_HLS_TUNING));
  const usable = Object.entries(tuning)
    .filter((entry): entry is [string, number | boolean] => {
      const [key, value] = entry;
      return tunable.has(key) && (typeof value === 'boolean' || Number.isFinite(value));
    })
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(usable));
}

/**
 * Identity of a ladder, by the only parts of it the player has to be rebuilt for.
 *
 * Deliberately excludes bandwidth. The uploader keeps correcting each rung's measured bandwidth,
 * and rebuilding the player every time it did would restart playback every half minute. A session
 * therefore runs on the bandwidths that had landed by the time hls.js read the master — which for
 * a live stream is once, at the start — and later corrections benefit later sessions.
 */
function ladderKey(renditions: Rendition[] | undefined): string {
  if (!renditions || renditions.length === 0) {
    return '';
  }

  return renditions.map((r) => `${r.name}:${r.topic}`).join('|');
}

/**
 * Pins hls.js to one rung. Called only when a rung was asked for; otherwise ABR chooses.
 *
 * Rungs are matched by their feed URI rather than by height or bitrate, because that is the one
 * attribute of a level that came from this ladder and cannot collide with another rung's.
 * Assigning `currentLevel` is also what turns ABR off — a `startLevel` alone only picks where it
 * begins, and it would switch away on the first throughput sample.
 */
function applyLevel(hls: Hls, owner: string, renditions: Rendition[], level: string): void {
  const target = renditions.find((r) => r.name === level);
  if (!target) {
    console.warn(`Unknown rendition "${level}", leaving level selection on auto`);
    return;
  }

  const uri = buildSwarmUri(owner, target.topic);
  const index = hls.levels.findIndex((candidate) => candidate.uri === uri);
  if (index < 0) {
    console.warn(`Rendition "${target.name}" is not among the parsed levels, leaving selection on auto`);
    return;
  }

  hls.currentLevel = index;
}

interface HlsPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  owner: string;
  topicString: string;
  mediaType: MediaType;
  enableQoeOverlay?: boolean;
  /**
   * The stream's ABR ladder. Absent or empty, the player reads `topicString` as a single media
   * playlist exactly as it always has.
   */
  renditions?: Rendition[];
  /**
   * Rung to pin playback to, by name. Omitted, or {@link AUTO_LEVEL}, leaves the choice to ABR,
   * which is the default. Pinning is for isolating one rung — comparing it against the others, or
   * telling a bad rung apart from a bad switch. Ignored without a ladder.
   */
  level?: string;
  /**
   * Overrides merged over {@link DEFAULT_HLS_TUNING}.
   *
   * Compared by value rather than by reference, so passing an object literal is safe: it does not
   * hand the effect a new identity on every render and tear the player down mid-playback. A change
   * in the values themselves does rebuild the player, which loses playback position.
   */
  hlsConfig?: HlsTuning;
}

export const SwarmHlsPlayer: React.FC<HlsPlayerProps> = ({
  owner,
  topicString,
  mediaType,
  autoPlay = true,
  controls = true,
  enableQoeOverlay = false,
  renditions,
  level,
  hlsConfig,
  ...videoProps
}) => {
  const [restartTrigger, setRestartTrigger] = useState(0);
  const [metrics, setMetrics] = useState<QoeMetrics>(initialMetrics);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsConfigKey = tuningKey(hlsConfig ?? {});
  const renditionKey = ladderKey(renditions);

  // Read through a ref, not a dependency. The catalog is polled every few seconds and hands back
  // a fresh array each time, so depending on it directly would tear the player down and rebuild
  // it on every poll. `renditionKey` is what the effect actually reacts to.
  const renditionsRef = useRef(renditions);
  renditionsRef.current = renditions;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const sourceUrl = buildSwarmUri(owner, topicString);
    const ladder = renditionsRef.current;
    const isLadder = renditionKey.length > 0 && !!ladder;
    const ladderTopics = isLadder ? ladder.map((r) => r.topic) : [topicString];

    if (isLadder) {
      manifestFetcher.registerLadder(sourceUrl, () => ({
        owner,
        renditions: renditionsRef.current ?? ladder,
      }));
    }

    let hls: Hls | null = null;

    const onHlsPause = () => {
      hls?.stopLoad();
    };
    const onHlsPlay = () => {
      hls?.startLoad();
    };

    if (Hls.isSupported()) {
      hls = new Hls({
        ...DEFAULT_HLS_TUNING,
        ...(JSON.parse(hlsConfigKey) as HlsTuning),
        // Last, so they cannot be overridden. These loaders are what make this a Swarm player
        // rather than an HTTP one, and a caller that replaced them would get a component which
        // looks like this one and fetches from somewhere else entirely.
        pLoader: CustomManifestLoader,
        fLoader: CustomFragmentLoader,
      });

      const restartStream = () => {
        console.warn('Restarting stream due to manifest parsing error.');
        hls?.destroy();
        setRestartTrigger((prev) => prev + 1);
      };

      video.addEventListener('pause', onHlsPause);
      video.addEventListener('play', onHlsPlay);

      hls.on(Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.error('HLS.js fatal error:', data.type, data.details);
        } else {
          console.warn('HLS.js non-fatal error:', data.details, data.error?.message ?? '');
          return;
        }

        if (data.details === ErrorDetails.LEVEL_PARSING_ERROR) {
          console.error('Media sequence mismatch detected, reloading stream.');
          restartStream();
          return;
        }

        switch (data.type) {
          case ErrorTypes.NETWORK_ERROR:
            console.warn('Fatal network error');
            restartStream();
            break;
          case ErrorTypes.MEDIA_ERROR:
            console.warn('Fatal media error');
            hls?.recoverMediaError();
            break;
          default:
            console.error('Unrecoverable fatal error. Destroying and restarting.');
            restartStream();
            break;
        }
      });

      hls.attachMedia(video);
      hls.loadSource(sourceUrl);

      hls.on(Events.MANIFEST_PARSED, () => {
        if (isLadder && level && level !== AUTO_LEVEL) {
          applyLevel(hls!, owner, renditionsRef.current ?? ladder, level);
        }

        if (autoPlay) {
          video.play().catch((err) => {
            console.warn('Auto-play failed:', err);
          });
        }
      });
    } else {
      console.error('HLS is not supported in this browser.');
    }

    const detachQoe = enableQoeOverlay ? attachQoeTracking(video, hls, setMetrics) : null;

    return () => {
      video.removeEventListener('pause', onHlsPause);
      video.removeEventListener('play', onHlsPlay);
      detachQoe?.();
      manifestFetcher.unregisterLadder(sourceUrl);

      if (hls) {
        // Every rung, not just the one that was playing: the others hold accumulated segment
        // state too, and leaving it behind would have the next session resume someone else's
        // playlist.
        for (const topicString of ladderTopics) {
          try {
            ManifestStateManager.getInstance().clear(Topic.fromString(topicString).toString());
          } catch (error) {
            console.warn('Failed to clear manifest state for topic:', topicString, error);
          }
        }

        hls.destroy();
        hls = null;
      }
    };
  }, [autoPlay, restartTrigger, enableQoeOverlay, owner, topicString, hlsConfigKey, renditionKey, level]);

  const videoEl =
    mediaType === MEDIA_TYPE_VIDEO ? (
      <video ref={videoRef} controls={controls} autoPlay={autoPlay} muted playsInline {...videoProps} />
    ) : (
      <audio
        className="swarm-hls-player-audio"
        ref={videoRef as React.RefObject<HTMLAudioElement>}
        controls={controls}
        autoPlay={autoPlay}
      />
    );

  return (
    <div className="swarm-hls-player-wrapper">
      {videoEl}
      {enableQoeOverlay && <QoeOverlay metrics={metrics} />}
    </div>
  );
};
