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

/**
 * One rung of a stream's ABR ladder, as the uploader published it.
 *
 * `bandwidth` and `avgBandwidth` are measured from real segments rather than taken from the
 * encoder's configuration — they are the entire supply-side input to hls.js's ABR decision.
 */
export interface Rendition {
  name: string;
  width: number;
  height: number;
  topic: string;
  bandwidth: number;
  avgBandwidth: number;
  index?: number;
  duration?: number;
}

export interface Stream {
  owner: string;
  /**
   * The stream's primary feed. For a ladder this is its lowest rung, so a client that ignores
   * `renditions` still plays something rather than nothing.
   */
  topic: string;
  state?: StreamState;
  duration?: string;
  index?: number;
  timestamp: number;
  mediatype: MediaType;
  title: string;
  /** Ladder identity; present only on streams the encoder produced more than one rendition of. */
  group?: string;
  renditions?: Rendition[];
}
