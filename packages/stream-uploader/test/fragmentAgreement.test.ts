import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FRAGMENT_AGREES,
  FRAGMENT_MISMATCH,
  FRAGMENT_PUBLISHER_GOP,
  FRAGMENT_SAMPLE_COUNT,
  FRAGMENT_TOLERANCE,
  FRAGMENT_UNDECIDED,
  fragmentLengthNotice,
  fragmentMismatchReport,
  FragmentStage,
  fragmentVerdict,
  medianSeconds,
  UNWATCHED_FRAGMENT,
  watchFragment,
  withFragmentSample,
} from '../src/libs/fragmentAgreement.js';

/**
 * The shipping stage: the ladder on, dating by 0.5s, which is what `HLS_FRAGMENT` defaults to in
 * `docker-compose.yml` and what `deploy/test/srsTuning.test.js` holds the engine to.
 */
const LADDER_STAGE: FragmentStage = { configuredSeconds: 0.5, underLadder: true };

/** The same deployment with the ladder off, where the publisher's own GOP decides the segment. */
const SINGLE_RENDITION_STAGE: FragmentStage = { configuredSeconds: 0.5, underLadder: false };

/** What the engine was really cutting on 2026-09-04 while the uploader dated by 0.5. */
const ENGINE_WAS_CUTTING = 1;

const STREAM_ID = 'live/one_1080p';

function samplesOf(seconds: number, count = FRAGMENT_SAMPLE_COUNT): number[] {
  return Array.from({ length: count }, () => seconds);
}

/** A watch fed `count` segments of `seconds`, which is the only way to reach a verdict. */
function watchFed(seconds: number, stage: FragmentStage, count = FRAGMENT_SAMPLE_COUNT) {
  let watch = UNWATCHED_FRAGMENT;
  for (let i = 0; i < count; i++) {
    watch = watchFragment(watch, seconds, stage);
  }
  return watch;
}

describe('the fragment length sampler', () => {
  it('takes the first N readings and then stops', () => {
    let samples: readonly number[] = [];
    for (let i = 0; i < FRAGMENT_SAMPLE_COUNT + 5; i++) {
      samples = withFragmentSample(samples, i);
    }

    assert.equal(samples.length, FRAGMENT_SAMPLE_COUNT);
    assert.deepEqual(
      [...samples],
      Array.from({ length: FRAGMENT_SAMPLE_COUNT }, (_, i) => i),
      'the opening of a broadcast is what is measured, so the readings kept must be the first ones',
    );
  });

  it('returns a new list rather than growing the one it was given', () => {
    const before: readonly number[] = [1, 2];
    const after = withFragmentSample(before, 3);

    assert.deepEqual([...before], [1, 2], 'a caller still holding the old list must keep what it had');
    assert.deepEqual([...after], [1, 2, 3]);
  });

  it('reads the middle of an even sample as the mean of the two middle readings', () => {
    assert.equal(medianSeconds([2, 1, 4, 3]), 2.5);
  });

  it('rides out a single outlier, because one segment can be force-closed without a keyframe', () => {
    // SRS closes a segment at HLS_FRAGMENT x HLS_AOF_RATIO whether a keyframe arrived or not, so one
    // reading of a broadcast can be far longer than the rest without the deployment being wrong.
    const withOneLongSegment = [...samplesOf(0.5, FRAGMENT_SAMPLE_COUNT - 1), 2.5];

    assert.equal(medianSeconds(withOneLongSegment), 0.5);
  });
});

describe('the fragment length verdict', () => {
  it('has no verdict one reading short of the sample', () => {
    const verdict = fragmentVerdict(samplesOf(ENGINE_WAS_CUTTING, FRAGMENT_SAMPLE_COUNT - 1), LADDER_STAGE);

    assert.equal(verdict.kind, FRAGMENT_UNDECIDED, 'a verdict on a short sample is a guess with a number on it');
  });

  it('agrees when the media is the length the deployment configured', () => {
    const verdict = fragmentVerdict(samplesOf(0.5), LADDER_STAGE);

    assert.equal(verdict.kind, FRAGMENT_AGREES);
  });

  it('calls a doubled segment a mismatch under a ladder', () => {
    const verdict = fragmentVerdict(samplesOf(ENGINE_WAS_CUTTING), LADDER_STAGE);

    assert.equal(verdict.kind, FRAGMENT_MISMATCH);
    assert.equal(verdict.kind === FRAGMENT_MISMATCH && verdict.measuredSeconds, ENGINE_WAS_CUTTING);
  });

  it('admits a reading inside the tolerance, so the tolerance is not nothing', () => {
    // Half a tolerance out rather than exactly on it. An equality against a float boundary tests
    // IEEE754 and not the gate, because 0.5 x 1.05 and 0.5 + 0.5 x 0.05 are different numbers.
    const inside = LADDER_STAGE.configuredSeconds * (1 + FRAGMENT_TOLERANCE / 2);

    assert.equal(fragmentVerdict(samplesOf(inside), LADDER_STAGE).kind, FRAGMENT_AGREES);
  });

  it('calls a reading just past the tolerance a mismatch', () => {
    const justPast = LADDER_STAGE.configuredSeconds * (1 + FRAGMENT_TOLERANCE * 2);

    assert.equal(fragmentVerdict(samplesOf(justPast), LADDER_STAGE).kind, FRAGMENT_MISMATCH);
  });

  it('judges a shorter segment the same way, because the stale container can be either one', () => {
    const verdict = fragmentVerdict(samplesOf(0.25), LADDER_STAGE);

    assert.equal(verdict.kind, FRAGMENT_MISMATCH);
  });

  it('does not call a longer segment a fault on a single rendition', () => {
    // HLS_FRAGMENT is a floor there rather than the segment: SRS cuts at the first keyframe at or
    // after it, and nothing in the deployment sets the publisher's keyframe interval.
    const verdict = fragmentVerdict(samplesOf(2), SINGLE_RENDITION_STAGE);

    assert.notEqual(verdict.kind, FRAGMENT_MISMATCH);
    assert.equal(verdict.kind, FRAGMENT_PUBLISHER_GOP);
  });

  it('agrees on a single rendition whose publisher happens to match the configured length', () => {
    assert.equal(fragmentVerdict(samplesOf(0.5), SINGLE_RENDITION_STAGE).kind, FRAGMENT_AGREES);
  });
});

describe('watching one stream to a verdict', () => {
  it('settles on the reading that completes the sample and not before', () => {
    const oneShort = watchFed(ENGINE_WAS_CUTTING, LADDER_STAGE, FRAGMENT_SAMPLE_COUNT - 1);
    assert.equal(oneShort.verdict.kind, FRAGMENT_UNDECIDED);

    const settled = watchFragment(oneShort, ENGINE_WAS_CUTTING, LADDER_STAGE);
    assert.equal(settled.verdict.kind, FRAGMENT_MISMATCH);
  });

  it('keeps its verdict once it has one, so a later reading cannot move it', () => {
    const settled = watchFed(ENGINE_WAS_CUTTING, LADDER_STAGE);
    const afterMore = watchFragment(settled, 0.5, LADDER_STAGE);

    assert.equal(afterMore, settled, 'a settled watch is returned unchanged, which is what reports it once');
  });

  it('starts from a watch that has measured nothing', () => {
    assert.equal(UNWATCHED_FRAGMENT.verdict.kind, FRAGMENT_UNDECIDED);
    assert.equal(UNWATCHED_FRAGMENT.samples.length, 0);
  });
});

describe('what an operator is told', () => {
  it('names both numbers and the container to redeploy', () => {
    const report = fragmentMismatchReport(STREAM_ID, ENGINE_WAS_CUTTING, LADDER_STAGE);

    assert.match(report, /0\.5/, 'the number this uploader dates by has to be in the line');
    assert.match(report, /\b1\b/, 'so does the number the media actually measured');
    assert.match(report, /redeploy the stale one/i, 'a fault with no remedy in it sends the reader hunting');
  });

  it('tells a single-rendition operator what decides the length instead', () => {
    const notice = fragmentLengthNotice(STREAM_ID, 2, SINGLE_RENDITION_STAGE);

    assert.match(notice, /0\.5/);
    assert.match(notice, /\b2\b/);
    assert.match(notice, /keyframe|GOP/i, 'the publisher sets this, and the line has to say so');
  });
});
