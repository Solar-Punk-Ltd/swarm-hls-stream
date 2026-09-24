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
import { fetchPreviewManifest, rungSlotsKey } from '@/components/StreamPreview/previewManifest';
import { previewMode, thumbnailFailed, thumbnailImageUrl } from '@/components/StreamPreview/previewMode';
import { previewSourceFrom } from '@/components/StreamPreview/previewSource';
import { CustomFragmentLoader } from '@/components/SwarmHlsPlayer/CustomManifestLoader';
import { useAppContext } from '@/providers/App';
import { MediaType, Rendition, STREAM_STATUS_LIVE, STREAM_STATUS_SCHEDULED, StreamState } from '@/types/stream';
import { formatDuration } from '@/utils/format';
import { scheduledStartLabel } from '@/utils/scheduledStart';
import { previewSegmentUrl } from '@/utils/thumbnailManifest';

import './StreamPreview.scss';

const thumbnailQueue = new Pqueue({ concurrency: 1 });

interface StreamPreviewProps {
  owner: string;
  topic: string;
  state?: StreamState;
  duration?: string | number;
  mediatype: MediaType;
  title: string;
  /** The SOC index of this stream's final manifest, published by the uploader on a finished stream. */
  index?: number;
  /** A ladder's rungs, which on a finished entry name the slot each recorded rung's final playlist is at. */
  renditions?: Rendition[];
  /** A Swarm reference to a still image the publisher uploaded. Absent or '' when there is none. */
  thumbnail?: string;
  /** Only ever set on a scheduled entry, and null there until a time is fixed. */
  scheduledStartTime?: string | number | null;
}

/** The preview plays one segment, so the target duration only has to be at least that long. */
const PREVIEW_TARGET_DURATION_SECONDS = 10;

export const StreamPreview = ({
  owner,
  topic,
  state,
  duration,
  mediatype,
  title,
  index,
  renditions,
  thumbnail,
  scheduledStartTime,
}: StreamPreviewProps) => {
  const navigate = useNavigate();
  const { gatewayUrl } = useAppContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDataAvailable, setIsDataAvailable] = useState(false);
  /**
   * The thumbnail reference the browser could not load, which demotes this card out of `image` mode.
   * Held in state rather than handled in the `onError` branch directly, so the decision stays in
   * `previewMode` — a scheduled card must not fall back to a probe, and that rule lives in one place
   * with a test rather than in two handlers.
   *
   * ⛔ The reference and not a boolean, because a card outlives the picture it was given. `StreamList`
   * keys a card by topic, and in admin mode the topic belongs to the declaration and outlives every
   * session on it, so a publisher replacing a broken thumbnail re-renders this same mounted component
   * with a new `thumbnail` prop. A boolean latched on the first failure never cleared, and the card
   * went on probing — or, for a scheduled stream, went on showing the placeholder for ever, since a
   * scheduled card is never probed. Comparing against the current reference makes the failure a fact
   * about one picture rather than about the card.
   */
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
  const imageFailed = thumbnailFailed(failedThumbnail, thumbnail);

  const mode = previewMode({ thumbnail, state, imageFailed });
  const isScheduled = state === STREAM_STATUS_SCHEDULED;
  const startsAt = scheduledStartLabel(scheduledStartTime);

  // Read through a ref, not a dependency: the catalog poll hands back a fresh array every time, and
  // `slotsKey` is what the effect reacts to. The player keys its ladder the same way.
  const renditionsRef = useRef(renditions);
  renditionsRef.current = renditions;
  const slotsKey = rungSlotsKey({ state, renditions });

  useEffect(() => {
    // The card already knows what it is showing, so nothing is fetched and no queue slot is taken.
    // This is the whole saving for a scheduled stream: its manifest feed does not exist, and ten
    // announced broadcasts used to mean ten serial misses before a live card could get its frame.
    if (mode !== 'probe') {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    const abort = new AbortController();
    let hls: Hls | null = null;
    let blobUrl: string | null = null;

    thumbnailQueue.add(async () => {
      if (abort.signal.aborted) {
        return;
      }

      try {
        const { res, segments } = await fetchPreviewManifest(
          gatewayUrl,
          { owner, topic, index, state, renditions: renditionsRef.current },
          abort.signal,
        );

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
        const segUrl = previewSegmentUrl(seg.uri, gatewayUrl, window.location.origin);

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
  }, [owner, topic, gatewayUrl, index, state, slotsKey, mode]);

  return (
    <div className="stream-preview" onClick={() => navigate(`/watch/${mediatype}/${owner}/${topic}`)}>
      {isLoading && (
        <div className="stream-preview-overlay">
          <div className="spinner"></div>
        </div>
      )}
      {/*
        The picture, from exactly one of the three sources `previewMode` names. The video element is
        mounted only for a probe: `videoRef` is what the effect attaches hls.js to, so rendering it
        beside an image would hand the card a second, black layer for no reason.
      */}
      {mode === 'image' && thumbnail && (
        <img
          // Keyed by the reference so a replaced thumbnail mounts a new element rather than having its
          // `src` swapped underneath. React updates attributes in place, so without this an error for
          // the picture just replaced could arrive after the prop changed and be recorded against the
          // new reference — demoting a card for a failure that was never its own.
          key={thumbnail}
          className="stream-preview-image"
          src={thumbnailImageUrl(gatewayUrl, thumbnail)}
          alt=""
          onError={() => setFailedThumbnail(thumbnail)}
        />
      )}
      {mode === 'probe' && <video ref={videoRef} className="stream-preview-video" controls={false} muted playsInline />}
      {(mode === 'placeholder' || (mode === 'probe' && !isLoading && !isDataAvailable)) && (
        <div className="stream-preview-error">
          <img src={DefaultPreviewImage} alt="" />
        </div>
      )}

      {/*
        The caption belongs to the card, not to the frame. It used to render only when a frame had
        been captured, so a stream whose preview failed — and every scheduled stream, which has no
        frame to capture — showed an untitled picture nobody could identify.
      */}
      {!isLoading && (
        <div className="stream-preview-button-wrapper">
          {/* Nothing to play yet on an announced broadcast, so the card does not promise one. */}
          {!isScheduled && <img src={playIcon} alt="play-icon" />}
          <div className="stream-preview-button">
            <span className="stream-preview-button-title">{title}</span>
            {state === STREAM_STATUS_LIVE && <span className="stream-preview-button-state">{state}</span>}
            {isScheduled && (
              <span className="stream-preview-button-state stream-preview-button-state-scheduled">Upcoming</span>
            )}
            {isScheduled && startsAt && <span className="stream-preview-button-schedule">{startsAt}</span>}
            {duration && (
              <span className="stream-preview-button-duration">
                {formatDuration(Number.parseFloat(String(duration)))}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
