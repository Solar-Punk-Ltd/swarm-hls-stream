import { useEffect, useRef } from 'react';
import type { ContinuationPlayerTest } from './window';

type Replay = {
  master: { reference: string };
  renditions: Array<{ reference: string }>;
};

type PlayerProps = {
  topicString: string;
  renditions?: Array<{ topic: string }>;
  replay?: Replay;
  pinnedRecording?: Replay;
};

const session: ContinuationPlayerTest = { created: 0, destroyed: 0 };
window.__continuationPlayerTest = session;

export function SwarmHlsPlayer({ topicString, renditions, replay, pinnedRecording }: PlayerProps) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    session.created++;
    return () => {
      session.destroyed++;
    };
  }, []);

  return (
    <video
      ref={video}
      data-testid="continuation-player"
      data-master-reference={replay?.master.reference ?? ''}
      data-rendition-reference={replay?.renditions[0]?.reference ?? ''}
      data-pinned-master-reference={pinnedRecording?.master.reference ?? ''}
      data-rendition-topic={renditions?.[0]?.topic ?? ''}
      data-topic={topicString}
    />
  );
}
