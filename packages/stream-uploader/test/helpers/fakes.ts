import { Bee, BeeResponseError, FeedIndex } from '@ethersphere/bee-js';

import { BeePublisher, BeePublisherPool, shortBatchId, SINGLE_PUBLISHER } from '../../src/libs/BeePublisherPool.js';
import { Clock, systemClock } from '../../src/libs/Clock.js';
import { RecoveryStore } from '../../src/libs/RecoveryStore.js';
import { MetricsSnapshot } from '../../src/libs/ServiceMetrics.js';
import { StreamCatalog } from '../../src/libs/StreamCatalog.js';
import { StreamOrchestrator, StreamOrchestratorConfig } from '../../src/libs/StreamOrchestrator.js';
import {
  BroadcastAnchor,
  HealthSignals,
  MEDIA_TYPE_VIDEO,
  PRESSURE_LOW,
  RECOVERY_ENTRY_LOADED,
  RECOVERY_ENTRY_MISSING,
  RecoveryEntry,
  STREAM_LIFECYCLE_UNKNOWN,
  StreamState,
} from '../../src/types.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';

/**
 * The wall clock a test broadcast is dated against, and the fragment length it steps by.
 *
 * A round instant and a whole number of seconds, so a `#EXT-X-PROGRAM-DATE-TIME` an assertion writes
 * out by hand is legible. Deliberately unlike any `#EXTINF` the fakes produce: the stamp is derived
 * from the declared fragment length and never from what a segment measured, and a test whose two
 * numbers agreed would not notice if that stopped being true.
 */
export const TEST_ANCHOR: BroadcastAnchor = {
  startedAtMs: Date.UTC(2026, 8, 1, 12, 0, 0),
  fragmentSeconds: 2,
};

/**
 * A status outside `RETRYABLE_HTTP_STATUSES`, so `retryUntilDeadlineAsync` rethrows on the first
 * attempt instead of burning its 15 second window. Without this a single induced upload failure
 * takes 15 seconds of wall clock.
 */
const NON_RETRYABLE_STATUS = 400;

/** What a manifest feed currently holds at its head, in the terms a test states it in. */
export interface FakeFeedHead {
  index: number;
  manifest: string;
}

export interface FakeUploads {
  /** Segment payload write, called as Bee is: stamp, then payload. Defaults to a fresh reference. */
  uploadData?: (stamp: string, data: Uint8Array) => Promise<unknown>;
  /**
   * Manifest SOC write. Defaults to resolving with a reference for the requested index.
   *
   * The payload is passed too, so a test can read the playlist a viewer would be served rather than
   * only counting that one was published.
   */
  uploadPayload?: (index: number, payload: unknown) => Promise<unknown>;
  /**
   * What the head of a stream's manifest feed answers, which is what a finalize after a crash asks
   * before it publishes anything. See `StreamUploader.publishedRecordingIndex`.
   *
   * Returning `null`, which is also the default, is a feed nothing was ever written to: bee answers
   * that with a 404 and the finalize takes the ordinary full path. Every test that does not set this
   * wants exactly that, so a fake left alone behaves the way it did before the read existed.
   */
  feedHead?: () => FakeFeedHead | null;
}

/** Bee's answer for a feed topic nothing has ever been written to. */
const feedNotFound = () => new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');

/**
 * What the no-index read answers instead of the playlist, because a real recording is bigger than
 * one chunk.
 *
 * ⛔ Modelled rather than simplified, and it is the difference between a guard that runs and one
 * that cannot. bee-js rejoins a payload over 4096 bytes only on `downloadPayload({ index })`
 * (`feed/index.js`, the `cac.span > 4096n` branch). Without an index it returns the feed update as
 * it stands, which for anything larger is the wrapping chunk. A VOD manifest names every segment of
 * a broadcast, so it is always in that regime, and a fake that served the playlist either way would
 * pass a reader that never reads the playlist at all on the stage.
 *
 * The four span bytes are escapes rather than literal bytes because raw NULs make git call this
 * whole file binary, and a binary file has no diff for a reviewer to read.
 */
const OVERSIZED_PAYLOAD_WRAPPER = '\x00\x00\x10\x00wrapping-chunk-not-the-playlist';

/** Rejects immediately with a non-retryable status, standing in for a Bee that refuses the write. */
export function rejectImmediately(): Promise<never> {
  return Promise.reject({ status: NON_RETRYABLE_STATUS, message: 'fake bee refused the write' });
}

/** Never settles, standing in for a Bee that accepted the connection and went silent. */
export function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

export function makeFakeBee(uploads: FakeUploads = {}): Bee {
  let refCounter = 0;
  return {
    uploadData: uploads.uploadData ?? (async () => ({ reference: { toHex: () => `ref${refCounter++}` } })),
    makeFeedReader: () => ({
      // Both shapes bee-js offers, answered the way bee-js answers them. The index comes from the
      // no-index call and the playlist only from the indexed one, per
      // {@link OVERSIZED_PAYLOAD_WRAPPER}. A read at an index this feed is not at is a defect rather
      // than an empty feed, so it is refused rather than answered.
      downloadPayload: async (opts?: { index?: FeedIndex }) => {
        const head = uploads.feedHead?.() ?? null;
        if (head === null || (opts?.index !== undefined && Number(opts.index.toBigInt()) !== head.index)) {
          throw feedNotFound();
        }
        const payload = opts?.index === undefined ? OVERSIZED_PAYLOAD_WRAPPER : head.manifest;
        return { feedIndex: FeedIndex.fromBigInt(BigInt(head.index)), payload: { toUtf8: () => payload } };
      },
    }),
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, data: unknown, opts: { index: number }) =>
        uploads.uploadPayload
          ? uploads.uploadPayload(opts.index, data)
          : { reference: { toHex: () => `soc${opts.index}` } },
    }),
  } as unknown as Bee;
}

/**
 * Every method the orchestrator and the uploader call on the catalog, so a stub cannot go stale by
 * omitting one. Cast through `unknown`, so a method the callers start using is not a compile error
 * anywhere: it is a runtime failure in whichever tests happen to reach that line. That has now
 * happened three times in this repository, twice on the orchestrator stub and once here, which is
 * why the shape lives in one place and every stub takes overrides rather than rebuilding it.
 */
export function makeFakeCatalog(overrides: Record<string, unknown> = {}): StreamCatalog {
  return {
    // `true` rather than nothing, because the real `addStream` answers whether the entry it just
    // wrote is the moment the broadcast became a recording, and a fake holding no previous state is
    // in the position the real catalog is in when it holds no previous entry: the write IS the flip.
    // Returning nothing would silently drop `Updating stream in list to VOD` from every test that
    // takes this default, which is the line six e2e scenarios wait on.
    addStream: async () => true,
    getMsSinceIndexSaveFailed: () => null,
    // Called from the uploader's segment path, so every fake needs it or the segment path throws.
    recordRungDelivered: () => {},
    ...overrides,
  } as unknown as StreamCatalog;
}

/**
 * A catalog that appends every published entry, for asserting that a VOD actually landed.
 *
 * Answers `true` for the same reason the default above does: it keeps no previous state, so every
 * write it takes is a first one.
 */
export function makeRecordingCatalog(published: unknown[]): StreamCatalog {
  return makeFakeCatalog({
    addStream: async (entry: unknown) => {
      published.push(entry);
      return true;
    },
  });
}

/**
 * Every method a test double for the orchestrator plausibly needs, so a stub cannot go stale by
 * omitting one. The same shape and the same reason as `makeFakeCatalog`, one layer up.
 *
 * This has now broken five times, most of them on a stub that was correct when it was written: the
 * cast through `unknown` means a method the production code starts calling is not a compile error
 * anywhere, so it surfaces as a `TypeError` in whichever tests happen to reach that line, and only
 * in those. Prefer `makeTestOrchestrator`, which is a real orchestrator. Reach for this one only
 * when the test is about what the caller does with the answer, and pass the answers as overrides.
 */
export function makeFakeOrchestrator(overrides: Record<string, unknown> = {}): StreamOrchestrator {
  return {
    startStream: () => true,
    stopStream: async () => {},
    handleSegment: () => ({ accepted: true }),
    handleSegmentLoss: () => true,
    keepAlive: () => false,
    recordSegmentsSkipped: () => {},
    recordAuthRejection: () => {},
    getStreamStatus: () => ({ streamId: '', state: STREAM_LIFECYCLE_UNKNOWN }),
    getSegmentStallMs: () => 30_000,
    getHealthSignals: () => makeHealthSignals(),
    getMetricsSnapshot: () => makeMetricsSnapshot(),
    ...overrides,
  } as unknown as StreamOrchestrator;
}

/** An entirely healthy reading, so a test that cares about one signal sets only that one. */
export function makeHealthSignals(overrides: Partial<HealthSignals> = {}): HealthSignals {
  return {
    activeStreams: 0,
    staleManifestStreams: 0,
    maxConsecutiveManifestFailures: 0,
    maxConsecutiveSegmentFailures: 0,
    queuePressure: PRESSURE_LOW,
    msSinceStreamActivity: null,
    msSinceSegmentLoss: null,
    msSinceCatalogAnnounceFailed: null,
    msSinceStatePersistFailed: null,
    queueBacklogSeconds: 0,
    msSinceAuthRejection: null,
    hasIngestedMedia: false,
    segmentsSkipped: 0,
    openingSegmentsWithheld: 0,
    segmentsNeverNamed: 0,
    quarantinedRecoveryEntries: 0,
    ...overrides,
  };
}

/** A process that has done nothing yet, which is every counter at zero and no segment on record. */
export function makeMetricsSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    segmentsUploadedTotal: 0,
    segmentsDroppedTotal: 0,
    segmentsLostTotal: 0,
    segmentsSkippedTotal: 0,
    openingSegmentsWithheldTotal: 0,
    segmentsNeverNamedTotal: 0,
    manifestPublishFailuresTotal: 0,
    streamsFinalizedTotal: 0,
    streamsFailedTotal: 0,
    streamsReapedTotal: 0,
    segmentDurationsUnreadTotal: 0,
    authRejectionsTotal: 0,
    takeoversRefusedTotal: 0,
    segmentsUploadedByRung: {},
    lastSegmentAt: null,
    activeStreams: 0,
    queueDepth: 0,
    queueBacklogSeconds: 0,
    ...overrides,
  };
}

export function makeFakeRecoveryStore(overrides: Partial<Record<keyof RecoveryStore, unknown>> = {}): RecoveryStore {
  const load = (overrides.load as ((fileId: string) => StreamState | null) | undefined) ?? (() => null);

  return {
    save: () => {},
    remove: () => {},
    listActive: () => [],
    listQuarantined: () => [],
    quarantine: () => null,
    load,
    // Recovery reads through `read`, so deriving it from `load` keeps every fake that names only
    // `load` describing one store. A test that needs a damaged entry overrides `read` itself, since
    // that is exactly the distinction `load` cannot express.
    read: (fileId: string): RecoveryEntry => {
      const state = load(fileId);
      return state === null ? { kind: RECOVERY_ENTRY_MISSING } : { kind: RECOVERY_ENTRY_LOADED, state };
    },
    ...overrides,
  } as unknown as RecoveryStore;
}

/** A stream state as RecoveryStore.load would return it, for exercising the recovery path. */
export function makeRecoveredState(streamId: string): StreamState {
  return {
    streamId,
    streamRawTopic: 'topic-xyz',
    mediatype: MEDIA_TYPE_VIDEO,
    socIndex: 3,
    segments: [{ index: 0, duration: 2, ref: 'ref0', discontinuity: false }],
    hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
    isFirstSegmentReady: true,
    isFirstManifestReady: true,
    pendingDiscontinuity: false,
    liveManifestStale: false,
    updatedAt: Date.now(),
  };
}

/** RecoveryStore.listActive returns the slash-sanitized file name, not the real stream id. */
export function toRecoveryFileId(streamId: string): string {
  return streamId.replace(/[/\\]/g, '_');
}

/**
 * One node for everything, which is what an unsplit deployment gets from `BeePublisherPool.single`.
 *
 * Every rung resolves to the same publisher, so a test that turns the ladder on still writes through
 * one fake bee and can assert on it without knowing which rung asked.
 */
/**
 * A url the real pool would accept. It used to be the empty string, which no deployment could have
 * and which `BeePublisherPool.single` refuses, so anything reading a publisher's url off this fake
 * was reading a value that cannot occur.
 */
const FAKE_BEE_URL = 'http://fake-bee:1633';

function makeFakePublishers(bee: Bee): BeePublisherPool {
  const publisher: BeePublisher = { rung: SINGLE_PUBLISHER, url: FAKE_BEE_URL, stamp: 'stamp', bee };
  return {
    coordinator: () => publisher,
    forRung: () => publisher,
    nodes: () => [publisher],
    routing: () => [{ rung: SINGLE_PUBLISHER, url: FAKE_BEE_URL, batch: shortBatchId(publisher.stamp) }],
  } as unknown as BeePublisherPool;
}

/**
 * Real time, and no timer of it keeps the test process alive.
 *
 * Spawning an uploader arms a sixty second stall reaper, and a test that asserts on the spawn and then
 * ends has nothing to cancel it with, so on the plain system clock that one timer held the test
 * runner's child process open for a minute after the file had finished. `--test-force-exit` used to
 * hide that by killing the process, and killing it dropped whole late-registering files uncounted with
 * exit 0. Nothing here depends on a real timer firing: every test that exercises a timeout injects the
 * `FakeClock` from `./fakeClock.js` through `config.clock` and steps it, and the spread below leaves
 * that override winning.
 */
const detachedClock: Clock = {
  now: () => systemClock.now(),
  setTimer: (handler, delayMs) => systemClock.setTimer(handler, delayMs, { unref: true }),
};

export function makeTestOrchestrator(
  config: Partial<StreamOrchestratorConfig> = {},
  uploads: FakeUploads = {},
  recoveryStore: RecoveryStore = makeFakeRecoveryStore(),
  catalog: StreamCatalog = makeFakeCatalog(),
): StreamOrchestrator {
  return new StreamOrchestrator(makeFakePublishers(makeFakeBee(uploads)), catalog, recoveryStore, {
    clock: detachedClock,
    streamKey: TEST_STREAM_KEY,
    maxQueueSize: 100,
    recoveryTimeout: 60_000,
    orphanReapMs: 60_000,
    segmentStallMs: 30_000,
    fragmentSeconds: TEST_ANCHOR.fragmentSeconds,
    segmentDedupWindow: 10_000,
    segmentRedundancy: 1,
    ...config,
  });
}
