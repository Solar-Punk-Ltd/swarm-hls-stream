import { Bee, BeeResponseError } from '@ethersphere/bee-js';
import {
  engineSkippedSegments,
  rungBatchRefused,
  rungBatchRefusedPattern,
  segmentUploadFailed,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AnnounceReadiness, READINESS_ANNOUNCED } from '../src/libs/AnnounceReadiness.js';
import { ErrorHandler } from '../src/libs/ErrorHandler.js';
import { Logger } from '../src/libs/Logger.js';
import { ManifestManager } from '../src/libs/ManifestManager.js';
import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { ServiceMetrics } from '../src/libs/ServiceMetrics.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO, StreamState } from '../src/types.js';

import { makeFakeCatalog, makeFakeRecoveryStore, TEST_ANCHOR } from './helpers/fakes.js';

// A valid 32-byte secp256k1 private key (value 1) — enough for bee-js to derive a signer in tests.
const TEST_STREAM_KEY = '0'.repeat(63) + '1';

const permanentError = () => Object.assign(new Error('402 payment required'), { status: 402 });

/** A status in `RETRYABLE_HTTP_STATUSES`, so the write is expected to be attempted again. */
const transientError = () => Object.assign(new Error('503 service unavailable'), { status: 503 });

interface SegmentUploadControl {
  fail?: () => Error | null;
}

/** Fails the first `times` calls with `error` and succeeds from then on. */
function failFirst(times: number, error: () => Error): () => Error | null {
  let remaining = times;
  return () => (remaining-- > 0 ? error() : null);
}

/** Fails only the `nth` call, so one write in a sequence can be refused while the rest land. */
function failOnly(nth: number, error: () => Error): () => Error | null {
  let calls = 0;
  return () => (++calls === nth ? error() : null);
}

/**
 * Run against the shared logger with a captured sink, restoring whatever was configured before.
 *
 * The levels are handed over beside the lines because the level is not reliably in the line: under
 * `LOG_FORMAT=json` the line is an envelope, so a test reading `[ERROR]` out of the text would pass
 * or fail on how the machine running it is configured.
 */
async function withCapturedLog(run: (lines: string[], levels: string[]) => Promise<void>): Promise<void> {
  const lines: string[] = [];
  const levels: string[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({
    sink: (level, line) => {
      lines.push(line);
      levels.push(level);
    },
  });
  try {
    await run(lines, levels);
  } finally {
    logger.configure(previous);
  }
}

/** Counts the calls a control saw, which is what tells one attempt apart from a retried one. */
function countingControl(fail: () => Error | null): SegmentUploadControl & { attempts: number } {
  const control = {
    attempts: 0,
    fail: () => {
      control.attempts++;
      return fail();
    },
  };
  return control;
}

function makeBee(segmentControl: SegmentUploadControl, feedControl: SegmentUploadControl = {}): Bee {
  let refCounter = 0;
  const bee = {
    uploadData: async () => {
      const err = segmentControl.fail?.();
      if (err) {
        throw err;
      }
      const ref = `ref${refCounter++}`;
      return { reference: { toHex: () => ref } };
    },
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) => {
        const err = feedControl.fail?.();
        if (err) {
          throw err;
        }
        return { reference: { toHex: () => `soc${opts.index}` } };
      },
    }),
  };
  return bee as unknown as Bee;
}

function newUploader(
  segmentControl: SegmentUploadControl = {},
  opts: {
    restoreState?: unknown;
    feedWriteFails?: boolean;
    feedControl?: SegmentUploadControl;
    /** Overridden only where the batch id itself is what a test reads, on the refusal line. */
    stamp?: string;
  } = {},
): StreamUploader {
  const feedControl = opts.feedControl ?? (opts.feedWriteFails ? { fail: permanentError } : {});
  return new StreamUploader({
    anchor: TEST_ANCHOR,
    bee: makeBee(segmentControl, feedControl),
    streamCatalog: makeFakeCatalog(),
    recoveryStore: makeFakeRecoveryStore(),
    streamKey: TEST_STREAM_KEY,
    stamp: opts.stamp ?? 'stamp',
    redundancyLevel: 1,
    streamId: 'stream-test',
    streamTopic: 'topic-test',
    mediatype: MEDIA_TYPE_VIDEO,
    restoreState: opts.restoreState as never,
  });
}

async function drain(uploader: StreamUploader): Promise<void> {
  await uploader.segmentQueue.onIdle();
  await (uploader as unknown as { manifestQueue: { onIdle(): Promise<void> } }).manifestQueue.onIdle();
}

describe('StreamUploader discontinuity lifecycle', () => {
  it('marks the first segment after a failed upload as a discontinuity, then clears the flag', async () => {
    const control: SegmentUploadControl = {};
    const uploader = newUploader(control);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    // Segment 1's upload fails permanently (fast) → dropped, discontinuity armed.
    control.fail = permanentError;
    uploader.handleSegment(1, 2, Buffer.from('seg1'));
    await drain(uploader);

    // Segment 2 uploads cleanly → carries the discontinuity...
    control.fail = undefined;
    uploader.handleSegment(2, 2, Buffer.from('seg2'));
    await drain(uploader);

    // ...and segment 3 does not (flag was reset).
    uploader.handleSegment(3, 2, Buffer.from('seg3'));
    await drain(uploader);

    const state = uploader.getStreamState();
    const byIndex = new Map(state.segments.map((s) => [s.index, s]));

    assert.deepEqual(
      [...byIndex.keys()].sort((a, b) => a - b),
      [0, 2, 3],
      'segment 1 should have been dropped after exhausting its upload',
    );
    assert.equal(byIndex.get(0)?.discontinuity, false);
    assert.equal(byIndex.get(2)?.discontinuity, true);
    assert.equal(byIndex.get(3)?.discontinuity, false);
    assert.equal(state.pendingDiscontinuity, false);
  });

  it('flags the next segment as a discontinuity when the engine never delivered one', async () => {
    const uploader = newUploader();

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    uploader.handleSegmentLoss(1, 1);
    await drain(uploader);

    assert.equal(
      uploader.getConsecutiveSegmentFailures(),
      0,
      'a loss deliberately leaves the upload-failure counter alone, since no upload was attempted',
    );

    uploader.handleSegment(2, 2, Buffer.from('seg2'));
    await drain(uploader);

    const byIndex = new Map(uploader.getStreamState().segments.map((s) => [s.index, s]));

    assert.deepEqual(
      [...byIndex.keys()].sort((a, b) => a - b),
      [0, 2],
    );
    assert.equal(
      byIndex.get(0)?.discontinuity,
      false,
      'a segment already queued when the loss arrives is not flagged retroactively',
    );
    assert.equal(byIndex.get(2)?.discontinuity, true, 'the first segment after the gap carries the discontinuity');
  });

  it('flags one discontinuity for a gap however many segments it spans', async () => {
    const uploader = newUploader();

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    uploader.handleSegmentLoss(1, 40);
    uploader.handleSegment(41, 2, Buffer.from('seg41'));
    uploader.handleSegment(42, 2, Buffer.from('seg42'));
    await drain(uploader);

    const byIndex = new Map(uploader.getStreamState().segments.map((s) => [s.index, s]));

    assert.equal(byIndex.get(41)?.discontinuity, true, 'the segment that closes the gap carries the marker');
    assert.equal(byIndex.get(42)?.discontinuity, false, 'and the one after it does not');
  });

  /**
   * The gap nobody reported. On the SRS path a segment closed while this process was dead is never
   * posted again, so the only evidence is the index that follows it, and the orchestrator hands the
   * gap here. Queued the same way a reported loss is, so it lands in front of the arriving segment's
   * own upload rather than on whatever was already waiting.
   */
  it('flags the segment that closes a gap the orchestrator inferred', async () => {
    const uploader = newUploader();

    uploader.handleSegment(4, 2, Buffer.from('seg4'));
    uploader.handleInferredSegmentLoss(4, 9, 4);
    uploader.handleSegment(9, 2, Buffer.from('seg9'));
    uploader.handleSegment(10, 2, Buffer.from('seg10'));
    await drain(uploader);

    const byIndex = new Map(uploader.getStreamState().segments.map((s) => [s.index, s]));

    assert.equal(byIndex.get(4)?.discontinuity, false, 'the segment in front of the gap is not flagged retroactively');
    assert.equal(byIndex.get(9)?.discontinuity, true, 'the segment that closes the gap carries the marker');
    assert.equal(byIndex.get(10)?.discontinuity, false, 'and the one after it does not');
    assert.equal(
      uploader.getConsecutiveSegmentFailures(),
      0,
      'an inferred loss attempted no upload, so it must not move the upload-failure counter',
    );
  });

  /**
   * ⛔ The wording is the assertion. `logwatch` counts this family on its own and scenario F waits
   * for it, so a line reworded here and not read there passes that wait vacuously for ever.
   */
  it('announces an inferred loss in the words the harness reads it by', async () => {
    await withCapturedLog(async (lines, levels) => {
      const uploader = newUploader();

      uploader.handleInferredSegmentLoss(4, 9, 4);
      await drain(uploader);

      const announce = lines.findIndex((line) => line.includes(engineSkippedSegments(4, 9, 'stream-test', 4)));

      assert.notEqual(announce, -1, `the announce is not the composed message. Lines were:\n${lines.join('\n')}`);
      assert.equal(
        levels[announce],
        'error',
        'an inferred loss is media that is gone, so it is an error rather than an ordinary note',
      );
    });
  });

  it('restores pendingDiscontinuity across a restart so the next segment is flagged', async () => {
    const uploader = newUploader(
      {},
      {
        restoreState: {
          streamRawTopic: 'topic-abc',
          socIndex: 5,
          segments: [{ index: 0, duration: 2, ref: 'ref0', discontinuity: false }],
          hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
          isFirstSegmentReady: true,
          isFirstManifestReady: true,
          pendingDiscontinuity: true,
        },
      },
    );

    uploader.handleSegment(7, 2, Buffer.from('seg7'));
    await drain(uploader);

    const state = uploader.getStreamState();
    const seg7 = state.segments.find((s) => s.index === 7);
    assert.equal(seg7?.discontinuity, true);
    assert.equal(state.pendingDiscontinuity, false);
  });

  /**
   * The field is optional, so an entry written by a build that predates it restores as absent, and
   * absent has to mean "nothing was pending". Read the other way round, every restart of every
   * stream opens with a discontinuity the broadcast never had, which players answer by flushing
   * whatever they had buffered.
   */
  it('does not flag a discontinuity when the restored entry carries none', async () => {
    const uploader = newUploader(
      {},
      {
        restoreState: {
          streamRawTopic: 'topic-abc',
          socIndex: 5,
          segments: [{ index: 0, duration: 2, ref: 'ref0', discontinuity: false }],
          hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
          isFirstSegmentReady: true,
          isFirstManifestReady: true,
        },
      },
    );

    uploader.handleSegment(7, 2, Buffer.from('seg7'));
    await drain(uploader);

    const state = uploader.getStreamState();
    assert.equal(state.segments.find((s) => s.index === 7)?.discontinuity, false);
    assert.equal(state.pendingDiscontinuity, false);
  });

  /**
   * The marker itself is asserted above. This is what an operator is told about it, and it is the
   * only trace either kind of gap leaves here: a loss is counted by the orchestrator rather than by
   * this class, and an origin break is counted by nothing at all.
   */
  it('reports the size of a gap it marks, and an origin break as ordinary', async () => {
    await withCapturedLog(async (lines) => {
      const uploader = newUploader();

      uploader.handleSegmentLoss(4, 1);
      uploader.handleSegmentLoss(10, 40);
      uploader.markDiscontinuity();
      await drain(uploader);

      const gaps = lines.filter((line) => line.includes('never reached the uploader'));
      assert.equal(gaps.length, 2, `both gaps have to be reported, got ${gaps.length}`);
      assert.ok(gaps[0].includes('Segment 4 for stream stream-test'), gaps[0]);
      assert.ok(gaps[1].includes('40 segments from index 10 for stream stream-test'), gaps[1]);
      assert.ok(
        lines.some((line) => line.includes('Origin declared a discontinuity for stream stream-test')),
        'an encoder restart upstream marks the same flag, and nothing else says which happened',
      );
    });
  });

  it('persists pendingDiscontinuity when a segment upload fails, so it survives a crash', async () => {
    const saved: StreamState[] = [];
    const recovery = {
      save: (_id: string, state: StreamState) => {
        saved.push(state);
      },
      load: () => null,
      remove: () => {},
      listActive: () => [],
    } as unknown as RecoveryStore;
    const uploader = new StreamUploader({
      anchor: TEST_ANCHOR,
      bee: makeBee({ fail: permanentError }),
      streamCatalog: makeFakeCatalog(),
      recoveryStore: recovery,
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
    });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.ok(
      saved.some((s) => s.pendingDiscontinuity === true),
      'a failed segment upload must persist pendingDiscontinuity=true',
    );
  });
});

/**
 * The two writes take opposite `deferred` values, deliberately, and the asymmetry is the point.
 *
 * A segment is bytes nothing refers to yet, so deferring it costs a viewer nothing: by the time a
 * manifest names it, bee has pushed it (measured at 0.8s mean to a second node).
 *
 * The manifest SOC is the announcement. Deferring that one means the publish reports success while
 * the chunk is still only in the writer's local store, so a viewer's gateway is told about a
 * segment it cannot yet resolve. LAT-10: two 30-minute broadcasts with the synchronous write put
 * the worst capture-to-fetchable at 9.04s and 9.27s against 14.04s and 14.53s deferred, and the
 * buffer a player needs at 7.08s against 12.08s. The synchronous push itself costs about 300ms.
 */
describe('StreamUploader Swarm write options', () => {
  it('defers the segment upload but not the manifest feed write', async () => {
    const dataOptions: unknown[] = [];
    const payloadOptions: unknown[] = [];
    let refCounter = 0;
    const bee = {
      uploadData: async (_stamp: string, _data: unknown, opts: unknown) => {
        dataOptions.push(opts);
        return { reference: { toHex: () => `ref${refCounter++}` } };
      },
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) => {
          payloadOptions.push(opts);
          return { reference: { toHex: () => `soc${opts.index}` } };
        },
      }),
    } as unknown as Bee;

    const uploader = new StreamUploader({
      anchor: TEST_ANCHOR,
      bee,
      streamCatalog: makeFakeCatalog(),
      recoveryStore: makeFakeRecoveryStore(),
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
    });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.deepEqual(dataOptions, [{ redundancyLevel: 1, deferred: true }]);
    assert.deepEqual(payloadOptions, [{ index: 0, deferred: false }]);
  });
});

describe('StreamUploader live manifest failure surfacing', () => {
  it('flags liveManifestStale when manifest publishes fail while segments still upload', async () => {
    const uploader = newUploader({}, { feedWriteFails: true });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    const state = uploader.getStreamState();
    assert.equal(state.liveManifestStale, true);
    // The segment itself uploaded fine — only the manifest (SOC feed) write failed.
    assert.equal(state.segments.length, 1);
  });

  // The control the flag needs. Without it, a reading that is always stale passes: /health would
  // report every healthy stream as one whose viewers are stuck on a manifest that has moved on.
  it('does not flag a stale manifest while publishes are landing', async () => {
    const uploader = newUploader();

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(uploader.hasStaleLiveManifest(), false);
    assert.equal(uploader.getStreamState().liveManifestStale, false);
  });
});

/**
 * `retryUntilDeadlineAsync` and `isRetryableError` had direct unit tests in `common.test.ts` and
 * nothing else. Measured rather than assumed: replacing the retry loop's body with a bare rethrow
 * left every one of the other 27 uploader test files green, including this one, because every
 * induced failure here was a 402 chosen to keep the tests fast. So the helpers were proven, and
 * their two callers' dependence on them was not.
 *
 * TEST-1 recorded this as "the Bee mock always succeeds", which is no longer true: this file builds
 * a 402, `OmeHlsPuller.test.ts` a 503, `StreamCatalog.test.ts` a real `BeeResponseError`. The
 * conclusion held anyway, for a different reason.
 *
 * One retry costs one real backoff sleep, 175-350ms, which is why these fail once rather than
 * repeatedly.
 */
describe('StreamUploader survives a transient Bee failure (TEST-1)', () => {
  it('retries a segment upload that fails with a retryable status, and keeps the segment', async () => {
    const control = countingControl(failFirst(1, transientError));
    const uploader = newUploader(control);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(control.attempts, 2, 'a 503 has to be attempted again, not dropped on the first answer');
    assert.deepEqual(
      uploader.getStreamState().segments.map((s) => s.index),
      [0],
      'the segment survived the flake, so nothing downstream sees a gap',
    );
  });

  it('does not retry a segment upload that fails with a permanent status', async () => {
    const control = countingControl(() => permanentError());
    const uploader = newUploader(control);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(control.attempts, 1, 'a 402 means the stamp is exhausted, so retrying only burns the window');
    assert.deepEqual(uploader.getStreamState().segments, [], 'and the segment is dropped rather than held');
  });

  it('retries a live manifest publish that fails with a retryable status', async () => {
    const feedControl = countingControl(failFirst(1, transientError));
    const uploader = newUploader({}, { feedControl });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(feedControl.attempts, 2, 'the SOC write has to be attempted again');
    assert.equal(uploader.getStreamState().socIndex, 0, 'and the feed advanced, so a reader can find it');
  });

  /**
   * The stale flag needs a publish that actually fails, which a retried one never is: the retry
   * swallows the transient error before the uploader sees it, so the counter is still at its
   * initial 0 and an assertion that it is 0 cannot fail. An earlier version of the test above
   * carried exactly that assertion, and deleting `consecutiveManifestFailures = 0` from the success
   * path left all 561 tests green.
   *
   * So the reset is driven the only way it can be: fail permanently until the flag is set, then
   * succeed, and watch it go back down.
   */
  it('clears the stale-manifest flag once a publish finally succeeds', async () => {
    const feedControl = countingControl(failFirst(2, () => permanentError()));
    const uploader = newUploader({}, { feedControl });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);
    uploader.handleSegment(1, 2, Buffer.from('seg1'));
    await drain(uploader);

    assert.equal(uploader.getConsecutiveManifestFailures(), 2, 'two refused publishes have to be a stale manifest');

    uploader.handleSegment(2, 2, Buffer.from('seg2'));
    await drain(uploader);

    assert.equal(
      uploader.getConsecutiveManifestFailures(),
      0,
      'a manifest that published is not stale, and /health reports this counter',
    );
  });
});

/**
 * ⛔ **The line that tells a drained postage batch from a dead encoder.** Each rung publishes through
 * its own bee with its own prepaid batch, and a batch that runs dry stops that rung alone: bee refuses
 * every upload, the segment is dropped on the first answer, and the dead-rung rule takes the rung out
 * of the master a few segments later. An encoder that died looks the same from every other
 * instrument, and `segmentUploadFailed` says only that the retry window is spent.
 *
 * Once per stream per process rather than once per segment, because a batch that has started refusing
 * goes on refusing for as long as it stays configured and a line per segment would bury the diagnosis
 * under its own consequences. Never re-armed by a segment that lands: a filling batch refuses a
 * growing share of segments rather than all of them, and the batch itself cannot change without a
 * redeploy, which is a new process.
 */
describe('StreamUploader names the postage batch bee refused', () => {
  /** A batch id is 64 hex characters. One repeated group, so nothing here reads as a real one. */
  const BATCH = 'ba7c4de1'.repeat(8);
  /** Bee refusing a full batch: the status is what the retry policy reads, the message its own words. */
  const batchRefused =
    (status = 402) =>
    () =>
      Object.assign(new Error('batch is not usable'), { status });
  const refusalLines = (lines: readonly string[]): string[] =>
    lines.filter((line) => rungBatchRefusedPattern().test(line));

  it('writes the line once, at error level, the first time bee refuses an upload', async () => {
    await withCapturedLog(async (lines, levels) => {
      const uploader = newUploader({ fail: batchRefused() }, { stamp: BATCH });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      const refusals = refusalLines(lines);
      assert.equal(refusals.length, 1, 'a rung that went quiet with no line is indistinguishable from a dead encoder');
      assert.ok(refusals[0].includes(rungBatchRefused(BATCH, 'stream-test', 402, 'batch is not usable')), refusals[0]);
      assert.equal(levels[lines.indexOf(refusals[0])], 'error', 'a refused batch is not an informational event');
    });
  });

  /**
   * ⛔ Beside the existing drop line, never instead of it. Six suites count discontinuities off
   * `segmentUploadFailed` and the bee-outage scenario asserts on the index it names, so a diagnosis
   * that replaced it would take a segment index out of the log to say something more general.
   */
  it('keeps writing the ordinary drop line for every segment it drops', async () => {
    await withCapturedLog(async (lines) => {
      const uploader = newUploader({ fail: batchRefused() }, { stamp: BATCH });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);
      uploader.handleSegment(1, 2, Buffer.from('seg1'));
      await drain(uploader);

      assert.equal(refusalLines(lines).length, 1, 'the diagnosis is once per drain, not once per lost segment');
      for (const index of [0, 1]) {
        assert.ok(
          lines.some((line) => line.includes(segmentUploadFailed('stream-test', index))),
          `segment ${index} was dropped and no line names it`,
        );
      }
    });
  });

  /**
   * ⛔⛔⛔ **This is the shape a real batch running out has, and the opposite of what the line was
   * built for.** Measured on the first live drain, 2026-09-04: bee refused one rung's depth 17 batch
   * four times in about fifty seconds with segments landing in between. A chunk is refused only when
   * its own bucket is full, and at the first overflow about a thousandth of the buckets are, so a
   * segment of a few hundred chunks is refused about a quarter of the time and then more and more
   * often. A landed segment after a refusal is therefore the ramp and never a new batch: which batch
   * a rung spends is read once at process start, so nothing but a redeploy can change it, and a
   * redeploy is a new process with its own first line.
   */
  it('writes one line through a ramp, where segments land in between the refusals', async () => {
    await withCapturedLog(async (lines) => {
      const control: SegmentUploadControl = { fail: batchRefused() };
      const uploader = newUploader(control, { stamp: BATCH });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      control.fail = undefined;
      uploader.handleSegment(1, 2, Buffer.from('seg1'));
      await drain(uploader);

      assert.equal(refusalLines(lines).length, 1, 'precondition: the first refusal wrote its line');

      control.fail = batchRefused();
      uploader.handleSegment(2, 2, Buffer.from('seg2'));
      await drain(uploader);

      assert.equal(
        refusalLines(lines).length,
        1,
        'the batch that landed segment 1 is the same batch that refused segment 2, so the second ' +
          'refusal is the ramp continuing and a second line would read as a second drain',
      );
      assert.ok(
        lines.some((line) => line.includes(segmentUploadFailed('stream-test', 2))),
        'the segment the ramp cost still has to be named, since the diagnosis is written only once',
      );
    });
  });

  /**
   * ⛔⛔⛔ **The case a single flag lost, and it lost the finding this whole line exists to produce.**
   * Anything outside the retryable set arms the report, so one 413 on an oversized segment early in
   * a broadcast would have claimed it for the life of the process. The postage refusal that came ten
   * minutes later would then have been silent, the log would have carried one refusal naming 413,
   * and a harness counting refusals would still have counted one and filed the drain as proven
   * against evidence of something else entirely. Keyed on the status, a different answer gets its
   * own line and the ramp of identical answers still gets one.
   */
  it('says a different status even after one refusal has been reported', async () => {
    await withCapturedLog(async (lines) => {
      const control: SegmentUploadControl = { fail: batchRefused(413) };
      const uploader = newUploader(control, { stamp: BATCH });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      assert.equal(refusalLines(lines).length, 1, 'precondition: the first answer wrote its line');

      control.fail = batchRefused(402);
      uploader.handleSegment(1, 2, Buffer.from('seg1'));
      await drain(uploader);

      const statuses = refusalLines(lines).map((line) => rungBatchRefusedPattern().exec(line)?.[3]);
      assert.deepEqual(
        statuses,
        ['413', '402'],
        'the second answer is a different condition and the log has to carry it, or the drain is ' +
          'filed against whatever happened to fail first',
      );

      control.fail = batchRefused(402);
      uploader.handleSegment(2, 2, Buffer.from('seg2'));
      await drain(uploader);

      assert.equal(
        refusalLines(lines).length,
        2,
        'and a repeat of an answer already reported is the ramp, which stays one line',
      );
    });
  });

  /**
   * ⛔ Which status family bee 2.8.2 answers a full batch with is recorded nowhere in this repo, and
   * every test here assumes 402 because that is what the fixtures throw. The line carries whatever
   * arrived so the first live drain settles it, and a status read off anything but the error itself
   * would answer the question with the assumption.
   */
  it('carries the status bee answered with, not the one the fixtures assume', async () => {
    await withCapturedLog(async (lines) => {
      const uploader = newUploader({ fail: batchRefused(400) }, { stamp: BATCH });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      assert.equal(rungBatchRefusedPattern().exec(refusalLines(lines)[0] ?? '')?.[3], '400');
    });
  });

  /**
   * ⛔⛔⛔ **`error.message` on a bee failure is the HTTP client's sentence, not bee's.** bee-js builds
   * its `BeeResponseError` with axios's message and puts bee's own answer in `responseBody`, so a line
   * composed from the message prints "Request failed with status code 402" next to the 402 it
   * restates, and the one question this line exists to settle, which words bee names a full batch
   * with, stays exactly as open as it was.
   *
   * ⭐ **Every other fixture in this block is a hand-built error carrying one message**, so bee's
   * answer and the client's sentence are the same string and the call site could go back to reading
   * the message with the whole package still green. This one throws the class bee-js really throws.
   */
  it("carries bee's own words for the refusal rather than the HTTP client's sentence", async () => {
    await withCapturedLog(async (lines) => {
      const refusedByBee = () =>
        new BeeResponseError(
          'post',
          '/bytes',
          'Request failed with status code 402',
          { code: 402, message: 'batch is overissued' },
          402,
          'ERR_BAD_REQUEST',
        );
      const uploader = newUploader({ fail: refusedByBee }, { stamp: BATCH });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      const refusal = refusalLines(lines)[0] ?? '';
      assert.ok(refusal.includes('batch is overissued'), `bee's own answer is not in the line: ${refusal}`);
      assert.equal(
        refusal.includes('Request failed with status code'),
        false,
        `the line restates the status the client saw instead of what bee answered: ${refusal}`,
      );
    });
  });

  /**
   * ⛔ Scoped to the segment upload, which is a `/bytes` POST, and not to the manifest's SOC write.
   * Both spend the same batch, so a refused publish is evidence of the same condition, but it is
   * retried at the next segment and the rung keeps publishing media. Reporting it as the batch being
   * refused would say a rung had gone quiet while it was still up.
   */
  it('says nothing when only a manifest publish is refused', async () => {
    await withCapturedLog(async (lines) => {
      const uploader = newUploader({}, { feedControl: { fail: batchRefused() }, stamp: BATCH });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      assert.deepEqual(refusalLines(lines), [], 'a rung whose media is landing has not gone quiet');
    });
  });

  it('says nothing on a broadcast whose batch holds', async () => {
    await withCapturedLog(async (lines) => {
      const uploader = newUploader({}, { stamp: BATCH });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      assert.deepEqual(refusalLines(lines), []);
    });
  });
});

describe('StreamUploader finalization (CON-25)', () => {
  const ENDLIST_TAG = '#EXT-X-ENDLIST';
  const PLAYLIST_TYPE_VOD_TAG = '#EXT-X-PLAYLIST-TYPE:VOD';

  /**
   * Two callers reach `notifyStop` for one session and neither can see the other. A reconnect during a
   * drain retires the live session and hands it to `finalizeRetiredSession`, which deliberately stays
   * out of `drainPromises` because the id belongs to the replacement by then, so the guard in
   * `stopStream` that answers a duplicate stop with the in-flight drain never sees it. Both then
   * finalize the same session: two VOD manifests, each a SOC write and the postage for it, and the
   * second rewrites the catalog entry the first published.
   */
  it('publishes one VOD however many times it is asked to finalize', async () => {
    const socWrites: number[] = [];
    const published: { state: string }[] = [];
    const bee = {
      uploadData: async () => ({ reference: { toHex: () => 'ref0' } }),
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) => {
          socWrites.push(opts.index);
          return { reference: { toHex: () => `soc${opts.index}` } };
        },
      }),
    } as unknown as Bee;
    const catalog = makeFakeCatalog({
      addStream: async (entry: { state: string }) => {
        published.push(entry);
      },
    });

    const uploader = new StreamUploader({
      anchor: TEST_ANCHOR,
      bee,
      streamCatalog: catalog,
      recoveryStore: makeFakeRecoveryStore(),
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
    });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    // Sequential, not concurrent. Two calls issued before either is awaited are deduped by any memo,
    // including one that clears itself once the first settles, and that mutant survived. The second
    // stop really can arrive after the first finished: `stopStream` deletes its `drainPromises` entry
    // when the drain resolves, and `finalizeRetiredSession` never registers one at all.
    await uploader.notifyStop();
    await uploader.notifyStop();

    assert.deepEqual(
      published.map((entry) => entry.state),
      ['live', 'vod'],
      'a session announces once and finalizes once, whoever asks',
    );
    assert.deepEqual(
      socWrites,
      [0, 1, 2],
      'the live manifest, then one closing manifest and one VOD however many times finalize is asked',
    );
  });

  /**
   * The VOD manifest renumbers the playlist from zero, and it lands in the feed live viewers are
   * still walking. hls.js merges a live playlist against its predecessor and reads a media sequence
   * moving backwards as a parsing error, which its error controller escalates to fatal on a
   * single-variant stream, and the client answers a fatal parsing error by remounting the player.
   * That is how the end of a broadcast used to send a viewer back to its first second.
   *
   * So the broadcast ends on a manifest a live viewer can merge, and the recording follows it.
   */
  it('ends the live playlist before publishing the VOD that renumbers it', async () => {
    const written: string[] = [];
    const bee = {
      uploadData: async () => ({ reference: { toHex: () => 'ref0' } }),
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, data: Uint8Array, opts: { index: number }) => {
          written.push(Buffer.from(data).toString('utf-8'));
          return { reference: { toHex: () => `soc${opts.index}` } };
        },
      }),
    } as unknown as Bee;

    const uploader = new StreamUploader({
      anchor: TEST_ANCHOR,
      bee,
      streamCatalog: makeFakeCatalog(),
      recoveryStore: makeFakeRecoveryStore(),
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
    });

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);
    await uploader.notifyStop();

    const [live, closing, vod] = written;
    assert.equal(written.length, 3, `expected live, closing and VOD manifests, got ${written.length}`);
    assert.ok(!live.includes(ENDLIST_TAG), 'the live manifest is open while the broadcast runs');
    assert.ok(closing.includes(ENDLIST_TAG), 'the broadcast ends on a playlist a live viewer can merge');
    assert.ok(!closing.includes(PLAYLIST_TYPE_VOD_TAG), 'and that playlist is still the live one');
    assert.ok(vod.includes(PLAYLIST_TYPE_VOD_TAG), 'the recording is published after it, not instead of it');
  });

  /**
   * A refused closing manifest does not fail the finalization, deliberately: the recording is what
   * the catalog points at and it is still worth publishing. What is lost is only visible to whoever
   * is watching at that moment, whose player restarts at the beginning of the recording, so the log
   * line is the only place that outcome is recorded at all.
   *
   * The feed refuses the second write of three: the live manifest publishes, the closing one is
   * refused, the VOD lands.
   */
  it('says the ending was lost when the closing manifest is refused, and stays quiet when it lands', async () => {
    const lostEndings = (lines: string[]): string[] => lines.filter((line) => line.includes('closing live manifest'));

    await withCapturedLog(async (lines) => {
      const refused = newUploader({}, { feedControl: { fail: failOnly(2, permanentError) } });
      refused.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(refused);
      await refused.notifyStop();

      assert.equal(lostEndings(lines).length, 1, 'a viewer sent back to the first second has to be explainable');

      const clean = newUploader();
      clean.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(clean);
      await clean.notifyStop();

      assert.equal(lostEndings(lines).length, 1, 'and an ending that published must not report itself as lost');
    });
  });
});

describe('StreamUploader catalog announce backoff (CON-3)', () => {
  function makeCatalog(attempts: unknown[], shouldFail: () => boolean): StreamCatalog {
    return makeFakeCatalog({
      addStream: async (entry: unknown) => {
        attempts.push(entry);
        if (shouldFail()) {
          throw new Error('catalog feed write refused');
        }
      },
    });
  }

  /** Omitting the window is a case of its own: it is the one every deployment actually runs. */
  function newAnnouncingUploader(catalog: StreamCatalog, catalogAnnounceRetryMs?: number): StreamUploader {
    return new StreamUploader({
      anchor: TEST_ANCHOR,
      bee: makeBee({}),
      streamCatalog: catalog,
      recoveryStore: makeFakeRecoveryStore(),
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
      catalogAnnounceRetryMs,
    });
  }

  async function publishSegments(uploader: StreamUploader, count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      uploader.handleSegment(index, 2, Buffer.from(`seg${index}`));
      await drain(uploader);
    }
  }

  /**
   * A failed announce left `isFirstManifestReady` false, so every later manifest publish tried again:
   * a feed read, a feed write and the postage for it once per segment, for as long as the catalog was
   * down, with nothing surfaced.
   */
  it('attempts the catalog announce once per retry window, not once per segment', async () => {
    const attempts: unknown[] = [];
    const uploader = newAnnouncingUploader(
      makeCatalog(attempts, () => true),
      60_000,
    );

    await publishSegments(uploader, 5);

    assert.equal(attempts.length, 1, `five segments cost ${attempts.length} paid catalog writes against a dead feed`);
  });

  /**
   * The same rule, with nobody supplying the window. Every test above names one, so the default that
   * ships was the one configuration none of them exercised, and a default that resolves to no window
   * at all rate-limits nothing: the spend it was added to stop comes back in full.
   */
  it('rate limits on its own default, not only on a window a test supplied', async () => {
    const attempts: unknown[] = [];
    const uploader = newAnnouncingUploader(makeCatalog(attempts, () => true));

    await publishSegments(uploader, 3);

    assert.equal(attempts.length, 1, `three segments cost ${attempts.length} paid catalog writes at the default`);
  });

  /**
   * Which write failed, in the one log line an operator gets. A catalog announce and the two Swarm
   * writes at the bottom of the file all fail as a handled error with a context label, and the label
   * is the only thing separating a broadcast nobody can find from one nobody can play.
   */
  it('names the catalog announce as the write that failed', async () => {
    const capture = captureHandledErrors();
    try {
      const uploader = newAnnouncingUploader(
        makeCatalog([], () => true),
        60_000,
      );

      await publishSegments(uploader, 1);

      assert.deepEqual(
        capture.handled.map((h) => h.context),
        ['StreamUploader.notifyStart'],
      );
    } finally {
      capture.restore();
    }
  });

  /**
   * The other half, and the one that matters more: the catalog entry is the only thing that makes a
   * live broadcast discoverable, so an announce that gives up leaves the stream running and unlistable
   * for its whole duration. Suppressing the retry is a worse outcome than the cost it was suppressing.
   */
  it('keeps retrying once the window has elapsed, so a recovered catalog still lists the stream', async () => {
    const attempts: unknown[] = [];
    let catalogIsDown = true;
    const uploader = newAnnouncingUploader(
      makeCatalog(attempts, () => catalogIsDown),
      0,
    );

    await publishSegments(uploader, 2);
    assert.equal(attempts.length, 2, 'a zero window must not suppress anything');

    catalogIsDown = false;
    await publishSegments(uploader, 1);

    assert.equal(attempts.length, 3, 'the announce never landed after the catalog came back');
    assert.equal(uploader.getMsSinceCatalogAnnounceFailed(), null, 'a listed stream still reads as unlisted');
  });

  it('stops announcing once the catalog accepts it', async () => {
    const attempts: unknown[] = [];
    const uploader = newAnnouncingUploader(
      makeCatalog(attempts, () => false),
      0,
    );

    await publishSegments(uploader, 4);

    assert.equal(attempts.length, 1, 'a listed stream re-announced itself on every publish');
  });

  /**
   * An age rather than a count, because the retry window and the segment cadence are unrelated, so a
   * count of failures says nothing about how long a viewer has been unable to find the broadcast.
   */
  it('reports how long the stream has been live and unlisted', async () => {
    const attempts: unknown[] = [];
    const uploader = newAnnouncingUploader(
      makeCatalog(attempts, () => true),
      60_000,
    );

    assert.equal(uploader.getMsSinceCatalogAnnounceFailed(), null, 'nothing has failed yet');

    // Bounded by the elapsed time rather than only by zero. An age built from the instant instead of
    // the interval is positive too, and reads as the whole of the epoch, which no threshold survives.
    const startedAt = Date.now();
    await publishSegments(uploader, 1);

    const age = uploader.getMsSinceCatalogAnnounceFailed();
    assert.ok(
      age !== null && age >= 0 && age <= Date.now() - startedAt,
      `a live unlisted stream must be reportable as an age, got ${age}`,
    );
  });
});

describe('StreamUploader recovery persist failures (OBS-4)', () => {
  function newUploaderWithStore(recoveryStore: RecoveryStore): StreamUploader {
    return new StreamUploader({
      anchor: TEST_ANCHOR,
      bee: makeBee({}),
      streamCatalog: makeFakeCatalog(),
      recoveryStore,
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
    });
  }

  /**
   * A swallowed persist means recovery loads state older than reality, so a crash re-uploads or drops
   * everything written since the last save that landed. Nothing outside the log said it had happened.
   */
  it('reports how long state has been failing to persist', async () => {
    let saveFails = true;
    const uploader = newUploaderWithStore(
      makeFakeRecoveryStore({
        save: () => {
          if (saveFails) {
            throw new Error('ENOSPC: no space left on device');
          }
        },
      }),
    );

    assert.equal(uploader.getMsSinceStatePersistFailed(), null, 'nothing has been written yet');

    // Bounded by the elapsed time, for the reason given beside the catalog announce age above.
    const startedAt = Date.now();
    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    const age = uploader.getMsSinceStatePersistFailed();
    assert.ok(
      age !== null && age >= 0 && age <= Date.now() - startedAt,
      `a stream whose state is not on disk must be reportable as an age, got ${age}`,
    );

    saveFails = false;
    uploader.handleSegment(1, 2, Buffer.from('seg1'));
    await drain(uploader);

    assert.equal(uploader.getMsSinceStatePersistFailed(), null, 'a save that landed must clear the signal');
  });
});

/**
 * A Swarm reference at the width the uploader really publishes, which is what sizes the live window.
 *
 * The window is a byte budget and a segment line is a duration and a reference, so how many segments
 * fit is decided by how long a reference is. The `ref0` the fixtures elsewhere in this file use is
 * four characters against a real one's sixty-four, and at that width it would take about 250
 * segments to overflow one chunk rather than the {@link OVERFLOWING_SEGMENT_COUNT} used here.
 *
 * This replaces a 1,000-character `MANIFEST_ACCESS_URL` that used to be prepended to every line for
 * the same purpose. That variable is gone, and the fixture is the better for it: overflowing at a
 * real reference width is the state the deployment actually reaches, at 36 segments and a 0.25s GOP.
 */
function wideRef(index: number): string {
  return index.toString(16).padStart(64, '0');
}

/**
 * More segments than one chunk of manifest can name, so the window outruns a held publish.
 *
 * Fifty-two fit at this reference width and a 2s segment, so this leaves a margin either side of the
 * boundary rather than sitting on it. Nine seconds of a stalled publish at the 0.25s profile, and a
 * publish may retry for fifteen.
 */
const OVERFLOWING_SEGMENT_COUNT = 60;

/** How many of `count` segments a live manifest built the same way would actually name. */
function liveWindowSize(count: number): number {
  const probe = new ManifestManager(TEST_ANCHOR);
  for (let i = 0; i < count; i++) {
    probe.addSegment(i, 2, wideRef(i));
  }
  return probe
    .buildLiveManifest()
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#')).length;
}

/**
 * A bee whose first feed write blocks until released, so segments pile up behind one publish.
 *
 * `socWrites` collects the feed index of every publish, which is what a paid SOC write looks like
 * from outside: one entry is one chunk and the postage for it.
 */
function beeWithHeldFirstPublish(held: Promise<void>, entered: () => void, socWrites: number[] = []): Bee {
  let refCounter = 0;
  const bee = {
    uploadData: async () => ({ reference: { toHex: () => wideRef(refCounter++) } }),
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, _data: unknown, opts: { index: number }) => {
        socWrites.push(opts.index);
        if (socWrites.length === 1) {
          entered();
          await held;
        }
        return { reference: { toHex: () => `soc${opts.index}` } };
      },
    }),
  };
  return bee as unknown as Bee;
}

interface UploaderFixtureOptions {
  restoreState?: unknown;
  metrics?: ServiceMetrics;
  /** Present makes this one rung of a ladder, absent makes it a single-rendition stream. */
  ladder?: { group: string; rung: { name: string; width: number; height: number; configuredKbps: number } };
  /** A catalog to watch, where the default one accepts everything and remembers nothing. */
  streamCatalog?: StreamCatalog;
}

function uploaderWith(bee: Bee, options: UploaderFixtureOptions = {}): StreamUploader {
  return new StreamUploader({
    anchor: TEST_ANCHOR,
    bee,
    streamCatalog: options.streamCatalog ?? makeFakeCatalog(),
    recoveryStore: makeFakeRecoveryStore(),
    streamKey: TEST_STREAM_KEY,
    stamp: 'stamp',
    redundancyLevel: 1,
    streamId: 'stream-test',
    streamTopic: 'topic-test',
    mediatype: MEDIA_TYPE_VIDEO,
    restoreState: options.restoreState as never,
    metrics: options.metrics,
    ladder: options.ladder,
  });
}

/** A publish held at the first feed write, with the handles to know it started and to let it finish. */
function heldPublish(socWrites: number[] = []): { bee: Bee; started: Promise<void>; release: () => void } {
  let release = (): void => {};
  let entered = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  return {
    bee: beeWithHeldFirstPublish(held, () => entered(), socWrites),
    started,
    release: () => release(),
  };
}

/**
 * One publish for a burst, rather than one per segment.
 *
 * Every segment calls `uploadLiveManifest`, and every publish that reaches Bee is a SOC write and the
 * postage for it. `liveManifestQueued` is what holds that at one write per publish while a publish is
 * slow. The block below is the same condition read the other way: this is what it costs, that is what
 * it loses.
 */
describe('StreamUploader live manifest publish coalescing', () => {
  it('publishes once for a burst that arrives behind an in-flight publish', async () => {
    const socWrites: number[] = [];
    const publish = heldPublish(socWrites);
    const uploader = uploaderWith(publish.bee);

    uploader.handleSegment(0, 2, Buffer.from('a'));
    await publish.started;

    for (let index = 1; index <= 9; index++) {
      uploader.handleSegment(index, 2, Buffer.from('a'));
    }
    await uploader.segmentQueue.onIdle();

    publish.release();
    await drain(uploader);

    assert.deepEqual(
      socWrites,
      [0, 1],
      `ten segments behind one held publish cost ${socWrites.length} paid feed writes`,
    );
  });
});

/**
 * The quietest way this uploader can lose a piece of a broadcast.
 *
 * A viewer learns of a segment only from a manifest naming it. `uploadLiveManifest` coalesces behind
 * `liveManifestQueued` while a publish is in flight, and the segment queue is a separate queue that
 * keeps running, so a publish slow enough lets the window advance past segments that were uploaded
 * perfectly well. Their bytes are in Swarm. No playlist names them, and `pendingDiscontinuity`
 * answers a failed upload rather than this, so not even a discontinuity marks the hole.
 */
describe('segments the live window outran before anything published them', () => {
  it('counts the segments no published manifest ever named, and says so', async () => {
    await withCapturedLog(async (lines) => {
      const publish = heldPublish();
      const uploader = uploaderWith(publish.bee);

      // The first publish names segment 0 alone, and is held there.
      uploader.handleSegment(0, 2, Buffer.from('a'));
      await publish.started;

      // The rest upload while it is held, so the next publish is built from all of them.
      for (let index = 1; index < OVERFLOWING_SEGMENT_COUNT; index++) {
        uploader.handleSegment(index, 2, Buffer.from('a'));
      }
      await uploader.segmentQueue.onIdle();

      publish.release();
      await drain(uploader);

      const named = liveWindowSize(OVERFLOWING_SEGMENT_COUNT);
      assert.ok(
        named < OVERFLOWING_SEGMENT_COUNT - 1,
        `fixture must overflow the window, but it named ${named} of ${OVERFLOWING_SEGMENT_COUNT}`,
      );
      // Everything after segment 0 and before the window: the whole fixture, less the window, less segment 0.
      const lost = OVERFLOWING_SEGMENT_COUNT - named - 1;
      assert.equal(uploader.getSegmentsNeverNamed(), lost);
      // The counter is read by /health. The line is what says which segments and when, and it is the
      // last thing the publish does, so it also proves the publish finished rather than threw.
      assert.ok(
        lines.some((line) => line.includes(`skipped ${lost} uploaded segment(s)`)),
        `no line reported the ${lost} segments this stream published nothing for`,
      );
    });
  });

  /**
   * ⛔ The reading the per-rung split turns on. Four rungs at 0.5s segments need 2.00 uploads a second
   * each and 8.00 between them, and one shared Bee node was measured delivering 5.61 in total. The
   * only answer available before this was a grep of the service's log, which is not where the decision
   * is made. Asserted end to end from a published segment, because the counter is only worth having if
   * the rung actually reaches it.
   */
  /**
   * ⛔⛔⛔ **The one call the whole dead-rung mechanism hangs off, and a mutation run found nothing
   * watching it.** Turning `if (this.ladder)` to false left every test in this package green, and
   * that call is how the catalog learns a rung is still delivering. Without it no rung ever looks
   * alive, so the master is never rewritten: a rung that goes quiet is never dropped from it, and a
   * rung that comes back is never restored. Both drain suites and V3 read the master for their
   * verdict, so a paid broadcast would report the product on a live line nobody made.
   *
   * ⭐ A single-rendition stream deliberately records nothing, because a stream with no ladder has no
   * rung to be the liveness of, and the catalog would have nothing to key it by.
   */
  it("tells the catalog its rung delivered, which is what keeps a rung in the ladder's master", async () => {
    const delivered: Array<[string, string]> = [];
    const watching = makeFakeCatalog({
      recordRungDelivered: (group: string, rung: string) => {
        delivered.push([group, rung]);
      },
    });
    const uploader = uploaderWith(makeBee({}), {
      streamCatalog: watching,
      ladder: { group: 'group-1', rung: { name: '720p', width: 1280, height: 720, configuredKbps: 2800 } },
    });

    uploader.handleSegment(0, 2, Buffer.from('a'));
    await drain(uploader);

    assert.deepEqual(delivered, [['group-1', '720p']], 'a landed segment is what marks its rung alive');
  });

  it('tells the catalog nothing about a rung on a stream that has no ladder', async () => {
    const delivered: string[] = [];
    const watching = makeFakeCatalog({
      recordRungDelivered: (_group: string, rung: string) => {
        delivered.push(rung);
      },
    });
    const uploader = uploaderWith(makeBee({}), { streamCatalog: watching });

    uploader.handleSegment(0, 2, Buffer.from('a'));
    await drain(uploader);

    assert.deepEqual(delivered, [], 'a single-rendition stream has no rung whose liveness this could be');
  });

  it('counts an upload against its rung as well as against the total', async () => {
    const metrics = new ServiceMetrics();
    const uploader = uploaderWith(makeBee({}), {
      metrics,
      ladder: { group: 'group-1', rung: { name: '720p', width: 1280, height: 720, configuredKbps: 2800 } },
    });

    uploader.handleSegment(0, 2, Buffer.from('a'));
    await drain(uploader);

    const counters = metrics.getCounters();
    assert.equal(counters.segmentsUploadedTotal, 1);
    assert.deepEqual(counters.segmentsUploadedByRung, { '720p': 1 });
  });

  /**
   * ⛔ Under no rung, rather than under a placeholder one. A segment from a single-rendition stream
   * belongs to no rung, and inventing one would make the breakdown's sum look complete while naming a
   * rung the deployment does not have. So the two counters are not required to agree, and a check
   * that insisted they did would be wrong.
   */
  it('counts a single-rendition upload in the total and under no rung', async () => {
    const metrics = new ServiceMetrics();
    const uploader = uploaderWith(makeBee({}), { metrics });

    uploader.handleSegment(0, 2, Buffer.from('a'));
    await drain(uploader);

    const counters = metrics.getCounters();
    assert.equal(counters.segmentsUploadedTotal, 1);
    assert.deepEqual(counters.segmentsUploadedByRung, {});
  });

  /**
   * ⛔ What a drained postage batch costs, per rung. `segmentsDroppedTotal` climbs whether one rung of
   * four lost everything or all four lost a little, so on a ladder it cannot say which quality a
   * viewer stopped being offered. The refusal line names the batch, this names the loss.
   *
   * Asserted end to end from a refused upload rather than off the counter, because a per-rung counter
   * the drop path never reaches is worth nothing on the deployment it was added for.
   */
  it('counts a dropped segment against its rung as well as against the total', async () => {
    const metrics = new ServiceMetrics();
    const uploader = uploaderWith(makeBee({ fail: permanentError }), {
      metrics,
      ladder: { group: 'group-1', rung: { name: '1080p', width: 1920, height: 1080, configuredKbps: 6000 } },
    });

    uploader.handleSegment(0, 2, Buffer.from('a'));
    await drain(uploader);

    const counters = metrics.getCounters();
    assert.equal(counters.segmentsDroppedTotal, 1);
    assert.deepEqual(counters.segmentsDroppedByRung, { '1080p': 1 });
    assert.deepEqual(counters.segmentsUploadedByRung, {}, 'a dropped segment must not also count as one that landed');
  });

  /** Under no rung, for the reason the uploaded breakdown leaves a rung-less segment out of its own. */
  it('counts a single-rendition drop in the total and under no rung', async () => {
    const metrics = new ServiceMetrics();
    const uploader = uploaderWith(makeBee({ fail: permanentError }), { metrics });

    uploader.handleSegment(0, 2, Buffer.from('a'));
    await drain(uploader);

    const counters = metrics.getCounters();
    assert.equal(counters.segmentsDroppedTotal, 1);
    assert.deepEqual(counters.segmentsDroppedByRung, {});
  });

  it('counts nothing while every segment still reaches a manifest', async () => {
    const metrics = new ServiceMetrics();
    const reported: number[] = [];
    metrics.recordSegmentsNeverNamed = (count: number) => {
      reported.push(count);
    };
    const uploader = uploaderWith(makeBee({}), { metrics });

    for (let index = 0; index < 5; index++) {
      uploader.handleSegment(index, 2, Buffer.from('a'));
      await drain(uploader);
    }

    assert.equal(uploader.getSegmentsNeverNamed(), 0);
    // A counter incremented by zero reads the same as one never touched, so the guard that stops
    // this reporting a loss on every healthy publish is only visible in the calls themselves.
    assert.deepEqual(reported, [], 'a publish that skipped nothing must not report a loss of zero');
  });

  /**
   * Segments a restart reloaded are not this session's to lose, which is why `announcedThrough`
   * starts at null rather than at whatever the recovery entry said. The window a recovered uploader
   * publishes is built from segments it did reload, so counting against a restored high-water reports
   * the whole outage as segments this session uploaded and failed to name, when nothing here failed.
   */
  it('does not count reloaded segments as segments it failed to name', async () => {
    const restored = Array.from({ length: OVERFLOWING_SEGMENT_COUNT }, (_, index) => ({
      index,
      duration: 2,
      ref: wideRef(index),
      discontinuity: false,
    }));
    const uploader = uploaderWith(makeBee({}), {
      restoreState: {
        streamRawTopic: 'topic-abc',
        socIndex: 5,
        segments: restored,
        hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
        isFirstSegmentReady: true,
        isFirstManifestReady: true,
      },
    });

    uploader.handleSegment(OVERFLOWING_SEGMENT_COUNT, 2, Buffer.from('a'));
    await drain(uploader);

    const offered = OVERFLOWING_SEGMENT_COUNT + 1;
    assert.ok(
      liveWindowSize(offered) < offered,
      'fixture must overflow the window, or a restored high-water would count nothing either',
    );
    assert.equal(uploader.getSegmentsNeverNamed(), 0, 'a restart published one manifest and lost nothing');
  });
});

interface HandledError {
  error: unknown;
  context?: string;
}

/**
 * Collect what the shared `ErrorHandler` was told, and put it back afterwards.
 *
 * Every uploader in the process reports through `ErrorHandler.getInstance()`, so replacing the method
 * on that one object is enough to see the calls. The assignment shadows the prototype rather than
 * overwriting it, which is why restoring is a delete and not a second assignment.
 */
function captureHandledErrors(): { handled: HandledError[]; restore: () => void } {
  const handler = ErrorHandler.getInstance();
  const handled: HandledError[] = [];

  handler.handleError = (error: unknown, context?: string) => {
    handled.push({ error, context });
  };

  return {
    handled,
    restore: () => {
      Reflect.deleteProperty(handler, 'handleError');
    },
  };
}

/**
 * What an operator is told when a Swarm write fails, and which of the two writes it was.
 *
 * Both writes turn a failure into a falsy return so the caller can mark a discontinuity instead of
 * losing its queue task to a rejection, and the blocks above cover that half. The other half, the
 * report, had nothing at all: the Stryker run of 2026-08-04 emptied either catch block and blanked
 * the context label, and all three mutants survived the entire suite.
 *
 * The label is the only thing in a log line that separates the two, and they are not the same
 * incident. A lost segment leaves a hole the next manifest marks as a discontinuity and a player
 * skips past. A lost manifest leaves every viewer holding the last one that landed, watching a
 * stream that has moved on without them.
 *
 * The labels are written out here rather than imported from the source. Importing them would assert
 * each against itself, which is the trap `e2e/src/bench/clientTuning.ts` records.
 */
describe('StreamUploader reporting which Swarm write failed', () => {
  it('names the segment write, and carries the error Bee refused it with', async () => {
    const capture = captureHandledErrors();
    try {
      const uploader = newUploader({ fail: permanentError });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      assert.deepEqual(
        capture.handled.map((h) => h.context),
        ['StreamUploader.uploadDataToBee'],
      );
      assert.equal((capture.handled[0].error as Error).message, '402 payment required');
    } finally {
      capture.restore();
    }
  });

  it('names the manifest write, which fails the same way and costs a viewer something else', async () => {
    const capture = captureHandledErrors();
    try {
      const uploader = newUploader({}, { feedWriteFails: true });

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      assert.deepEqual(
        capture.handled.map((h) => h.context),
        ['StreamUploader.uploadDataAsSoc'],
      );
      assert.equal((capture.handled[0].error as Error).message, '402 payment required');
    } finally {
      capture.restore();
    }
  });

  // The control the three above need. Without it a capture that reported on every publish would pass
  // all of them, and the label would stop meaning that anything went wrong.
  it('reports nothing when both writes land', async () => {
    const capture = captureHandledErrors();
    try {
      const uploader = newUploader();

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);

      assert.deepEqual(capture.handled, []);
    } finally {
      capture.restore();
    }
  });
});

/**
 * The title is what a viewer reads when picking a broadcast out of the catalog, and both entries this
 * uploader writes carry it: the announce that lists a live stream and the VOD entry that replaces it.
 *
 * The clock is frozen on a single-digit day and month, which is the only shape that tells a padded
 * field from an unpadded one, and it makes the expected title a literal rather than the same
 * arithmetic the source does. Reimplementing the format here would assert it against itself, which is
 * the trap `e2e/src/bench/clientTuning.ts` records.
 */
describe('StreamUploader catalog entry title', () => {
  it('titles a stream with the day it went live, zero padded', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 2, 5, 12, 0, 0).getTime() });

    const published: { title: string }[] = [];
    const uploader = new StreamUploader({
      anchor: TEST_ANCHOR,
      bee: makeBee({}),
      streamCatalog: makeFakeCatalog({
        addStream: async (entry: { title: string }) => {
          published.push(entry);
        },
      }),
      recoveryStore: makeFakeRecoveryStore(),
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
    });

    await uploader.notifyStart();

    assert.deepEqual(
      published.map((entry) => entry.title),
      ['05/03/2026'],
    );
  });
});

/**
 * A recovery entry that says the catalog announce happened before the first segment did.
 *
 * No live sequence can produce that pair, since the announce is gated on the segment, so the entry on
 * disk was corrupted or hand-edited. It is repaired rather than refused, for the reasons on
 * `readinessFromPersisted`, and a silent repair is how a deployment goes on writing damaged entries
 * with nothing to show for it.
 */
describe('StreamUploader restoring an impossible recovery entry', () => {
  function restoredFrom(readiness: { isFirstSegmentReady: boolean; isFirstManifestReady: boolean }): void {
    newUploader(
      {},
      {
        restoreState: {
          streamRawTopic: 'topic-abc',
          socIndex: 5,
          segments: [{ index: 0, duration: 2, ref: 'ref0', discontinuity: false }],
          hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
          ...readiness,
        },
      },
    );
  }

  it('warns that the entry could not have been written by a live stream, and only then', async () => {
    await withCapturedLog(async (lines) => {
      const repairs = (): string[] => lines.filter((line) => line.includes('claims the catalog announce'));

      restoredFrom({ isFirstSegmentReady: false, isFirstManifestReady: true });
      assert.equal(repairs().length, 1, 'a repair nobody is told about is a corrupt store nobody fixes');
      assert.ok(repairs()[0].includes('stream-test'), repairs()[0]);

      // Every ordinary restart passes through the same line. A warning that fires on all of them says
      // nothing about any of them, and every recovery entry on disk starts looking hand-edited.
      restoredFrom({ isFirstSegmentReady: true, isFirstManifestReady: true });
      restoredFrom({ isFirstSegmentReady: true, isFirstManifestReady: false });
      restoredFrom({ isFirstSegmentReady: false, isFirstManifestReady: false });
      assert.equal(repairs().length, 1, 'a reachable pair is not a repair');
    });
  });
});

describe('StreamUploader catalog failures on the segment path', () => {
  const LADDER = {
    group: 'group-1',
    rung: { name: '360p', width: 640, height: 360, configuredKbps: 800 },
  };

  function primeForDriftCorrection(uploader: StreamUploader): void {
    const inner = uploader as unknown as {
      readiness: AnnounceReadiness;
      driftBaselineBps: number;
      lastAnnounceAttemptAt: number;
      bitrate: { peakBps: number };
    };
    // The real guard refreshBandwidthIfDrifted reads. Priming a segment while already ANNOUNCED is
    // what makes the segment path take the drift-refresh branch rather than the initial announce, so
    // the announce these tests observe is the correction and not the first publish.
    inner.readiness = READINESS_ANNOUNCED;
    inner.driftBaselineBps = 1_000_000;
    inner.lastAnnounceAttemptAt = 0;
    inner.bitrate.peakBps = 5_000_000;
  }

  /** onIdle resolves whether or not a task rejected, so the rejection needs a loop turn to arrive. */
  function letRejectionsSurface(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 50));
  }

  function uploaderWithCatalog(catalog: StreamCatalog, saved: StreamState[] = []): StreamUploader {
    const recovery = {
      save: (_id: string, state: StreamState) => {
        saved.push(state);
      },
      load: () => null,
      remove: () => {},
      listActive: () => [],
    } as unknown as RecoveryStore;

    return new StreamUploader({
      anchor: TEST_ANCHOR,
      bee: makeBee({}),
      streamCatalog: catalog,
      recoveryStore: recovery,
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
      ladder: LADDER,
    });
  }

  it('keeps a failed rendition announcement inside the segment task', async () => {
    // The listener is the assertion. Watching persistState instead proves nothing — commitManifest
    // persists from the manifest queue too, so state lands either way and the escape hides.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const catalog = {
      addStream: async () => {},
      upsertRendition: async () => {
        throw new Error('catalog feed read failed after the retry window');
      },
      recordRungDelivered: () => {},
    } as unknown as StreamCatalog;

    try {
      const uploader = uploaderWithCatalog(catalog);
      primeForDriftCorrection(uploader);

      uploader.handleSegment(0, 2, Buffer.from('seg0'));
      await drain(uploader);
      await letRejectionsSurface();

      assert.equal(uploader.getStreamState().segments.length, 1, 'the segment itself must still be recorded');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(
      rejections.map((r) => (r as Error)?.message),
      [],
      'a failing catalog write must not escape the segment queue as an unhandled rejection',
    );
  });

  it('does not advance the drift baseline when the announcement failed to land', async () => {
    // Advance it on a write the catalog never received and the next comparison measures the new
    // bandwidth against itself: no drift, and the correction is never retried.
    const catalog = {
      addStream: async () => {},
      upsertRendition: async () => {
        throw new Error('catalog feed read failed after the retry window');
      },
      recordRungDelivered: () => {},
    } as unknown as StreamCatalog;

    const uploader = uploaderWithCatalog(catalog);
    primeForDriftCorrection(uploader);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    const inner = uploader as unknown as { driftBaselineBps: number };
    assert.equal(inner.driftBaselineBps, 1_000_000, 'the unpublished bandwidth must not become the baseline');
  });

  it('advances the drift baseline once the announcement lands', async () => {
    const announced: number[] = [];
    const catalog = {
      addStream: async () => {},
      upsertRendition: async (_identity: unknown, rendition: { bandwidth: number }) => {
        announced.push(rendition.bandwidth);
      },
      recordRungDelivered: () => {},
    } as unknown as StreamCatalog;

    const uploader = uploaderWithCatalog(catalog);
    primeForDriftCorrection(uploader);

    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    assert.equal(announced.length, 1);
    const inner = uploader as unknown as { driftBaselineBps: number };
    assert.equal(inner.driftBaselineBps, announced[0]);
    assert.notEqual(inner.driftBaselineBps, 1_000_000);
  });
});

describe('StreamUploader ladder finalize metrics', () => {
  const LADDER = {
    group: 'group-1',
    rung: { name: '360p', width: 640, height: 360, configuredKbps: 800 },
  };

  function ladderUploader(metrics: ServiceMetrics): StreamUploader {
    const recovery = {
      save: () => {},
      load: () => null,
      remove: () => {},
      listActive: () => [],
    } as unknown as RecoveryStore;
    const catalog = {
      addStream: async () => {},
      upsertRendition: async () => {},
      recordRungDelivered: () => {},
    } as unknown as StreamCatalog;

    return new StreamUploader({
      anchor: TEST_ANCHOR,
      bee: makeBee({}),
      streamCatalog: catalog,
      recoveryStore: recovery,
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: 'topic-test',
      mediatype: MEDIA_TYPE_VIDEO,
      ladder: LADDER,
      metrics,
    });
  }

  it('counts a finalized ABR broadcast in streams_finalized_total', async () => {
    let finalized = 0;
    const metrics = new ServiceMetrics();
    metrics.recordStreamFinalized = () => {
      finalized += 1;
    };

    const uploader = ladderUploader(metrics);
    uploader.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(uploader);

    await uploader.notifyStop();

    assert.equal(finalized, 1, 'the ladder finalize path never counted the recording it published');
  });
});

describe('StreamUploader ladder re-announce safety', () => {
  const LADDER = {
    group: 'group-1',
    rung: { name: '360p', width: 640, height: 360, configuredKbps: 800 },
  };

  interface CatalogRung {
    name: string;
    topic: string;
  }

  function ladderUploaderOn(topic: string, catalog: StreamCatalog): StreamUploader {
    const recovery = {
      save: () => {},
      load: () => null,
      remove: () => {},
      listActive: () => [],
    } as unknown as RecoveryStore;

    return new StreamUploader({
      anchor: TEST_ANCHOR,
      bee: makeBee({}),
      streamCatalog: catalog,
      recoveryStore: recovery,
      streamKey: TEST_STREAM_KEY,
      stamp: 'stamp',
      redundancyLevel: 1,
      streamId: 'stream-test',
      streamTopic: topic,
      mediatype: MEDIA_TYPE_VIDEO,
      ladder: LADDER,
    });
  }

  it('a retired session does not overwrite the live rung when it finalizes', async () => {
    // The shared ladder entry, keyed by rung name exactly as the real catalog's mergeRendition keys
    // it, so an upsert for a name that already exists replaces the previous session's rung.
    const rungsByName = new Map<string, CatalogRung>();
    const catalog = {
      addStream: async () => {},
      upsertRendition: async (_identity: unknown, rendition: { name: string; topic: string }) => {
        rungsByName.set(rendition.name, { name: rendition.name, topic: rendition.topic });
      },
      recordRungDelivered: () => {},
    } as unknown as StreamCatalog;

    // The outgoing session for the 360p rung, on its own feed topic. Publishing a segment gives it a
    // recording to finalize and lands its own live announce.
    const outgoing = ladderUploaderOn('outgoing-topic', catalog);
    outgoing.handleSegment(0, 2, Buffer.from('seg0'));
    await drain(outgoing);
    assert.equal(
      rungsByName.get('360p')?.topic,
      'outgoing-topic',
      'the live announce should land while it owns the rung',
    );

    // A transcode restart re-announces 360p to a new session on a new topic, now the live rung, and
    // retires the outgoing session so it no longer owns the shared entry.
    rungsByName.set('360p', { name: '360p', topic: 'live-topic' });
    outgoing.retire();

    // The outgoing session finalizes late, after the new session already published live.
    await outgoing.notifyStop();

    assert.equal(
      rungsByName.get('360p')?.topic,
      'live-topic',
      'the retired session clobbered the live rung on finalize',
    );
  });
});
