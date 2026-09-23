/**
 * HLS playlist tags (RFC 8216), as bare tag names without a trailing colon.
 *
 * Tags that carry a value are composed at the call site (`${HLS_EXTINF}:${duration},`) so the
 * builders in the uploader and the parser in the client share one spelling of each tag.
 */
export const HLS_M3U = '#EXTM3U';
export const HLS_VERSION = '#EXT-X-VERSION';
export const HLS_TARGET_DURATION = '#EXT-X-TARGETDURATION';
export const HLS_MEDIA_SEQUENCE = '#EXT-X-MEDIA-SEQUENCE';
export const HLS_PROGRAM_DATE_TIME = '#EXT-X-PROGRAM-DATE-TIME';
export const HLS_PLAYLIST_TYPE = '#EXT-X-PLAYLIST-TYPE';
export const HLS_EXTINF = '#EXTINF';
export const HLS_STREAM_INF = '#EXT-X-STREAM-INF';
export const HLS_INDEPENDENT_SEGMENTS = '#EXT-X-INDEPENDENT-SEGMENTS';
export const HLS_DISCONTINUITY = '#EXT-X-DISCONTINUITY';
/**
 * Says the entry after it names no media, so a client skips it instead of trying to fetch it.
 *
 * RFC 8216bis §4.4.4.7. It is how a playlist admits a hole in its own timeline without claiming the
 * media after the hole is a fresh encode, which is what `#EXT-X-DISCONTINUITY` would claim.
 */
export const HLS_GAP = '#EXT-X-GAP';
export const HLS_ENDLIST = '#EXT-X-ENDLIST';

/**
 * How many `#EXT-X-DISCONTINUITY` tags the playlist's own window has already slid past, so a client
 * joining mid-broadcast numbers the discontinuities it can see from the same place as one that has
 * been watching since the start.
 *
 * RFC 8216 §4.3.3.3. It belongs in the header, before the first media entry and before any
 * `#EXT-X-DISCONTINUITY`: hls.js 1.6.15 parses it into `level.startCC` and reports a playlist that
 * declares it after a fragment, or twice, as a playlist error.
 */
export const HLS_DISCONTINUITY_SEQUENCE = '#EXT-X-DISCONTINUITY-SEQUENCE';

/**
 * The two fully composed tags the client writes when it normalizes a manifest it is assembling
 * from feed slots, where the playlist it serves to hls.js is an EVENT playlist starting at 0
 * regardless of the media sequence the publisher's own window happened to carry.
 */
export const HLS_PLAYLIST_TYPE_EVENT = `${HLS_PLAYLIST_TYPE}:EVENT`;
export const HLS_MEDIA_SEQUENCE_ZERO = `${HLS_MEDIA_SEQUENCE}:0`;

/** The value `#EXT-X-PLAYLIST-TYPE` carries on a finished recording. */
export const HLS_PLAYLIST_TYPE_VOD = `${HLS_PLAYLIST_TYPE}:VOD`;
