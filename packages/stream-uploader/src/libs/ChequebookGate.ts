import { Logger } from './Logger.js';

/**
 * Refuse to start unless every Bee node this stage publishes through can still pay for bandwidth.
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
 * Startup only. No periodic re-check and no change to what `/health` reports, because the owner rule
 * is that the uploader only *runs* with a filled chequebook. A node that drains mid-broadcast is a
 * different question and is not answered here.
 */
export class ChequebookGate {
  constructor(
    private readonly nodes: readonly ChequebookNode[],
    private readonly floorPlur: bigint,
    private readonly logger: FundingLogger = Logger.getInstance(),
  ) {}

  /**
   * Read every distinct node's chequebook, throw on the first that cannot pay, and otherwise leave
   * one funding reading per node in the log.
   *
   * Sequential rather than concurrent, so "the first failure" is the first node in ladder order
   * rather than whichever request happened to lose the race. The nodes are deduplicated by URL
   * because two rungs may sit behind one bee, and one bee has one chequebook however many rungs
   * route through it.
   */
  public async assertFunded(): Promise<void> {
    const distinct = distinctByUrl(this.nodes);
    if (distinct.length === 0) {
      throw new Error(
        '[ChequebookGate] asked to clear no Bee node at all. An empty set establishes nothing, so it ' +
          'is refused rather than passed.',
      );
    }

    for (const node of distinct) {
      const availablePlur = await this.readAvailablePlur(node);

      if (availablePlur < this.floorPlur) {
        throw new Error(this.unfundedRefusal(node.url, availablePlur));
      }

      this.logger.info(
        `[ChequebookGate] ${node.url} chequebook available ${plurToBzz(availablePlur)} BZZ, ` +
          `floor ${plurToBzz(this.floorPlur)} BZZ`,
      );
    }
  }

  private async readAvailablePlur(node: ChequebookNode): Promise<bigint> {
    let body: unknown;
    try {
      body = await node.bee.getChequebookBalance();
    } catch (error) {
      throw new Error(this.unreadableRefusal(node.url, describeFailure(error)));
    }

    const availablePlur = parseAvailablePlur(body);
    if (availablePlur === null) {
      throw new Error(this.unreadableRefusal(node.url, 'the response carried no readable availableBalance'));
    }
    return availablePlur;
  }

  private unfundedRefusal(url: string, availablePlur: bigint): string {
    return (
      `[ChequebookGate] ${url} has ${plurToBzz(availablePlur)} BZZ available in its chequebook and the ` +
      `floor is ${plurToBzz(this.floorPlur)} BZZ. The uploader refuses to run on an unfunded chequebook, ` +
      'because a dry node answers /health in a millisecond while every paid push behind it stalls. Fund ' +
      "it with a chequebook deposit from the node's own wallet, then restart. CHEQUEBOOK_MIN_BZZ moves " +
      'the floor.'
    );
  }

  private unreadableRefusal(url: string, reason: string): string {
    return (
      `[ChequebookGate] ${url} chequebook is absent or unreadable: ${reason}. The uploader refuses to ` +
      'run without a funding reading, because a chequebook nothing can read is not one anyone can call ' +
      'filled, and a node running with SWAP disabled has no chequebook to fill at all. The floor is ' +
      `${plurToBzz(this.floorPlur)} BZZ.`
    );
  }
}

/** 1 BZZ = 1e16 PLUR. PLUR is bee's integer base unit, and every balance it reports is denominated in it. */
export const PLUR_PER_BZZ = 10n ** 16n;

/** One node to check. `BeePublisher` satisfies this, which is how the publisher pool's nodes arrive. */
export interface ChequebookNode {
  /** The node's API URL, and the only thing that tells an operator which node a refusal is about. */
  readonly url: string;
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
