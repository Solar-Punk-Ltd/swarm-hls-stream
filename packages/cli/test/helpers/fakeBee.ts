import { Bee, type PostageBatch } from '@ethersphere/bee-js';

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
  /** Batches the node already holds, before anything is bought. */
  existingBatches?: { batchID: string; usable: boolean }[];
  bzz?: bigint;
  xdai?: bigint;
}

export interface FakeBee {
  bee: Bee;
  /** Batch id the purchase returned, or undefined if nothing was bought. */
  purchased(): string | undefined;
  /** How many times `createPostageBatch` was called. One is correct, two means a duplicate. */
  purchaseCount(): number;
  /** How many times the batch was polled for usability. */
  pollCount(): number;
}

const BATCH_ID = 'be'.repeat(32);

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
  let purchases = 0;
  let polls = 0;

  const bee = {
    getHealth: async () => ({ status: 'ok' }),

    getNodeAddresses: async () => ({ ethereum: { toHex: () => '0xnode' } }),

    getWalletBalance: async () => ({
      bzzBalance: {
        toDecimalString: () => String(options.bzz ?? 1n),
        toPLURBigInt: () => options.bzz ?? 1n,
      },
      nativeTokenBalance: {
        toDecimalString: () => String(options.xdai ?? 1n),
        toWeiBigInt: () => options.xdai ?? 1n,
      },
    }),

    getPostageBatches: async () => (options.existingBatches ?? []).map((b) => batch(b.batchID, b.usable)),

    createPostageBatch: async () => {
      purchases += 1;
      if (options.purchaseError) {
        // The money is NOT spent in this case: the transaction never landed.
        throw new Error(options.purchaseError);
      }
      purchasedId = BATCH_ID;
      return { toHex: () => BATCH_ID };
    },

    getPostageBatch: async (id: string) => {
      polls += 1;
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
    purchased: () => purchasedId,
    purchaseCount: () => purchases,
    pollCount: () => polls,
  };
}
