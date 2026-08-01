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
/** The stream is finalizing. Distinct from `unknown_stream`: it existed, and its manifest is closed. */
export const REJECT_DRAINING = 'draining' as const;

export type RejectReason =
  | typeof REJECT_QUEUE_FULL
  | typeof REJECT_UNKNOWN_STREAM
  | typeof REJECT_DUPLICATE
  | typeof REJECT_DRAINING;

export type SegmentResult = { accepted: true } | { accepted: false; reason: RejectReason };

export const MEDIA_TYPE_AUDIO = 'audio' as const;
export const MEDIA_TYPE_VIDEO = 'video' as const;

export type MediaType = typeof MEDIA_TYPE_AUDIO | typeof MEDIA_TYPE_VIDEO;

export const PRESSURE_LOW = 'low' as const;
export const PRESSURE_MEDIUM = 'medium' as const;
export const PRESSURE_HIGH = 'high' as const;

export type QueuePressure = typeof PRESSURE_LOW | typeof PRESSURE_MEDIUM | typeof PRESSURE_HIGH;

export const HEALTH_OK = 'ok' as const;
export const HEALTH_DEGRADED = 'degraded' as const;

export type HealthStatus = typeof HEALTH_OK | typeof HEALTH_DEGRADED;

export const HEALTH_REASON_STALE_MANIFEST = 'stale_manifest' as const;
export const HEALTH_REASON_SEGMENT_UPLOAD_FAILURE = 'segment_upload_failure' as const;
export const HEALTH_REASON_QUEUE_PRESSURE = 'queue_pressure' as const;
export const HEALTH_REASON_SEGMENT_STALL = 'segment_stall' as const;
export const HEALTH_REASON_SEGMENT_LOSS = 'segment_loss' as const;

export type HealthReason =
  | typeof HEALTH_REASON_STALE_MANIFEST
  | typeof HEALTH_REASON_SEGMENT_UPLOAD_FAILURE
  | typeof HEALTH_REASON_QUEUE_PRESSURE
  | typeof HEALTH_REASON_SEGMENT_STALL
  | typeof HEALTH_REASON_SEGMENT_LOSS;

export interface HealthSignals {
  activeStreams: number;
  staleManifestStreams: number;
  maxConsecutiveManifestFailures: number;
  maxConsecutiveSegmentFailures: number;
  queuePressure: QueuePressure;
  /**
   * Age of the least recently active stream that is expected to be producing segments, so the worst
   * stream sets the number rather than the busiest one. `null` when no such stream is registered,
   * which is how an idle uploader, a draining stream and a stream awaiting recovery all avoid
   * looking stalled.
   */
  msSinceStreamActivity: number | null;
  /**
   * Age of the most recent segment the engine could not deliver at all, across every registered
   * stream. `null` when none has been reported.
   *
   * An age rather than a count because a loss is permanent and instantaneous: there is no later
   * event that makes it untrue, so a counter that clears on the next success reports nothing. The
   * next success is also the common case, since a puller writes a segment off and then downloads the
   * one behind it in the same pass.
   */
  msSinceSegmentLoss: number | null;
}

export interface HealthReport {
  status: HealthStatus;
  reasons: HealthReason[];
}
