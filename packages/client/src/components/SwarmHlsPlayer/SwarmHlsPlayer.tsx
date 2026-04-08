import React, { useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';
import Hls, { ErrorDetails, ErrorTypes, Events } from 'hls.js';

import { MEDIA_TYPE_VIDEO, MediaType } from '@/types/stream';

import { CustomFragmentLoader, CustomManifestLoader } from './CustomManifestLoader';
import { ManifestStateManager } from './ManifestManagement';

import './SwarmHlsPlayer.scss';

interface HlsPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  owner: string;
  topic: string;
  mediatype: MediaType;
}

export const SwarmHlsPlayer: React.FC<HlsPlayerProps> = ({
  owner,
  topic,
  mediatype,
  autoPlay = true,
  controls = true,
  ...videoProps
}) => {
  const [restartTrigger, setRestartTrigger] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

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

      hls.on(Events.ERROR, (_event, data) => {
        console.error('HLS.js error:', data);

        if (data.fatal) {
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
      hls.loadSource(`${owner}/${topic}`);

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

    return () => {
      if (hls) {
        const t = Topic.fromString(topic);
        ManifestStateManager.getInstance().clear(t.toString());

        hls.destroy();
        hls = null;
      }
    };
  }, [autoPlay, restartTrigger]);

  return mediatype === MEDIA_TYPE_VIDEO ? (
    <video ref={videoRef} controls={controls} autoPlay={autoPlay} muted playsInline {...videoProps} />
  ) : (
    <audio className="swarm-hls-player-audio" ref={videoRef} controls={controls} autoPlay={autoPlay} />
  );
};
