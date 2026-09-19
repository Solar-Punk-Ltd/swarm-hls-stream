// One definition, in the shared package, because the uploader writes the catalog entries this reads
// and both packages used to carry their own copies of these literals. Re-exported here rather than
// imported at every call site so the move stays invisible to the components. See ARCH-1.
export {
  MEDIA_TYPE_AUDIO,
  MEDIA_TYPE_VIDEO,
  type MediaType,
  type Rendition,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_SCHEDULED,
  STREAM_STATUS_VOD,
} from '@swarm-hls-stream/shared';

import type { MediaType, Rendition, StreamStatus } from '@swarm-hls-stream/shared';

/** The uploader's name for this is `StreamStatus`, which is what the catalog entry actually says. */
export type StreamState = StreamStatus;

export interface Stream {
  owner: string;
  /**
   * The stream's primary feed. Current ladder entries name the master playlist here. Older
   * entries may name their lowest rung, with the complete ladder in `renditions`.
   */
  topic: string;
  state?: StreamState;
  duration?: string;
  index?: number;
  timestamp: number;
  mediatype: MediaType;
  title: string;
  /** Ladder identity, present only on streams the encoder produced more than one rendition of. */
  group?: string;
  renditions?: Rendition[];
  /**
   * A Swarm reference to a still image for this stream, served at `{gateway}/bzz/{thumbnail}/`.
   *
   * ⭐ Optional, and empty string means the same as absent. The uploader has never written this and
   * the admin layer only started to, so the field is missing on every entry published before that
   * and on every entry a broadcaster never gave an image for. A card treats it as a hint it may
   * have, never as one it can rely on.
   */
  thumbnail?: string;
  description?: string;
  tags?: string[];
  /**
   * When an announced broadcast is meant to begin. Only the admin layer writes it, and it is
   * explicitly `null` on an entry that has no time fixed yet, which is why null is in the type.
   */
  scheduledStartTime?: string | null;
}
