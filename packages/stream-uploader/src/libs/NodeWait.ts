import { NodeWaitReport } from '../types.js';

/**
 * The half of the boot that needs a Bee node, run as a wait rather than as a one-shot.
 *
 * ## The failure this exists for
 *
 * `start()` used to run the two start gates, then `StreamCatalog.init`, then the recovery pass, and
 * only then listen. Every one of those reads a node, so a node that was not answering ended the boot:
 * "Failed to start", exit 1, docker restarts the container, the next boot meets the same node. The
 * uploader was fine throughout. On 2026-09-16 the node in question did not exist at all, because a
 * rung had been given a pool address with nothing behind it, and the loop that followed is what made
 * the deploy guard refuse: it watches the restart count, and a count that climbs is its definition of
 * a service falling over.
 *
 * ## What the owner ruled, 2026-09-17
 *
 * "We should be able to start the uploader but maybe say its node not available, try to reconnect or
 * something." So the listener goes first and this runs behind it. A failure that says the node is not
 * answering costs one log line and a wait. The wait doubles from a second and holds at thirty, and it
 * does not give up, because there is no number of attempts after which the right answer becomes
 * exiting: a node that is down for an hour is a node that comes back in an hour, and a process that
 * is up and saying so the whole time is worth more than one that died at attempt ten.
 *
 * ## What still ends the boot
 *
 * Everything else. A feed whose payload cannot be parsed, a key this deployment cannot sign with, a
 * chequebook below its floor under `UPLOADER_START_GATES=refuse`. Waiting on those would be a service
 * that never starts and never says why, which is worse than the exit it replaced. {@link
 * isNodeUnavailable} is where that line is drawn and it reads the error rather than assuming.
 */

/** The first wait, and the shortest. A node that was a second late costs a second. */
export const NODE_WAIT_FIRST_DELAY_MS = 1_000;

/**
 * The longest wait between attempts.
 *
 * Doubling with no ceiling reaches hours, and the cost of that lands on the person who has just
 * repaired the node and is watching a service that could start sit there not starting. Thirty
 * seconds is short enough that a repair is picked up while someone is still looking at it.
 */
export const NODE_WAIT_MAX_DELAY_MS = 30_000;

const MS_PER_SECOND = 1_000;

/** Two levels, because a wait is a warning and the node finally answering is not. */
interface NodeWaitLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Local, like the logger above: `index.ts` builds this object at the one call site and nothing else
 * names the type, so exporting it would be surface `deploy/scripts/unused-exports.mjs` counts and
 * nothing takes up.
 */
interface NodeWaitOptions {
  /** The node the wait is about, which is the coordinator: the one every boot read reaches. */
  readonly url: string;
  readonly logger: NodeWaitLogger;
  /** Called before the first attempt and after every failure, so `/health` can answer from the start. */
  readonly onReport: (report: NodeWaitReport) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly firstDelayMs?: number;
  readonly maxDelayMs?: number;
}

/**
 * Run `init` until it succeeds or fails for a reason waiting cannot fix.
 *
 * Returns whatever `init` returned, so the caller keeps the recovered stream ids it needs next.
 */
export async function waitForNode<T>(init: () => Promise<T>, options: NodeWaitOptions): Promise<T> {
  const { url, logger, onReport } = options;
  const sleep = options.sleep ?? defaultSleep;
  const waitingSince = (options.now ?? (() => new Date()))().toISOString();
  const maxDelayMs = options.maxDelayMs ?? NODE_WAIT_MAX_DELAY_MS;

  let delayMs = options.firstDelayMs ?? NODE_WAIT_FIRST_DELAY_MS;
  let attempts = 0;

  onReport({ url, waitingSince, attempts });

  for (;;) {
    attempts += 1;
    try {
      const value = await init();
      logger.info(`[NodeWait] node at ${url} answered after ${attempts} attempt(s), startup continues`);
      return value;
    } catch (error) {
      if (!isNodeUnavailable(error)) {
        throw error;
      }

      const lastError = describeFailure(error);
      onReport({ url, waitingSince, attempts, lastError });
      logger.warn(`[NodeWait] node not available at ${url}, retrying in ${delayMs / MS_PER_SECOND}s: ${lastError}`);

      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}

/**
 * Whether this failure says the node is not answering, as opposed to answering something wrong.
 *
 * ⛔ **The message is read as well as the code, and that is not belt and braces.** The two start
 * gates do not rethrow what bee-js threw: each wraps the cause in a sentence of its own, so the
 * `code` is gone by the time it arrives here and the only surviving evidence is the text. "timeout of
 * 20000ms exceeded" inside a `[ChequebookGate]` sentence is the shape today's gate budget produces.
 * The live failure of 2026-09-16 said 4000ms, because the gates were bounded by the upload loop's
 * deadline then.
 *
 * A 5xx counts, because a node that answers 500 is up and not ready, which is the same wait with a
 * different cause. A 4xx does not: the node answered and is refusing this request, and no amount of
 * waiting changes a batch it does not hold.
 */
export function isNodeUnavailable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== null) {
    return status >= 500;
  }

  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) {
    return true;
  }

  return UNREACHABLE_TEXT.test(describeFailure(error));
}

/**
 * Node's own codes for a request that never reached the node, or reached it and lost the connection.
 *
 * ECONNRESET and ECONNABORTED are in, unlike the transfer-lost set in `StreamOrchestrator`, and the
 * difference is what the two decide. There, a lost transfer means a write may have landed and must
 * not be repeated blindly. Here nothing has been written yet and every read is safe to repeat.
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * The same facts as words, for the errors that arrive with their code stripped.
 *
 * Deliberately narrow. Every alternative names a transport failure that a caller cannot produce by
 * asking for the wrong thing, so a genuine fault in the feed, the key or the batch cannot match one
 * and be waited on for ever.
 */
const UNREACHABLE_TEXT =
  /ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|network error|timeout of \d+ms exceeded/i;

/** A status the node answered with, from bee-js or from the axios response under it. */
function statusOf(error: unknown): number | null {
  const carrier = error as { status?: unknown; response?: { status?: unknown } } | null | undefined;
  const status = typeof carrier?.status === 'number' ? carrier.status : carrier?.response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
