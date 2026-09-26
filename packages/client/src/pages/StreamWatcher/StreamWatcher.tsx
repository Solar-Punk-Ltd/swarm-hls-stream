import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Button, ButtonVariant } from '@/components/Button/Button';
import { SwarmHlsPlayer } from '@/components/SwarmHlsPlayer/SwarmHlsPlayer';
import { useAppContext } from '@/providers/App';
import { watchPageCatalogPollMs } from '@/providers/catalogPoll';
import { useCatalogPoll } from '@/providers/useCatalogPoll';
import { ROUTES } from '@/routes';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType } from '@/types/stream';
import { playableRenditions } from '@/utils/playableRenditions';
import { scheduledStartLabel } from '@/utils/scheduledStart';
import {
  WATCH_VIEW_NOT_STARTED,
  WATCH_VIEW_PLAYER,
  WATCH_VIEW_UNAVAILABLE,
  watchPageView,
} from '@/utils/watchPageView';

import { useIsWaitingForStart } from './useIsWaitingForStart';

import './StreamWatcher.scss';

const VALID_MEDIA_TYPES: MediaType[] = [MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO];

function isMediaType(value: string): value is MediaType {
  return VALID_MEDIA_TYPES.includes(value as MediaType);
}

export function StreamWatcher() {
  const { mediatype, owner, topic } = useParams<{
    mediatype: string;
    owner: string;
    topic: string;
  }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { streamList, isStreamListLoaded } = useAppContext();

  // The ladder lives in the catalog, keyed by the primary feed the browser links to. Current
  // entries name the master, older ones the lowest rung. Waiting for the first catalog read
  // rather than rendering without
  // it keeps a deep link from starting single-rendition and rebuilding a second later.
  const stream = streamList.find((entry) => entry.owner === owner && entry.topic === topic);

  // Above the early return, because a hook may not be skipped on some renders.
  const isWaiting = useIsWaitingForStart(`${owner}/${topic}`, stream);
  const view = watchPageView(isStreamListLoaded, stream, isWaiting);
  useCatalogPoll(watchPageCatalogPollMs(view));

  const handleBackButtonClick = () => {
    navigate(ROUTES.STREAM_BROWSER);
  };

  if (!mediatype || !owner || !topic || !isMediaType(mediatype)) {
    return <div>Invalid stream</div>;
  }

  const enableQoeOverlay = searchParams.get('qoe') === '1';
  // ?level=<rung name> pins playback to one rung, ?level=auto hands the choice to ABR. The route
  // carries no ladder of its own, so the rung names come from the catalog entry below.
  const level = searchParams.get('level') ?? undefined;

  // Neither message mounts the player. An announced broadcast has no manifest feed under its topic
  // yet, so a player there polls a slot nobody writes and loads for ever. See `watchPageView`.
  const startsAt = scheduledStartLabel(stream?.scheduledStartTime);

  return (
    <div className="stream-item-page">
      {view === WATCH_VIEW_NOT_STARTED && (
        <div className="stream-placeholder">
          <p>This stream has not started yet.</p>
          {startsAt && <p className="stream-placeholder-detail">Scheduled for {startsAt}</p>}
        </div>
      )}
      {view === WATCH_VIEW_UNAVAILABLE && (
        <div className="stream-placeholder">
          <p>This stream is no longer available.</p>
        </div>
      )}
      {view === WATCH_VIEW_PLAYER && (
        <SwarmHlsPlayer
          owner={owner}
          topicString={topic}
          mediaType={mediatype}
          enableQoeOverlay={enableQoeOverlay}
          renditions={playableRenditions(stream)}
          level={level}
        />
      )}
      <Button variant={ButtonVariant.SECONDARY} onClick={() => handleBackButtonClick()}>
        Back
      </Button>
    </div>
  );
}
