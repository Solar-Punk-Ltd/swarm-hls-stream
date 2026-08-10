import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Topic } from '@ethersphere/bee-js';
import Hls, { Events } from 'hls.js';
import Pqueue from 'p-queue';

import playIcon from '@/assets/icons/playIcon.png';
import DefaultPreviewImage from '@/assets/images/defaultPreviewImage.png';
import { CustomFragmentLoader } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { isMasterPlaylist, masterVariants, parseManifest } from '@/components/SwarmHlsPlayer/playlist';
import { useAppContext } from '@/providers/App';
import { MediaType, StreamState } from '@/types/stream';
import { formatDuration } from '@/utils/format';

import './StreamPreview.scss';

const thumbnailQueue = new Pqueue({ concurrency: 1 });
const STREAM_STATE_LIVE: StreamState = 'live';

async function fetchFeed(gatewayUrl: string, owner: string, topic: string, signal: AbortSignal): Promise<string> {
  const hexTopic = Topic.fromString(topic).toString();
  const res = await fetch(`${gatewayUrl}/feeds/${owner}/${hexTopic}`, { signal });
  return res.text();
}

/**
 * A media playlist to take the thumbnail frame from, following one level of indirection.
 *
 * A ladder's catalog topic is its master playlist, which has no segments in it — so a thumbnail
 * taken straight from the feed would find nothing and every ABR stream would show the placeholder
 * image. The lowest rung is the cheapest frame to fetch and is listed first.
 */
async function fetchPlaylist(gatewayUrl: string, owner: string, topic: string, signal: AbortSignal): Promise<string> {
  const text = await fetchFeed(gatewayUrl, owner, topic, signal);
  if (!isMasterPlaylist(text)) {
    return text;
  }

  const [variant] = masterVariants(text);
  if (!variant || signal.aborted) {
    return '';
  }

  return fetchFeed(gatewayUrl, variant.owner || owner, variant.topic, signal);
}

interface StreamPreviewProps {
  owner: string;
  topic: string;
  state?: StreamState;
  duration?: string;
  mediatype: MediaType;
  title: string;
}

export const StreamPreview = ({ owner, topic, state, duration, mediatype, title }: StreamPreviewProps) => {
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
        const text = await fetchPlaylist(gatewayUrl, owner, topic, abort.signal);
        const { segments } = parseManifest(text);

        if (segments.length === 0 || abort.signal.aborted) {
          return;
        }

        const seg = segments[0];
        const segUrl =
          seg.uri.startsWith('http') || seg.uri.startsWith('/bytes/') ? seg.uri : `${gatewayUrl}/bytes/${seg.uri}`;

        const miniManifest = [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:10',
          '#EXT-X-PLAYLIST-TYPE:VOD',
          '#EXT-X-MEDIA-SEQUENCE:0',
          seg.extinf,
          segUrl,
          '#EXT-X-ENDLIST',
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
  }, [owner, topic, gatewayUrl]);

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
