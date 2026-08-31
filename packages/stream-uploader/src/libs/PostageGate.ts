import { Logger } from './Logger.js';

/**
 * Refuse to start unless every postage batch this stage pays with can still carry a broadcast.
 *
 * ## The failure this exists for
 *
 * `BeePublisherPool` already refuses a batch id that is malformed, missing, or does not cover the
 * ladder. What nothing checked is whether the batch it names is still **usable**, and a batch has two
 * separate ways to stop being usable while its id stays perfectly well formed:
 *
 * - **It fills.** An immutable batch that reaches its capacity stops accepting chunks. The shipped
 *   latbench batch was measured on 2026-08-31 sitting at **90.6% utilization**, immutable, with
 *   nothing anywhere reading that number.
 * - **It expires.** A batch's remaining time is bought, and it runs out. Uploads against an expired
 *   batch fail, and the data it was paying for stops being kept.
 *
 * Both arrive as an upload error mid-broadcast rather than as anything an operator saw coming, which
 * is the same shape as the dry chequebook in {@link ChequebookGate}: the node answers, the config is
 * right, and every paid write fails. So this is a gate that refuses before the first segment, not a
 * number in a runbook. A threshold you wrote down is not a control.
 *
 * ## Why per publisher rather than per node
 *
 * `ChequebookGate` deduplicates by URL because one node has one chequebook however many rungs route
 * through it. A batch is the other way round: one node can hold several, and which batch a rung
 * spends is a per-rung routing decision. So this checks the pair, and two rungs sharing a batch are
 * checked once.
 *
 * ## Scope
 *
 * Startup only, exactly like the chequebook gate, and for the same reason: the owner rule is that the
 * uploader only *runs* with a stamp that can pay. A batch that fills mid-broadcast is a different
 * question and is not answered here.
 */
export class PostageGate {
  constructor(
    private readonly publishers: readonly StampedPublisher[],
    private readonly minTtlSeconds: number,
    private readonly maxUtilization: number,
    private readonly logger: FundingLogger = Logger.getInstance(),
  ) {}

  /**
   * Read every distinct batch, throw on the first that cannot carry a broadcast, and otherwise leave
   * one reading per batch in the log.
   *
   * Sequential rather than concurrent, so "the first failure" is the first rung in ladder order
   * rather than whichever request happened to lose the race. Mirrors {@link ChequebookGate}.
   */
  public async assertUsable(): Promise<void> {
    const distinct = distinctByNodeAndStamp(this.publishers);
    if (distinct.length === 0) {
      throw new Error(
        '[PostageGate] asked to clear no postage batch at all. An empty set establishes nothing, so it ' +
          'is refused rather than passed.',
      );
    }

    for (const publisher of distinct) {
      const batch = await this.readBatch(publisher);

      if (!batch.exists || !batch.usable) {
        throw new Error(this.unusableRefusal(publisher, batch));
      }
      if (batch.ttlSeconds < this.minTtlSeconds) {
        throw new Error(this.expiringRefusal(publisher, batch));
      }
      if (batch.utilization > this.maxUtilization) {
        throw new Error(this.fullRefusal(publisher, batch));
      }

      this.logger.info(
        `[PostageGate] ${publisher.rung} ${publisher.url} batch ${short(publisher.stamp)}: ` +
          `${percent(batch.utilization)} used, ${hours(batch.ttlSeconds)}h left ` +
          `(ceilings ${percent(this.maxUtilization)}, ${hours(this.minTtlSeconds)}h)`,
      );
    }
  }

  private async readBatch(publisher: StampedPublisher): Promise<BatchReading> {
    let body: unknown;
    try {
      body = await publisher.bee.getPostageBatch(publisher.stamp);
    } catch (error) {
      throw new Error(this.unreadableRefusal(publisher, describeFailure(error)));
    }

    const reading = parseBatch(body);
    if (reading === null) {
      throw new Error(this.unreadableRefusal(publisher, 'the response carried no readable batch fields'));
    }
    return reading;
  }

  private unreadableRefusal(publisher: StampedPublisher, reason: string): string {
    return (
      `[PostageGate] ${publisher.rung} batch ${short(publisher.stamp)} on ${publisher.url} is absent or ` +
      `unreadable: ${reason}. The uploader refuses to run without a batch reading, because a batch ` +
      'nothing can read is not one anyone can call usable, and every way of learning nothing here ' +
      'looks identical to a healthy answer at the first failed upload.'
    );
  }

  private unusableRefusal(publisher: StampedPublisher, batch: BatchReading): string {
    return (
      `[PostageGate] ${publisher.rung} batch ${short(publisher.stamp)} on ${publisher.url} reports ` +
      `exists=${batch.exists}, usable=${batch.usable}. A batch the node will not spend cannot carry a ` +
      'broadcast, and the uploader refuses rather than failing on the first segment. Buy a batch on ' +
      "that node and put its id in this rung's BEE_PUBLISHERS entry."
    );
  }

  private expiringRefusal(publisher: StampedPublisher, batch: BatchReading): string {
    return (
      `[PostageGate] ${publisher.rung} batch ${short(publisher.stamp)} on ${publisher.url} has ` +
      `${hours(batch.ttlSeconds)}h left and the floor is ${hours(this.minTtlSeconds)}h. A batch that ` +
      'expires mid-broadcast stops paying for the data it was keeping, so the uploader refuses to ' +
      'start one it cannot finish. Top it up with a postage top-up on that node, or lower the floor ' +
      'with STAMP_MIN_TTL_HOURS if this run really is shorter than the batch has left.'
    );
  }

  private fullRefusal(publisher: StampedPublisher, batch: BatchReading): string {
    return (
      `[PostageGate] ${publisher.rung} batch ${short(publisher.stamp)} on ${publisher.url} is ` +
      `${percent(batch.utilization)} used and the ceiling is ${percent(this.maxUtilization)}. An ` +
      'immutable batch that reaches capacity stops accepting chunks, and that arrives as a failed ' +
      'upload rather than as a warning. Dilute it on that node to buy depth, or buy a fresh batch. ' +
      'STAMP_MAX_UTILIZATION moves the ceiling.'
    );
  }
}

/** One rung's node and the batch it spends. `BeePublisher` satisfies this. */
export interface StampedPublisher {
  readonly rung: string;
  readonly url: string;
  readonly stamp: string;
  readonly bee: PostageClient;
}

/**
 * The one call this gate makes, as `Bee.getPostageBatch` from bee-js provides it.
 *
 * Typed as `unknown` rather than as the library's `PostageBatch` for the same reason
 * {@link ChequebookGate} does it: a node that does not hold the batch does not answer in that shape,
 * so the gate narrows the body itself rather than trusting a type that describes only the healthy
 * answer.
 */
export interface PostageClient {
  getPostageBatch(batchId: string): Promise<unknown>;
}

/** What the gate needs out of a batch, once the response has been narrowed. */
interface BatchReading {
  readonly exists: boolean;
  readonly usable: boolean;
  readonly ttlSeconds: number;
  /** 0 to 1. bee reports `utilization` in buckets and `utilizationRatio` already divided. */
  readonly utilization: number;
}

interface FundingLogger {
  info(message: string): void;
}

/**
 * Narrow bee's answer, or null when it is not one.
 *
 * ⛔ Absence is a refusal rather than a default. A batch whose `batchTTL` is missing is not a batch
 * with plenty of time, and reading it as one would make every unreadable answer pass the gate, which
 * is the failure this whole file exists to stop.
 */
function parseBatch(body: unknown): BatchReading | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const batch = body as Record<string, unknown>;
  const ttl = numberOf(batch.batchTTL);
  const ratio = numberOf(batch.utilizationRatio);
  if (ttl === null || ratio === null) {
    return null;
  }
  return {
    exists: batch.exists === true,
    usable: batch.usable === true,
    ttlSeconds: ttl,
    utilization: ratio,
  };
}

/** bee reports numbers as numbers here, but a proxy that stringifies them is not a reason to refuse. */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** One check per node-and-batch pair: one node may hold several, and two rungs may share one. */
function distinctByNodeAndStamp(publishers: readonly StampedPublisher[]): StampedPublisher[] {
  const seen = new Set<string>();
  return publishers.filter((publisher) => {
    const key = `${publisher.url} ${publisher.stamp}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Enough of a batch id to tell two apart in a log, and never the whole thing. */
function short(stamp: string): string {
  return `${stamp.slice(0, 8)}…`;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(1);
}
