import { safeUrl } from './BeePublisherPool.js';
import { gateReadingOfError } from './gateReadingOfError.js';
import { GateRefusalError } from './GateRefusalError.js';
import { Logger } from './Logger.js';
import { GateCollector, GateReading } from './StartGates.js';

/**
 * Read every Bee node's chequebook before the uploader touches anything paid, and refuse or warn
 * about one that cannot pay for bandwidth according to `UPLOADER_START_GATES`.
 *
 * ## The failure this exists for
 *
 * A Bee node whose SWAP chequebook has run dry does not report itself broken. It answers `/health`
 * in about a millisecond, keeps its peers, keeps its postage batch, and accepts every upload call.
 * What it cannot do is settle the bandwidth it owes, so each paid push blocks on an allowance that
 * never arrives and the segments queue behind it. From the outside that is indistinguishable from a
 * slow network, and it has already cost this project a full day of measurements attributed to
 * protocol overhead when the real reading was a chequebook drained to six decimal places.
 *
 * So the rule is a gate rather than a documented threshold, and it runs before the uploader touches
 * anything paid or stateful. A number written in a runbook is not a control. Only something that
 * refuses is.
 *
 * ## What happens to that refusal, 2026-09-17
 *
 * It became something a deployment asks for, and this gate is the one the ruling was about. The owner
 * ruled that day that "the uploader and engine should be able to start no matter what the status of
 * the chequebook is", after this read timed out
 * on the live host against a pool address that had no node behind it: the refusal was the loudest
 * line in the log, it was about a chequebook nothing was wrong with, and docker restarted the
 * container into it until the deploy gave up. So by default the reading below still happens on every
 * boot and still says exactly what it found, and the service starts anyway with the whole refusal in
 * the log as a warning, latched onto `/health`. `UPLOADER_START_GATES=refuse` puts the refusal back,
 * unchanged, and the shipped `chequebook-warn` is this gate warning while `PostageGate` refuses.
 * What that trades is in `libs/StartGates.ts`, which is where the decision lives for both gates.
 *
 * ## Why availableBalance rather than totalBalance
 *
 * `totalBalance` counts value the node has already promised away in cheques its peers have not
 * cashed yet. A node can therefore report a healthy total while having nothing left to spend, which
 * is exactly the state this gate is here to catch. `availableBalance` is what remains uncommitted,
 * and it is the only one of the two that answers "can this node pay for the next segment".
 *
 * Note that the e2e preflight at `e2e/suites/preflight/chequebook-funding.test.ts` reads
 * `totalBalance` against the same 0.5 BZZ number. That is a deliberate difference and not drift: the
 * preflight is asking an operator to top up before a paid sitting, where the total is the figure they
 * will deposit against.
 *
 * ## Scope
 *
 * Startup only, and no periodic re-check. Under `warn` what this pass found is latched onto `/health`
 * as `start_gate_warned`, so a chequebook read at boot is still visible hours later without anything
 * reading it again. A node that drains mid-broadcast is a different question and is not answered
 * here.
 */
export class ChequebookGate {
  constructor(
    private readonly nodes: readonly ChequebookNode[],
    private readonly floorPlur: bigint,
    private readonly logger: FundingLogger = Logger.getInstance(),
  ) {}

  /**
   * Read every distinct node's chequebook and leave one funding reading per node in the log.
   *
   * With no `collect` the first node that cannot pay throws, which is what a deployment asking for a
   * refusal needs. Given one, every node is read and each refusal is handed over with the message it
   * would have thrown, because under `warn` the service runs and an operator who hears about one
   * rung per boot fixes a four rung stage one restart at a time.
   *
   * Sequential rather than concurrent either way, so "the first failure" is the first node in ladder
   * order rather than whichever request happened to lose the race. The nodes are deduplicated by URL
   * because two rungs may sit behind one bee, and one bee has one chequebook however many rungs route
   * through it. That is also why a collected refusal names the first rung routed through the node
   * rather than all of them.
   */
  public async assertFunded(collect?: GateCollector): Promise<void> {
    const distinct = distinctByUrl(this.nodes);
    if (distinct.length === 0) {
      throw new Error(
        '[ChequebookGate] asked to clear no Bee node at all. An empty set establishes nothing, so it ' +
          'is refused rather than passed.',
      );
    }

    for (const node of distinct) {
      const refusal = await this.refusalFor(node);
      if (refusal === null) {
        continue;
      }
      if (collect === undefined) {
        throw new GateRefusalError(refusal.message, safeUrl(node.url));
      }
      collect({ rung: node.rung, url: safeUrl(node.url), ...refusal });
    }
  }

  /**
   * The refusal this node earns, or null once its reading is in the log.
   *
   * A balance under the floor is the node answering with a number, and a body with no readable
   * `availableBalance` is no reading at all. A read that threw is either, which is what
   * {@link gateReadingOfError} decides. This gate warns under the shipped mode whichever it is, and
   * the fact belongs to the gate that established it rather than to whoever acts on it.
   */
  private async refusalFor(node: ChequebookNode): Promise<ChequebookRefusal | null> {
    let body: unknown;
    try {
      body = await node.bee.getChequebookBalance();
    } catch (error) {
      return {
        message: this.unreadableRefusal(node.url, describeFailure(error)),
        reading: gateReadingOfError(error),
      };
    }

    const availablePlur = parseAvailablePlur(body);
    if (availablePlur === null) {
      return {
        message: this.unreadableRefusal(node.url, 'the response carried no readable availableBalance'),
        reading: 'unreadable',
      };
    }
    if (availablePlur < this.floorPlur) {
      return { message: this.unfundedRefusal(node.url, availablePlur), reading: 'answered' };
    }

    this.logger.info(
      `[ChequebookGate] ${safeUrl(node.url)} chequebook available ${plurToBzz(availablePlur)} BZZ, ` +
        `floor ${plurToBzz(this.floorPlur)} BZZ`,
    );
    return null;
  }

  private unfundedRefusal(url: string, availablePlur: bigint): string {
    return (
      `[ChequebookGate] ${safeUrl(url)} has ${plurToBzz(availablePlur)} BZZ available in its chequebook and the ` +
      `floor is ${plurToBzz(this.floorPlur)} BZZ. A dry node answers /health in a millisecond while ` +
      'every paid push behind it stalls, which reads as a slow network rather than as a funding ' +
      "fault. Fund it with a chequebook deposit from the node's own wallet, then restart. " +
      'CHEQUEBOOK_MIN_BZZ moves the floor.'
    );
  }

  private unreadableRefusal(url: string, reason: string): string {
    return (
      `[ChequebookGate] ${safeUrl(url)} chequebook is absent or unreadable: ${reason}. A chequebook ` +
      'nothing can read is not one anyone can call filled, and a node running with SWAP disabled has ' +
      'no chequebook to fill at all. Check that the node is answering on that address and that SWAP ' +
      `is on. The floor is ${plurToBzz(this.floorPlur)} BZZ.`
    );
  }
}

/** What a node earns when it cannot pay: the sentence, and which kind of fact it is. */
interface ChequebookRefusal {
  readonly message: string;
  readonly reading: GateReading;
}

/** 1 BZZ = 1e16 PLUR. PLUR is bee's integer base unit, and every balance it reports is denominated in it. */
export const PLUR_PER_BZZ = 10n ** 16n;

/** One node to check. `BeePublisher` satisfies this, which is how the publisher pool's nodes arrive. */
export interface ChequebookNode {
  /** The node's API URL, and the only thing that tells an operator which node a refusal is about. */
  readonly url: string;
  /**
   * The rung this node carries, where the caller knows one. `BeePublisher` has it, which is how the
   * pool's nodes arrive with it, and it is the only part of a refusal that is safe to publish on an
   * unauthenticated `/health`. Optional because a caller with a bare URL is still a legal caller.
   */
  readonly rung?: string;
  readonly bee: ChequebookClient;
}

/**
 * The one call this gate makes, as `Bee.getChequebookBalance` from bee-js provides it.
 *
 * Typed as `unknown` rather than as the library's `ChequebookBalanceResponse` on purpose. A node with
 * SWAP disabled has no chequebook, and what it returns is not that shape, so the gate has to narrow
 * the body itself rather than trust a type that describes only the healthy answer.
 */
export interface ChequebookClient {
  getChequebookBalance(): Promise<unknown>;
}

/** Where a funding reading is written. Matches `Logger`, narrowed to the one method used here. */
export interface FundingLogger {
  info(message: string): void;
}

/**
 * A BZZ amount as an integer count of PLUR.
 *
 * Rounds to the nearest PLUR, which is 1e-16 BZZ. No funding decision turns on that, and the
 * alternative is carrying a decimal string through a comparison whose whole point is exact integers.
 */
export function bzzToPlur(bzz: number): bigint {
  return BigInt(Math.round(bzz * Number(PLUR_PER_BZZ)));
}

/** Human-readable BZZ, for log lines and refusals only, where the precision loss is harmless. */
function plurToBzz(plur: bigint): string {
  return (Number(plur) / Number(PLUR_PER_BZZ)).toFixed(4);
}

/** A token amount as bee-js models one. The exact integer is the only reading the comparison uses. */
interface PlurAmount {
  toPLURBigInt(): bigint;
}

/** The available balance in PLUR, or null for any body this cannot read one out of. */
function parseAvailablePlur(body: unknown): bigint | null {
  const amount = (body as { availableBalance?: unknown } | null | undefined)?.availableBalance;
  if (typeof amount !== 'object' || amount === null || typeof (amount as PlurAmount).toPLURBigInt !== 'function') {
    return null;
  }

  try {
    const plur = (amount as PlurAmount).toPLURBigInt();
    return typeof plur === 'bigint' ? plur : null;
  } catch {
    return null;
  }
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function distinctByUrl(nodes: readonly ChequebookNode[]): ChequebookNode[] {
  const seen = new Set<string>();
  const distinct: ChequebookNode[] = [];

  for (const node of nodes) {
    if (seen.has(node.url)) {
      continue;
    }
    seen.add(node.url);
    distinct.push(node);
  }

  return distinct;
}
