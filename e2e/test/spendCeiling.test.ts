import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  availablePlur,
  ledgerRefusal,
  parseSpendLedger,
  readSpendLedger,
  spendAgainstCeiling,
  spendRefusal,
  spendSummary,
} from '../src/harness/spendCeiling.js';

/**
 * The gate that stops `pnpm e2e:run` spending past what the owner authorised.
 *
 * Every run against the deployed stack costs real BZZ in postage and bandwidth, and until this
 * existed the only thing holding a run to its authorisation was an operator remembering the number.
 * `deploy/scripts/spend-ceiling.sh` already refuses a bench sitting on the same ledger, so the rules
 * pinned here are that gate's, restated for the suite: `availableBalance` per node against its
 * baseline, a rise clamped to zero, and a missing ledger refused rather than read as unlimited.
 *
 * The arithmetic is in BigInt because a chequebook balance in PLUR is past 2^53, and several cases
 * below use values that would round if anything on the path touched a `number`.
 */

const PLUR_PER_BZZ = 10n ** 16n;

/** BZZ written in thousandths, so every fixture below is an exact integer rather than a float. */
function bzzMilli(thousandths: bigint): bigint {
  return thousandths * (PLUR_PER_BZZ / 1000n);
}

const FULL_LEDGER: Record<string, string> = {
  authorised_at: '2026-08-28T20:45:00Z',
  ceiling_plur: String(bzzMilli(2400n)),
  uploader_start_plur: String(bzzMilli(3000n)),
  gateway_start_plur: String(bzzMilli(1000n)),
};

/** The ledger as the owner writes it. An override of `undefined` means that line is absent. */
function ledgerText(overrides: Record<string, string | undefined> = {}): string {
  const lines = Object.entries({ ...FULL_LEDGER, ...overrides })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return ['# the night of 2026-08-28, authorised by the owner', ...lines, ''].join('\n');
}

const LEDGER = parseSpendLedger(ledgerText())!;

describe('reading the owner authorisation out of the ledger', () => {
  it('reads the four fields a run is authorised by', () => {
    const ledger = parseSpendLedger(ledgerText());

    assert.deepEqual(ledger, {
      authorisedAt: '2026-08-28T20:45:00Z',
      ceilingPlur: bzzMilli(2400n),
      uploaderStartPlur: bzzMilli(3000n),
      gatewayStartPlur: bzzMilli(1000n),
    });
  });

  it('skips comment and blank lines, which is how the owner annotates the night', () => {
    const annotated = `\n# 2.4 BZZ for the ladder sitting\n\n${ledgerText()}\n# nothing after this\n`;

    assert.equal(parseSpendLedger(annotated)?.ceilingPlur, bzzMilli(2400n));
  });

  /**
   * A balance in PLUR is around 1e16, which is past 2^53. Read through a `number` at any point on
   * this path and the last digits are gone, so the spend below it is a rounded figure presented as
   * an exact one.
   */
  it('keeps a balance past 2^53 exactly', () => {
    const exact = '30000000000000001';

    assert.equal(parseSpendLedger(ledgerText({ uploader_start_plur: exact }))?.uploaderStartPlur, BigInt(exact));
  });

  /**
   * The shell gate reads each field with `sed ... | head -1`, so the FIRST line wins there. An
   * operator who re-authorises by appending a new ceiling to the bottom of the file would otherwise
   * get one number from the bench gate and a different one from this suite, on the same ledger.
   */
  it('takes the first spelling of a key, the way the shell gate does', () => {
    const appended = `${ledgerText()}ceiling_plur=${bzzMilli(9000n)}\n`;

    assert.equal(parseSpendLedger(appended)?.ceilingPlur, bzzMilli(2400n));
  });

  it('refuses a ledger that is not there at all, because an unledgered run is not authorised', () => {
    assert.equal(parseSpendLedger(null), null);
  });

  /** A missing ceiling is not an unlimited one, which is the whole reason this reads as a refusal. */
  it('refuses a ledger naming no ceiling', () => {
    assert.equal(parseSpendLedger(ledgerText({ ceiling_plur: undefined })), null);
  });

  it('refuses a ledger missing either start balance, since that node cost is then unknown', () => {
    assert.equal(parseSpendLedger(ledgerText({ uploader_start_plur: undefined })), null);
    assert.equal(parseSpendLedger(ledgerText({ gateway_start_plur: undefined })), null);
  });

  it('refuses a ledger with no authorisation time, so a run can always be dated to a decision', () => {
    assert.equal(parseSpendLedger(ledgerText({ authorised_at: undefined })), null);
  });

  it('refuses a non-numeric or negative amount rather than reading it as zero', () => {
    for (const bad of ['', 'lots', '2.4', '-1', '2400000 BZZ']) {
      assert.equal(parseSpendLedger(ledgerText({ ceiling_plur: bad })), null, `accepted ceiling_plur=${bad}`);
    }
  });
});

describe('the refusal an unledgered run gets', () => {
  const PATH = '/repo/.spend-ledger.env';

  it('names the file, so the operator knows where the authorisation goes', () => {
    assert.match(ledgerRefusal(PATH, null), /\/repo\/\.spend-ledger\.env/);
  });

  it('names all four keys, so the file can be written from the message alone', () => {
    const refusal = ledgerRefusal(PATH, null);

    for (const key of ['authorised_at', 'ceiling_plur', 'uploader_start_plur', 'gateway_start_plur']) {
      assert.match(refusal, new RegExp(key), `the refusal does not name ${key}`);
    }
  });

  it('says the owner is the one who authorises a run by writing it', () => {
    assert.match(ledgerRefusal(PATH, null), /owner/i);
  });

  /**
   * A present but incomplete ledger and an absent one are different mistakes, and the second is the
   * one an operator makes at 2am. Saying which key is missing turns a re-read of the whole format
   * into a one-line edit.
   */
  it('names the key that is missing when the ledger exists but is short one', () => {
    const refusal = ledgerRefusal(PATH, ledgerText({ gateway_start_plur: undefined }));

    assert.match(refusal, /does not name[^\n]*gateway_start_plur/);
    assert.doesNotMatch(refusal, /no spend ledger/i);
  });

  it('says the ledger is absent when there is no file, rather than listing every key as missing', () => {
    assert.match(ledgerRefusal(PATH, null), /no spend ledger/i);
  });
});

describe('reading a chequebook balance off the wire', () => {
  /**
   * ⚠️ `availableBalance`, never `totalBalance`. The two move on different events: writing a cheque
   * drops available and leaves total, and a peer cashing an old cheque drops total and leaves
   * available. A gate reading total would count a neighbour's cashing as this run's spend.
   */
  it('takes availableBalance and not totalBalance', () => {
    const body = { totalBalance: '9000000000000000000', availableBalance: '30000000000000000' };

    assert.equal(availablePlur(body, 'uploader'), 30000000000000000n);
  });

  it('keeps a balance past 2^53 exactly', () => {
    assert.equal(availablePlur({ availableBalance: '30000000000000001' }, 'uploader'), 30000000000000001n);
  });

  /**
   * ⛔ An unreadable chequebook is not zero spend. A node mid-restart answers its own JSON error
   * envelope, which parses fine and holds no balance, and reading that as zero would hand the run a
   * clean bill of health from a node that cannot be measured at all.
   */
  it('refuses an error envelope from a node that is not answering properly', () => {
    assert.throws(() => availablePlur({ code: 503, message: 'Node is syncing' }, 'gateway'), /gateway/);
  });

  it('refuses a balance that is not an integer, rather than reading it as zero', () => {
    for (const bad of [{ availableBalance: '' }, { availableBalance: '1.5' }, { availableBalance: 3 }, null]) {
      assert.throws(() => availablePlur(bad, 'uploader'), /uploader/, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe('what this run has already cost, against the authorisation', () => {
  it('sums what both nodes have spent since the ledger was written', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: bzzMilli(2700n),
      gatewayPlur: bzzMilli(800n),
    });

    assert.equal(verdict.spentPlur, bzzMilli(500n));
    assert.equal(verdict.remainingPlur, bzzMilli(1900n));
    assert.equal(verdict.withinCeiling, true);
  });

  it('counts nothing spent on a run that has not started', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: bzzMilli(3000n),
      gatewayPlur: bzzMilli(1000n),
    });

    assert.equal(verdict.spentPlur, 0n);
    assert.equal(verdict.withinCeiling, true);
  });

  /**
   * The clamp, and the reason for it. Summing signed deltas would let a deposit on one node pay for
   * an overrun on the other, which is not what an authorisation of a total means. Here the gateway
   * gained 12 BZZ while the uploader really did spend 0.5, and a signed sum would report 11.5 BZZ of
   * headroom that nobody authorised.
   */
  it('clamps a node whose balance rose, so a deposit cannot fund an overrun on the other', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: bzzMilli(2500n),
      gatewayPlur: bzzMilli(13000n),
    });

    assert.equal(verdict.spentPlur, bzzMilli(500n));
    assert.deepEqual(verdict.rose, ['gateway']);
  });

  it('names both nodes when both rose', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: bzzMilli(9000n),
      gatewayPlur: bzzMilli(9000n),
    });

    assert.equal(verdict.spentPlur, 0n);
    assert.deepEqual(verdict.rose, ['uploader', 'gateway']);
  });

  it('leaves rose empty when neither node gained, which is the ordinary run', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: bzzMilli(2900n),
      gatewayPlur: bzzMilli(900n),
    });

    assert.deepEqual(verdict.rose, []);
  });

  /**
   * Refusing at exactly the ceiling rather than past it. The alternative admits a run that starts
   * with nothing left to spend, which then overruns by whatever the run itself costs.
   */
  it('refuses a run that has already spent the ceiling exactly', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: bzzMilli(600n),
      gatewayPlur: bzzMilli(1000n),
    });

    assert.equal(verdict.spentPlur, bzzMilli(2400n));
    assert.equal(verdict.remainingPlur, 0n);
    assert.equal(verdict.withinCeiling, false);
  });

  it('admits a run one PLUR under the ceiling', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: bzzMilli(600n) + 1n,
      gatewayPlur: bzzMilli(1000n),
    });

    assert.equal(verdict.remainingPlur, 1n);
    assert.equal(verdict.withinCeiling, true);
  });

  it('reports an overrun as a negative remainder rather than wrapping it', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: 0n,
      gatewayPlur: bzzMilli(1000n),
    });

    assert.equal(verdict.spentPlur, bzzMilli(3000n));
    assert.equal(verdict.remainingPlur, -bzzMilli(600n));
    assert.equal(verdict.withinCeiling, false);
  });

  it('keeps single-PLUR precision on balances past 2^53', () => {
    const verdict = spendAgainstCeiling(LEDGER, {
      uploaderPlur: bzzMilli(3000n) - 1n,
      gatewayPlur: bzzMilli(1000n),
    });

    assert.equal(verdict.spentPlur, 1n);
  });
});

describe('what the run prints about its own spend', () => {
  it('states spent, ceiling and remaining in BZZ to three decimals', () => {
    const summary = spendSummary(
      spendAgainstCeiling(LEDGER, { uploaderPlur: bzzMilli(2518n), gatewayPlur: bzzMilli(1000n) }),
    );

    assert.match(summary, /0\.482/);
    assert.match(summary, /2\.400/);
    assert.match(summary, /1\.918/);
  });

  /** Truncated rather than rounded, so this reads the same as `spend_bzz` in the shell gate. */
  it('truncates the fourth decimal instead of rounding it up', () => {
    const summary = spendSummary(
      spendAgainstCeiling(LEDGER, { uploaderPlur: bzzMilli(3000n) - 9_999_999_999_999n, gatewayPlur: bzzMilli(1000n) }),
    );

    assert.match(summary, /0\.000 BZZ spent/);
  });

  /**
   * An overrun has to read as an overrun. BigInt division truncates toward zero, so formatting the
   * signed value directly would print -0.6 BZZ of remaining headroom as "0.-600" or as "0.600",
   * either of which reads like there is room left.
   */
  it('prints a negative remainder with its sign', () => {
    const summary = spendSummary(spendAgainstCeiling(LEDGER, { uploaderPlur: 0n, gatewayPlur: bzzMilli(1000n) }));

    assert.match(summary, /-0\.600 BZZ remaining/);
  });

  /**
   * The three figures and nothing else. A rise refuses rather than passing with a caveat attached,
   * so this line is only ever printed by a run whose spend really was measurable, and a deposit
   * note on it would describe a state the printing path cannot be in.
   */
  it('carries no deposit caveat, because a run that saw a deposit never reaches this line', () => {
    const summary = spendSummary(
      spendAgainstCeiling(LEDGER, { uploaderPlur: bzzMilli(2500n), gatewayPlur: bzzMilli(13000n) }),
    );

    assert.doesNotMatch(summary, /deposit/i);
  });
});

describe('why a run is refused, or is not', () => {
  const PATH = '/repo/.spend-ledger.env';

  function refusalFor(uploaderPlur: bigint, gatewayPlur: bigint): string | null {
    return spendRefusal(spendAgainstCeiling(LEDGER, { uploaderPlur, gatewayPlur }), PATH);
  }

  it('lets an ordinary run through', () => {
    assert.equal(refusalFor(bzzMilli(2900n), bzzMilli(900n)), null);
  });

  it('lets a run that has not started through', () => {
    assert.equal(refusalFor(bzzMilli(3000n), bzzMilli(1000n)), null);
  });

  describe('past the ceiling', () => {
    it('carries the same spent, ceiling and remaining the passing run prints', () => {
      const refusal = String(refusalFor(0n, bzzMilli(1000n)));

      assert.match(refusal, /3\.000 BZZ spent/);
      assert.match(refusal, /2\.400/);
      assert.match(refusal, /-0\.600 BZZ remaining/);
    });

    it('names the ledger, because raising the ceiling means editing that file', () => {
      assert.match(String(refusalFor(0n, bzzMilli(1000n))), /\/repo\/\.spend-ledger\.env/);
    });

    it('says nothing was spent by the refusal itself', () => {
      assert.match(String(refusalFor(0n, bzzMilli(1000n))), /[Nn]othing has been run/);
    });
  });

  /**
   * ⛔⛔⛔ A rise refuses, and this is the estate's own learned position rather than a preference.
   * `availableBalance` has no way up other than a deposit, so a rise means the ledger's start
   * balances predate money arriving, and spend measured from them is not smaller, it is unknown.
   *
   * On 2026-08-14 a 12 BZZ deposit into the gateway turned that node's 0.5406 BZZ of real spend into
   * a clamped zero. The uploader was topped up minutes later, which would have taken the printed
   * total to 0.000 BZZ against a ceiling 1.98 of which was already gone. A note beside the number
   * would not have stopped that. `deploy/scripts/spend-ceiling.sh` refuses for the same reason, and
   * the two gates now agree.
   */
  describe('after a deposit', () => {
    it('refuses even though the ceiling arithmetic is nowhere near it', () => {
      const verdict = spendAgainstCeiling(LEDGER, { uploaderPlur: bzzMilli(2500n), gatewayPlur: bzzMilli(13000n) });

      assert.equal(verdict.withinCeiling, true, 'the ceiling is not what should stop this run');
      assert.notEqual(spendRefusal(verdict, PATH), null);
    });

    it('names the node the deposit landed on', () => {
      assert.match(String(refusalFor(bzzMilli(2500n), bzzMilli(13000n))), /gateway/);
    });

    it('names both nodes when both gained', () => {
      const refusal = String(refusalFor(bzzMilli(9000n), bzzMilli(9000n)));

      assert.match(refusal, /uploader/);
      assert.match(refusal, /gateway/);
    });

    it('says a deposit landed, which is the fact the operator has to act on', () => {
      assert.match(String(refusalFor(bzzMilli(2500n), bzzMilli(13000n))), /deposit/i);
    });

    /** The reason this is fatal rather than cosmetic: the recorded starts no longer measure anything. */
    it('says spend can no longer be measured against the recorded starts', () => {
      const refusal = String(refusalFor(bzzMilli(2500n), bzzMilli(13000n)));

      assert.match(refusal, /no longer be measured/);
      assert.match(refusal, /start/);
    });

    /**
     * A fresh ledger with new starts, which is the established workflow and is exactly what happened
     * on 2026-08-28. Telling the operator to raise a ceiling here would be wrong advice: the ceiling
     * is not what refused.
     */
    it('tells the owner to re-authorise with a fresh ledger and new start balances', () => {
      const refusal = String(refusalFor(bzzMilli(2500n), bzzMilli(13000n)));

      assert.match(refusal, /\/repo\/\.spend-ledger\.env/);
      assert.match(refusal, /fresh/i);
      assert.match(refusal, /owner/i);
    });

    /**
     * A deposit outranks an overrun. Both are true here, and the ceiling message would tell the
     * operator to raise a number, when the actual state is that the figure it would be raised
     * against cannot be trusted.
     */
    it('reports the deposit rather than the overrun when a run is both', () => {
      const refusal = String(refusalFor(0n, bzzMilli(13000n)));

      assert.match(refusal, /deposit/i);
      assert.doesNotMatch(refusal, /would spend past/);
    });

    it('says nothing was spent by the refusal itself', () => {
      assert.match(String(refusalFor(bzzMilli(2500n), bzzMilli(13000n))), /[Nn]othing has been run/);
    });

    /**
     * ⛔ No spend figure at all. Printing one would hand a reader a number to act on in the one case
     * where the number is not knowable, and a clamped total reads exactly like a measured one.
     */
    it('quotes no spend total, because the whole point is that the total is unknown', () => {
      assert.doesNotMatch(String(refusalFor(bzzMilli(2500n), bzzMilli(13000n))), /BZZ spent/);
    });
  });
});

describe('finding the ledger on disk', () => {
  const roots: string[] = [];

  after(() => {
    for (const dir of roots) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-spend-'));
    roots.push(dir);
    return dir;
  }

  it('reads the ledger the owner wrote', () => {
    const path = join(tempRoot(), '.spend-ledger.env');
    writeFileSync(path, ledgerText());

    assert.equal(parseSpendLedger(readSpendLedger(path))?.ceilingPlur, bzzMilli(2400n));
  });

  /**
   * Null rather than an empty string, and never a thrown ENOENT. A missing ledger is the case this
   * gate exists for, so it has to arrive at the refusal as itself: an empty string would be read as
   * a ledger naming no keys, and a raw ENOENT would fail the run with a stack trace instead of the
   * sentence telling the owner what to write.
   */
  it('reads a ledger that is not there as null, not as an empty one', () => {
    assert.equal(readSpendLedger(join(tempRoot(), '.spend-ledger.env')), null);
  });
});
