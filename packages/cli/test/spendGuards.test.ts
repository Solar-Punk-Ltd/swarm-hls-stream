import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArgs, stampArgs } from '../src/lib/args.js';
import { confirm } from '../src/lib/confirm.js';
import { resolveStampOptions } from '../src/lib/stamp.js';

/**
 * The two pieces standing between an unattended process and an on-chain spend, tested directly.
 *
 * Every other test in this package drives the confirmation through a seam, so the real `confirm` and
 * the argv that reaches it were the one part of the money path nothing exercised. Flipping the
 * no-TTY branch to `return true` and hardcoding `assumeYes: true` left the whole suite green.
 */
describe('the guards on a spend', () => {
  // Without a terminal there is nobody to ask, so the only safe answer is no. A CI job or a
  // `pnpm stamp:buy < /dev/null` would otherwise approve a purchase by having nobody at the keyboard.
  it('refuses without a TTY rather than assuming yes', async () => {
    const wasTty = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      assert.equal(await confirm('Buy this stamp?'), false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: wasTty, configurable: true });
    }
  });

  // `--yes` has to be typed. A flag that could be set any other way is not a confirmation.
  for (const argv of [['stamp-buy'], ['stamp-buy', '--yes=false'], ['stamp-buy', '--no-yes'], ['stamp-buy', '100']]) {
    it(`does not assume yes for ${JSON.stringify(argv)}`, () => {
      assert.equal(parseArgs(['node', 'cli', ...argv]).assumeYes, false);
    });
  }

  for (const flag of ['--yes', '-y']) {
    it(`assumes yes for ${flag}`, () => {
      assert.equal(parseArgs(['node', 'cli', 'stamp-buy', flag]).assumeYes, true);
    });
  }

  // pnpm requires `--` before it forwards arguments and passes the separator through. Left in argv
  // it became the amount, so `pnpm stamp:setup -- 6000000000 23` (the command the CLI README
  // documents) priced a batch of depth 6000000000 and failed inside bee-js.
  it('drops the pnpm argument separator instead of pricing it', () => {
    const parsed = stampArgs(parseArgs(['node', 'cli', 'stamp-setup', '--', '6000000000', '23']));

    assert.deepEqual({ amount: parsed.amount, depth: parsed.depth }, { amount: '6000000000', depth: 23 });
  });

  it('keeps the flags and the batch apart however they are ordered', () => {
    const parsed = stampArgs(parseArgs(['node', 'cli', 'stamp-buy', '--yes', '500', '--immutable', '21']));

    assert.deepEqual(parsed, { url: undefined, amount: '500', depth: 21, immutable: true, assumeYes: true });
  });
});

/**
 * A batch nothing downstream can price is refused where the numbers are resolved. Before this, the
 * first thing to notice was `BigInt()` inside bee-js, several calls later and inside whichever `try`
 * happened to enclose it, so a mistyped amount was reported as a fault in the operator's node.
 */
describe('batch parameters that cannot be priced', () => {
  const REJECTED: [string, string | undefined, number | undefined][] = [
    ['a non-numeric amount', 'lots', 20],
    ['a decimal amount', '1.5', 20],
    ['a negative amount', '-1', 20],
    ['a zero amount', '0', 20],
    ['the pnpm separator as the amount', '--', 20],
    ['a NaN depth', '10000000000', NaN],
    ['a depth below what a node accepts', '10000000000', 16],
    ['a wildly mistyped depth', '10000000000', 6000000000],
  ];

  for (const [name, amount, depth] of REJECTED) {
    it(`refuses ${name}, by name`, () => {
      assert.throws(() => resolveStampOptions(amount, depth, false), /Stamp (amount|depth) must be/);
    });
  }

  it('accepts the batch this project actually buys', () => {
    assert.deepEqual(resolveStampOptions('10000000000', 20, false), {
      amount: '10000000000',
      depth: 20,
      immutable: false,
    });
  });

  // The bounds are a refusal, not a preference, so both edges have to stay buyable.
  for (const depth of [17, 41]) {
    it(`accepts depth ${depth}, which is on the boundary`, () => {
      assert.equal(resolveStampOptions('10000000000', depth, false).depth, depth);
    });
  }
});
