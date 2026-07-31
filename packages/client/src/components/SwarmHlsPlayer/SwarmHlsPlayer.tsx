import React, { useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';
import Hls, { ErrorDetails, ErrorTypes, Events } from 'hls.js';

import { MEDIA_TYPE_VIDEO, MediaType } from '@/types/stream';

import { QoeOverlay } from './overlays/qoe/QoeOverlay';
import { attachQoeTracking, initialMetrics, QoeMetrics } from './overlays/qoe/useHlsQoeMetrics';
import { CustomFragmentLoader, CustomManifestLoader } from './CustomManifestLoader';
import { ManifestStateManager } from './ManifestManagement';

import './SwarmHlsPlayer.scss';

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
 *
 * Sorted, so a config assembled in a different key order is still the same config and does not
 * tear the player down and rebuild it mid-playback.
 */
function tuningKey(tuning: HlsTuning): string {
  const tunable = new Set(Object.keys(DEFAULT_HLS_TUNING));
  const usable = Object.entries(tuning)
    .filter((entry): entry is [string, number] => tunable.has(entry[0]) && Number.isFinite(entry[1]))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(usable));
}

interface HlsPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  owner: string;
  topicString: string;
  mediaType: MediaType;
  enableQoeOverlay?: boolean;
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
  hlsConfig,
  ...videoProps
}) => {
  const [restartTrigger, setRestartTrigger] = useState(0);
  const [metrics, setMetrics] = useState<QoeMetrics>(initialMetrics);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsConfigKey = tuningKey(hlsConfig ?? {});

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
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
      hls.loadSource(`${owner}/${topicString}`);

      if (autoPlay) {
        hls.on(Events.MANIFEST_PARSED, () => {
          video.play().catch((err) => {
            console.warn('Auto-play failed:', err);
          });
        });
      }
    } else {
      console.error('HLS is not supported in this browser.');
    }

    const detachQoe = enableQoeOverlay ? attachQoeTracking(video, hls, setMetrics) : null;

    return () => {
      video.removeEventListener('pause', onHlsPause);
      video.removeEventListener('play', onHlsPlay);
      detachQoe?.();

      if (hls) {
        try {
          const topic = Topic.fromString(topicString);
          ManifestStateManager.getInstance().clear(topic.toString());
        } catch (error) {
          console.warn('Failed to clear manifest state for topic:', topicString, error);
        } finally {
          hls.destroy();
          hls = null;
        }
      }
    };
  }, [autoPlay, restartTrigger, enableQoeOverlay, owner, topicString, hlsConfigKey]);

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
