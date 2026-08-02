import { z } from 'zod';

import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO } from '../../types.js';
import { isUsableDuration } from '../../utils/segmentDuration.js';
import { STREAM_ID_SEGMENT } from '../../utils/streamId.js';

/**
 * Long enough for the deepest `app/stream` an engine builds, short enough that the value cannot be
 * used as storage. It bounds a key, not a name: a stream id is retained per stream in several maps,
 * and the rate limiter added in S1.6 keys on the one arriving in `x-stream-id`.
 */
export const MAX_STREAM_ID_LENGTH = 128;

/**
 * Slash-separated {@link STREAM_ID_SEGMENT}s.
 *
 * This used to claim the shape "is what the engines already produce … so restricting to it costs
 * nothing a real broadcaster sends". That was false in the direction that matters: `parseAppStream`
 * would produce names this refuses, so a stream the engine had started could not be named to
 * `POST /stream/stop`, `/stream/status` or the `x-stream-id` header, and the per-stream rate limit
 * keyed on that header never saw it. The premise is now enforced rather than asserted, by building
 * both ends out of the same segment rule. See SEC-25.
 */
const STREAM_ID_PATTERN = new RegExp(`^${STREAM_ID_SEGMENT}(?:\\/${STREAM_ID_SEGMENT})*$`);

/**
 * Every message in this file is written here rather than taken from the validator's defaults, and
 * says what the caller should send instead. A validator's own text names the schema, the union
 * branch and the received value, which is internal shape reaching an unauthenticated caller. See
 * S1.7.
 */
const STREAM_ID_MESSAGE =
  `streamId must be 1 to ${MAX_STREAM_ID_LENGTH} characters, letters, digits, dot, dash and underscore, ` +
  'in slash-separated parts that each start with a letter or digit';

const MEDIATYPE_MESSAGE = `mediatype must be "${MEDIA_TYPE_AUDIO}" or "${MEDIA_TYPE_VIDEO}"`;

export const streamIdSchema = z
  .string(STREAM_ID_MESSAGE)
  .min(1, STREAM_ID_MESSAGE)
  .max(MAX_STREAM_ID_LENGTH, STREAM_ID_MESSAGE)
  .regex(STREAM_ID_PATTERN, STREAM_ID_MESSAGE);

/**
 * A header carrying a number. `Number` rather than `parseInt`/`parseFloat` on purpose: those stop at
 * the first character they cannot use, so `parseInt('5 GB')` is 5 and the caller's typo becomes a
 * silently different request. The empty string is excluded because `Number('')` is 0.
 */
function numericHeaderSchema(message: string) {
  return z
    .string(message)
    .trim()
    .refine((raw) => raw.length > 0 && Number.isFinite(Number(raw)), message)
    .transform(Number);
}

const SEGMENT_INDEX_MESSAGE = 'x-segment-index must be a whole number of zero or more';
const DURATION_MESSAGE = 'x-duration must be a segment length in seconds';

export const startStreamBodySchema = z.object({
  streamId: streamIdSchema,
  mediatype: z.enum([MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO], MEDIATYPE_MESSAGE),
});

export const stopStreamBodySchema = z.object({
  streamId: streamIdSchema,
});

export const streamStatusQuerySchema = z.object({
  streamId: streamIdSchema,
});

/**
 * The duration rule is `isUsableDuration` itself rather than a second copy of it, so the boundary and
 * the orchestrator cannot drift into disagreeing about what a segment length is. The orchestrator
 * keeps its own check: engines reach it without crossing this schema at all.
 */
export const segmentHeadersSchema = z.object({
  'x-stream-id': streamIdSchema,
  'x-segment-index': numericHeaderSchema(SEGMENT_INDEX_MESSAGE).refine(
    (value) => Number.isInteger(value) && value >= 0,
    SEGMENT_INDEX_MESSAGE,
  ),
  'x-duration': numericHeaderSchema(DURATION_MESSAGE).refine(isUsableDuration, DURATION_MESSAGE),
});
