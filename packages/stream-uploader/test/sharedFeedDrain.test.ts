import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminApiClient, STATE_REPORT_ACCEPTED } from '../src/libs/AdminApiClient.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_AUDIO, STOP_FAILURE_DRAIN_TIMEOUT, STREAM_LIFECYCLE_FAILED } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { FakeFeedHead, makeFakeRecoveryStore, makeRecoveredState, makeTestOrchestrator } from './helpers/fakes.js';
import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

const STREAM_ID = 'audio/declared-stream';
const DECLARATION: AdminSession = { id: 'admin-stream-id', topic: 'declared-topic' };
const DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const SETTLE_CEILING_MS = 4_000;
const QUIET_WINDOW_MS = 60;

interface ManifestWrite {
  index: number;
  playlist: string;
}

/** One promise a test controls without exposing its resolver before construction. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * One declared feed whose first VOD write stays in flight until the test releases it.
 *
 * The feed head changes only after a write completes. This models the part the handover gate protects:
 * a successor that reads while the predecessor VOD is still in flight sees the closing playlist and
 * chooses the same next index as that VOD.
 */
function sharedFeedHarness(options: { recovered?: boolean } = {}): {
  orchestrator: StreamOrchestrator;
  clock: FakeClock;
  writes: ManifestWrite[];
  uploadedSegments: string[];
  feedHeadReads: () => number;
  releaseFirstVod: () => void;
  firstVodStarted: () => boolean;
  start: () => void;
  segment: (label: string, index: number) => Promise<void>;
} {
  const clock = new FakeClock();
  const firstVod = deferred();
  const writes: ManifestWrite[] = [];
  const uploadedSegments: string[] = [];
  let head: FakeFeedHead | null = options.recovered
    ? {
        index: 3,
        manifest: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nref0\n',
      }
    : null;
  let reads = 0;
  let blockFirstVod = true;
  let vodStarted = false;

  const adminApi = {
    describe: () => 'http://admin.test',
    reportState: async () => STATE_REPORT_ACCEPTED,
  } as unknown as AdminApiClient;

  const recoveredState = {
    ...makeRecoveredState(STREAM_ID),
    streamRawTopic: DECLARATION.topic,
    mediatype: MEDIA_TYPE_AUDIO,
    adminStreamId: DECLARATION.id,
  };
  const recoveryStore = options.recovered
    ? makeFakeRecoveryStore({
        listActive: () => [STREAM_ID],
        load: () => recoveredState,
      })
    : makeFakeRecoveryStore();

  const orchestrator = makeTestOrchestrator(
    {
      adminApi,
      clock,
      // Advancing through the five minute drain deadline must not reap the live successor.
      orphanReapMs: DRAIN_TIMEOUT_MS * 4,
    },
    {
      uploadData: async (_stamp, data) => {
        const label = Buffer.from(data).toString('utf8');
        uploadedSegments.push(label);
        return { reference: { toHex: () => `segment-${label}` } };
      },
      feedHead: () => {
        reads += 1;
        return head;
      },
      uploadPayload: async (index, payload) => {
        const playlist = String(payload);
        if (blockFirstVod && playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD')) {
          blockFirstVod = false;
          vodStarted = true;
          await firstVod.promise;
        }
        writes.push({ index, playlist });
        head = { index, manifest: playlist };
        return { reference: { toHex: () => `soc-${index}` } };
      },
    },
    recoveryStore,
  );

  return {
    orchestrator,
    clock,
    writes,
    uploadedSegments,
    feedHeadReads: () => reads,
    releaseFirstVod: firstVod.resolve,
    firstVodStarted: () => vodStarted,
    start: () => {
      assert.equal(
        orchestrator.startStream(STREAM_ID, MEDIA_TYPE_AUDIO, undefined, DECLARATION),
        true,
        'the declared session must be admitted',
      );
    },
    segment: async (label, index) => {
      assert.deepEqual(orchestrator.handleSegment(STREAM_ID, index, 2, Buffer.from(label)), { accepted: true });
      await waitFor(() => uploadedSegments.includes(label), SETTLE_CEILING_MS);
    },
  };
}

function writesNaming(writes: ManifestWrite[], segment: string): ManifestWrite[] {
  return writes.filter((write) => write.playlist.includes(`segment-${segment}`));
}

async function beginBlockedVod(harness: ReturnType<typeof sharedFeedHarness>): Promise<void> {
  harness.start();
  await harness.segment('a0', 0);
  await waitFor(() => writesNaming(harness.writes, 'a0').length === 1, SETTLE_CEILING_MS);
  harness.start();
  await waitFor(harness.firstVodStarted, SETTLE_CEILING_MS);
}

async function releaseVodAndPublishSuccessor(
  harness: ReturnType<typeof sharedFeedHarness>,
  successorSegment: string,
  successorIndex: number,
): Promise<void> {
  harness.releaseFirstVod();
  await waitFor(
    () => harness.writes.some((write) => write.playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD')),
    SETTLE_CEILING_MS,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await harness.segment(successorSegment, successorIndex);
  await waitFor(() => writesNaming(harness.writes, successorSegment).length > 0, SETTLE_CEILING_MS);

  const vodIndex = harness.writes.find((write) => write.playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD'))?.index;
  const successorWrite = writesNaming(harness.writes, successorSegment)[0];
  assert.ok(vodIndex !== undefined);
  assert.ok(successorWrite.index > vodIndex, 'the successor must publish above the completed predecessor VOD');
}

async function releaseOutstandingVod(harness: ReturnType<typeof sharedFeedHarness>): Promise<void> {
  harness.releaseFirstVod();
  if (harness.firstVodStarted()) {
    await waitFor(
      () => harness.writes.some((write) => write.playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD')),
      SETTLE_CEILING_MS,
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
}

describe('shared manifest feeds wait for every outstanding predecessor write', () => {
  it('keeps a re-announced successor gated after the bounded predecessor stop times out', async () => {
    const harness = sharedFeedHarness();
    try {
      await beginBlockedVod(harness);
      await harness.segment('b0', 0);

      const readsBeforeDeadline = harness.feedHeadReads();
      await harness.clock.advance(DRAIN_TIMEOUT_MS + 1);
      await harness.segment('b1', 1);

      await waitAndConfirmNothingHappened(
        () => harness.feedHeadReads() === readsBeforeDeadline && writesNaming(harness.writes, 'b0').length === 0,
        QUIET_WINDOW_MS,
      );

      await releaseVodAndPublishSuccessor(harness, 'b2', 2);
    } finally {
      await releaseOutstandingVod(harness);
    }
  });

  it('keeps a fresh session gated when an explicit stop timed out but its VOD write is still running', async () => {
    const harness = sharedFeedHarness();
    try {
      harness.start();
      await harness.segment('a0', 0);
      await waitFor(() => writesNaming(harness.writes, 'a0').length === 1, SETTLE_CEILING_MS);

      const stopped = harness.orchestrator.stopStream(STREAM_ID);
      await waitFor(harness.firstVodStarted, SETTLE_CEILING_MS);
      await harness.clock.advance(DRAIN_TIMEOUT_MS + 1);
      await stopped;

      const timedOutStatus = harness.orchestrator.getStreamStatus(STREAM_ID);
      assert.equal(timedOutStatus.state, STREAM_LIFECYCLE_FAILED);
      assert.equal(timedOutStatus.reason, STOP_FAILURE_DRAIN_TIMEOUT);

      harness.start();
      const readsBeforeSuccessor = harness.feedHeadReads();
      await harness.segment('b0', 0);

      await waitAndConfirmNothingHappened(
        () => harness.feedHeadReads() === readsBeforeSuccessor && writesNaming(harness.writes, 'b0').length === 0,
        QUIET_WINDOW_MS,
      );

      await releaseVodAndPublishSuccessor(harness, 'b1', 1);
    } finally {
      await releaseOutstandingVod(harness);
    }
  });

  it('keeps a fresh declared session gated after a recovered admin session times out', async () => {
    const harness = sharedFeedHarness({ recovered: true });
    try {
      assert.deepEqual(await harness.orchestrator.recoverStreams(), [STREAM_ID]);

      const stopped = harness.orchestrator.stopStream(STREAM_ID);
      await waitFor(harness.firstVodStarted, SETTLE_CEILING_MS);
      await harness.clock.advance(DRAIN_TIMEOUT_MS + 1);
      await stopped;

      const timedOutStatus = harness.orchestrator.getStreamStatus(STREAM_ID);
      assert.equal(timedOutStatus.state, STREAM_LIFECYCLE_FAILED);
      assert.equal(timedOutStatus.reason, STOP_FAILURE_DRAIN_TIMEOUT);

      harness.start();
      const readsBeforeSuccessor = harness.feedHeadReads();
      await harness.segment('b0', 0);

      await waitAndConfirmNothingHappened(
        () => harness.feedHeadReads() === readsBeforeSuccessor && writesNaming(harness.writes, 'b0').length === 0,
        QUIET_WINDOW_MS,
      );

      await releaseVodAndPublishSuccessor(harness, 'b1', 1);
    } finally {
      await releaseOutstandingVod(harness);
    }
  });

  it('inherits A through a failed B finalize when A, B and C share one topic', async () => {
    const harness = sharedFeedHarness();
    try {
      await beginBlockedVod(harness);
      await harness.segment('b0', 0);

      harness.start();
      await waitFor(() => harness.orchestrator.getMetricsSnapshot().streamsFailedTotal === 1, SETTLE_CEILING_MS);

      const readsBeforeC = harness.feedHeadReads();
      await harness.segment('c0', 0);
      await waitAndConfirmNothingHappened(
        () => harness.feedHeadReads() === readsBeforeC && writesNaming(harness.writes, 'c0').length === 0,
        QUIET_WINDOW_MS,
      );

      await releaseVodAndPublishSuccessor(harness, 'c1', 1);
    } finally {
      await releaseOutstandingVod(harness);
    }
  });
});
