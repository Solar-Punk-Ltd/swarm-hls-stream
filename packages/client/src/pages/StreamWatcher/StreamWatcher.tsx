import { useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Button, ButtonVariant } from '@/components/Button/Button';
import { SwarmHlsPlayer } from '@/components/SwarmHlsPlayer/SwarmHlsPlayer';
import { useAppContext } from '@/providers/App';
import { ROUTES } from '@/routes';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType, type Stream, STREAM_STATUS_SCHEDULED } from '@/types/stream';
import { scheduledStartLabel } from '@/utils/scheduledStart';

import { StreamPlaybackSelection } from './StreamPlaybackSelection';

import './StreamWatcher.scss';

const VALID_MEDIA_TYPES: MediaType[] = [MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO];

function isMediaType(value: string): value is MediaType {
  return VALID_MEDIA_TYPES.includes(value as MediaType);
}

type PlayerProps = {
  owner: string;
  topicString: string;
  mediaType: MediaType;
  stream: Stream | undefined;
  enableQoeOverlay: boolean;
  level: string | undefined;
};

/**
 * The keyed watch-page boundary owns a player's selection for its whole mounted session.
 *
 * `StreamWatcher` renders this only after the initial catalogue lookup. That lets the first ABR
 * row establish the ladder, while a completed lookup with no row deliberately preserves the
 * legacy direct URL path. Catalogue refreshes still rerender the surrounding page, but cannot
 * replace this player's inputs. A route key in the parent is an intentional new selection.
 */
function StreamWatcherPlayer({ owner, topicString, mediaType, stream, enableQoeOverlay, level }: PlayerProps) {
  const selection = useRef<StreamPlaybackSelection | null>(null);
  const [, redraw] = useState(0);
  if (selection.current === null) {
    selection.current = new StreamPlaybackSelection({ owner, topicString, mediaType });
  }
  const playback = selection.current.select(stream);
  const liveAvailable =
    stream?.lifecycle?.version === 1 &&
    ['live', 'waiting'].includes(stream.lifecycle.state) &&
    playback.runNumber !== stream.lifecycle.runNumber;
  const replayAvailable =
    stream?.completedRecording !== undefined && stream.lifecycle?.runNumber !== stream.completedRecording.runNumber;

  const selectLive = () => {
    selection.current?.watchLive(stream);
    redraw((revision) => revision + 1);
  };

  const selectReplay = () => {
    selection.current?.watchReplay(stream);
    redraw((revision) => revision + 1);
  };

  return (
    <>
      <SwarmHlsPlayer
        key={playback.session}
        owner={playback.owner}
        topicString={playback.topicString}
        mediaType={playback.mediaType}
        enableQoeOverlay={enableQoeOverlay}
        renditions={playback.renditions}
        replay={playback.kind === 'replay' ? playback.completedRecording : undefined}
        pinnedRecording={playback.kind === 'live' ? playback.pinnedRecording : undefined}
        level={level}
      />
      {liveAvailable && (
        <Button variant={ButtonVariant.PRIMARY} onClick={selectLive}>
          Stream resumed · Watch live
        </Button>
      )}
      {playback.kind === 'live' && replayAvailable && (
        <Button variant={ButtonVariant.SECONDARY} onClick={selectReplay}>
          Watch previous replay
        </Button>
      )}
    </>
  );
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

  // The ladder lives in the catalog, keyed by the primary feed the browser links to. Current
  // entries name the master, older ones the lowest rung. Waiting for the first catalog read
  // rather than rendering without
  // it keeps a deep link from starting single-rendition and rebuilding a second later.
  const stream = streamList.find((entry) => entry.owner === owner && entry.topic === topic);

  /**
   * An announced broadcast has no manifest feed under its topic yet, so mounting the player would
   * start a poll loop against a slot nobody has written and show a viewer a loading player that can
   * never finish loading. Only an entry the catalog says is scheduled takes this path: a deep link
   * to a topic this catalog does not list still plays, because nothing here knows better.
   */
  const isScheduled = stream?.state === STREAM_STATUS_SCHEDULED;
  const startsAt = scheduledStartLabel(stream?.scheduledStartTime);

  return (
    <div className="stream-item-page">
      {isStreamListLoaded && isScheduled && (
        <div className="stream-not-started">
          <p>This stream has not started yet.</p>
          {startsAt && <p className="stream-not-started-time">Scheduled for {startsAt}</p>}
        </div>
      )}
      {isStreamListLoaded && !isScheduled && (
        <StreamWatcherPlayer
          key={`${mediatype}:${owner}:${topic}`}
          owner={owner}
          topicString={topic}
          mediaType={mediatype}
          enableQoeOverlay={enableQoeOverlay}
          level={level}
          stream={stream}
        />
      )}
      <Button variant={ButtonVariant.SECONDARY} onClick={() => handleBackButtonClick()}>
        Back
      </Button>
    </div>
  );
}
