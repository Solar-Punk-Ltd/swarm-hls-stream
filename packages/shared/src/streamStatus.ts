export const STREAM_STATUS_LIVE = 'live' as const;
export const STREAM_STATUS_VOD = 'vod' as const;

/**
 * What a catalog entry says about a broadcast: still running, or a finished recording.
 *
 * Distinct from the uploader's internal lifecycle, which has states this never names because a
 * reader has no use for them. See `StreamLifecycle` in the uploader.
 */
export type StreamStatus = typeof STREAM_STATUS_LIVE | typeof STREAM_STATUS_VOD;
