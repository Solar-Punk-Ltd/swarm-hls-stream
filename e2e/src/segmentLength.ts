/**
 * Whether the stack a run is pointed at cuts segments at the length that run's viewer needs.
 *
 * ⭐⭐⭐ **The two viewer types this project ships want opposite numbers, and that is a product trade
 * rather than a defect to reconcile.** Measured 2026-08-16 by the sibling repo
 * `swarm-stream-loadlab`, in `docs/measurements/2026-08-16-a-stock-tab-holds-realtime-on-two-second-segments.md`
 * and recorded as the open question Q23 in its `docs/spec/product-spec.md`:
 *
 *  - A stock weeb-3 tab, the in-tab node this project exists to measure, sustains **1.000x of
 *    realtime on 2s segments** holding about 90s of buffer, and **0.426x on 0.5s** holding 0.5 to
 *    3.5s. The mechanism is arithmetic, not tuning: weeb-3 admits about one segment per second
 *    whatever its peer count, so a 0.5s profile needs two admissions a second against a ceiling near
 *    one. Adding peers cannot help, because peers were never the constraint.
 *  - The **gateway** path measures the opposite optimum over 21 funded arms, 0.5s beating 2s on
 *    capture-to-fetchable latency at 1.55s against 3.88s.
 *
 * So a run has to name the number it needs, and the stack has to be producing it. Our own latbench
 * stage publishes 0.5s, and the `in-browser` profile has been running the byte source that cannot
 * sustain that: live in-tab readings sat at 0.35 to 0.68 of realtime with a 44ms buffer, which is the
 * 0.426x law and not a client fault.
 *
 * ## How our stage decides the number
 *
 * SRS publishes `segment = ceil(hls_fragment / GOP) * GOP`, force-closed at `hls_fragment *
 * hls_aof_ratio` whether a keyframe arrived or not. With the ladder on, `engines/srs/entrypoint.sh`
 * derives every rung's keyframe cadence from `HLS_FRAGMENT` itself, so the round-up is by one and the
 * fragment IS the segment. With the ladder off the cadence is whatever publishes, which for this
 * suite is `startPublisher`'s 2s GOP.
 *
 * The verdict lives here rather than in the preflight because nothing under `suites/` runs in CI.
 * This file is reached by `test/segmentLength.test.ts`, so the rules are covered by `pnpm verify` and
 * the preflight is left with the container read and a failure message.
 */

/**
 * The word that waives the check. Not exported: nothing outside needs the name, and spelling it once
 * here is what stops the parser and the messages that teach it from drifting apart.
 */
const SEGMENT_ANY = 'any';

/**
 * What the operator said this run needs, out of `E2E_EXPECT_SEGMENT_S`.
 *
 * `'any'` is a declaration and not an absence: a run against a stage this cannot read is legitimate
 * and says so once, the way `E2E_EXPECT_ABR=false` does. `'undeclared'` is the gap the gate refuses.
 */
export type SegmentExpectation = number | typeof SEGMENT_ANY | 'undeclared';

/**
 * The refusal for a run that named no segment length, which is a run whose report cannot be read.
 *
 * A constant rather than a function because two gates raise it: the profile preflight, which settles
 * it with no network at all, and the segment preflight, which must not dial a stage it has no
 * yardstick for.
 */
export const SEGMENT_UNDECLARED_REFUSAL =
  'This run has not said how long a segment it needs, and the two viewer types want opposite ' +
  'numbers: measured 2026-08-16, an in-tab weeb-3 node holds 1.000x of realtime on 2s segments and ' +
  '0.426x on 0.5s, while the gateway measures the opposite optimum. A reading taken against the ' +
  'wrong one is a wrong number rather than a missing one, so say which run this is. ' +
  `E2E_EXPECT_SEGMENT_S=2 is what an in-tab viewer needs, 0.5 is what the gateway control needs, and ` +
  `E2E_EXPECT_SEGMENT_S=${SEGMENT_ANY} declares a run that does not pin one and is never asked again.`;

/** Whole seconds and fractional seconds, and nothing with a unit or an exponent stuck to it. */
const SECONDS_RE = /^[0-9]+(\.[0-9]+)?$/;

/**
 * `E2E_EXPECT_SEGMENT_S` as an expectation, refusing a spelling it does not know.
 *
 * ⛔ Matched against a pattern before it is parsed, deliberately. `Number.parseFloat` stops at the
 * first character it cannot use, so `2s` would read as 2 and `0x2` as 0. The second is the one that
 * matters: a zero-length declaration and an unparseable one would become the same value, and the
 * arithmetic downstream divides by it.
 */
export function readSegmentExpectation(raw: string): SegmentExpectation {
  const value = raw.trim();

  if (value === '') {
    return 'undeclared';
  }
  if (value === SEGMENT_ANY) {
    return SEGMENT_ANY;
  }
  if (!SECONDS_RE.test(value) || Number.parseFloat(value) <= 0) {
    throw new Error(
      `E2E_EXPECT_SEGMENT_S must be a positive number of seconds, the word ${SEGMENT_ANY}, or unset. ` +
        `Got '${raw}'.`,
    );
  }

  return Number.parseFloat(value);
}
