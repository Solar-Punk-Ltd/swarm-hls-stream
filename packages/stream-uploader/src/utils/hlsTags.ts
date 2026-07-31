/**
 * HLS playlist tags (RFC 8216), as bare tag names without a trailing colon.
 *
 * Tags that carry a value are composed at the call site (`${HLS_EXTINF}:${duration},`) so the
 * builders in ManifestManager and the engine-side playlist parsers share one spelling of each tag.
 */
export const HLS_M3U = '#EXTM3U';
export const HLS_VERSION = '#EXT-X-VERSION';
export const HLS_TARGET_DURATION = '#EXT-X-TARGETDURATION';
export const HLS_MEDIA_SEQUENCE = '#EXT-X-MEDIA-SEQUENCE';
export const HLS_PROGRAM_DATE_TIME = '#EXT-X-PROGRAM-DATE-TIME';
export const HLS_PLAYLIST_TYPE = '#EXT-X-PLAYLIST-TYPE';
export const HLS_EXTINF = '#EXTINF';
export const HLS_STREAM_INF = '#EXT-X-STREAM-INF';
export const HLS_DISCONTINUITY = '#EXT-X-DISCONTINUITY';
export const HLS_ENDLIST = '#EXT-X-ENDLIST';
