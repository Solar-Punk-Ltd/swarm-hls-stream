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
 * ⛔ A node whose balance ROSE counts as having spent nothing, never as headroom. Summing signed
 * deltas would let a top-up on one node pay for an overrun on the other, which is not what an
 * authorisation of a total means. The clamp is reported rather than applied quietly: on 2026-08-14 a
 * 12 BZZ deposit into the gateway turned that node's 0.5406 BZZ of real spend into a clamped zero,
 * and the printed total was short by exactly that with nothing anywhere marking it.
 *
 * ⚠️ Divergence from the shell gate, deliberate and worth knowing. That one REFUSES on a rise,
 * reasoning that spend measured from baselines a deposit predates is unknown rather than smaller.
 * This one clamps and says so, which is what the suite was asked for. A run that sees the note is
 * looking at a floor, not a measurement.
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

/** The three figures a run reports about itself, passing or refused, plus any clamp behind them. */
export function spendSummary(verdict: SpendVerdict): string {
  const line =
    `${plurToBzz(verdict.spentPlur)} BZZ spent of ${plurToBzz(verdict.ceilingPlur)} authorised, ` +
    `${plurToBzz(verdict.remainingPlur)} BZZ remaining.`;

  return verdict.rose.length === 0 ? line : `${line} ${depositNote(verdict.rose)}`;
}

/**
 * ⛔ Never silent. A clamped node is a node whose real spend this run cannot see, so the total it
 * sits inside is a floor rather than a measurement, and a reader has to be told which one they have.
 */
function depositNote(rose: readonly string[]): string {
  const who =
    rose.length === 1
      ? `The ${rose[0]} now holds more than its ledger baseline`
      : `The ${rose.join(' and the ')} now hold more than their ledger baselines`;
  const those = rose.length === 1 ? 'that node' : 'those nodes';

  return (
    `${who}, so a deposit landed after this authorisation was written. Spend on ${those} counts as ` +
    'zero here, which makes the total above a floor rather than a measurement.'
  );
}

/**
 * Why a run past its authorisation stops, in the terms the operator has to act in.
 *
 * Names the ledger because raising a ceiling means editing that file, and only the owner does.
 */
export function ceilingRefusal(verdict: SpendVerdict, path: string): string {
  return (
    `This run would spend past what the owner authorised. ${spendSummary(verdict)}\n` +
    'Nothing has been run and nothing on the deployment was touched. A run continues once the owner ' +
    `rewrites ${path} with the total they have now authorised and fresh start balances.`
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
