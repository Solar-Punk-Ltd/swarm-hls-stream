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

/** The two ports the cases below are written against: a publisher node and the gateway. */
const UPLOADER_PORT = '10075';
const GATEWAY_PORT = '10077';

const FULL_LEDGER: Record<string, string> = {
  authorised_at: '2026-08-28T20:45:00Z',
  ceiling_plur: String(bzzMilli(2400n)),
  [`node_${UPLOADER_PORT}_start_plur`]: String(bzzMilli(3000n)),
  [`node_${GATEWAY_PORT}_start_plur`]: String(bzzMilli(1000n)),
};

/** The ledger as the owner writes it. An override of `undefined` means that line is absent. */
function ledgerText(overrides: Record<string, string | undefined> = {}): string {
  const lines = Object.entries({ ...FULL_LEDGER, ...overrides })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return ['# the night of 2026-08-28, authorised by the owner', ...lines, ''].join('\n');
}

const LEDGER = parseSpendLedger(ledgerText())!;

/**
 * The reading for a two-node stage, which is what these cases describe.
 *
 * Every node that can spend has to appear, in both directions: a reading with no baseline and a
 * baseline with no reading are both refused, so a helper that quietly dropped one would be writing
 * the gate's own blind spot into its tests.
 */
function readings(uploaderPlur: bigint, gatewayPlur: bigint) {
  return [
    { port: UPLOADER_PORT, who: 'uploader', plur: uploaderPlur },
    { port: GATEWAY_PORT, who: 'gateway', plur: gatewayPlur },
  ];
}

describe('reading the owner authorisation out of the ledger', () => {
  it('reads the ceiling, the time and one baseline per node', () => {
    const ledger = parseSpendLedger(ledgerText());

    assert.deepEqual(ledger, {
      authorisedAt: '2026-08-28T20:45:00Z',
      ceilingPlur: bzzMilli(2400n),
      startsByPort: new Map([
        [UPLOADER_PORT, bzzMilli(3000n)],
        [GATEWAY_PORT, bzzMilli(1000n)],
      ]),
    });
  });

  /**
   * ⛔⛔⛔ The regression that made this file's fixtures grow a port. The gate read exactly two
   * chequebooks, so when the publisher became one Bee node per ABR rung on 2026-08-31 the three new
   * nodes spent unwatched while holding 5.00 BZZ each. A ledger has to be able to carry however many
   * nodes the deployment has.
   */
  it('reads a baseline for every node, not a fixed pair', () => {
    const five = parseSpendLedger(
      ledgerText({
        node_11071_start_plur: String(bzzMilli(5000n)),
        node_11073_start_plur: String(bzzMilli(5000n)),
        node_11075_start_plur: String(bzzMilli(5000n)),
      }),
    );

    assert.equal(five?.startsByPort.size, 5);
    assert.equal(five?.startsByPort.get('11073'), bzzMilli(5000n));
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

    assert.equal(
      parseSpendLedger(ledgerText({ [`node_${UPLOADER_PORT}_start_plur`]: exact }))?.startsByPort.get(UPLOADER_PORT),
      BigInt(exact),
    );
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

  /**
   * ⛔ Zero baselines is a fault rather than an authorisation covering nothing. It would make the
   * spend total zero on every run, which reads exactly like a night that cost nothing. A ledger
   * naming SOME of the nodes is caught later, by the coverage check, which needs the live node set.
   */
  it('refuses a ledger with no start balance for any node at all', () => {
    const bare = parseSpendLedger(
      ledgerText({
        [`node_${UPLOADER_PORT}_start_plur`]: undefined,
        [`node_${GATEWAY_PORT}_start_plur`]: undefined,
      }),
    );

    assert.equal(bare, null);
  });

  it('refuses a ledger whose start balance is not a plain PLUR integer', () => {
    for (const bad of ['', 'lots', '2.4', '-1']) {
      assert.equal(
        parseSpendLedger(ledgerText({ [`node_${UPLOADER_PORT}_start_plur`]: bad })),
        null,
        `accepted a start balance of ${bad}`,
      );
    }
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

  it('names every key, so the file can be written from the message alone', () => {
    const refusal = ledgerRefusal(PATH, null);

    for (const key of ['authorised_at', 'ceiling_plur', 'node_<port>_start_plur']) {
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
    const refusal = ledgerRefusal(PATH, ledgerText({ ceiling_plur: undefined }));

    assert.match(refusal, /does not name[^\n]*ceiling_plur/);
    assert.doesNotMatch(refusal, /no spend ledger/i);
  });

  /** A baseline that is present and unusable names its own key, port and all, so the edit is one line. */
  it('names the node whose start balance it cannot read', () => {
    const refusal = ledgerRefusal(PATH, ledgerText({ [`node_${GATEWAY_PORT}_start_plur`]: 'lots' }));

    assert.match(refusal, new RegExp(`does not name[^\n]*node_${GATEWAY_PORT}_start_plur`));
  });

  /** A ledger naming no node at all cannot say which node is missing, so it names the shape instead. */
  it('names the line shape when the ledger baselines nothing', () => {
    const refusal = ledgerRefusal(
      PATH,
      ledgerText({
        [`node_${UPLOADER_PORT}_start_plur`]: undefined,
        [`node_${GATEWAY_PORT}_start_plur`]: undefined,
      }),
    );

    assert.match(refusal, /node_<port>_start_plur/);
  });

  it('points at the script that writes the baselines, since they are read off the nodes', () => {
    assert.match(ledgerRefusal(PATH, null), /spend-ledger\.sh --authorise=/);
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
    const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(2700n), bzzMilli(800n)));

    assert.equal(verdict.spentPlur, bzzMilli(500n));
    assert.equal(verdict.remainingPlur, bzzMilli(1900n));
    assert.equal(verdict.withinCeiling, true);
  });

  it('counts nothing spent on a run that has not started', () => {
    const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(3000n), bzzMilli(1000n)));

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
    const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(2500n), bzzMilli(13000n)));

    assert.equal(verdict.spentPlur, bzzMilli(500n));
    assert.deepEqual(verdict.rose, ['gateway']);
  });

  it('names both nodes when both rose', () => {
    const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(9000n), bzzMilli(9000n)));

    assert.equal(verdict.spentPlur, 0n);
    assert.deepEqual(verdict.rose, ['uploader', 'gateway']);
  });

  it('leaves rose empty when neither node gained, which is the ordinary run', () => {
    const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(2900n), bzzMilli(900n)));

    assert.deepEqual(verdict.rose, []);
  });

  /**
   * Refusing at exactly the ceiling rather than past it. The alternative admits a run that starts
   * with nothing left to spend, which then overruns by whatever the run itself costs.
   */
  it('refuses a run that has already spent the ceiling exactly', () => {
    const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(600n), bzzMilli(1000n)));

    assert.equal(verdict.spentPlur, bzzMilli(2400n));
    assert.equal(verdict.remainingPlur, 0n);
    assert.equal(verdict.withinCeiling, false);
  });

  it('admits a run one PLUR under the ceiling', () => {
    const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(600n) + 1n, bzzMilli(1000n)));

    assert.equal(verdict.remainingPlur, 1n);
    assert.equal(verdict.withinCeiling, true);
  });

  it('reports an overrun as a negative remainder rather than wrapping it', () => {
    const verdict = spendAgainstCeiling(LEDGER, readings(0n, bzzMilli(1000n)));

    assert.equal(verdict.spentPlur, bzzMilli(3000n));
    assert.equal(verdict.remainingPlur, -bzzMilli(600n));
    assert.equal(verdict.withinCeiling, false);
  });

  it('keeps single-PLUR precision on balances past 2^53', () => {
    const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(3000n) - 1n, bzzMilli(1000n)));

    assert.equal(verdict.spentPlur, 1n);
  });
});

describe('what the run prints about its own spend', () => {
  it('states spent, ceiling and remaining in BZZ to three decimals', () => {
    const summary = spendSummary(spendAgainstCeiling(LEDGER, readings(bzzMilli(2518n), bzzMilli(1000n))));

    assert.match(summary, /0\.482/);
    assert.match(summary, /2\.400/);
    assert.match(summary, /1\.918/);
  });

  /** Truncated rather than rounded, so this reads the same as `spend_bzz` in the shell gate. */
  it('truncates the fourth decimal instead of rounding it up', () => {
    const summary = spendSummary(
      spendAgainstCeiling(LEDGER, readings(bzzMilli(3000n) - 9_999_999_999_999n, bzzMilli(1000n))),
    );

    assert.match(summary, /0\.000 BZZ spent/);
  });

  /**
   * An overrun has to read as an overrun. BigInt division truncates toward zero, so formatting the
   * signed value directly would print -0.6 BZZ of remaining headroom as "0.-600" or as "0.600",
   * either of which reads like there is room left.
   */
  it('prints a negative remainder with its sign', () => {
    const summary = spendSummary(spendAgainstCeiling(LEDGER, readings(0n, bzzMilli(1000n))));

    assert.match(summary, /-0\.600 BZZ remaining/);
  });

  /**
   * The three figures and nothing else. A rise refuses rather than passing with a caveat attached,
   * so this line is only ever printed by a run whose spend really was measurable, and a deposit
   * note on it would describe a state the printing path cannot be in.
   */
  it('carries no deposit caveat, because a run that saw a deposit never reaches this line', () => {
    const summary = spendSummary(spendAgainstCeiling(LEDGER, readings(bzzMilli(2500n), bzzMilli(13000n))));

    assert.doesNotMatch(summary, /deposit/i);
  });
});

describe('why a run is refused, or is not', () => {
  const PATH = '/repo/.spend-ledger.env';

  function refusalFor(uploaderPlur: bigint, gatewayPlur: bigint): string | null {
    return spendRefusal(spendAgainstCeiling(LEDGER, readings(uploaderPlur, gatewayPlur)), PATH);
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
      const verdict = spendAgainstCeiling(LEDGER, readings(bzzMilli(2500n), bzzMilli(13000n)));

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

describe('every node that can spend, in both directions', () => {
  const PATH = '/repo/.spend-ledger.env';

  /** The five-node stage as it stands after the rung split: four publishers and a gateway. */
  function splitStage(uploaderPlur: bigint) {
    return [
      { port: UPLOADER_PORT, who: '360p publisher', plur: uploaderPlur },
      { port: '11071', who: '480p publisher', plur: bzzMilli(5000n) },
      { port: '11073', who: '720p publisher', plur: bzzMilli(5000n) },
      { port: '11075', who: '1080p publisher', plur: bzzMilli(5000n) },
      { port: GATEWAY_PORT, who: 'gateway', plur: bzzMilli(1000n) },
    ];
  }

  /**
   * ⛔⛔⛔ The defect this whole change exists for, as a test that fails against the old gate.
   *
   * On 2026-08-31 the publisher became one Bee node per ABR rung. The ledger baselined two
   * chequebooks, three new nodes joined holding 5.00 BZZ each, and the gate went on summing the two
   * it knew about and passing. It did not report a smaller number, it reported a different quantity,
   * with nothing anywhere saying so.
   */
  it('refuses a two-node ledger once the stage has five nodes', () => {
    const verdict = spendAgainstCeiling(LEDGER, splitStage(bzzMilli(3000n)));

    assert.deepEqual(verdict.unbaselined, [
      '480p publisher on 11071',
      '720p publisher on 11073',
      '1080p publisher on 11075',
    ]);
    assert.equal(spendRefusal(verdict, PATH)?.includes('480p publisher on 11071'), true);
  });

  /** ⛔ And it quotes no total, for the reason the deposit refusal quotes none: a partial sum reads like a whole one. */
  it('quotes no spend figure when it cannot cover every node', () => {
    const refusal = spendRefusal(spendAgainstCeiling(LEDGER, splitStage(bzzMilli(2000n))), PATH);

    assert.doesNotMatch(refusal ?? '', /BZZ spent/);
    assert.match(refusal ?? '', /Unknown spend is not zero spend/);
  });

  /** A baselined node nothing read is the other direction, and a node that stopped answering is when to stop. */
  it('refuses a ledger baselining a node the run did not read', () => {
    const verdict = spendAgainstCeiling(LEDGER, [{ port: UPLOADER_PORT, who: 'uploader', plur: bzzMilli(3000n) }]);

    assert.deepEqual(verdict.unread, [GATEWAY_PORT]);
    assert.match(spendRefusal(verdict, PATH) ?? '', new RegExp(`port ${GATEWAY_PORT}`));
  });

  /**
   * Order is load-bearing. A run with an unbaselined node AND a deposit has no measurable spend for
   * either reason, and the deposit message would send the operator to rewrite start balances without
   * telling them the node set changed too.
   */
  it('reports missing coverage ahead of a deposit', () => {
    const verdict = spendAgainstCeiling(LEDGER, splitStage(bzzMilli(9000n)));

    assert.deepEqual(verdict.rose, ['360p publisher']);
    assert.match(spendRefusal(verdict, PATH) ?? '', /cannot be measured against the authorisation/);
  });

  /** And ahead of an overrun, which is the same argument: the total it would quote is not the total. */
  it('reports missing coverage ahead of an overrun', () => {
    const verdict = spendAgainstCeiling(LEDGER, splitStage(0n));

    assert.equal(verdict.withinCeiling, false);
    assert.match(spendRefusal(verdict, PATH) ?? '', /cannot be measured against the authorisation/);
  });

  /** Exact coverage passes, which is what makes the two refusals above falsifiable. */
  it('passes when the ledger baselines exactly the nodes that were read', () => {
    const ledger = parseSpendLedger(
      ledgerText({
        node_11071_start_plur: String(bzzMilli(5000n)),
        node_11073_start_plur: String(bzzMilli(5000n)),
        node_11075_start_plur: String(bzzMilli(5000n)),
      }),
    )!;
    const verdict = spendAgainstCeiling(ledger, splitStage(bzzMilli(3000n)));

    assert.deepEqual(verdict.unbaselined, []);
    assert.deepEqual(verdict.unread, []);
    assert.equal(spendRefusal(verdict, PATH), null);
  });

  /**
   * ⛔ Two rungs can share one Bee node, and on an unsplit deployment the gateway can be that node.
   * A caller that lists the publishers and then appends the gateway hands over the same port twice,
   * and counting it twice would double that node's spend: an overrun this gate creates rather than
   * catches.
   */
  it('counts a node once when the same port is handed over twice', () => {
    const verdict = spendAgainstCeiling(LEDGER, [
      { port: UPLOADER_PORT, who: '360p publisher', plur: bzzMilli(2900n) },
      { port: UPLOADER_PORT, who: 'gateway', plur: bzzMilli(2900n) },
      { port: GATEWAY_PORT, who: 'gateway', plur: bzzMilli(1000n) },
    ]);

    // One hundred thousandths of a BZZ, not two hundred.
    assert.equal(verdict.spentPlur, bzzMilli(100n));
    assert.deepEqual(verdict.unbaselined, []);
  });

  /** Every publisher's fall is counted, not just the coordinator's. This is the arithmetic the split needed. */
  it('sums what every node spent', () => {
    const ledger = parseSpendLedger(
      ledgerText({
        node_11071_start_plur: String(bzzMilli(5000n)),
        node_11073_start_plur: String(bzzMilli(5000n)),
        node_11075_start_plur: String(bzzMilli(5000n)),
      }),
    )!;
    const verdict = spendAgainstCeiling(ledger, [
      { port: UPLOADER_PORT, who: '360p publisher', plur: bzzMilli(2900n) },
      { port: '11071', who: '480p publisher', plur: bzzMilli(4800n) },
      { port: '11073', who: '720p publisher', plur: bzzMilli(4700n) },
      { port: '11075', who: '1080p publisher', plur: bzzMilli(4400n) },
      { port: GATEWAY_PORT, who: 'gateway', plur: bzzMilli(950n) },
    ]);

    // 100 + 200 + 300 + 600 + 50 thousandths of a BZZ.
    assert.equal(verdict.spentPlur, bzzMilli(1250n));
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
