import React, { useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';
import Hls, { ErrorDetails, ErrorTypes, Events } from 'hls.js';

import { MEDIA_TYPE_VIDEO, MediaType } from '@/types/stream';

import { FeedStateOverlay } from './overlays/feed/FeedStateOverlay';
import { QoeOverlay } from './overlays/qoe/QoeOverlay';
import { attachQoeTracking, initialMetrics, QoeMetrics } from './overlays/qoe/useHlsQoeMetrics';
import { CustomFragmentLoader, CustomManifestLoader, manifestFetcher } from './CustomManifestLoader';
import { FEED_STATE_LIVE, FeedState } from './feedState';
import { attachLivePlaybackRateGuard } from './livePlaybackRate';
import { ManifestStateManager } from './ManifestManagement';
import { nextMediaErrorAction, NO_MEDIA_ERRORS_YET } from './mediaErrorRecovery';
import { attachPlaybackStallReporter } from './playbackHealth';
import { buildPlayerConfig } from './playerConfig';

import './SwarmHlsPlayer.scss';

// TODO Consider switching to React.MediaHTMLAttributes<HTMLMediaElement> to support <audio> as well
interface HlsPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  owner: string;
  topicString: string;
  mediaType: MediaType;
  enableQoeOverlay?: boolean;
}

/** The key both the manifest state and the feed state are held under. Null if the name is unusable. */
function toHexTopic(topicString: string): string | null {
  try {
    return Topic.fromString(topicString).toString();
  } catch (error) {
    console.warn('Not a usable topic name:', topicString, error);
    return null;
  }
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
  const [feedState, setFeedState] = useState<FeedState>(FEED_STATE_LIVE);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Deliberately not part of the effect below, which reruns on every restart. A fatal network error
  // is what causes a restart, so a subscription torn down and rebuilt with the player would be
  // dropped at exactly the moment it has something to say. The tracker replays on subscribe, so a
  // mount that lands in the middle of an outage still hears about it.
  useEffect(() => {
    const hexTopic = toHexTopic(topicString);
    if (!hexTopic) {
      return;
    }
    return manifestFetcher.feedHealth.subscribe(hexTopic, setFeedState);
  }, [topicString]);

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

      // Held across errors rather than inside the handler, because the escalation is about how many
      // failures arrived in a row and a per-event value cannot remember that.
      let mediaErrors = NO_MEDIA_ERRORS_YET;

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
          case ErrorTypes.MEDIA_ERROR: {
            // ⛔ Recovery re-appends the media that just failed, so calling it on every fatal media
            // error with no window and no ending is an unbounded loop that refetches fragments each
            // turn. A broadcast whose opening media a decoder will not accept used to leave a viewer
            // on a black player pulling media for as long as the tab stayed open.
            const decision = nextMediaErrorAction(mediaErrors, performance.now());
            mediaErrors = decision.state;
            console.warn(`Fatal media error, ${decision.action}`);
            if (decision.action === 'restart') {
              restartStream();
              break;
            }
            if (decision.action === 'swap-codec-and-recover') {
              hls?.swapAudioCodec();
            }
            hls?.recoverMediaError();
            break;
          }
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

    // Attached with the player rather than with the subscription above, because it is the player
    // that stalls: a restart builds a fresh media pipeline and the stalls of the one before it are
    // not the new one's. The burst they feed lives in the tracker, which does outlive the restart.
    const stallTopic = toHexTopic(topicString);
    const detachStallReporter = stallTopic
      ? attachPlaybackStallReporter(video, () => manifestFetcher.feedHealth.recordPlaybackStall(stallTopic))
      : null;

    return () => {
      video.removeEventListener('pause', onHlsPause);
      video.removeEventListener('play', onHlsPlay);
      detachQoe?.();
      detachRateGuard?.();
      detachStallReporter?.();

      if (hls) {
        // The destroy runs whatever the clear does. Losing it leaks the loaders and the media
        // attachment of every player the page has ever mounted, and a cleanup that throws takes the
        // rest of React's cleanup with it, so this is not a guarantee to drop for tidiness.
        try {
          const hexTopic = toHexTopic(topicString);
          if (hexTopic) {
            ManifestStateManager.getInstance().clear(hexTopic);
          }
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
      <FeedStateOverlay state={feedState} />
      {enableQoeOverlay && <QoeOverlay metrics={metrics} />}
    </div>
  );
};
