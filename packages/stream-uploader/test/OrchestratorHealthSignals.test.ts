import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO, PRESSURE_HIGH, PRESSURE_LOW, PRESSURE_MEDIUM, QueuePressure } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeFakeCatalog, makeTestOrchestrator, neverSettles } from './helpers/fakes.js';

/** Wide enough that a queue can land on either pressure threshold exactly rather than near it. */
const QUEUE_CEILING = 10;

const SEGMENT_SECONDS = 2;

/** A ceiling on an age that has to read as an age, generous enough to survive a loaded machine. */
const PLAUSIBLE_AGE_CEILING_MS = 60_000;

/**
 * What one stream contributes to `/health` and `/metrics`.
 *
 * This is the whole set of readings the orchestrator asks an uploader for while building a snapshot,
 * and it is complete on purpose: the stub is cast, so a reading the orchestrator starts asking for is
 * a `TypeError` in whichever test reaches it rather than a compile error anywhere. Same shape and same
 * reason as `makeFakeCatalog`.
 */
interface StreamReadings {
  hasStaleLiveManifest: boolean;
  consecutiveManifestFailures: number;
  consecutiveSegmentFailures: number;
  msSinceStatePersistFailed: number | null;
  msSinceCatalogAnnounceFailed: number | null;
  queuedSeconds: number;
  queuedSegments: number;
}

/** A stream with nothing wrong with it, so a test that cares about one reading sets only that one. */
const HEALTHY_READINGS: StreamReadings = {
  hasStaleLiveManifest: false,
  consecutiveManifestFailures: 0,
  consecutiveSegmentFailures: 0,
  msSinceStatePersistFailed: null,
  msSinceCatalogAnnounceFailed: null,
  queuedSeconds: 0,
  queuedSegments: 0,
};

function makeReadingStream(overrides: Partial<StreamReadings>): StreamUploader {
  const readings = { ...HEALTHY_READINGS, ...overrides };
  return {
    hasStaleLiveManifest: () => readings.hasStaleLiveManifest,
    getConsecutiveManifestFailures: () => readings.consecutiveManifestFailures,
    getConsecutiveSegmentFailures: () => readings.consecutiveSegmentFailures,
    getMsSinceStatePersistFailed: () => readings.msSinceStatePersistFailed,
    getMsSinceCatalogAnnounceFailed: () => readings.msSinceCatalogAnnounceFailed,
    getQueuedSeconds: () => readings.queuedSeconds,
    segmentQueue: { size: readings.queuedSegments },
  } as unknown as StreamUploader;
}

/**
 * Registers streams whose readings are given rather than produced.
 *
 * Each signal below folds over the live streams to pick one extreme, and the fold is what is under
 * test: which stream wins, and whether one that is fine can displace one that is not. Two of the ages
 * are taken on the uploader's own wall clock, which has no seam, so a stream driven through the real
 * path can only ever contribute an age of roughly zero and no ordering between streams is expressible
 * at all.
 *
 * Given as a list because insertion order is the order the fold walks them in, and where the extreme
 * falls in that walk is exactly what distinguishes a fold from picking the first or the last.
 */
function registerReadings(orchestrator: StreamOrchestrator, streams: [string, Partial<StreamReadings>][]): void {
  const live = (orchestrator as unknown as { activeStreams: Map<string, StreamUploader> }).activeStreams;
  for (const [streamId, readings] of streams) {
    live.set(streamId, makeReadingStream(readings));
  }
}

function makePressureOrchestrator(maxQueueSize = QUEUE_CEILING): StreamOrchestrator {
  return makeTestOrchestrator({ clock: new FakeClock(), maxQueueSize }, { uploadData: neverSettles });
}

/**
 * Starts a stream and leaves exactly `queued` segments waiting on its upload queue. It takes one more
 * segment than that, because p-queue runs the first job rather than queueing it and `size` counts only
 * what waits.
 */
function fillQueue(orchestrator: StreamOrchestrator, streamId: string, queued: number): void {
  orchestrator.startStream(streamId, MEDIA_TYPE_VIDEO);
  for (let index = 0; index <= queued; index += 1) {
    orchestrator.handleSegment(streamId, index, SEGMENT_SECONDS, Buffer.from(`segment ${index}`));
  }
}

describe('StreamOrchestrator queue pressure', () => {
  it('reports the rung its ratio lands on, at both thresholds and between them', () => {
    const orch = makePressureOrchestrator();

    const ladder: { queued: number; expected: QueuePressure; why: string }[] = [
      { queued: 0, expected: PRESSURE_LOW, why: 'a stream with nothing waiting is the bottom of the ladder' },
      {
        queued: QUEUE_CEILING / 2,
        expected: PRESSURE_LOW,
        why: 'exactly half the ceiling is not past half of it, and a ratio multiplied rather than divided reads 50 here',
      },
      {
        queued: QUEUE_CEILING / 2 + 1,
        expected: PRESSURE_MEDIUM,
        why: 'the first segment past half the ceiling is what medium means',
      },
      { queued: 8, expected: PRESSURE_MEDIUM, why: 'exactly four fifths of the ceiling is not past four fifths' },
      { queued: 9, expected: PRESSURE_HIGH, why: 'the first segment past four fifths is what high means' },
    ];

    for (const { queued, expected, why } of ladder) {
      const streamId = `live/queued-${queued}`;
      fillQueue(orch, streamId, queued);
      assert.equal(orch.getQueuePressure(streamId), expected, why);
    }
  });

  it('answers for a stream it does not have instead of reading a queue that is not there', () => {
    const orch = makePressureOrchestrator();

    assert.equal(
      orch.getQueuePressure('live/never-started'),
      PRESSURE_LOW,
      'an id nothing holds has no queue to measure, and reaching for one throws rather than answering',
    );
  });

  it('reports low while every stream is at or below half its ceiling', () => {
    const orch = makePressureOrchestrator();

    fillQueue(orch, 'live/idle', 0);
    fillQueue(orch, 'live/at-half', QUEUE_CEILING / 2);

    assert.equal(
      orch.getOverallQueuePressure(),
      PRESSURE_LOW,
      'nothing is above half its ceiling, so an overall reading above low is a service reporting a backlog it does not have',
    );
  });

  it('reports the worst stream rather than the last one it walked', () => {
    const orch = makePressureOrchestrator();

    fillQueue(orch, 'live/over-half', QUEUE_CEILING / 2 + 1);
    fillQueue(orch, 'live/idle', 0);

    assert.equal(
      orch.getOverallQueuePressure(),
      PRESSURE_MEDIUM,
      'one backed-up stream sets the reading, and a quiet stream walked after it must not clear it',
    );
  });
});

describe('StreamOrchestrator stale manifest count', () => {
  it('counts the streams whose live manifest has stopped advancing, and only those', () => {
    const orch = makeTestOrchestrator();

    registerReadings(orch, [
      ['live/stuck', { hasStaleLiveManifest: true, consecutiveManifestFailures: 4 }],
      ['live/fine', {}],
      ['live/also-stuck', { hasStaleLiveManifest: true, consecutiveManifestFailures: 2 }],
    ]);

    assert.equal(
      orch.getStaleManifestStreamCount(),
      2,
      'two of the three streams have a playlist that is not advancing',
    );
    assert.equal(
      orch.getHealthSignals().staleManifestStreams,
      2,
      'and the same number has to reach `/health`, which is the only place an operator sees it',
    );
  });
});

describe('StreamOrchestrator state persist age', () => {
  const catalogFailing = (msSinceIndexSaveFailed: number | null) =>
    makeFakeCatalog({ getMsSinceIndexSaveFailed: () => msSinceIndexSaveFailed });

  it('reports the oldest failure across the catalog index and every stream', () => {
    const orch = makeTestOrchestrator({}, {}, undefined, catalogFailing(5_000));

    registerReadings(orch, [
      ['live/recent', { msSinceStatePersistFailed: 100 }],
      ['live/longest', { msSinceStatePersistFailed: 9_000 }],
      ['live/middling', { msSinceStatePersistFailed: 300 }],
      ['live/writing-fine', {}],
    ]);

    assert.equal(
      orch.getMsSinceStatePersistFailed(),
      9_000,
      'the longest-running failure is the one an operator has to see, wherever it falls in the walk and whatever is walked after it',
    );
  });

  it('does not let a stream that is writing fine answer for a catalog index that is not', () => {
    const orch = makeTestOrchestrator({}, {}, undefined, catalogFailing(5_000));

    registerReadings(orch, [['live/writing-fine', {}]]);

    assert.equal(
      orch.getMsSinceStatePersistFailed(),
      5_000,
      'a healthy stream reads null, and folding that in would answer `nothing is wrong` for a store that cannot write',
    );
  });
});

describe('StreamOrchestrator catalog announce age', () => {
  it('reports the longest-waiting stream, wherever it falls in the walk', () => {
    const orch = makeTestOrchestrator();

    registerReadings(orch, [
      ['live/recent', { msSinceCatalogAnnounceFailed: 100 }],
      ['live/longest', { msSinceCatalogAnnounceFailed: 9_000 }],
      ['live/middling', { msSinceCatalogAnnounceFailed: 300 }],
      ['live/listed', {}],
    ]);

    assert.equal(
      orch.getMsSinceCatalogAnnounceFailed(),
      9_000,
      'the broadcast nobody has been able to find for longest sets the number, and a listed stream must not clear it',
    );
  });
});

describe('StreamOrchestrator stream activity age', () => {
  it('reports the stream that has been quiet longest, wherever it falls in the walk', async () => {
    const clock = new FakeClock();
    const orch = makeTestOrchestrator({ clock });

    orch.startStream('live/walked-first', MEDIA_TYPE_VIDEO);
    orch.startStream('live/quietest', MEDIA_TYPE_VIDEO);
    orch.startStream('live/walked-last', MEDIA_TYPE_VIDEO);

    await clock.advance(1_000);
    orch.handleSegment('live/walked-first', 0, SEGMENT_SECONDS, Buffer.from('a'));
    await clock.advance(1_000);
    orch.handleSegment('live/walked-last', 0, SEGMENT_SECONDS, Buffer.from('b'));
    await clock.advance(1_000);

    assert.equal(
      orch.getMsSinceStreamActivity(),
      3_000,
      'one busy stream must not mask a dead sibling, so the worst age wins rather than the first or the last one read',
    );
  });
});

describe('StreamOrchestrator segment loss age', () => {
  it('reports the freshest loss as an age, wherever it falls in the walk', async () => {
    const clock = new FakeClock();
    const orch = makeTestOrchestrator({ clock });

    orch.startStream('live/walked-first', MEDIA_TYPE_VIDEO);
    orch.startStream('live/freshest', MEDIA_TYPE_VIDEO);
    orch.startStream('live/walked-last', MEDIA_TYPE_VIDEO);

    // Every loss is reported at a non-zero reading. Against a clock still at zero the age and the
    // instant the loss happened are the same number, and nothing here could tell one from the other.
    await clock.advance(100);
    orch.handleSegmentLoss('live/walked-first', 0, 1);
    await clock.advance(200);
    orch.handleSegmentLoss('live/walked-last', 0, 1);
    await clock.advance(200);
    orch.handleSegmentLoss('live/freshest', 0, 1);
    await clock.advance(500);

    assert.equal(
      orch.getMsSinceSegmentLoss(),
      500,
      'the health policy holds a loss for a fixed window, so the newest one has to set the age rather than the first or the last read',
    );
  });
});

describe('StreamOrchestrator metrics gauges', () => {
  it('adds up what every stream has waiting rather than cancelling them out', () => {
    const orch = makePressureOrchestrator(100);

    fillQueue(orch, 'live/three-waiting', 3);
    fillQueue(orch, 'live/five-waiting', 5);

    assert.equal(
      orch.getMetricsSnapshot().queueDepth,
      8,
      'the depth is the whole process backlog, and a fold that subtracts reports a service with nothing to do',
    );
  });

  it('forwards a skipped-segment report to the counter both surfaces read', () => {
    const orch = makeTestOrchestrator();

    orch.recordSegmentsSkipped(3);
    orch.recordSegmentsSkipped(4);

    assert.equal(orch.getMetricsSnapshot().segmentsSkippedTotal, 7, 'the counter is what `/metrics` renders');
    assert.equal(
      orch.getHealthSignals().segmentsSkipped,
      7,
      'and `/health` reports the same total, so a report that never reaches the counter is invisible on both',
    );
  });

  it('reports an auth rejection as an age since it happened rather than as the instant', () => {
    const orch = makeTestOrchestrator();

    assert.equal(orch.getHealthSignals().msSinceAuthRejection, null, 'nothing has been refused yet');

    orch.recordAuthRejection();
    const age = orch.getHealthSignals().msSinceAuthRejection;

    assert.ok(
      age !== null && age >= 0 && age < PLAUSIBLE_AGE_CEILING_MS,
      `a rejection just now has to read as an age of about zero, and an epoch reading satisfies "not negative" just as well: ${age}`,
    );
  });
});
