import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HLS_ENDLIST,
  HLS_M3U,
  HLS_MEDIA_SEQUENCE_ZERO,
  HLS_PLAYLIST_TYPE_VOD,
  HLS_TARGET_DURATION,
  HLS_VERSION,
} from '@swarm-hls-stream/shared';
import Hls, { Events } from 'hls.js';
import Pqueue from 'p-queue';

import playIcon from '@/assets/icons/playIcon.png';
import DefaultPreviewImage from '@/assets/images/defaultPreviewImage.png';
import { previewSourceFrom } from '@/components/StreamPreview/previewSource';
import { CustomFragmentLoader } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { parseManifest } from '@/components/SwarmHlsPlayer/ManifestManagement';
import { useAppContext } from '@/providers/App';
import { MediaType, StreamState } from '@/types/stream';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { formatDuration } from '@/utils/format';
import { previewSegmentUrl, thumbnailManifestUrl } from '@/utils/thumbnailManifest';

import './StreamPreview.scss';

const thumbnailQueue = new Pqueue({ concurrency: 1 });
const STREAM_STATE_LIVE: StreamState = 'live';

interface StreamPreviewProps {
  owner: string;
  topic: string;
  state?: StreamState;
  duration?: string;
  mediatype: MediaType;
  title: string;
  /** The SOC index of this stream's final manifest, published by the uploader on a finished stream. */
  index?: number;
}

/** The preview plays one segment, so the target duration only has to be at least that long. */
const PREVIEW_TARGET_DURATION_SECONDS = 10;

export const StreamPreview = ({ owner, topic, state, duration, mediatype, title, index }: StreamPreviewProps) => {
  const navigate = useNavigate();
  const { gatewayUrl } = useAppContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDataAvailable, setIsDataAvailable] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    let hls: Hls | null = null;
    let blobUrl: string | null = null;

    thumbnailQueue.add(async () => {
      if (abort.signal.aborted) {
        return;
      }

      try {
        const res = await fetchWithTimeout(thumbnailManifestUrl(gatewayUrl, owner, topic, index), {
          signal: abort.signal,
        });
        const { segments } = parseManifest(res.text);

        // Split from the check below, because the two used to share an early return and only one of
        // them is a reason to leave the spinner up. An aborted card is being unmounted and nobody is
        // looking at it; a card with nothing to show is on screen and has to say so.
        if (abort.signal.aborted) {
          return;
        }

        const source = previewSourceFrom(res, segments);
        if (source.kind === 'unavailable') {
          console.warn(`Thumbnail unavailable for ${topic}: ${source.reason}`);
          setIsLoading(false);
          return;
        }

        const seg = source.firstSegment;
        const segUrl = previewSegmentUrl(seg.uri, gatewayUrl);

        // Spelled from the shared constants rather than by hand. These six literals were the last
        // place a tag rename could pass every type check and every test and still leave the preview
        // player asking for a playlist no decoder accepts. See ARCH-1.
        const miniManifest = [
          HLS_M3U,
          `${HLS_VERSION}:3`,
          `${HLS_TARGET_DURATION}:${PREVIEW_TARGET_DURATION_SECONDS}`,
          HLS_PLAYLIST_TYPE_VOD,
          HLS_MEDIA_SEQUENCE_ZERO,
          seg.extinf,
          segUrl,
          HLS_ENDLIST,
        ].join('\n');

        const blob = new Blob([miniManifest], { type: 'application/vnd.apple.mpegurl' });
        blobUrl = URL.createObjectURL(blob);

        if (abort.signal.aborted) {
          return;
        }

        await new Promise<void>((resolve) => {
          if (!videoRef.current || abort.signal.aborted) {
            resolve();
            return;
          }

          hls = new Hls({ fLoader: CustomFragmentLoader });
          hls.attachMedia(videoRef.current);
          hls.loadSource(blobUrl!);

          const done = () => {
            abort.signal.removeEventListener('abort', done);
            resolve();
          };
          abort.signal.addEventListener('abort', done, { once: true });

          hls.on(Events.FRAG_CHANGED, () => {
            if (videoRef.current) {
              videoRef.current.currentTime = 0;
              videoRef.current.pause();
            }
            setIsDataAvailable(true);
            setIsLoading(false);
            hls?.stopLoad();
            done();
          });

          hls.on(Events.ERROR, () => {
            setIsLoading(false);
            done();
          });
        });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        console.error('Thumbnail load failed:', err);
        setIsLoading(false);
      }
    });

    return () => {
      abort.abort();
      if (hls) {
        hls.destroy();
        hls = null;
      }
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
    };
  }, [owner, topic, gatewayUrl, index]);

  return (
    <div className="stream-preview" onClick={() => navigate(`/watch/${mediatype}/${owner}/${topic}`)}>
      {isLoading && (
        <div className="stream-preview-overlay">
          <div className="spinner"></div>
        </div>
      )}
      <video ref={videoRef} className="stream-preview-video" controls={false} muted playsInline />

      {!isLoading && isDataAvailable && (
        <div className="stream-preview-button-wrapper">
          <img src={playIcon} alt="play-icon" />
          <div className="stream-preview-button">
            <span className="stream-preview-button-title">{title}</span>
            {state === STREAM_STATE_LIVE && <span className="stream-preview-button-state">{state}</span>}
            {duration && (
              <span className="stream-preview-button-duration">{formatDuration(Number.parseFloat(duration))}</span>
            )}
          </div>
        </div>
      )}
      {!isLoading && !isDataAvailable && (
        <div className="stream-preview-error">
          <img src={DefaultPreviewImage} alt="" />
        </div>
      )}
    </div>
  );
};
