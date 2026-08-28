/**
 * What the owner authorised this run to spend, and what it has spent already.
 *
 * ⛔⛔ A THRESHOLD WRITTEN DOWN IS NOT A CONTROL, ONLY A GATE THAT REFUSES IS.
 *
 * Every `pnpm e2e:run` against the deployed stack costs real BZZ in postage and bandwidth. The owner
 * authorises an amount, and until this existed the only thing holding a run to it was an operator
 * remembering the number at launch time. `deploy/scripts/spend-ceiling.sh` already refuses a bench
 * sitting on this same ledger, so the rules here are that gate's, restated for the suite. The two
 * read one file so two paths cannot each spend the whole allowance.
 *
 * ## What it measures spend with
 *
 * `availableBalance` per node, against what that node held when the authorisation was written.
 *
 * ⚠️ NOT `totalBalance`. The two move on different events: writing a cheque drops `available` and
 * leaves `total`, and a peer cashing a cheque already written drops `total` and leaves `available`.
 * Spending is the first of those, so a run quoting `total` would report a neighbour cashing an old
 * cheque as this run's cost.
 *
 * ⛔⛔⛔ A NODE WHOSE BALANCE ROSE ENDS THE LEDGER. IT IS NOT HEADROOM AND IT IS NOT A FOOTNOTE.
 *
 * `availableBalance` has no way up. Writing a cheque lowers it and a peer cashing one leaves it
 * alone, so a rise is a deposit, and a deposit means these start balances were written before money
 * arrived. Spend measured from baselines a deposit predates is not a smaller number, it is an
 * unknown one, and unknown spend is refused here for the same reason an unreadable chequebook is.
 *
 * On 2026-08-14 a 12 BZZ deposit into the gateway turned that node's 0.5406 BZZ of real spend into a
 * clamped zero. The uploader was topped up minutes later, which would have taken the printed total
 * to 0.000 BZZ against a ceiling 1.98 of which was already gone. A note printed beside the number
 * would not have stopped any of that, which is why this refuses instead of annotating.
 *
 * ✅ The two gates agree. `deploy/scripts/spend-ceiling.sh` refuses a bench sitting on a rise on this
 * same reasoning, and neither path will now measure a night from starts that predate a deposit. Keep
 * them in step: they read one file and answer one question.
 *
 * The per-node clamp survives underneath the refusal, and is deliberately kept rather than made
 * redundant by it. Summing signed deltas would let a top-up on one node pay for an overrun on the
 * other, so the arithmetic stays correct on its own terms even though a rise never reaches a total.
 *
 * Everything here is pure so `test/spendCeiling.test.ts` covers it under `pnpm verify`, which nothing
 * under `suites/` is. That leaves `suites/preflight/spend-ceiling.test.ts` as wiring.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../config.js';
import { parseEnvText } from '../envFile.js';

/** 1 BZZ = 1e16 PLUR. PLUR is bee's integer base unit for every balance field. */
const PLUR_PER_BZZ = 10n ** 16n;

/** Thousandths of a BZZ, which is the precision every figure below is reported at. */
const PLUR_PER_MILLI_BZZ = PLUR_PER_BZZ / 1000n;

/**
 * Where the authorisation lives, at the repository root and out of git.
 *
 * The same path the bench drivers read, and it rides the rsync to the bench host, where the repo is
 * bind-mounted at `/repo`. Resolving it from this file's own location rather than from the working
 * directory is what makes both true at once.
 */
export const SPEND_LEDGER_PATH = join(ROOT_DIR, '.spend-ledger.env');

/** The four keys an authorisation is, in the order the refusal prints them. */
const LEDGER_FIELDS = ['authorised_at', 'ceiling_plur', 'uploader_start_plur', 'gateway_start_plur'] as const;

/** What each key holds, for an operator writing the file from a refusal message alone. */
const LEDGER_FIELD_HELP: Record<(typeof LEDGER_FIELDS)[number], string> = {
  authorised_at: 'ISO timestamp of the decision',
  ceiling_plur: 'total PLUR this authorisation covers',
  uploader_start_plur: 'uploader chequebook availableBalance when it was written',
  gateway_start_plur: 'gateway chequebook availableBalance when it was written',
};

/** PLUR is an unsigned integer in every bee response, so anything else is a ledger to refuse. */
const PLUR_VALUE = /^\d+$/;

/**
 * Not exported: callers take it from {@link parseSpendLedger}'s inferred return, and exporting it
 * would add a name to the surface that nothing imports.
 */
interface SpendLedger {
  readonly authorisedAt: string;
  readonly ceilingPlur: bigint;
  readonly uploaderStartPlur: bigint;
  readonly gatewayStartPlur: bigint;
}

/** Not exported: the shape is an argument, and exporting it would add a name nothing else needs. */
interface ChequebookReading {
  readonly uploaderPlur: bigint;
  readonly gatewayPlur: bigint;
}

/**
 * Not exported: callers take it from {@link spendAgainstCeiling}'s inferred return, and exporting it
 * would add a name to the surface that nothing imports.
 */
interface SpendVerdict {
  readonly spentPlur: bigint;
  readonly ceilingPlur: bigint;
  /** Negative once a run is past the authorisation, which is how far past it is. */
  readonly remainingPlur: bigint;
  readonly withinCeiling: boolean;
  /** Nodes now holding more than their baseline, whose fall was clamped to zero. */
  readonly rose: readonly string[];
}

/** The ledger's text, or null when there is no ledger. A missing file is the case this gate is for. */
export function readSpendLedger(path: string = SPEND_LEDGER_PATH): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * The authorisation the owner wrote, or null when the file cannot be read as one.
 *
 * Partial is never returned. A ledger short a key or holding an unusable amount says nothing about
 * what was authorised, and a run measured against half an authorisation reports a number that looks
 * exactly like a measured one. `parseEnvText` does the reading so this file and the deploy scripts
 * agree about quoting, inline comments and which line wins on a repeated key.
 */
export function parseSpendLedger(text: string | null): SpendLedger | null {
  if (text === null) {
    return null;
  }
  const bag = parseEnvText(text);
  if (unusableFields(bag).length > 0) {
    return null;
  }
  return {
    authorisedAt: bag.authorised_at,
    ceilingPlur: BigInt(bag.ceiling_plur),
    uploaderStartPlur: BigInt(bag.uploader_start_plur),
    gatewayStartPlur: BigInt(bag.gateway_start_plur),
  };
}

/** The keys a ledger does not name, or names with something this cannot spend against. */
function unusableFields(bag: Readonly<Record<string, string>>): readonly string[] {
  return LEDGER_FIELDS.filter((field) => {
    const value = bag[field];
    if (value === undefined || value.trim() === '') {
      return true;
    }
    return field !== 'authorised_at' && !PLUR_VALUE.test(value);
  });
}

/**
 * Why this run is not authorised to spend, for a ledger {@link parseSpendLedger} refused.
 *
 * An absent ledger and a half-written one are different mistakes, and saying which turns a re-read
 * of the whole format into a one-line edit. Both end with the format, because the operator reading
 * this is the one who has to write the file.
 */
export function ledgerRefusal(path: string, text: string | null): string {
  const format = LEDGER_FIELDS.map((field) => `  ${field}=<${LEDGER_FIELD_HELP[field]}>`).join('\n');
  const opening =
    text === null
      ? `No spend ledger at ${path}, so nothing here is authorised to spend.`
      : `The spend ledger at ${path} does not name a usable ${unusableFields(parseEnvText(text)).join(', ')}, ` +
        'and a run cannot be measured against an authorisation it cannot read.';

  return (
    `${opening}\n` +
    'An authorisation is four lines, and the owner is the one who writes them:\n' +
    `${format}\n` +
    'Nothing has been run and nothing on the deployment was touched.'
  );
}

/**
 * One node's spendable balance out of whatever its chequebook endpoint answered.
 *
 * ⛔ Throws rather than defaulting, because an unreadable chequebook is not zero spend. A node
 * mid-restart answers its own JSON error envelope, which parses as JSON and carries no balance, and
 * a node that cannot be measured is exactly when a run should stop. `who` names it in the message,
 * since the two nodes are read the same way and a bare parse error would not say which one went.
 */
export function availablePlur(body: unknown, who: string): bigint {
  const value = (body as { availableBalance?: unknown } | null)?.availableBalance;
  if (typeof value !== 'string' || !PLUR_VALUE.test(value)) {
    return refuseUnreadableChequebook(who, body);
  }
  return BigInt(value);
}

function refuseUnreadableChequebook(who: string, body: unknown): never {
  throw new Error(
    `the ${who} chequebook did not answer with an availableBalance, and unknown spend is not zero ` +
      `spend, so this run stops here. It answered: ${JSON.stringify(body)?.slice(0, 200)}`,
  );
}

/**
 * What this run has cost so far, against what it was authorised to cost.
 *
 * Refuses at exactly the ceiling rather than past it, because a run starting with nothing left to
 * spend overruns by whatever the run itself costs.
 */
export function spendAgainstCeiling(ledger: SpendLedger, now: ChequebookReading): SpendVerdict {
  const uploader = fell(ledger.uploaderStartPlur, now.uploaderPlur);
  const gateway = fell(ledger.gatewayStartPlur, now.gatewayPlur);
  const spentPlur = uploader + gateway;

  return {
    spentPlur,
    ceilingPlur: ledger.ceilingPlur,
    remainingPlur: ledger.ceilingPlur - spentPlur,
    withinCeiling: spentPlur < ledger.ceilingPlur,
    rose: [
      ...(now.uploaderPlur > ledger.uploaderStartPlur ? ['uploader'] : []),
      ...(now.gatewayPlur > ledger.gatewayStartPlur ? ['gateway'] : []),
    ],
  };
}

/** What one node spent, with a rise counted as nothing rather than as headroom. */
function fell(startPlur: bigint, nowPlur: bigint): bigint {
  const delta = startPlur - nowPlur;
  return delta > 0n ? delta : 0n;
}

/**
 * The three figures a run reports about itself.
 *
 * Only ever printed by a run that {@link spendRefusal} let through, so it carries no caveat about
 * deposits: a run that saw one does not reach a line like this, it stops.
 */
export function spendSummary(verdict: SpendVerdict): string {
  return (
    `${plurToBzz(verdict.spentPlur)} BZZ spent of ${plurToBzz(verdict.ceilingPlur)} authorised, ` +
    `${plurToBzz(verdict.remainingPlur)} BZZ remaining.`
  );
}

/**
 * Why this run must not proceed, or null when it may, in the terms the operator has to act in.
 *
 * One entry point rather than a refusal per cause, so a caller cannot check the ceiling and forget
 * the deposit. The order inside is load-bearing and matches the shell gate's: a deposit outranks an
 * overrun, because when both are true the ceiling message would tell an operator to raise a number
 * measured against starts that no longer mean anything.
 */
export function spendRefusal(verdict: SpendVerdict, path: string): string | null {
  if (verdict.rose.length > 0) {
    return depositRefusal(verdict.rose, path);
  }
  if (!verdict.withinCeiling) {
    return (
      `This run would spend past what the owner authorised. ${spendSummary(verdict)}\n` +
      'Nothing has been run and nothing on the deployment was touched. A run continues once the ' +
      `owner rewrites ${path} with the total they have now authorised and fresh start balances.`
    );
  }
  return null;
}

/**
 * ⛔ Deliberately quotes no spend total. A clamped total reads exactly like a measured one, and this
 * is the single case where the number is not knowable, so handing the reader one to act on is the
 * mistake rather than the courtesy. The fix is a fresh authorisation, which is how 2026-08-28 went.
 */
function depositRefusal(rose: readonly string[], path: string): string {
  const who =
    rose.length === 1
      ? `the ${rose[0]} now holds more than the ledger's start balance for it`
      : `the ${rose.join(' and the ')} now hold more than the ledger's start balances for them`;

  return (
    `A deposit landed after this authorisation was written: ${who}. An availableBalance has no other ` +
    'way up, since writing a cheque lowers it and a peer cashing one leaves it alone, so this ' +
    "run's spend can no longer be measured against the recorded starts. Unknown spend is not " +
    'smaller spend, so it stops here rather than being reported as a total.\n' +
    'Nothing has been run and nothing on the deployment was touched. The owner re-authorises by ' +
    `writing a fresh ${path}, with start balances read now and the total they are authorising now.`
  );
}

/**
 * PLUR as BZZ to three decimals, truncated, which is what `spend_bzz` in the shell gate prints.
 *
 * Formatted out of the integer rather than divided as a `number`, because a balance around 1e16 is
 * past 2^53 and would lose its last digits on the way through one. The sign is carried separately
 * for the same arithmetic reason: BigInt division truncates toward zero, so a negative remainder
 * formatted term by term reads as headroom that is not there.
 */
function plurToBzz(plur: bigint): string {
  const sign = plur < 0n ? '-' : '';
  const magnitude = plur < 0n ? -plur : plur;
  const thousandths = (magnitude % PLUR_PER_BZZ) / PLUR_PER_MILLI_BZZ;

  return `${sign}${magnitude / PLUR_PER_BZZ}.${thousandths.toString().padStart(3, '0')}`;
}
