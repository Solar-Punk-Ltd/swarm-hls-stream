/**
 * What a single `app` or `stream` name may contain: `[A-Za-z0-9._-]`, beginning with an
 * alphanumeric.
 *
 * The leading-alphanumeric requirement is what does the security work. It makes `..` unrepresentable
 * as a segment, so a traversal cannot be spelled rather than being sanitized away later, and it
 * excludes the separators that let one name resolve to a path it does not look like.
 *
 * This lives here rather than in the request schema because both ends need the same rule and they
 * are on opposite sides of the process. `streamIdSchema` applies it to ids arriving from an operator
 * over HTTP; `parseAppStream` applies it to names arriving from a media engine over a webhook.
 * Before it was shared, only the first end had it, and the schema's docstring asserted that the
 * shape "is what the engines already produce", which was false: a name containing a backslash came
 * out of `parseAppStream`, was admitted, and then could not be named to `POST /stream/stop` because
 * this pattern refused it. See SEC-25.
 */
export const STREAM_ID_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*';

const STREAM_ID_SEGMENT_RE = new RegExp(`^${STREAM_ID_SEGMENT}$`);

/**
 * Long enough for the deepest `app/stream` an engine builds, short enough that the value cannot be
 * used as storage. It bounds a key, not a name: a stream id is retained per stream in several maps,
 * and the rate limiter added in S1.6 keys on the one arriving in `x-stream-id`.
 */
export const MAX_STREAM_ID_LENGTH = 128;

/** Whether one path component is usable as an `app` or a `stream` name. */
export function isStreamIdSegment(value: string): boolean {
  return STREAM_ID_SEGMENT_RE.test(value);
}

/**
 * Whether a whole `app/stream` id is one every consumer of it will accept.
 *
 * The length is checked here and not per segment because that is where the bound belongs and where
 * `streamIdSchema` applies it. Checking only the character class left an engine able to mint a
 * 406-character id that the schema then refused, which is the same defect as an illegal character:
 * the operator cannot name the stream back to `POST /stream/stop`.
 */
export function isUsableStreamId(id: string): boolean {
  return id.length <= MAX_STREAM_ID_LENGTH && id.split('/').every(isStreamIdSegment);
}
