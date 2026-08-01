import { ZodType } from 'zod';

import { ApiError } from '../middleware/errorHandler.js';

/**
 * Validates one part of a request and answers 400 with the schema's own wording when it does not fit.
 *
 * Only the messages authored in the schema reach the caller. The validator's `issues` also carry the
 * value it received and the branch it tried, and echoing those back hands an unauthenticated caller
 * a description of the internal shape. Duplicates are dropped because one message covers a field
 * whichever rule on it failed.
 */
export function parseOrBadRequest<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const reasons = [...new Set(result.error.issues.map((issue) => issue.message))];
  throw new ApiError(400, reasons.join('; '));
}
