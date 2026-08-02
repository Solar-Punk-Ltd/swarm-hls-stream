import React, { useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';
import Hls, { ErrorDetails, ErrorTypes, Events } from 'hls.js';

import { MEDIA_TYPE_VIDEO, MediaType } from '@/types/stream';

import { QoeOverlay } from './overlays/qoe/QoeOverlay';
import { attachQoeTracking, initialMetrics, QoeMetrics } from './overlays/qoe/useHlsQoeMetrics';
import { CustomFragmentLoader, CustomManifestLoader } from './CustomManifestLoader';
import { attachLivePlaybackRateGuard } from './livePlaybackRate';
import { ManifestStateManager } from './ManifestManagement';
import { buildPlayerConfig } from './playerConfig';

import './SwarmHlsPlayer.scss';

// TODO Consider switching to React.MediaHTMLAttributes<HTMLMediaElement> to support <audio> as well
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
      hls = new Hls(buildPlayerConfig({ pLoader: CustomManifestLoader, fLoader: CustomFragmentLoader }));

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
    const detachRateGuard = hls ? attachLivePlaybackRateGuard(video, hls) : null;

    return () => {
      video.removeEventListener('pause', onHlsPause);
      video.removeEventListener('play', onHlsPlay);
      detachQoe?.();
      detachRateGuard?.();

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
