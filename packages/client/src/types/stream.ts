// One definition, in the shared package, because the uploader writes the catalog entries this reads
// and both packages used to carry their own copies of these literals. Re-exported here rather than
// imported at every call site so the move stays invisible to the components. See ARCH-1.
export {
  MEDIA_TYPE_AUDIO,
  MEDIA_TYPE_VIDEO,
  type MediaType,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_VOD,
} from '@swarm-hls-stream/shared';

import type { MediaType, StreamStatus } from '@swarm-hls-stream/shared';

/** The uploader's name for this is `StreamStatus`, which is what the catalog entry actually says. */
export type StreamState = StreamStatus;

export interface Stream {
  owner: string;
  topic: string;
  state?: StreamState;
  duration?: string;
  index?: number;
  timestamp: number;
  mediatype: MediaType;
  title: string;
}
