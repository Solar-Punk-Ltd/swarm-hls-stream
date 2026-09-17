import { GateReading } from './StartGates.js';

/**
 * Whether a failed gate read is the node answering, or no reading arriving at all.
 *
 * ## Why the status and nothing else
 *
 * Both start gates wrap what their client threw in a sentence of their own, so by the time a refusal
 * reaches an operator the cause is prose. This runs before that, on the thrown error itself, and asks
 * the one question a policy of `answered` turns on: did a node answer this request. bee-js throws
 * `BeeResponseError` with the response's `status` on it, and an axios error arriving unwrapped
 * carries the same number one level down on `response`, so both are read.
 *
 * ⛔ A 4xx is the node answering and refusing this request, which for `/stamps/<id>` is bee's
 * 404 "issuer does not exist" for a batch it does not hold, verified live 2026-08-31. Everything
 * else is unreadable, **including an error with no status at all**, because a request that never
 * reached a node cannot carry that node's opinion of anything.
 *
 * ## Why this does not come from `NodeWait.ts`
 *
 * That file answers a different question, whether waiting can fix this, and it reads codes and
 * message text as well because a gate's wrapper has already thrown the status away by the time it
 * gets there. Here the error is still the original, so the status is present whenever a node gave
 * one, and matching prose would classify a batch id that happens to contain "404" as an answer.
 */
export function gateReadingOfError(error: unknown): GateReading {
  const status = statusOf(error);
  return status !== null && status >= 400 && status < 500 ? 'answered' : 'unreadable';
}

function statusOf(error: unknown): number | null {
  const carrier = error as { status?: unknown; response?: { status?: unknown } } | null | undefined;
  const status = typeof carrier?.status === 'number' ? carrier.status : carrier?.response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}
