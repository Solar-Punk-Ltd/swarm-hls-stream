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
 * ## ⛔⛔⛔ EVERY NODE THAT CAN SPEND, NEVER A FIXED PAIR
 *
 * This gate read exactly two chequebooks until 2026-08-31: an `uploader` and a `gateway`. That was
 * the whole deployment when it was written. Splitting the publisher into one Bee node per ABR rung
 * made it four plus the gateway, and the three new ones were **invisible to the gate while holding
 * 5.00 BZZ each**. Worse than a refusal: it would have passed a sitting while watching a minority of
 * the money, and most publishing spend now lands on the nodes it was not looking at.
 *
 * So the node set is an argument rather than a constant, and coverage is checked in both directions.
 * A node read with no baseline is refused, because unknown spend is not zero spend. A baseline with
 * no reading is refused too, because a node that stopped answering is exactly when a run should stop.
 *
 * ## ⛔⛔⛔ A NODE WHOSE BALANCE ROSE ENDS THE LEDGER. IT IS NOT HEADROOM AND IT IS NOT A FOOTNOTE.
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

/** The two keys every authorisation names, whatever the deployment looks like. */
const FIXED_FIELDS = ['authorised_at', 'ceiling_plur'] as const;

/** What each fixed key holds, for an operator reading a refusal. */
const FIXED_FIELD_HELP: Record<(typeof FIXED_FIELDS)[number], string> = {
  authorised_at: 'ISO timestamp of the decision',
  ceiling_plur: 'total PLUR this authorisation covers',
};

/**
 * One baseline per node, keyed by the port that node answers on.
 *
 * The port rather than a role name, because a role is not a node: on a single-rendition deployment
 * one Bee node carries every rung, and on a split one a rung's node is identified in the uploader's
 * own routing by nothing else. `deploy/scripts/spend-ledger.sh` writes these with a comment naming
 * each one, so the file stays readable without the port map being in anyone's head.
 */
const START_KEY = /^node_(\d+)_start_plur$/;

/** PLUR is an unsigned integer in every bee response, so anything else is a ledger to refuse. */
const PLUR_VALUE = /^\d+$/;

/**
 * Not exported: callers take it from {@link parseSpendLedger}'s inferred return, and exporting it
 * would add a name to the surface that nothing imports.
 */
interface SpendLedger {
  readonly authorisedAt: string;
  readonly ceilingPlur: bigint;
  /** Port to that node's `availableBalance` when the authorisation was written. */
  readonly startsByPort: ReadonlyMap<string, bigint>;
}

/**
 * What one node holds now.
 *
 * `who` is carried alongside the port because a refusal naming `11073` sends its reader to a port
 * map, and one naming `720p publisher` does not.
 */
export interface NodeReading {
  readonly port: string;
  readonly who: string;
  readonly plur: bigint;
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
  /** Nodes that can spend and have no baseline, so what they cost cannot be known. */
  readonly unbaselined: readonly string[];
  /** Ports the ledger has a baseline for and nothing read, named as ports because that is all there is. */
  readonly unread: readonly string[];
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
  if (ledgerFaults(bag).length > 0) {
    return null;
  }
  return {
    authorisedAt: bag.authorised_at,
    ceilingPlur: BigInt(bag.ceiling_plur),
    startsByPort: startsIn(bag),
  };
}

/** Every `node_<port>_start_plur` line, as a map. Unusable values are caught by {@link ledgerFaults}. */
function startsIn(bag: Readonly<Record<string, string>>): Map<string, bigint> {
  const starts = new Map<string, bigint>();
  for (const [key, value] of Object.entries(bag)) {
    const port = START_KEY.exec(key)?.[1];
    if (port !== undefined && PLUR_VALUE.test(value.trim())) {
      starts.set(port, BigInt(value.trim()));
    }
  }
  return starts;
}

/**
 * What is wrong with this ledger, in the words a refusal prints.
 *
 * ⛔ A ledger with no node baseline at all is a fault rather than an authorisation covering nothing.
 * Zero baselines would make the spend total zero on every run, which reads exactly like a night that
 * cost nothing.
 */
function ledgerFaults(bag: Readonly<Record<string, string>>): readonly string[] {
  const faults: string[] = FIXED_FIELDS.filter((field) => {
    const value = bag[field];
    if (value === undefined || value.trim() === '') {
      return true;
    }
    return field !== 'authorised_at' && !PLUR_VALUE.test(value.trim());
  });

  const startKeys = Object.keys(bag).filter((key) => START_KEY.test(key));
  const unusable = startKeys.filter((key) => !PLUR_VALUE.test(bag[key].trim()));
  if (unusable.length > 0) {
    faults.push(...unusable);
  } else if (startKeys.length === 0) {
    faults.push('node_<port>_start_plur line for any node');
  }
  return faults;
}

/**
 * Why this run is not authorised to spend, for a ledger {@link parseSpendLedger} refused.
 *
 * An absent ledger and a half-written one are different mistakes, and saying which turns a re-read
 * of the whole format into a one-line edit. Both end with the format, because the operator reading
 * this is the one who has to write the file.
 */
export function ledgerRefusal(path: string, text: string | null): string {
  const format =
    FIXED_FIELDS.map((field) => `  ${field}=<${FIXED_FIELD_HELP[field]}>`).join('\n') +
    '\n  node_<port>_start_plur=<that node’s chequebook availableBalance now>, one line per node that can spend';
  const opening =
    text === null
      ? `No spend ledger at ${path}, so nothing here is authorised to spend.`
      : `The spend ledger at ${path} does not name a usable ${ledgerFaults(parseEnvText(text)).join(', ')}, ` +
        'and a run cannot be measured against an authorisation it cannot read.';

  return (
    `${opening}\n` +
    'An authorisation is a ceiling and one baseline per node, and the owner is the one who sets the ceiling:\n' +
    `${format}\n` +
    'deploy/scripts/spend-ledger.sh --authorise=<BZZ> reads the baselines off the nodes and writes it.\n' +
    'Nothing has been run and nothing on the deployment was touched.'
  );
}

/**
 * One node's spendable balance out of whatever its chequebook endpoint answered.
 *
 * ⛔ Throws rather than defaulting, because an unreadable chequebook is not zero spend. A node
 * mid-restart answers its own JSON error envelope, which parses as JSON and carries no balance, and
 * a node that cannot be measured is exactly when a run should stop. `who` names it in the message,
 * since every node is read the same way and a bare parse error would not say which one went.
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
export function spendAgainstCeiling(ledger: SpendLedger, readings: readonly NodeReading[]): SpendVerdict {
  let spentPlur = 0n;
  const rose: string[] = [];
  const unbaselined: string[] = [];

  for (const reading of distinctByPort(readings)) {
    const start = ledger.startsByPort.get(reading.port);
    if (start === undefined) {
      unbaselined.push(`${reading.who} on ${reading.port}`);
      continue;
    }
    if (reading.plur > start) {
      rose.push(reading.who);
    }
    spentPlur += fell(start, reading.plur);
  }

  const read = new Set(readings.map((reading) => reading.port));
  const unread = [...ledger.startsByPort.keys()].filter((port) => !read.has(port));

  return {
    spentPlur,
    ceilingPlur: ledger.ceilingPlur,
    remainingPlur: ledger.ceilingPlur - spentPlur,
    withinCeiling: spentPlur < ledger.ceilingPlur,
    rose,
    unbaselined,
    unread,
  };
}

/**
 * One reading per node, keyed by port.
 *
 * ⛔ Two rungs can share one Bee node, and on a single-node deployment the gateway can be that node
 * too, so a caller assembling publishers and then appending the gateway can hand over the same port
 * twice. Counting it twice would double that node's spend, which is an overrun this gate would create
 * rather than catch. `spend_nodes` in the shell gate dedupes the same way, and the two are meant to
 * answer identically.
 */
function distinctByPort(readings: readonly NodeReading[]): NodeReading[] {
  const seen = new Set<string>();
  return readings.filter((reading) => {
    if (seen.has(reading.port)) {
      return false;
    }
    seen.add(reading.port);
    return true;
  });
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
 * deposits or about a node nothing baselined: a run that saw either does not reach a line like this,
 * it stops.
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
 * the deposit. The order inside is load-bearing: coverage outranks a deposit, which outranks an
 * overrun. A total summed over some of the nodes is not a smaller total, it is a different quantity,
 * so quoting it in either of the other two refusals would tell the operator to act on a number that
 * does not mean what it says.
 */
export function spendRefusal(verdict: SpendVerdict, path: string): string | null {
  if (verdict.unbaselined.length > 0 || verdict.unread.length > 0) {
    return coverageRefusal(verdict, path);
  }
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
 * ⛔ Deliberately quotes no spend total, for the same reason {@link depositRefusal} does not: a total
 * that covers some of the nodes reads exactly like one that covers all of them.
 *
 * This is the refusal the 2026-08-31 rung split needed and did not have. Three new Bee nodes joined
 * the deployment holding 5.00 BZZ each, the gate went on summing two chequebooks, and nothing
 * anywhere said the number had stopped meaning what it used to.
 */
function coverageRefusal(verdict: SpendVerdict, path: string): string {
  const parts: string[] = [];
  if (verdict.unbaselined.length > 0) {
    parts.push(
      `${verdict.unbaselined.join(', ')} can spend and the ledger has no start balance for ` +
        `${verdict.unbaselined.length === 1 ? 'it' : 'them'}`,
    );
  }
  if (verdict.unread.length > 0) {
    parts.push(
      `the ledger has a start balance for ${verdict.unread.map((port) => `port ${port}`).join(', ')} ` +
        'and nothing read that node',
    );
  }

  return (
    `This run cannot be measured against the authorisation: ${parts.join(', and ')}. Unknown spend is ` +
    'not zero spend, and a total summed over some of the nodes reads exactly like one summed over ' +
    'all of them, so it stops here rather than reporting a figure.\n' +
    'Nothing has been run and nothing on the deployment was touched. The owner re-authorises by ' +
    `writing a fresh ${path} covering every node that can spend, which ` +
    'deploy/scripts/spend-ledger.sh --authorise=<BZZ> does from the nodes themselves.'
  );
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
