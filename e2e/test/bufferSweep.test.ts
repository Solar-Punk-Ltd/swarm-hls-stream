import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  armIsComparable,
  armResultFrom,
  type ArmSetup,
  MAX_LOGGED_UNEVENTFUL_SAMPLES,
  perArmFromSessionTotals,
  thinSamples,
} from '../src/browser/bufferSweep.js';
import { type InstrumentReading, REQUIRED_CODECS } from '../src/browser/instrument.js';
import { type ViewerSample } from '../src/browser/session.js';
import { type SampledStretch } from '../src/browser/watchLoop.js';

function armThatTook(over: Partial<ArmSetup> = {}): ArmSetup {
  return {
    targetLatencyS: 3,
    maxLatencyS: 6,
    targetDurationS: 1,
    stallCountAtStart: 0,
    failure: null,
    ...over,
  };
}

const BASE: ViewerSample = {
  atMs: 0,
  currentTime: 0,
  paused: false,
  readyState: 4,
  playbackRate: 1,
  bufferAheadS: 8,
  liveLatencyS: 1.5,
  liveTargetLatencyS: 1.5,
  bufferStalls: 0,
  rebufferCount: 0,
  rebufferMs: 0,
  fatalErrors: 0,
  decodedFrames: 0,
  droppedFrames: 0,
  resolution: '1280×720',
  feedStateMessage: null,
};

/**
 * An arm that watched `count` seconds without incident, with `at` applied from its index on.
 *
 * The overrides carry forward rather than landing on one sample, because everything the sweep reads
 * is a running total the player maintains for the session: a rebuffer that reverted a second later
 * would be a player restart rather than a rebuffer.
 */
function arm(count: number, at: Record<number, Partial<ViewerSample>> = {}): ViewerSample[] {
  let carried: Partial<ViewerSample> = {};
  return Array.from({ length: count }, (_, i) => {
    carried = { ...carried, ...at[i] };
    return { ...BASE, atMs: i * 1000, currentTime: i, ...carried };
  });
}

const SOUND_READING: InstrumentReading = {
  visibilityState: 'visible',
  timerDriftRatio: 1,
  codecSupport: Object.fromEntries(REQUIRED_CODECS.map((codec) => [codec, true])),
};

const stretchOf = (samples: readonly ViewerSample[]): SampledStretch => ({
  samples: [...samples],
  readings: samples.map(() => SOUND_READING),
  screenshots: [],
});

/**
 * What the sweep is allowed to count.
 *
 * The reason this is a function rather than a comment in the runner is that a sweep which quietly
 * counts a contaminated arm reports a clean result it never measured, and by then the broadcast has
 * been paid for. Every rejection here corresponds to a way an arm can look fine and mean nothing.
 */
describe('deciding whether an arm can be counted', () => {
  it('counts an arm that took its target on a clean player', () => {
    assert.equal(armIsComparable(armThatTook(), 1), null);
  });

  it('rejects an arm the player never accepted', () => {
    const reason = armIsComparable(armThatTook({ targetLatencyS: null }), 1);

    assert.match(reason ?? '', /nothing says the arm took/);
  });

  it('passes a setup failure straight through rather than judging around it', () => {
    const reason = armIsComparable(armThatTook({ failure: 'no player at globalThis.__swarmHlsPlayer' }), 1);

    assert.equal(reason, 'no player at globalThis.__swarmHlsPlayer');
  });

  /**
   * hls.js carries `stallCount` on the player instance and adds it to every target it computes, so an
   * arm that starts with one inherited from its predecessor is measuring the arm before it.
   * `hls.targetLatency = x` is supposed to zero it, and this is what notices when it did not.
   */
  it('rejects an arm still carrying the previous arm stall penalty', () => {
    const reason = armIsComparable(armThatTook({ stallCountAtStart: 2 }), 1);

    assert.match(reason ?? '', /carries the previous arm/);
  });

  /**
   * The penalty ceiling is `#EXT-X-TARGETDURATION`, which the uploader keeps as a running maximum of
   * `ceil()` that never falls. One force-closed segment raises it for the rest of the broadcast, so
   * arms either side of that moment are measured under different ceilings.
   */
  it('rejects an arm measured under a ceiling that moved mid-sitting', () => {
    const reason = armIsComparable(armThatTook({ targetDurationS: 3 }), 1);

    assert.match(reason ?? '', /EXT-X-TARGETDURATION moved from 1 to 3/);
  });

  it('does not reject on a ceiling it never saw, since an unknown is not a mismatch', () => {
    assert.equal(armIsComparable(armThatTook({ targetDurationS: null }), 1), null);
    assert.equal(armIsComparable(armThatTook(), null), null);
  });

  /**
   * A player that reports no stall count at all is a player this cannot vet, and rejecting on that
   * would drop every arm. It is allowed through deliberately, which is worth an assertion so the
   * decision is visible rather than an accident of the condition's shape.
   */
  it('allows an arm whose player reported no stall count', () => {
    assert.equal(armIsComparable(armThatTook({ stallCountAtStart: null }), 1), null);
  });
});

/**
 * That an arm is scored on what it did, not on what the sweep had accumulated by the time it ran.
 *
 * `summarize` reads rebuffers through `totalAcrossRestarts`, which takes the peak of a monotonic
 * session counter. Right for a whole watch, wrong for one arm: the sweep is scored on this column,
 * and left cumulative it can only ever go up, so every arm after a bad one inherits its damage and
 * the sweep reports a floor wherever the first trouble happened.
 *
 * Found in a live sitting reading 5, 5, 5 across three different buffer targets, which is the shape
 * this produces and is indistinguishable from a real invariance.
 */
describe('scoring an arm on its own rebuffers', () => {
  it('differences a rising session counter into per-arm contributions', () => {
    assert.deepEqual(perArmFromSessionTotals([0, 4, 5, 5, 5]), [0, 4, 1, 0, 0]);
  });

  it('reports nothing for an arm that added nothing, rather than the running total', () => {
    assert.deepEqual(perArmFromSessionTotals([7, 7, 7]), [7, 0, 0]);
  });

  it('leaves a sweep where nothing ever rebuffered at zero throughout', () => {
    assert.deepEqual(perArmFromSessionTotals([0, 0, 0, 0]), [0, 0, 0, 0]);
  });

  /**
   * A total that falls is the player's counter resetting, which `totalAcrossRestarts` handles inside
   * an arm and cannot see across them. The arm still did the work it reached from zero, so crediting
   * it with a negative would hide a real rebuffer.
   */
  it('credits an arm whose counter restarted with what it reached, never a negative', () => {
    assert.deepEqual(perArmFromSessionTotals([5, 2, 3]), [5, 2, 1]);
  });

  it('handles an empty sweep without inventing an arm', () => {
    assert.deepEqual(perArmFromSessionTotals([]), []);
  });
});

/**
 * What an arm keeps of its own series.
 *
 * The sweep is scored on rebuffers, and a rebuffer count on its own cannot be lined up against
 * anything. The refusals our uploader's `deferred: false` feed slot produces are already in the
 * `.requests.json` with their `startedAtMs`, so whether a small buffer target's rebuffers are those
 * refusals is a question about two timestamps, and this is the side that used to be a count.
 */
describe('what an arm keeps of its samples', () => {
  const uneventful = (count: number): number => thinSamples(arm(count)).length;

  it('keeps a short arm whole, so an ordinary sitting loses nothing', () => {
    const kept = thinSamples(arm(MAX_LOGGED_UNEVENTFUL_SAMPLES));

    assert.equal(kept.length, MAX_LOGGED_UNEVENTFUL_SAMPLES);
  });

  it('thins a long arm to the cap rather than growing with the sitting', () => {
    assert.ok(uneventful(4_000) <= MAX_LOGGED_UNEVENTFUL_SAMPLES + 1);
  });

  it('keeps the arm start, which is what puts the arm on the request log wall clock', () => {
    const kept = thinSamples(arm(4_000));

    assert.equal(kept[0].atMs, 0);
  });

  /**
   * The one this whole change is for. A thinned stretch is sampled every Nth second, so a rebuffer
   * surviving only as "somewhere in the last N" would make the alignment coarser exactly as the
   * sitting grew, which is the thinning dissolving the comparison it is meant to keep affordable.
   *
   * ⛔ Asserted over a run of positions rather than one. An event's predecessor lands on the thinning
   * stride roughly one time in N by coincidence, and at a single position this passed with the
   * predecessor rule taken out.
   */
  it('keeps a rebuffer out of a long uneventful arm, bracketed to one interval', () => {
    for (let landsAt = 2_000; landsAt < 2_010; landsAt += 1) {
      const kept = thinSamples(arm(4_000, { [landsAt]: { rebufferCount: 1, rebufferMs: 400 } }));
      const at = kept.findIndex((sample) => sample.rebufferCount === 1);

      assert.ok(at > 0, `the rebuffer at sample ${landsAt} was thinned away`);
      assert.equal(
        kept[at].atMs - kept[at - 1].atMs,
        1_000,
        `nothing within a sampling interval bounds when the rebuffer at sample ${landsAt} started`,
      );
    }
  });

  /**
   * A stall is a step rather than a counter, so both ends of it have to survive: the pair is what
   * `summarize` reads to call the sample stalled at all.
   */
  it('keeps both ends of a stall, which is scored off the step and not off a counter', () => {
    const frozen = arm(4_000).map((sample, i) => (i >= 2_000 ? { ...sample, currentTime: 2_000 } : sample));

    const at = new Set(thinSamples(frozen).map((sample) => sample.atMs));

    assert.ok(at.has(2_000_000) && at.has(2_001_000), 'the interval playback stopped over was thinned away');
  });

  it('keeps what the overlay told the viewer when it changed', () => {
    const kept = thinSamples(arm(4_000, { 2_000: { feedStateMessage: 'Waiting for the broadcast' } }));

    assert.ok(kept.some((sample) => sample.atMs === 2_000_000));
  });

  it('does not fall over on an arm that took nothing', () => {
    assert.deepEqual(thinSamples([]), []);
    assert.equal(uneventful(1), 1);
  });
});

/**
 * ⛔ The regression this exists to stop: `samples` used to be `stretch.samples.length`, a count, and
 * the whole series was dropped on the floor. A published sweep could then say how many rebuffers an
 * arm had and nothing at all about when inside the arm they happened.
 */
describe('the arm result a sweep publishes', () => {
  const resultFor = (samples: readonly ViewerSample[]) =>
    armResultFrom({ label: 'arm@1.5s', targetS: 1.5, counted: true }, armThatTook(), 1, stretchOf(samples));

  it('carries the samples themselves rather than a count of them', () => {
    const result = resultFor(arm(3, { 1: { rebufferCount: 1 } }));

    assert.deepEqual(
      result.samples.map((sample) => sample.atMs),
      [0, 1_000, 2_000],
    );
  });

  /**
   * Counted over the whole stretch, so the column a reader scores the sweep on is the number of
   * samples the arm took rather than the number that survived thinning.
   */
  it('counts every sample taken, not the ones the artefact kept', () => {
    const result = resultFor(arm(4_000));

    assert.equal(result.sampleCount, 4_000);
    assert.ok(result.samples.length < result.sampleCount);
  });

  /** Thinning runs after the scoring, so nothing a sweep report prints moves when the cap does. */
  it('scores the arm over the whole series, before any of it is thinned', () => {
    const withLateRebuffers = arm(4_000, { 3_500: { rebufferCount: 2, rebufferMs: 900 } });

    const result = resultFor(withLateRebuffers);

    assert.equal(result.rebufferCount, 2);
  });

  it('names a warm-up arm as excluded without judging its setup', () => {
    const warmup = armResultFrom(
      { label: 'warmup-0@6s', targetS: 6, counted: false },
      armThatTook(),
      1,
      stretchOf(arm(3)),
    );

    assert.equal(warmup.excludedBecause, 'warm-up');
  });

  it('carries the reason a counted arm was excluded', () => {
    const contaminated = armResultFrom(
      { label: 'arm@1.5s', targetS: 1.5, counted: true },
      armThatTook({ stallCountAtStart: 2 }),
      1,
      stretchOf(arm(3)),
    );

    assert.match(contaminated.excludedBecause ?? '', /carries the previous arm/);
  });
});
