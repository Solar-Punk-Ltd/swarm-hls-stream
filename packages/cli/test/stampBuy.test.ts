import { Bee, BZZ } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { stampBuy, StampBuySeams } from '../src/commands/stamp-buy.js';

import {
  TEST_BATCH,
  TEST_BATCH_COST_BZZ,
  TEST_BATCH_COST_PLUR,
  TEST_BATCH_DURATION,
  TEST_CHAIN_PRICE,
} from './helpers/fakeBee.js';

/** Enough for the quote to name a TTL, which is the only thing the buy path asks the chain for. */
const CHAIN_STATE = { chainTip: 1, block: 1, totalAmount: '0', currentPrice: TEST_CHAIN_PRICE };

const BATCH_ID = `${process.pid.toString(16).padStart(8, '0')}`.repeat(8).slice(0, 64);
const recoveryFiles: string[] = [];
const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-buy-'));
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

/** Set by `run` for the duration of a run, so a seam can read the output printed up to its own call. */
let capture: () => string = () => '';

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

interface Run {
  spends: number;
  output: string;
  exitCode?: number;
}

async function run(overrides: StampBuySeams & { buyThrows?: boolean; assumeYes?: boolean; rung?: string }): Promise<Run> {
  const captured: string[] = [];
  const sinks = ['log', 'info', 'warn', 'error'] as const;
  const originals = sinks.map((name) => [name, console[name]] as const);
  for (const name of sinks) {
    console[name] = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
  }

  /** Everything printed so far, for a seam that needs to know what was on screen when it ran. */
  capture = () => captured.join('\n');

  let spends = 0;
  let exitCode: number | undefined;

  try {
    await stampBuy(
      { ...TEST_BATCH, assumeYes: overrides.assumeYes, rung: overrides.rung },
      {
        createBee: () => ({ getChainState: async () => CHAIN_STATE } as unknown as Bee),
        // Every test here predates the spend confirmation and is about some other step, so the
        // default answers yes. The prompt itself has its own tests below.
        confirm: async () => true,
        buyStamp: async () => {
          spends += 1;
          if (overrides.buyThrows) {
            throw new Error('chain rejected the transaction');
          }
          return BATCH_ID;
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

describe('stampBuy, OPS-1: the second command that spends money', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = workspace();
    envPath = join(dir, '.env');
  });

  it('records the batch id rather than only printing it', async () => {
    // This command used to print "Add to .env: STAMP=..." and record nothing, so the id survived
    // only in terminal scrollback. Same loss as stamp:setup, on a command that also spends.
    const result = await run({ envPath });

    assert.equal(result.spends, 1);
    assert.match(readFileSync(envPath, 'utf-8'), new RegExp(`^STAMP=${BATCH_ID}$`, 'm'));
    assert.equal(result.exitCode, undefined);
  });

  it('refuses to spend when .env cannot be written', async () => {
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');
    chmodSync(envPath, 0o400);

    const result = await run({ envPath });

    assert.equal(result.spends, 0, 'no money may be spent when the result cannot be recorded');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /No money has been spent/);
  });

  it('fails without touching .env when the purchase throws', async () => {
    const result = await run({ envPath, buyThrows: true });

    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(envPath), false);
  });

  it('exits non-zero and names the recovery file when .env becomes unwritable after the preflight', async () => {
    const result = await run({
      envPath,
      buyStamp: async () => {
        chmodSync(dir, 0o500);
        return BATCH_ID;
      },
    });

    const savedAt = /Saved a copy at: (.+)$/m.exec(result.output)?.[1];
    assert.ok(savedAt, `the notice must name where it saved the id, got: ${result.output}`);
    recoveryFiles.push(savedAt);

    assert.equal(readFileSync(savedAt, 'utf-8').trim(), `STAMP=${BATCH_ID}`);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /PAID FOR/);
  });

  it('says the previous stamp value was replaced', async () => {
    // Overwriting STAMP orphans whatever batch was there. The operator should know.
    writeFileSync(envPath, 'STAMP=older-batch\n');

    const result = await run({ envPath });

    assert.match(result.output, /replaced any previous STAMP/);
    assert.match(readFileSync(envPath, 'utf-8'), new RegExp(`^STAMP=${BATCH_ID}$`, 'm'));
  });

  // The command used to print the amount and depth and buy. Neither says what the purchase costs or
  // how long the batch lasts, and both are derived rather than looked up, so an operator typing a
  // depth one digit out had nothing on screen that would have told them. See OPS-7.
  it('shows the cost and the lifetime, and shows them before it asks', async () => {
    let shownWhenAsked = '';
    const result = await run({
      envPath,
      confirm: async () => {
        shownWhenAsked = capture();
        return true;
      },
    });

    // Asserted against what was on screen AT THE MOMENT OF THE PROMPT, not against the whole run.
    // Matching the full output cannot tell a quote printed before the question from one printed
    // after the money is gone, and both tests here are named for the ordering.
    assert.match(
      shownWhenAsked,
      new RegExp(`Cost: ${TEST_BATCH_COST_BZZ} BZZ`),
      'the cost was not shown before asking',
    );
    assert.match(
      shownWhenAsked,
      new RegExp(`Lasts for: ${TEST_BATCH_DURATION}`),
      'the lifetime was not shown before asking',
    );
    assert.equal(result.exitCode, undefined);
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

  // Same ordering on this command: the writability check comes first, so a run that was going to
  // refuse never asks. And the affordability refusal comes before the prompt for the same reason.
  it('does not ask when the batch id could not have been recorded anyway', async () => {
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');
    chmodSync(envPath, 0o400);
    let asked = 0;

    const result = await run({
      envPath,
      confirm: async () => {
        asked += 1;
        return true;
      },
    });

    assert.equal(asked, 0, 'the operator was asked to approve a purchase this run then refused');
    assert.equal(result.spends, 0);
    assert.equal(result.exitCode, 1);
  });

  // The affordability refusal `stamp:setup` has, on the command that had no guard at all. Showing a
  // cost the wallet cannot pay and then asking to confirm it is OPS-5's harm with a prompt in front.
  it('refuses a batch the wallet cannot pay for, without asking', async () => {
    let asked = 0;
    const result = await run({
      envPath,
      createBee: () =>
        ({
          getChainState: async () => CHAIN_STATE,
          getWalletBalance: async () => ({ bzzBalance: BZZ.fromPLUR(1n) }),
        } as unknown as Bee),
      confirm: async () => {
        asked += 1;
        return true;
      },
    });

    assert.equal(asked, 0, 'the operator was asked to approve a batch the node cannot pay for');
    assert.equal(result.spends, 0);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /would fail on chain/);
  });

  it('spends when the wallet can pay', async () => {
    const result = await run({
      envPath,
      createBee: () =>
        ({
          getChainState: async () => CHAIN_STATE,
          getWalletBalance: async () => ({ bzzBalance: BZZ.fromPLUR(TEST_BATCH_COST_PLUR) }),
        } as unknown as Bee),
    });

    assert.equal(result.spends, 1, 'a wallet holding exactly the price was refused');
    assert.equal(result.exitCode, undefined);
  });

  // A node that cannot report a balance is not a reason to block a command that never promised to
  // check one. It warns and lets the operator decide, which is different from checking and passing.
  it('warns but still offers the purchase when the balance cannot be read', async () => {
    const result = await run({
      envPath,
      createBee: () =>
        ({
          getChainState: async () => CHAIN_STATE,
          getWalletBalance: async () => {
            throw new Error('json-rpc: connection refused');
          },
        } as unknown as Bee),
    });

    assert.equal(result.spends, 1);
    assert.match(result.output, /Could not check the wallet balance/);
  });

  it('does not spend when the confirmation is declined', async () => {
    const result = await run({ envPath, confirm: async () => false });

    assert.equal(result.spends, 0, 'a declined confirmation still bought a stamp');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /No money has been spent/);
    assert.equal(existsSync(envPath), false, 'an aborted buy must not touch .env');
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

  // A node with no working chain RPC can still sell a batch, so a missing TTL must not stop the
  // purchase. It must also not be shown as a blank or a zero, which reads as "expires immediately".
  it('still buys when the chain price is unavailable, and says why the lifetime is unknown', async () => {
    const result = await run({
      envPath,
      createBee: () =>
        ({
          getChainState: async () => {
            throw new Error('json-rpc: connection refused');
          },
        } as unknown as Bee),
    });

    assert.equal(result.spends, 1, 'an unreadable chain price blocked a purchase it has no bearing on');
    assert.match(
      result.output,
      new RegExp(`Cost: ${TEST_BATCH_COST_BZZ} BZZ`),
      'the cost needs no chain call and must still be shown',
    );
    assert.match(result.output, /connection refused/, 'an unknown lifetime was shown without saying why');
  });
});

describe('stampBuy on a configured ladder, finding 21: the rung is not optional', () => {
  const LADDER = `360p@http://n1:1633<${'1'.repeat(64)}> 1080p@http://n2:1633<${'4'.repeat(64)}>`;
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = workspace();
    envPath = join(dir, '.env');
    process.env.BEE_PUBLISHERS = LADDER;
  });

  afterEach(() => {
    delete process.env.BEE_PUBLISHERS;
  });

  // A batch can only be spent by the node that bought it, so a bare buy on a split deployment has no
  // rung to land on. Falling back to the single-node uploader would fund a node no rung publishes
  // through, and the batch would sit there while a rung quietly stopped. It must fail before it ever
  // reaches the chain, which is exactly what the command's docstring promises.
  it('refuses a buy with no --rung, before contacting any node', async () => {
    let beeMade = 0;
    const result = await run({
      envPath,
      createBee: () => {
        beeMade += 1;
        return { getChainState: async () => CHAIN_STATE } as unknown as Bee;
      },
    });

    assert.equal(beeMade, 0, 'a node was contacted before the missing rung was caught');
    assert.equal(result.spends, 0, 'a stamp was bought on a ladder with no rung named');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Which rung\?/);
  });

  // The positive control: naming a rung still buys, and routes to that rung's node rather than being
  // over-refused by the guard above.
  it('buys on the named rung when one is given', async () => {
    const result = await run({
      envPath,
      rung: '1080p',
      createBee: () =>
        ({
          getChainState: async () => CHAIN_STATE,
          getWalletBalance: async () => ({ bzzBalance: BZZ.fromPLUR(TEST_BATCH_COST_PLUR) }),
        } as unknown as Bee),
    });

    assert.equal(result.spends, 1);
    assert.equal(result.exitCode, undefined);
    assert.match(result.output, /rung 1080p \(http:\/\/n2:1633\)/);
  });
});
