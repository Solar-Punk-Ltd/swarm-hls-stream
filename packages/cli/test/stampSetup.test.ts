import { Bee, BZZ, DAI } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { stampSetup, StampSetupSeams } from '../src/commands/stamp-setup.js';

import { TEST_BATCH, TEST_BATCH_COST_PLUR } from './helpers/fakeBee.js';

// Unique per process. A fixed id let the recovery file this suite leaks into the shared temp
// directory satisfy the next run's assertion, so the entire fallback mechanism could be deleted and
// the suite stayed green on any machine that had run it once.
const BATCH_ID = `${process.pid.toString(16).padStart(8, '0')}`.repeat(8).slice(0, 64);
const recoveryFiles: string[] = [];
const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-setup-'));
  workspaces.push(dir);
  return dir;
}

after(() => {
  for (const file of recoveryFiles) {
    rmSync(file, { force: true });
  }
  for (const dir of workspaces) {
    try {
      chmodSync(dir, 0o700);
      for (const entry of readdirSync(dir)) {
        chmodSync(join(dir, entry), 0o600);
      }
    } catch {
      // Already writable, or already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

interface WalletBeeOptions {
  /** BZZ the node holds, in PLUR. Defaults to twice the cost of the batch this command would buy. */
  bzzPlur?: bigint;
  xdaiWei?: bigint;
  batches?: unknown[];
}

/**
 * A bee stub whose wallet holds exactly what the test says, and which reports the batches it names.
 *
 * The balances are real `BZZ` and `DAI` rather than objects carrying the two methods the caller
 * happens to use. The sufficiency check compares two BZZ values, so a hand-rolled balance would be
 * unable to answer the one question under test while still passing every other assertion here.
 */
function walletBee({ bzzPlur, xdaiWei = 1n, batches = [] }: WalletBeeOptions = {}): Bee {
  return {
    getNodeAddresses: async () => ({ ethereum: { toHex: () => '0xnode' } }),
    getWalletBalance: async () => ({
      bzzBalance: BZZ.fromPLUR(bzzPlur ?? TEST_BATCH_COST_PLUR * 2n),
      nativeTokenBalance: DAI.fromWei(xdaiWei),
    }),
    getChainState: async () => ({ chainTip: 1, block: 1, totalAmount: '0', currentPrice: 24000 }),
    getPostageBatches: async () => batches,
  } as unknown as Bee;
}

/** A wallet that can pay, with no existing batches, so the run reaches the spend. */
function fundedBee(): Bee {
  return walletBee();
}

interface Run {
  spends: number;
  output: string;
  exitCode?: number;
}

async function run(
  overrides: StampSetupSeams & { buyThrows?: boolean; waitThrows?: boolean; assumeYes?: boolean },
): Promise<Run> {
  const captured: string[] = [];
  const sinks = ['log', 'info', 'warn', 'error'] as const;
  const originals = sinks.map((name) => [name, console[name]] as const);
  for (const name of sinks) {
    console[name] = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
  }

  let spends = 0;
  let exitCode: number | undefined;

  try {
    await stampSetup(
      { ...TEST_BATCH, assumeYes: overrides.assumeYes },
      {
        createBee: () => fundedBee(),
        // Every test here predates the spend confirmation and is about some other step, so the
        // default answers yes. The prompt itself has its own tests below.
        confirm: async () => true,
        waitForNode: async () => undefined,
        buyStamp: async () => {
          spends += 1;
          if (overrides.buyThrows) {
            throw new Error('chain rejected the transaction');
          }
          return BATCH_ID;
        },
        waitForStamp: async () => {
          if (overrides.waitThrows) {
            throw new Error('stamp did not become usable in time');
          }
          return undefined;
        },
        exit: (code: number) => {
          throw new ExitCalled(code);
        },
        ...overrides,
      },
    );
  } catch (err) {
    if (!(err instanceof ExitCalled)) {
      throw err;
    }
    exitCode = err.code;
  } finally {
    for (const [name, fn] of originals) {
      console[name] = fn;
    }
  }

  return { spends, output: captured.join('\n'), exitCode };
}

describe('stampSetup, OPS-1: no path loses the batch id after a spend', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = workspace();
    envPath = join(dir, '.env');
  });

  it('records the batch id when .env does not exist', async () => {
    // A fresh clone. The write used to throw ENOENT after the money was gone.
    assert.equal(existsSync(envPath), false);

    const result = await run({ envPath });

    assert.equal(result.spends, 1, 'the stamp should have been bought');
    assert.match(readFileSync(envPath, 'utf-8'), new RegExp(`^STAMP=${BATCH_ID}$`, 'm'));
    assert.match(result.output, new RegExp(BATCH_ID), 'the id must also be echoed');
  });

  it('records the batch id before waiting for the stamp, so a wait timeout cannot lose it', async () => {
    // waitForStamp routinely times out on a slow chain. It used to sit between the spend and the
    // only write, so a timeout meant a paid-for batch with its id in scrollback.
    const result = await run({ envPath, waitThrows: true });

    assert.equal(result.spends, 1);
    assert.equal(result.exitCode, 1, 'a wait timeout is still a failure');
    assert.match(
      readFileSync(envPath, 'utf-8'),
      new RegExp(`^STAMP=${BATCH_ID}$`, 'm'),
      'the id must be on disk even though the run failed',
    );
  });

  it('refuses to spend at all when .env cannot be written', async () => {
    // The criterion's read-only case. Refusing before the spend is the outcome that costs nothing.
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');
    chmodSync(envPath, 0o400);

    const result = await run({ envPath });

    assert.equal(result.spends, 0, 'no money may be spent when the result cannot be recorded');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Refusing to buy a stamp/);
    assert.match(result.output, /No money has been spent/);
  });

  it('falls back to a recovery file when .env becomes unwritable after the preflight', async () => {
    // The race the preflight cannot close: writable at check time, not at write time. The spend has
    // happened by then, so the id has to land somewhere and be shouted about.
    const result = await run({
      envPath,
      buyStamp: async () => {
        chmodSync(dir, 0o500);
        return BATCH_ID;
      },
    });

    // The path is read out of the output rather than discovered by scanning a shared directory, and
    // its contents are checked. Scanning let a previous run's leftover satisfy this.
    const savedAt = /Saved a copy at: (.+)$/m.exec(result.output)?.[1];
    assert.ok(savedAt, `the notice must name where it saved the id, got: ${result.output}`);
    recoveryFiles.push(savedAt);

    assert.equal(
      readFileSync(savedAt, 'utf-8').trim(),
      `STAMP=${BATCH_ID}`,
      'the recovery file must hold the id that was actually bought',
    );
    assert.equal(result.exitCode, 1, 'a spend whose id never reached .env is a failure');
    assert.match(result.output, /PAID FOR/, 'the operator must be told the money is already gone');
    assert.match(result.output, new RegExp(BATCH_ID), 'the id must be echoed whatever else fails');
    assert.doesNotMatch(
      result.output,
      /Run \.\/deploy\/scripts\/deploy\.sh/,
      'a run that could not record the id must not end by telling the operator to deploy',
    );
  });

  it('does not claim a successful .env write when the write failed', async () => {
    const result = await run({
      envPath,
      buyStamp: async () => {
        chmodSync(dir, 0o500);
        return BATCH_ID;
      },
    });

    assert.doesNotMatch(result.output, /Written STAMP=.* to \.env/, 'reporting a write that did not happen is the bug');
  });

  it('exits zero on a fully successful run', async () => {
    // Without this, appending exit(1) to the success path changes no test, which is how the
    // opposite defect got in: a failed write exiting zero.
    const result = await run({ envPath });

    assert.equal(result.exitCode, undefined, 'a successful run must not exit non-zero');
    assert.match(result.output, /Run \.\/deploy\/scripts\/deploy\.sh/);
  });

  it('fails without writing anything when the purchase itself throws', async () => {
    // The stub for this existed and no test ever used it. Swallowing the error here would write an
    // empty STAMP= into the operator's .env and report it as written.
    const result = await run({ envPath, buyThrows: true });

    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(envPath), false, 'a failed purchase must not create or touch .env');
    assert.doesNotMatch(result.output, /Written STAMP=/);
  });

  it('does not spend when the wallet is unfunded', async () => {
    const result = await run({
      envPath,
      createBee: () => walletBee({ bzzPlur: 0n, xdaiWei: 0n }),
    });

    assert.equal(result.spends, 0, 'an unfunded wallet must never reach the purchase');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /cannot pay for this batch/);
  });

  // The check used to be `balance > 0`, so a wallet holding a single PLUR passed it and the run went
  // on to submit a transaction the chain then reverted, after the gas for it had been spent. A batch
  // costs `amount * 2^depth`, which is a number this command has known all along. See OPS-5.
  it('does not spend when the wallet holds dust rather than the batch price', async () => {
    const result = await run({ envPath, createBee: () => walletBee({ bzzPlur: 1n }) });

    assert.equal(result.spends, 0, 'a dust balance reached the purchase');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /This batch costs .* BZZ and the node holds/);
  });

  // The other side of the same line, and the one an over-strict check breaks. A wallet holding
  // exactly the price can afford the batch, so refusing it would be a refusal to spend money the
  // operator has.
  it('spends when the wallet holds exactly the batch price', async () => {
    const result = await run({ envPath, createBee: () => walletBee({ bzzPlur: TEST_BATCH_COST_PLUR }) });

    assert.equal(result.spends, 1, 'a wallet holding exactly the price was refused');
    assert.equal(result.exitCode, undefined);
  });

  // Nothing prints the price of what is about to be bought unless it is asserted. The cost is
  // derived rather than looked up, so an operator typing a depth one digit out has only this line
  // between them and a batch costing four times what they meant to spend.
  it('shows the cost and the lifetime before the spend', async () => {
    const result = await run({ envPath });

    assert.match(result.output, /Cost: [\d.]+ BZZ/);
    assert.match(result.output, /Lasts for: \S+/);
  });

  it('does not spend when the confirmation is declined', async () => {
    const result = await run({ envPath, confirm: async () => false });

    assert.equal(result.spends, 0, 'a declined confirmation still bought a stamp');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /No money has been spent/);
  });

  // The order matters as much as the prompt existing: an approval collected after the money is gone
  // is not an approval. The event log rather than a flag, because "was the prompt reached" and "was
  // it reached first" are different questions and only the sequence answers both.
  it('asks before spending, not after', async () => {
    const events: string[] = [];
    const result = await run({
      envPath,
      confirm: async () => {
        events.push('ASKED');
        return true;
      },
      buyStamp: async () => {
        events.push('BOUGHT');
        return BATCH_ID;
      },
    });

    assert.equal(result.exitCode, undefined);
    assert.deepEqual(events, ['ASKED', 'BOUGHT']);
  });

  // `--yes` is what a non-interactive run uses to approve a spend, and it has to work without ever
  // reaching a prompt: `confirm` returns false with no TTY, so a run that still asked would abort.
  it('spends without asking when --yes is given', async () => {
    let asked = 0;
    const result = await run({
      envPath,
      assumeYes: true,
      confirm: async () => {
        asked += 1;
        return false;
      },
    });

    assert.equal(asked, 0, '--yes still reached the prompt');
    assert.equal(result.spends, 1);
    assert.equal(result.exitCode, undefined);
  });

  it('reuses an existing usable batch without spending', async () => {
    // The whole reuse branch, including its own recording, was never entered by any test.
    const existing = 'cd'.repeat(32);
    const result = await run({
      envPath,
      createBee: () =>
        walletBee({
          batches: [{ usable: true, batchID: { toHex: () => existing }, depth: 20, amount: '1', immutableFlag: false }],
        }),
    });

    assert.equal(result.spends, 0, 'a usable batch already exists, nothing may be bought');
    assert.equal(result.exitCode, undefined);
    assert.match(readFileSync(envPath, 'utf-8'), new RegExp(`^STAMP=${existing}$`, 'm'));
    assert.doesNotMatch(result.output, /PAID FOR/, 'nothing was paid for on this path');
  });

  it('does not claim a purchase when reuse cannot record the id', async () => {
    const existing = 'cd'.repeat(32);
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');
    chmodSync(dir, 0o500);

    const result = await run({
      envPath,
      createBee: () =>
        walletBee({
          batches: [{ usable: true, batchID: { toHex: () => existing }, depth: 20, amount: '1', immutableFlag: false }],
        }),
    });

    const savedAt = /Saved a copy at: (.+)$/m.exec(result.output)?.[1];
    if (savedAt) {
      recoveryFiles.push(savedAt);
    }
    assert.equal(result.spends, 0);
    assert.equal(result.exitCode, 1, 'an id that never reached .env is a failure here too');
    assert.doesNotMatch(
      result.output,
      /PAID FOR/,
      'telling someone their money is gone when it is not is the mirror bug',
    );
    assert.match(result.output, /Nothing was bought/);
  });

  // OPS-12: a check that fails is not a check that passed. Both of these used to warn on one line
  // and carry on to the purchase.
  it('does not spend when the wallet balance cannot be read', async () => {
    const result = await run({
      envPath,
      createBee: () =>
        ({
          getNodeAddresses: async () => ({ ethereum: { toHex: () => '0xnode' } }),
          getWalletBalance: async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:1633');
          },
          getPostageBatches: async () => [],
        } as unknown as Bee),
    });

    assert.equal(result.spends, 0, 'buying with the balance unknown is the least defensible spend');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Could not check the wallet balance/);
    assert.match(result.output, /No money has been spent/);
  });

  it('reuses an existing batch even when the wallet balance cannot be read', async () => {
    // Listing is local to the node, the balance needs a working chain RPC. A node with a usable
    // batch and a failing RPC has to keep working: reuse spends nothing, so refusing it protects
    // the operator from nothing and costs them the one free outcome.
    const existing = 'cd'.repeat(32);
    const result = await run({
      envPath,
      createBee: () =>
        ({
          getNodeAddresses: async () => ({ ethereum: { toHex: () => '0xnode' } }),
          getWalletBalance: async () => {
            throw new Error('Request failed with status code 500');
          },
          getPostageBatches: async () => [
            { usable: true, batchID: { toHex: () => existing }, depth: 20, amount: '1', immutableFlag: false },
          ],
        } as unknown as Bee),
    });

    assert.equal(result.spends, 0);
    assert.equal(result.exitCode, undefined, 'reuse must not be blocked by an unreadable balance');
    assert.match(readFileSync(envPath, 'utf-8'), new RegExp(`^STAMP=${existing}$`, 'm'));
  });

  it('does not spend when existing stamps cannot be listed', async () => {
    // A transient error here is indistinguishable from "there are none", and the difference costs
    // a whole batch: carrying on buys a duplicate and orphans one of them.
    const result = await run({
      envPath,
      createBee: () =>
        ({
          ...walletBee(),
          getPostageBatches: async () => {
            throw new Error('Request failed with status code 500');
          },
        } as unknown as Bee),
    });

    assert.equal(result.spends, 0, 'a duplicate batch is a whole batch of wasted money');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Could not list existing stamps/);
  });

  it('does not spend when the node is unreachable', async () => {
    const result = await run({
      envPath,
      waitForNode: async () => {
        throw new Error('node not reachable');
      },
    });

    assert.equal(result.spends, 0);
    assert.equal(result.exitCode, 1);
  });
});
