import { PostageBatch } from '@ethersphere/bee-js';

import { shortBatchId } from './BeePublisherPool.js';
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

      if (!batch.usable) {
        throw new Error(this.unusableRefusal(publisher, batch));
      }
      if (batch.ttlSeconds < this.minTtlSeconds) {
        throw new Error(this.expiringRefusal(publisher, batch));
      }
      if (batch.utilization > this.maxUtilization) {
        throw new Error(this.fullRefusal(publisher, batch));
      }

      this.logger.info(
        `[PostageGate] ${publisher.rung} ${publisher.url} batch ${shortBatchId(publisher.stamp)}: ` +
          `${percent(batch.utilization)} used, ${hours(batch.ttlSeconds)}h left ` +
          `(ceilings ${percent(this.maxUtilization)}, ${hours(this.minTtlSeconds)}h)`,
      );
    }
  }

  /**
   * ⛔ The catch is the absent-batch path, not an oversight. bee answers `/stamps/<id>` with
   * **404 "issuer does not exist"** for a batch it does not hold, verified against a live node on
   * 2026-08-31, so bee-js throws instead of returning something with `exists: false` on it. There is
   * no field to read for absence, and looking for one is what this gate used to do.
   */
  private async readBatch(publisher: StampedPublisher): Promise<BatchReading> {
    let body: PostageBatch;
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
      `[PostageGate] ${publisher.rung} batch ${shortBatchId(publisher.stamp)} on ${publisher.url} is absent or ` +
      `unreadable: ${reason}. The uploader refuses to run without a batch reading, because a batch ` +
      'nothing can read is not one anyone can call usable, and every way of learning nothing here ' +
      'looks identical to a healthy answer at the first failed upload.'
    );
  }

  private unusableRefusal(publisher: StampedPublisher, batch: BatchReading): string {
    return (
      `[PostageGate] ${publisher.rung} batch ${shortBatchId(publisher.stamp)} on ${publisher.url} reports ` +
      `usable=${batch.usable}. A batch the node will not spend cannot carry a ` +
      'broadcast, and the uploader refuses rather than failing on the first segment. Buy a batch on ' +
      "that node and put its id in this rung's BEE_PUBLISHERS entry."
    );
  }

  private expiringRefusal(publisher: StampedPublisher, batch: BatchReading): string {
    return (
      `[PostageGate] ${publisher.rung} batch ${shortBatchId(publisher.stamp)} on ${publisher.url} has ` +
      `${hours(batch.ttlSeconds)}h left and the floor is ${hours(this.minTtlSeconds)}h. A batch that ` +
      'expires mid-broadcast stops paying for the data it was keeping, so the uploader refuses to ' +
      'start one it cannot finish. Top it up with a postage top-up on that node, or lower the floor ' +
      'with STAMP_MIN_TTL_HOURS if this run really is shorter than the batch has left.'
    );
  }

  private fullRefusal(publisher: StampedPublisher, batch: BatchReading): string {
    return (
      `[PostageGate] ${publisher.rung} batch ${shortBatchId(publisher.stamp)} on ${publisher.url} is ` +
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
 * ⛔⛔⛔ Typed as the library's own `PostageBatch` rather than as `unknown`, which is the fix for the
 * defect that stopped the four-node stage starting on 2026-08-31. bee answers `/stamps/<id>` with
 * `batchTTL` in seconds and `utilizationRatio`; bee-js 9 replaces both before any caller sees them,
 * with a `Duration` instance and a `usage` ratio. This gate parsed bee's names off an `unknown`, so
 * it could not read a single live batch, while a test fake built from bee's JSON passed every case.
 * Reading through the library's type makes the next rename a compile error here instead.
 *
 * The runtime narrowing below stays, because the type describes bee-js and this contract does not
 * require the caller to be bee-js: a proxy or a hand-rolled client can answer in a shape the type
 * says is impossible, and absence of a reading has to refuse rather than default.
 */
export interface PostageClient {
  getPostageBatch(batchId: string): Promise<PostageBatch>;
}

/** What the gate needs out of a batch, once the response has been narrowed. */
interface BatchReading {
  readonly usable: boolean;
  readonly ttlSeconds: number;
  /** 0 to 1, which is bee-js's `usage`. Its `utilization` is the raw count in the fullest bucket. */
  readonly utilization: number;
}

interface FundingLogger {
  info(message: string): void;
}

/**
 * Narrow bee-js's answer, or null when it is not one.
 *
 * ⛔ Absence is a refusal rather than a default. A batch whose duration is missing is not a batch
 * with plenty of time, and reading it as one would make every unreadable answer pass the gate, which
 * is the failure this whole file exists to stop.
 *
 * ⚠️ `usage` is bee-js's own `utilization / 2 ** (depth - bucketDepth)`, which is arithmetically the
 * same number bee publishes as `utilizationRatio`. Checked against a live batch on 2026-08-31:
 * 232 of 256 buckets, both ways round to 0.90625. The library's is used rather than a second copy of
 * its formula, for the reason `BatchLimits` in the CLI package gives: a duplicated formula is a thing
 * nothing notices drifting.
 *
 * ⚠️ A negative TTL never arrives here. bee reports -1 for a batch whose lifetime it cannot work out,
 * and bee-js clamps that to one second on the way through, so an expired batch is refused by the
 * floor below rather than read as unreadable.
 */
function parseBatch(batch: PostageBatch): BatchReading | null {
  const ttl = numberOf(secondsOf(batch.duration));
  const usage = numberOf(batch.usage);
  if (ttl === null || usage === null) {
    return null;
  }
  return {
    usable: batch.usable === true,
    ttlSeconds: ttl,
    utilization: usage,
  };
}

/**
 * Seconds off a bee-js `Duration`, read through `unknown` on purpose.
 *
 * The type promises an instance with the method on it. A proxy or a hand-rolled client can hand over
 * a plain object instead, and calling a method that is not there throws a TypeError that reads as
 * this gate crashing rather than as it refusing.
 */
function secondsOf(duration: unknown): unknown {
  if (typeof duration !== 'object' || duration === null) {
    return null;
  }
  const toSeconds = (duration as { toSeconds?: unknown }).toSeconds;
  return typeof toSeconds === 'function' ? (toSeconds as () => unknown).call(duration) : null;
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

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(1);
}
