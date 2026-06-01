import React, { useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';
import Hls, { ErrorDetails, ErrorTypes, Events } from 'hls.js';

import { MEDIA_TYPE_VIDEO, MediaType } from '@/types/stream';

import { QoeOverlay } from './overlays/qoe/QoeOverlay';
import { initialMetrics, QoeMetrics } from './overlays/qoe/useHlsQoeMetrics';
import { CustomFragmentLoader, CustomManifestLoader } from './CustomManifestLoader';
import { ManifestStateManager } from './ManifestManagement';

import './SwarmHlsPlayer.scss';

interface HlsPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  owner: string;
  topicString: string;
  mediaType: MediaType;
  enableQoeOverlay?: boolean;
}

export const SwarmHlsPlayer: React.FC<HlsPlayerProps> = ({
  owner,
  topicString,
  mediaType,
  autoPlay = true,
  controls = true,
  enableQoeOverlay = false,
  ...videoProps
}) => {
  const [restartTrigger, setRestartTrigger] = useState(0);
  const [metrics, setMetrics] = useState<QoeMetrics>(initialMetrics);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const sessionStart = performance.now();
    const metrics: QoeMetrics = initialMetrics();

    let playbackStartTime: number | null = null;
    let accPlaybackMs = 0;
    let rebufferStart: number | null = null;
    let recoveryStart: number | null = null;
    let firstPlaying = false;

    const flush = () => {
      if (!enableQoeOverlay) {
        return;
      }

      setMetrics({ ...metrics });
    };

    const onLoadedData = () => {
      if (metrics.firstFrameTimeMs === null) {
        metrics.firstFrameTimeMs = performance.now() - sessionStart;
        flush();
      }
    };

    const onPlaying = () => {
      if (!firstPlaying) {
        firstPlaying = true;
        metrics.startupTimeMs = performance.now() - sessionStart;
      }
      if (rebufferStart !== null) {
        metrics.rebufferingDurationMs += performance.now() - rebufferStart;
        rebufferStart = null;
      }
      if (recoveryStart !== null) {
        metrics.lastRecoveryTimeMs = performance.now() - recoveryStart;
        metrics.reconnectSuccesses += 1;
        recoveryStart = null;
      }
      playbackStartTime = performance.now();
      flush();
    };

    const onWaiting = () => {
      if (firstPlaying && rebufferStart === null) {
        rebufferStart = performance.now();
        metrics.rebufferingCount += 1;
        metrics.hadRebuffering = true;
      }
      if (playbackStartTime !== null) {
        accPlaybackMs += performance.now() - playbackStartTime;
        playbackStartTime = null;
      }
      flush();
    };

    const onPause = () => {
      if (playbackStartTime !== null) {
        accPlaybackMs += performance.now() - playbackStartTime;
        playbackStartTime = null;
      }
    };

    const onEnded = () => {
      metrics.sessionCompleted = true;
      flush();
    };

    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);

    let hls: Hls | null = null;

    if (Hls.isSupported()) {
      hls = new Hls({
        pLoader: CustomManifestLoader,
        fLoader: CustomFragmentLoader,
        liveSyncDuration: 10,
        liveMaxLatencyDuration: 30,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 60 * 1024 * 1024, // 60MB
        maxBufferHole: 1,
      });

      const restartStream = () => {
        console.warn('Restarting stream due to manifest parsing error.');
        hls?.destroy();
        setRestartTrigger((prev) => prev + 1);
      };

      video.addEventListener('pause', () => {
        hls?.stopLoad();
      });

      video.addEventListener('play', () => {
        hls?.startLoad();
      });

      hls.on(Events.LEVEL_SWITCHED, () => {
        metrics.qualitySwitchCount += 1;
        flush();
      });

      const fragBitrateSamples: number[] = [];
      hls.on(Events.FRAG_LOADED, (_event, data) => {
        const { frag } = data;
        const loaded: number = frag.stats?.loaded ?? 0;
        if (frag.duration > 0 && loaded > 0) {
          const bps = (loaded * 8) / frag.duration;
          fragBitrateSamples.push(bps);

          if (fragBitrateSamples.length > 3) {
            fragBitrateSamples.shift();
          }

          const avg = fragBitrateSamples.reduce((a, b) => a + b, 0) / fragBitrateSamples.length;
          metrics.bitrateKbps = Math.round(avg / 1000);
          flush();
        }
      });

      hls.on(Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.error('HLS.js fatal error:', data.type, data.details);
        } else {
          console.warn('HLS.js non-fatal error:', data.details, data.error?.message ?? '');
          return;
        }

        if (data.fatal) {
          metrics.fatalErrorCount += 1;
          if (!firstPlaying) {
            metrics.startupFailed = true;
          }
          if (data.type === ErrorTypes.NETWORK_ERROR) {
            metrics.reconnectAttempts += 1;
            recoveryStart = performance.now();
          }
          flush();

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

    const interval = setInterval(() => {
      if (!enableQoeOverlay) {
        return;
      }
      let total = accPlaybackMs;
      if (playbackStartTime !== null) {
        total += performance.now() - playbackStartTime;
      }
      metrics.playbackTimeMs = total;

      if (video.videoWidth && video.videoHeight) {
        metrics.resolution = `${video.videoWidth}×${video.videoHeight}`;
      }

      metrics.rebufferingRatio = total > 0 ? metrics.rebufferingDurationMs / total : 0;
      const elapsedMin = total / 60_000;
      metrics.qualitySwitchPerMin = elapsedMin > 0 ? metrics.qualitySwitchCount / elapsedMin : 0;

      const vq = video.getVideoPlaybackQuality?.();
      if (vq) {
        metrics.droppedFrames = vq.droppedVideoFrames;
      }

      metrics.reconnectSuccessRate =
        metrics.reconnectAttempts > 0 ? metrics.reconnectSuccesses / metrics.reconnectAttempts : 0;

      if (hls) {
        const latency = hls.latency;
        metrics.liveLatencySec =
          typeof latency === 'number' && Number.isFinite(latency) && latency > 0 ? latency : null;
      }

      flush();
    }, 500);

    return () => {
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      clearInterval(interval);

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
  }, [autoPlay, restartTrigger, enableQoeOverlay, owner, topicString]);

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
