import { useMemo } from 'react';

import { StreamPreview } from '@/components/StreamPreview/StreamPreview';
import { useAppContext } from '@/providers/App';
import { StreamState } from '@/types/stream';

import './StreamList.scss';

const MAX_DISPLAYED_STREAMS = 10;
const STREAM_STATE_LIVE: StreamState = 'live';

function compareStreams(a: { state?: string; timestamp?: number; index?: number }, b: typeof a): number {
  const aLive = a.state === STREAM_STATE_LIVE;
  const bLive = b.state === STREAM_STATE_LIVE;
  if (aLive !== bLive) {
    return aLive ? -1 : 1;
  }

  const aHasTs = typeof a.timestamp === 'number';
  const bHasTs = typeof b.timestamp === 'number';
  if (aHasTs && bHasTs) {
    return b.timestamp! - a.timestamp!;
  }
  if (aHasTs !== bHasTs) {
    return aHasTs ? -1 : 1;
  }

  return (b.index ?? 0) - (a.index ?? 0);
}

export function StreamList() {
  const { streamList } = useAppContext();

  const recentStreams = useMemo(() => streamList.slice(-MAX_DISPLAYED_STREAMS), [streamList]);

  const displayedStreams = useMemo(() => [...recentStreams].sort(compareStreams), [recentStreams]);

  return (
    <div className="stream-list">
      <div className="stream-list-text">Choose a stream!</div>
      <div className="stream-preview-list">
        {displayedStreams.map((stream) => (
          <StreamPreview
            key={stream.topic}
            owner={stream.owner}
            topic={stream.topic}
            state={stream.state}
            duration={stream.duration}
            mediatype={stream.mediatype}
            title={stream.title}
          />
        ))}
      </div>
    </div>
  );
}
