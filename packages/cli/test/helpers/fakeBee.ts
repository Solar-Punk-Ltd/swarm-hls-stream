import { Bee, BZZ, DAI, type PostageBatch } from '@ethersphere/bee-js';

/**
 * A Bee stub that models what a real postage batch purchase actually does, so the wait loop can be
 * driven without a chain.
 *
 * The lifecycle a real node puts a batch through, and why each stage matters here:
 *
 * 1. `createPostageBatch` submits a transaction to Gnosis Chain. With `waitForUsable: false`, which
 *    is what `buyStamp` passes, it returns as soon as the batch id is known rather than waiting for
 *    the batch to be usable. On a 5 second block time that is seconds, not instant.
 * 2. Immediately afterwards `getPostageBatch` **throws**, because the node has not indexed the batch
 *    yet. This is the stage most easily got wrong: a fake that returns a batch straight away never
 *    exercises the poll loop's error swallowing, which is the branch that matters most.
 * 3. Then it resolves with `usable: false`.
 * 4. Then `usable: true`, once the batch has propagated. Minutes, in the worst case, which is why
 *    the real timeout is five.
 *
 * Timings are expressed in polls rather than milliseconds so a test can drive the same loop at any
 * speed. `notFoundPolls` and `unusablePolls` place the transitions between stages 2, 3 and 4.
 */
export interface FakeBeeOptions {
  /** Polls that throw before the node has indexed the batch. Real nodes 404 here. */
  notFoundPolls?: number;
  /** Polls that resolve with `usable: false` after the batch appears. */
  unusablePolls?: number;
  /** Make the purchase itself fail, the way an underfunded or reverted transaction does. */
  purchaseError?: string;
  /** Never become usable, so the caller has to hit its timeout. */
  neverUsable?: boolean;
  /** Polls where the node is not yet answering health checks, as it is while starting up. */
  unhealthyPolls?: number;
  /** Batches the node already holds, before anything is bought. */
  existingBatches?: { batchID: string; usable: boolean }[];
  /** Wallet balance in PLUR. Defaults to exactly what the default batch costs, so a test says which side of the line it wants. */
  bzz?: bigint;
  xdai?: bigint;
  /** PLUR per chunk per block, which is what turns an amount into a TTL. */
  currentPrice?: number;
  /** Make the chain-state lookup fail, the way a node with no working RPC does. */
  chainStateError?: string;
}

/**
 * Batch parameters every test passes explicitly, rather than letting the command's defaults apply.
 *
 * `resolveStampOptions` falls back to STAMP_AMOUNT and STAMP_DEPTH from the environment, and every
 * command calls `loadEnv()` first, which loads the repository's own `.env`. So a test that let the
 * defaults through would price a different batch on every machine: this one carries STAMP_DEPTH=22,
 * which costs four times what a depth of 20 does.
 */
export const TEST_BATCH = { amount: '10000000000', depth: 20 };

/**
 * What TEST_BATCH costs, so a fixture wallet can be put on either side of affording it.
 *
 * A literal, deliberately, rather than `Utils.getStampCost(TEST_BATCH.depth, TEST_BATCH.amount)`.
 * Calling the same helper the production code calls made the fixture move with the formula: halving
 * the quoted cost halved this balance too, so the affordability boundary tests still landed on the
 * correct side and the whole suite stayed green. `amount * 2 ** depth` is 10000000000 * 2**20.
 */
export const TEST_BATCH_COST_PLUR = 10_485_760_000_000_000n;

/** The same number as the CLI renders it, so a test can pin what the operator is shown. */
export const TEST_BATCH_COST_BZZ = '1.048576';

/** PLUR per chunk per block the fake node reports, and the lifetime that implies for TEST_BATCH. */
export const TEST_CHAIN_PRICE = 24000;
export const TEST_BATCH_DURATION = '3 weeks';

export interface FakeBee {
  bee: Bee;
  /** Options `createPostageBatch` was called with. `waitForUsable` is the one that matters. */
  purchaseOptions(): { waitForUsable?: boolean; immutableFlag?: boolean } | undefined;
  /** How many times the node was polled for health. */
  healthPolls(): number;
  /** Batch id the purchase returned, or undefined if nothing was bought. */
  purchased(): string | undefined;
  /** How many times `createPostageBatch` was called. One is correct, two means a duplicate. */
  purchaseCount(): number;
  /** How many times the batch was polled for usability. */
  pollCount(): number;
}

// Unique per process, so a recovery file one run leaks cannot satisfy another run's assertion.
// The suite this replaced had exactly that hazard.
const BATCH_ID = `${process.pid.toString(16).padStart(8, '0')}`.repeat(8).slice(0, 64);

function batch(id: string, usable: boolean): PostageBatch {
  return {
    batchID: { toHex: () => id },
    usable,
    depth: 20,
    amount: '10000000000',
    immutableFlag: false,
  } as unknown as PostageBatch;
}

export function createFakeBee(options: FakeBeeOptions = {}): FakeBee {
  const notFoundPolls = options.notFoundPolls ?? 2;
  const unusablePolls = options.unusablePolls ?? 2;

  let purchasedId: string | undefined;
  let purchaseOpts: { waitForUsable?: boolean; immutableFlag?: boolean } | undefined;
  let purchases = 0;
  let polls = 0;
  let healths = 0;

  const bee = {
    getHealth: async () => {
      healths += 1;
      if (healths <= (options.unhealthyPolls ?? 0)) {
        throw new Error('connect ECONNREFUSED: node still starting');
      }
      return { status: 'ok' };
    },

    getNodeAddresses: async () => ({ ethereum: { toHex: () => '0xnode' } }),

    // Real BZZ and DAI rather than objects with the two methods the caller happens to use. The
    // sufficiency check compares two BZZ values, and a hand-rolled balance would have made that
    // comparison untestable by being the one thing it could not do.
    getWalletBalance: async () => ({
      bzzBalance: BZZ.fromPLUR(options.bzz ?? TEST_BATCH_COST_PLUR),
      nativeTokenBalance: DAI.fromWei(options.xdai ?? 1n),
    }),

    getChainState: async () => {
      if (options.chainStateError) {
        throw new Error(options.chainStateError);
      }
      return { chainTip: 1, block: 1, totalAmount: '0', currentPrice: options.currentPrice ?? TEST_CHAIN_PRICE };
    },

    getPostageBatches: async () => (options.existingBatches ?? []).map((b) => batch(b.batchID, b.usable)),

    createPostageBatch: async (
      _amount: string,
      _depth: number,
      opts?: { waitForUsable?: boolean; immutableFlag?: boolean },
    ) => {
      purchases += 1;
      purchaseOpts = opts;
      if (options.purchaseError) {
        throw new Error(options.purchaseError);
      }
      purchasedId = BATCH_ID;
      return { toHex: () => BATCH_ID };
    },

    getPostageBatch: async (id: string) => {
      polls += 1;
      // A real node 404s an id it does not know, forever. Without this the fake happily returns a
      // batch for any string, and a test polling the wrong id would still pass.
      if (purchasedId !== undefined && id !== purchasedId) {
        throw new Error(`batch not found: ${id}`);
      }
      if (polls <= notFoundPolls) {
        // What a real node does before it has indexed the batch. The caller must swallow this.
        throw new Error(`batch not found: ${id}`);
      }
      if (options.neverUsable || polls <= notFoundPolls + unusablePolls) {
        return batch(id, false);
      }
      return batch(id, true);
    },
  } as unknown as Bee;

  return {
    bee,
    purchaseOptions: () => purchaseOpts,
    healthPolls: () => healths,
    purchased: () => purchasedId,
    purchaseCount: () => purchases,
    pollCount: () => polls,
  };
}
