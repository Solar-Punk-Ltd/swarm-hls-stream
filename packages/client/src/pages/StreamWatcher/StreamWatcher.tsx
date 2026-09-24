import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';

import { Button, ButtonVariant } from '@/components/Button/Button';
import { SwarmHlsPlayer } from '@/components/SwarmHlsPlayer/SwarmHlsPlayer';
import { useAppContext } from '@/providers/App';
import { watchPageCatalogPollMs } from '@/providers/catalogPoll';
import { ROUTES } from '@/routes';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO, MediaType, STREAM_STATUS_SCHEDULED } from '@/types/stream';
import { playableRenditions } from '@/utils/playableRenditions';
import { scheduledStartLabel } from '@/utils/scheduledStart';

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
  const { streamList, isStreamListLoaded, fetchAppState, setNewStreamList, gatewayUrl } = useAppContext();

  // The ladder lives in the catalog, keyed by the primary feed the browser links to. Current
  // entries name the master, older ones the lowest rung. Waiting for the first catalog read
  // rather than rendering without
  // it keeps a deep link from starting single-rendition and rebuilding a second later.
  const stream = streamList.find((entry) => entry.owner === owner && entry.topic === topic);

  // Above the early return, because a hook may not be skipped on some renders. The key is the browse
  // page's own, so the two pages share one poll rather than running two against the gateway, and a
  // null key is SWR's way of not polling at all.
  const pollMs = watchPageCatalogPollMs(stream?.state);
  const { data } = useSWR(pollMs === null ? null : ['app-state', gatewayUrl], fetchAppState, {
    refreshInterval: pollMs ?? 0,
    dedupingInterval: pollMs ?? 0,
    revalidateOnFocus: true,
    shouldRetryOnError: true,
  });

  useEffect(() => {
    if (data) setNewStreamList(data);
  }, [data, setNewStreamList]);

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
