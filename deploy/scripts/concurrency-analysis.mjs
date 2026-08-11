/**
 * Turns the raw fetches an in-browser concurrency sweep collected into a throughput curve.
 *
 * ⭐⭐ THIS IS DELIBERATELY NOT IN THE BROWSER HARNESS. Every in-browser throughput figure this project
 * held before 2026-08-11 was retracted, and none of them were retracted because a fetch was mistimed.
 * They were retracted for what was computed afterwards: a per-request median multiplied by a worker
 * count, and a worker count assumed to have been reached rather than measured. So the collector stays
 * a collector, the arithmetic lives here where `node --test` can reach it, and a sitting saved as a TSV
 * can be re-derived later without asking anyone to sit at a browser again.
 *
 * Run it over a saved sitting with:
 *   node deploy/scripts/concurrency-analysis.mjs docs/bench/in-browser-concurrency-sweep-<date>.tsv
 */

/**
 * @typedef {object} SweepRow
 * @property {string} arm Requested concurrency as written, or `canary` / `warm`.
 * @property {number} round
 * @property {string} ref
 * @property {number} startMs Milliseconds since the sitting began, so overlap is recoverable.
 * @property {number} endMs
 * @property {number} ms
 * @property {number} bytes
 * @property {number} status
 * @property {boolean} overBudget Did not finish inside the bound the harness imposed. Not a failure.
 */

export const CONTROL_VALID = 'valid';
export const CONTROL_INVALID = 'invalid: a warm re-read cost what a cold one cost';
export const CONTROL_NOT_RUN = 'not run';

/** A warm re-read served from the node's own store came back 485x faster than cold when last measured. */
const WARM_CONTROL_FACTOR = 10;

const median = (values) => percentile(values, 0.5);

function percentile(values, fraction) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const round2 = (value) => Math.round(value * 100) / 100;

const isArm = (row) => row.arm !== '' && Number.isFinite(Number(row.arm));

const delivered = (row) => row.status === 200 && row.bytes > 0 && !row.overBudget;

/**
 * Highest number of requests open at once.
 *
 * Ends sort before starts at equal timestamps, so a handover is one slot rather than two. Without that
 * tie-break a strictly sequential arm reports concurrency 2 and looks like it scaled.
 */
function peakInFlight(rows) {
  const events = rows.flatMap((row) => [
    [row.startMs, 1],
    [row.endMs, -1],
  ]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak = 0;
  for (const [, delta] of events) {
    open += delta;
    peak = Math.max(peak, open);
  }
  return peak;
}

/**
 * Wall time an arm occupied, summed per round rather than spanned across them.
 *
 * Spanning would swallow every other arm's block into this one's denominator and divide its throughput
 * by the length of the whole sitting.
 */
function wallMsOf(rows) {
  const byRound = new Map();
  for (const row of rows) {
    const span = byRound.get(row.round);
    byRound.set(
      row.round,
      span
        ? { from: Math.min(span.from, row.startMs), to: Math.max(span.to, row.endMs) }
        : { from: row.startMs, to: row.endMs },
    );
  }
  return [...byRound.values()].reduce((sum, span) => sum + (span.to - span.from), 0);
}

function summariseArm(requested, rows) {
  const done = rows.filter(delivered);
  const bytes = done.reduce((sum, row) => sum + row.bytes, 0);
  const wallMs = wallMsOf(rows);
  const busyMs = rows.reduce((sum, row) => sum + row.ms, 0);
  const wallS = wallMs / 1000;
  const achievedPeak = peakInFlight(rows);
  return {
    requested,
    achievedMean: wallMs ? round2(busyMs / wallMs) : 0,
    achievedPeak,
    reached: achievedPeak >= requested ? '' : `⛔ only reached ${achievedPeak}`,
    inBudget: `${done.length}/${rows.length}`,
    wallS: round2(wallS),
    bytes,
    kbPerS: wallS ? Math.round(bytes / 1024 / wallS) : 0,
    fetchPerS: wallS ? round2(done.length / wallS) : 0,
    p50Ms: median(done.map((row) => row.ms)),
    p90Ms: percentile(
      done.map((row) => row.ms),
      0.9,
    ),
    meanKB: done.length ? Math.round(bytes / done.length / 1024) : 0,
  };
}

/**
 * A round is trusted only if its canary came back. The node decays under exactly the load a sweep
 * applies, and a decayed round read as a concurrency effect is how the size story nearly became
 * unfalsifiable in the fragment sittings. A round that never ran a canary is not trusted either:
 * silence is not evidence of health.
 */
function degradedRoundsOf(rows, rounds) {
  return rounds.filter((round) => !rows.some((row) => row.arm === 'canary' && row.round === round && delivered(row)));
}

/**
 * @param {SweepRow[]} rows
 */
export function summariseSweep(rows) {
  const armRows = rows.filter(isArm);
  const rounds = [...new Set(armRows.map((row) => row.round))].sort((a, b) => a - b);
  const degradedRounds = degradedRoundsOf(rows, rounds);
  const healthy = armRows.filter((row) => !degradedRounds.includes(row.round));

  const byArm = new Map();
  for (const row of healthy) {
    const requested = Number(row.arm);
    byArm.set(requested, [...(byArm.get(requested) || []), row]);
  }

  const perArm = [...byArm.keys()]
    .sort((a, b) => a - b)
    .map((requested) => summariseArm(requested, byArm.get(requested)));
  const baseline = perArm[0];

  const warmMs = rows.filter((row) => row.arm === 'warm' && delivered(row)).map((row) => row.ms);
  const coldP50 = median(healthy.filter(delivered).map((row) => row.ms));

  return {
    perArm: perArm.map((arm) => ({
      ...arm,
      speedup: baseline && baseline.kbPerS ? round2(arm.kbPerS / baseline.kbPerS) : null,
    })),
    control: !warmMs.length
      ? CONTROL_NOT_RUN
      : median(warmMs) * WARM_CONTROL_FACTOR <= coldP50
      ? CONTROL_VALID
      : CONTROL_INVALID,
    warmControlMs: warmMs.length ? median(warmMs) : null,
    coldP50Ms: coldP50,
    degradedRounds,
    roundsTrusted: rounds.length - degradedRounds.length,
  };
}

/**
 * What a player actually did, rather than what a harness asked for.
 *
 * ⭐⭐ Every concurrency figure this project holds came from a sweep that CHOSE its concurrency. The
 * player's own was read out of weeb-3's source and then inferred from a synthetic arm agreeing with a
 * playback result to within 3%. Agreement is not observation, and the same rows summarised here are
 * the sweep's rows, so the two become directly comparable instead of merely consistent.
 *
 * ⭐ The verdict is a fetch RATE, not a byte rate. A segment has to be replaced once per segment
 * duration however small it is, so a player that cannot complete that many fetches a second cannot
 * hold realtime no matter how fast each one is. That is the whole of why a 0.266s profile fails on a
 * node that serves a 4.167s one comfortably.
 *
 * @param {SweepRow[]} rows Every fetch the page issued, in the shape {@link parseSweepRows} produces.
 * @param {{segmentSeconds: number}} stream The shape being played, which sets the bar.
 */
export function summariseObserved(rows, { segmentSeconds }) {
  if (!rows.length) {
    return { fetches: 0, delivered: 0, verdict: 'no fetches' };
  }
  const done = rows.filter(delivered);
  const wallMs = wallMsOf(rows);
  const wallS = wallMs / 1000;
  const busyMs = rows.reduce((sum, row) => sum + row.ms, 0);
  const fetchPerS = wallS ? round2(done.length / wallS) : 0;
  const requiredFetchPerS = round2(1 / segmentSeconds);

  return {
    fetches: rows.length,
    delivered: done.length,
    achievedMean: wallMs ? round2(busyMs / wallMs) : 0,
    achievedPeak: peakInFlight(rows),
    wallS: round2(wallS),
    kbPerS: wallS ? Math.round(done.reduce((sum, row) => sum + row.bytes, 0) / 1024 / wallS) : 0,
    fetchPerS,
    requiredFetchPerS,
    p50Ms: median(done.map((row) => row.ms)),
    realtimeHeadroom: requiredFetchPerS ? round2(fetchPerS / requiredFetchPerS) : 0,
    verdict: fetchPerS >= requiredFetchPerS ? 'keeps up' : 'short',
  };
}

const COLUMNS = ['arm', 'round', 'ref', 'startMs', 'endMs', 'ms', 'bytes', 'status', 'overBudget'];

/**
 * @param {string} tsv Whatever `window.__conc.tsv()` produced, comment lines and all.
 * @returns {SweepRow[]}
 */
export function parseSweepRows(tsv) {
  return tsv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(COLUMNS[0] + '\t'))
    .map((line) => {
      const cell = line.split('\t');
      return {
        arm: cell[0],
        round: Number(cell[1]),
        ref: cell[2],
        startMs: Number(cell[3]),
        endMs: Number(cell[4]),
        ms: Number(cell[5]),
        bytes: Number(cell[6]),
        status: Number(cell[7]),
        overBudget: cell[8] === 'over-budget',
      };
    });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node concurrency-analysis.mjs <sitting.tsv>');
    process.exit(1);
  }
  const { readFileSync } = await import('node:fs');
  const summary = summariseSweep(parseSweepRows(readFileSync(path, 'utf-8')));
  console.table(summary.perArm);
  console.log(
    `control: ${summary.control} (warm ${summary.warmControlMs}ms vs cold p50 ${summary.coldP50Ms}ms), ` +
      `rounds trusted ${summary.roundsTrusted}, degraded ${JSON.stringify(summary.degradedRounds)}`,
  );
}
