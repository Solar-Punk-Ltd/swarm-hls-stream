export const MEDIA_TYPE_AUDIO = 'audio' as const;
export const MEDIA_TYPE_VIDEO = 'video' as const;

export type MediaType = typeof MEDIA_TYPE_AUDIO | typeof MEDIA_TYPE_VIDEO;

export type StreamState = 'live' | 'vod';

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
