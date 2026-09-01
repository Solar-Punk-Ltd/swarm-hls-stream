export const STREAM_STATUS_LIVE = 'live' as const;
export const STREAM_STATUS_VOD = 'vod' as const;

export type StreamStatus = typeof STREAM_STATUS_LIVE | typeof STREAM_STATUS_VOD;

export interface StreamState {
  streamId: string;
  streamRawTopic: string;
  mediatype: MediaType;
  socIndex: number | null;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
  pendingDiscontinuity?: boolean;
  liveManifestStale?: boolean;
  updatedAt: number;
  /** Absent on state written before the ABR ladder existed, and on non-ladder streams. */
  ladder?: LadderMembership;
  bitrate?: BitrateSample;
}

/** One rung of the encoder's ABR ladder, as configured via ABR_LADDER. */
export interface LadderRung {
  /** Suffix the engine appends to the stream name, e.g. '720p'. */
  name: string;
  width: number;
  height: number;
  /** The encoder's target, in kbps. Stands in until enough segments have been measured. */
  configuredKbps: number;
}

/** What ties one rung's uploader to the other three. */
export interface LadderMembership {
  /** Stable id for the ladder, shared by every rung and used as the catalog entry's identity. */
  group: string;
  rung: LadderRung;
}

/** Running bitrate measurement, carried across a restart so a recovery does not reset it. */
export interface BitrateSample {
  totalBytes: number;
  totalDuration: number;
  peakBps: number;
  /** Trailing segments the peak is measured across. See {@link PEAK_WINDOW_SEGMENTS}. */
  window?: SegmentSize[];
}

export interface SegmentSize {
  bytes: number;
  duration: number;
}

/**
 * One rung as the player sees it: enough to build an EXT-X-STREAM-INF and to find the feed
 * carrying that rung's media playlist.
 */
export interface Rendition {
  name: string;
  width: number;
  height: number;
  topic: string;
  /** Peak observed segment bitrate, bits/s — HLS's BANDWIDTH. */
  bandwidth: number;
  /** Mean bitrate so far, bits/s — HLS's AVERAGE-BANDWIDTH. */
  avgBandwidth: number;
  /** Both set once this rung has been finalized as VOD. */
  index?: number;
  duration?: number;
}

export interface SegmentEntry {
  index: number;
  duration: number;
  ref: string;
  discontinuity?: boolean;
}

export const REJECT_QUEUE_FULL = 'queue_full' as const;
export const REJECT_UNKNOWN_STREAM = 'unknown_stream' as const;
export const REJECT_DUPLICATE = 'duplicate' as const;

export type RejectReason = typeof REJECT_QUEUE_FULL | typeof REJECT_UNKNOWN_STREAM | typeof REJECT_DUPLICATE;

export type SegmentResult = { accepted: true } | { accepted: false; reason: RejectReason };

export const MEDIA_TYPE_AUDIO = 'audio' as const;
export const MEDIA_TYPE_VIDEO = 'video' as const;

export type MediaType = typeof MEDIA_TYPE_AUDIO | typeof MEDIA_TYPE_VIDEO;

export const PRESSURE_LOW = 'low' as const;
export const PRESSURE_MEDIUM = 'medium' as const;
export const PRESSURE_HIGH = 'high' as const;

export type QueuePressure = typeof PRESSURE_LOW | typeof PRESSURE_MEDIUM | typeof PRESSURE_HIGH;
