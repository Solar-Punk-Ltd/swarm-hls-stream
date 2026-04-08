export const STREAM_STATUS_LIVE = 'live' as const;
export const STREAM_STATUS_VOD = 'vod' as const;

export type StreamStatus = typeof STREAM_STATUS_LIVE | typeof STREAM_STATUS_VOD;

export interface StreamState {
  streamId: string;
  streamRawTopic: string;
  mediatype: MediaType;
  socIndex: number;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
  updatedAt: number;
}

export interface SegmentEntry {
  index: number;
  duration: number;
  ref: string;
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
