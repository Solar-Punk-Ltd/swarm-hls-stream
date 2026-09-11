export const STREAM_STATUS_LIVE = 'live' as const;
export const STREAM_STATUS_VOD = 'vod' as const;
/**
 * Announced, but nothing has been broadcast under the topic yet.
 *
 * Written by the admin layer, which publishes a catalog entry when a broadcast is *scheduled*
 * rather than when it starts. The uploader never writes this and has no lifecycle that maps to it.
 *
 * ⛔ **A scheduled entry has no manifest feed.** Its topic is a promise, not a stream, so asking the
 * gateway for a playlist under it is a guaranteed miss rather than a slow hit. Telling that apart
 * from "live, and the first segment has not landed yet" is the whole reason this literal exists: a
 * reader that cannot will spend a fetch, and a spinner, on every announced broadcast.
 */
export const STREAM_STATUS_SCHEDULED = 'scheduled' as const;

/**
 * What a catalog entry says about a broadcast: announced, still running, or a finished recording.
 *
 * Distinct from the uploader's internal lifecycle, which has states this never names because a
 * reader has no use for them. See `StreamLifecycle` in the uploader.
 *
 * Widened rather than versioned. A catalog entry is JSON on a feed that more than one publisher now
 * writes and every reader parses unchecked, so entries written before a status existed keep their
 * old shape forever and a reader has to carry all of them. The rule that keeps that safe: only
 * `live` is live, and everything a consumer does not recognise is treated as not-live.
 */
export type StreamStatus = typeof STREAM_STATUS_LIVE | typeof STREAM_STATUS_VOD | typeof STREAM_STATUS_SCHEDULED;
