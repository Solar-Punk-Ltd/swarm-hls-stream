import { Bee, BeeResponseError, PrivateKey, Topic } from '@ethersphere/bee-js';
import {
  addingStreamToList,
  engineSkippedSegments,
  finalizeResumed,
  ladderFinalized,
  manifestUploaded,
  originDeclaredDiscontinuity,
  publishingRendition,
  rungBatchRefused,
  segmentsNeverArrived,
  segmentUploaded,
  segmentUploadFailed,
  updatingStreamToVod,
} from '@swarm-hls-stream/shared';
import PQueue from 'p-queue';

import {
  BitrateSample,
  BroadcastAnchor,
  InheritedTimeline,
  LadderMembership,
  MediaType,
  Rendition,
  SegmentEntry,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_VOD,
  StreamState,
} from '../types.js';
import { beeAnswer, getErrorMessage, nonRetryableStatus, retryUntilDeadlineAsync } from '../utils/common.js';
import { HLS_ENDLIST, HLS_PLAYLIST_TYPE_VOD } from '../utils/hlsTags.js';

import {
  ADMIN_STATE_LIVE,
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStateReport,
  stateWasReported,
} from './AdminApiClient.js';
import {
  AnnounceReadiness,
  needsCatalogAnnounce,
  onCatalogAnnounced,
  onFirstSegmentUploaded,
  READINESS_ANNOUNCED,
  READINESS_PENDING,
  readinessFromPersisted,
  readinessToPersisted,
} from './AnnounceReadiness.js';
import { BeePublisher } from './BeePublisherPool.js';
import { averageBandwidth, emptyBitrateSample, peakBandwidth, recordSegment } from './BitrateMeter.js';
import { BroadcastDating } from './broadcastDating.js';
import { ErrorHandler } from './ErrorHandler.js';
import { LadderRegistry, RenditionAnnouncement } from './LadderRegistry.js';
import { Logger } from './Logger.js';
import { continuesFrom, inheritedTimeline, ManifestManager } from './ManifestManager.js';
import { RecoveryStore } from './RecoveryStore.js';
import { ServiceMetrics } from './ServiceMetrics.js';
import { StreamCatalog } from './StreamCatalog.js';

const SEGMENT_UPLOAD_RETRY_WINDOW_MS = 15_000;
const MANIFEST_UPLOAD_RETRY_WINDOW_MS = 15_000;
const UPLOAD_RETRY_BASE_MS = 350;
const UPLOAD_RETRY_CAP_MS = 2_000;

/**
 * How long a recovered finalize keeps asking its own manifest feed whether the recording is already
 * there, before it gives up and defers rather than guesses.
 *
 * The same window as a manifest publish, because it is the same node answering about the same feed,
 * and this read is the thing standing between a crash and a second paid recording.
 */
const FEED_HEAD_READ_WINDOW_MS = 15_000;

/**
 * Whether a playlist read back out of the feed is this stream's finished recording.
 *
 * ⛔ `#EXT-X-ENDLIST` on its own is not the test, and the difference is a paid feed write.
 * `buildClosingLiveManifest` ends the live playlist and carries ENDLIST too, and it is published at
 * the SOC index **before** the VOD manifest. A crash between the two leaves that closing playlist at
 * the head with the recording it promises not written yet, so a resume reading only ENDLIST would
 * skip the one publish that still had to happen and hand the catalog an index holding a live window.
 * `#EXT-X-PLAYLIST-TYPE:VOD` is written by `buildVODManifest` and by nothing else.
 */
function isFinishedRecording(manifest: string): boolean {
  return manifest.includes(HLS_PLAYLIST_TYPE_VOD) && manifest.includes(HLS_ENDLIST);
}

/**
 * Bee's not-found for a feed read, which on the recovered-finalize path says nothing about whether
 * the feed holds a recording.
 *
 * ⛔⛔⛔ **Named for what bee answered and not for what it means, because here it means the opposite
 * of what it means everywhere else.** It was called `isFeedNeverWritten` until 2026-09-15 and the
 * name was load-bearing: the caller read a 404 as an empty feed and published a second recording
 * over one that may already have been bought. The caller reaches this read only with a non-null
 * `socIndex`, which is an index this stream wrote itself, so the feed is KNOWN non-empty and a 404
 * is a chunk that will not retrieve right now. See {@link FeedHeadNotRetrievedError} for what is
 * done with it instead.
 *
 * ⛔⛔ **Deliberately narrower than `isFeedAbsent`, which also takes 503, and the difference is a
 * recording.** The two predicates answer different questions. `isFeedAbsent` answers "is this feed
 * empty" for a reader with no other information, and bee says 503 when a topic exists with no update
 * on it, so taking 503 there is right. A 503 here cannot mean an empty feed. It is a warming or busy
 * node, it is retryable already, and short-circuiting the retry window on it answers "nothing was
 * published" to a question that was never asked. Left retryable it ends in the deferring throw,
 * which costs an unfinalized interval and nothing that cannot be undone.
 */
function isFeedHeadNotFound(error: unknown): boolean {
  return error instanceof BeeResponseError && error.status === 404;
}

/**
 * Why a feed head was being read, so the one failure message says what was lost rather than naming a
 * cause the caller does not have.
 *
 * Two callers, two entirely different stakes, one read. The finalize asks whether a recording is
 * already in the feed and the answer decides whether a second one gets paid for; an admin-mode start
 * asks where the feed has got to and the answer decides whether this session writes over the last
 * one's playlists. An operator reading "leaving the broadcast unfinalized" about a stream that has
 * not started yet is reading a sentence about the other caller.
 */
interface FeedHeadQuestion {
  asked: string;
  consequence: string;
  /**
   * What a 404 from the head read means for this caller, which is the one thing the two disagree
   * about and the reason this is a parameter rather than a constant.
   *
   * ⛔⛔ **The same status, opposite meanings, and reading it the wrong way costs something different
   * each time.** The recovered finalize reaches the read only with a non-null `socIndex` — an index
   * this stream wrote itself — so its feed is known non-empty and a 404 is a chunk that will not
   * retrieve right now: false here, and {@link FeedHeadNotRetrievedError} sends it back through the
   * retry window rather than answering "nothing was published" to a question nobody asked. An
   * start on a topic that outlived the last session asks where that topic has got to, and such a
   * topic is handed out — by the admin, or by the master playlist — before anything has ever
   * published on it, so 404 is the answer and index 0 is right: true here.
   *
   * Taking the recording path's reading for the start one refuses the first publish of every newly
   * declared stream and every new ladder, for ever, since the read is re-attempted at each segment and
   * never settles. Taking the start path's reading for the recording one publishes a second recording
   * over one that has already been paid for. See `5aedcd83`, which closed the second before the first
   * existed.
   */
  emptyFeedIsAnAnswer: boolean;
}

const RECORDING_ALREADY_PUBLISHED: FeedHeadQuestion = {
  asked: 'whether it published its recording before the crash',
  consequence:
    'Leaving the broadcast unfinalized for the next boot to retry, rather than publishing a second ' +
    'recording over one that may already be in the feed. Where the feed has been established by hand ' +
    "to hold nothing, clearing socIndex in this stream's recovery entry makes the next boot publish afresh",
  emptyFeedIsAnAnswer: false,
};

const FEED_HEAD_ON_START: FeedHeadQuestion = {
  asked: 'where the topic it continues has got to',
  consequence:
    'Refusing this manifest publish and retrying at the next segment, rather than starting again at ' +
    'SOC index 0 and writing over the previous session on the same topic',
  emptyFeedIsAnAnswer: true,
};

/**
 * The head of a feed this stream has written to came back 404, which is inconclusive rather than an
 * answer.
 *
 * ⛔⛔⛔ **Carries no HTTP status, and that absence is the whole mechanism.** `nonRetryableStatus`
 * puts 404 outside `RETRYABLE_HTTP_STATUSES`, which is right for every other reader in this service:
 * a 404 from a feed that may never have been written is settled on the first attempt, and retrying
 * it only spends a window learning what that attempt already said. This one read knows better, per
 * {@link isFeedHeadNotFound}. Re-thrown with no status of its own it reads as retryable, so
 * {@link retryUntilDeadlineAsync} gives the chunk the rest of the window to turn up, and the
 * retryable set stays as it is for the uploads, the catalog and the master feed that share it.
 *
 * Bee's own words are carried rather than the status alone, because a 404 that outlasts the window
 * is the one shape here an operator has to diagnose by hand.
 */
class FeedHeadNotRetrievedError extends Error {
  constructor(error: unknown) {
    super(`the head of a feed this stream has written to answered 404: ${beeAnswer(error)}`);
    this.name = 'FeedHeadNotRetrievedError';
  }
}

/**
 * How long to wait before re-attempting a catalog announce that failed.
 *
 * The announce has to keep retrying, because the catalog entry is the only thing that makes a live
 * broadcast discoverable and a stream that gives up is unwatchable for its whole duration. What it
 * must not do is retry on the segment cadence, which is what tied a dead catalog to a feed read, a
 * feed write and the postage for it every two seconds. The right rate is how long a viewer can wait
 * for a broadcast to appear, not how often media arrives.
 */
const CATALOG_ANNOUNCE_RETRY_MS = 30_000;

/**
 * How far the measured bitrate has to drift, and how long between corrections, before a rung
 * rewrites the catalog.
 *
 * BANDWIDTH is the whole supply-side input to the player's ABR decision, so it has to end up
 * honest — but the catalog is one feed shared by every stream, and republishing per segment would
 * have four rungs contending on it every fragment. Announce on the encoder's target, then correct
 * only when the measurement has actually moved.
 */
const BITRATE_REFRESH_RATIO = 0.15;
const BITRATE_REFRESH_INTERVAL_MS = 30_000;

/**
 * The admin service and this broadcast's place in it, when `ADMIN_API_URL` is set. Absent is the
 * standalone deployment, where the stream catalog on Swarm is this service's own to write.
 *
 * Its presence changes four things in this class and nothing else, and every one of them follows from
 * the single fact that the topic is the declaration's rather than this session's:
 *
 * 1. **No catalog write, ever.** Not the live announce, not the VOD flip. The admin owns the list of
 *    streams in admin mode, and a second writer would publish entries nothing reconciles.
 * 2. **A state report in each of their places**, at the same two moments and in the same order, so
 *    the memoization and the ordering the comments here describe go on meaning what they say.
 * ⚠️ A rung of a ladder in admin mode holds (1) and (2) unchanged, with the reports made at ladder
 * granularity — see {@link notifyStart} and {@link completeFinalize}. Its own manifest topic is not
 * the declared one, which is the ladder's master feed; what it publishes on is derived from its
 * ladder group and its rung name, and outlives its session for reasons of its own. See
 * {@link topicOutlivesThisSession}.
 */
interface AdminReporting {
  client: AdminApiClient;
  /** The admin's own id for this stream, which every report names. */
  id: string;
}

interface RestoreState {
  streamRawTopic: string;
  socIndex: number | null;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
  pendingDiscontinuity?: boolean;
  bitrate?: BitrateSample;
  /** Absent on an entry written before playlists carried a wall clock. See {@link BroadcastAnchor}. */
  anchor?: BroadcastAnchor;
  /** Absent on an entry written before a rung's feed outlived its session. See {@link StreamState}. */
  sequenceOffset?: number;
  /** Absent on an entry written before recordings were glued, and on a session over an empty feed. */
  inherited?: InheritedTimeline;
  /**
   * Absent on an entry written before a disconnect held a session open, and on every session whose
   * encoder was still feeding it. See {@link StreamUploader.resumeAfterReconnect}.
   */
  resumingAfterReconnect?: boolean;
}

export interface StreamUploaderOptions {
  /**
   * The Bee node this session publishes through and the postage batch it pays with, as one value.
   *
   * One value rather than a client and a batch id passed side by side, because they are one routing
   * decision taken in `BeePublisherPool` and a session that held a client from one node and a batch
   * from another would spend a batch that node cannot issue against. It also carries the node's own
   * rung and url, which is the identity a refused batch is reported under. See
   * {@link StreamUploader.reportBatchRefusal}.
   */
  publisher: BeePublisher;
  streamCatalog: StreamCatalog;
  /**
   * Where a ladder rung's rendition record goes, and where its deliveries are counted.
   *
   * Defaults to `streamCatalog`, which is the standalone deployment: the catalog merges the four rungs
   * into one entry and writes the master from it. In admin mode the merge state belongs to the admin,
   * so an `AdminLadderRegistry` takes its place — and nothing else in this class changes, because a rung
   * announcing itself is the same act either way. Unread on a stream with no ladder.
   */
  ladderRegistry?: LadderRegistry;
  recoveryStore: RecoveryStore;
  streamKey: string;
  streamId: string;
  /**
   * Feed topic for this stream's manifest. Supplied rather than generated, because a ladder's
   * rungs derive theirs from a shared group id and the orchestrator is what knows the group.
   */
  streamTopic: string;
  mediatype: MediaType;
  /**
   * Erasure-coding level for segment uploads.
   *
   * Parity is durability insurance, and it is paid for twice on a live stream: once on upload, and
   * again by every viewer, because the extra chunks widen the retrieval fan-out that dominates how
   * long a segment takes to arrive. A segment that outlives its playlist window is of no use to
   * anyone, so for live the insurance mostly buys nothing. 0 turns it off.
   */
  redundancyLevel: number;
  ladder?: LadderMembership;
  /**
   * The instant this broadcast started and the fragment length it cuts at, which together date every
   * segment this session publishes. One value for the whole ladder. See {@link BroadcastAnchor}.
   */
  anchor: BroadcastAnchor;
  /**
   * Where a restart's re-anchoring of that dating is minted, once for the whole ladder. Absent
   * leaves this session re-anchoring on its own wall clock, which is a ladder of one.
   */
  dating?: BroadcastDating;
  /** State from a previous run of this stream id, so a restart resumes rather than starting over. */
  restoreState?: RestoreState;
  /**
   * How long to wait before re-attempting a failed catalog announce. Injectable only so the retry can
   * be driven in a test: at its default the sequence takes half a minute of wall clock.
   */
  catalogAnnounceRetryMs?: number;
  /** Process-lifetime counters this session reports into. Absent in tests that do not read them. */
  metrics?: ServiceMetrics;
  /** The admin service, when the deployment has one. See {@link AdminReporting}. */
  admin?: AdminReporting;
  /**
   * The actual write completion of every earlier session on this topic, when any are still pending.
   *
   * ⛔ **It is what keeps two sessions off one feed.** A re-announce retires the live session and
   * starts this one in the same synchronous turn, then drains the retired one in the background. An
   * explicit stop can also time out and free the id while its I/O continues. Both cases share the
   * same topic wherever that topic outlives a session, a declared stream in admin mode or a rung of
   * a ladder in either deployment. Earlier closing and VOD manifests are SOC writes onto the
   * feed this session is about to publish into. `retire()` does not stop them. It only gives up the
   * recovery entry, the admin report and the catalog entry.
   *
   * Unset means no earlier writer is still outstanding on this topic. A standalone single-rendition
   * stream always qualifies because its topic is a fresh uuid nothing else has ever held.
   *
   * See {@link predecessorHasDrained}.
   */
  predecessorDrained?: Promise<void>;
}

export class StreamUploader {
  public readonly segmentQueue = new PQueue({ concurrency: 1 });
  private manifestQueue = new PQueue({ concurrency: 1 });
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private publisher: BeePublisher;
  private bee: Bee;
  private streamSigner: PrivateKey;
  private streamRawTopic: string;
  private streamCatalog: StreamCatalog;
  private ladderRegistry: LadderRegistry;
  private recoveryStore: RecoveryStore;
  private streamId: string;
  private stamp: string;
  private redundancyLevel: number;
  private socIndex: number | null = null;
  private mediatype: MediaType;
  private readiness: AnnounceReadiness = READINESS_PENDING;
  private ladder?: LadderMembership;
  private liveManifestQueued = false;
  private pendingDiscontinuity = false;
  private consecutiveManifestFailures = 0;
  private consecutiveSegmentFailures = 0;
  /**
   * The upload statuses this stream has already reported a postage refusal for, so the line is said
   * once for each answer bee gives rather than once per segment a filling batch loses.
   *
   * ⛔⛔ Keyed on the status rather than on a single flag, and that is the difference between a
   * diagnosis and a wrong one. A batch fills over a minute or two, so identical refusals repeat and
   * one line is right for them. A DIFFERENT status is a different condition, and a flag would let an
   * early 413 or 404 claim the report for the whole process and silence the postage refusal that
   * followed it: the log would then carry one refusal naming the wrong answer, a harness counting
   * refusals would still count one, and a drain would be filed as proven against evidence of
   * something else.
   *
   * Deliberately not persisted with the rest of the stream state. A restart is the only way the batch
   * changes, because `BEE_PUBLISHERS` is read once at process start, and a restart starts this set
   * empty again, so the first refusal of a batch this process has never uploaded against is still
   * said.
   */
  private readonly batchRefusalStatuses = new Set<number>();
  /**
   * The newest segment index a published live manifest has named, or null before the first publish.
   *
   * Null rather than restored from persisted state after a crash: the window a recovered uploader
   * publishes is built from segments it did reload, so a restored value would report the whole
   * outage as segments this uploader failed to name when nothing here failed at all.
   */
  private announcedThrough: number | null = null;
  private segmentsNeverNamed = 0;
  /** Whether the recovery entry under this stream id still describes this uploader. See `retire`. */
  private ownsRecoveryEntry = true;
  /**
   * Whether this session was rebuilt from a recovery entry rather than announced by an engine.
   *
   * The only thing it decides is whether `finalize` asks the feed where it got to before publishing
   * anything. A session this process started itself has published every SOC index it holds and
   * knows it, so the read would buy nothing. One rebuilt off disk cannot know how far the run that
   * wrote that entry got, because the crash is exactly what stopped it saying.
   */
  private readonly resumedFromCrash: boolean;
  /** The one finalize this session gets, so a second caller joins it rather than repeating it. */
  private finalizing: Promise<void> | undefined;
  /** When the catalog announce first failed and has not since succeeded, or null while it is listed. */
  private catalogAnnounceFailedAt: number | null = null;
  private lastCatalogAnnounceAt: number | null = null;
  private readonly catalogAnnounceRetryMs: number;
  /** When this stream's state first failed to reach disk and has not since landed. See OBS-4. */
  private statePersistFailedAt: number | null = null;
  private readonly metrics?: ServiceMetrics;
  /** Playing time of everything still queued, in seconds, which is how far behind live this stream is. */
  private queuedSeconds = 0;
  /** Segments this session was handed, so an empty finalize can tell "nothing to record" from "lost it all". */
  private segmentsOffered = 0;

  private bitrate: BitrateSample = emptyBitrateSample();
  private driftBaselineBps = 0;
  private lastAnnounceAttemptAt = 0;

  /** The admin service and this stream's id in it, or undefined in the standalone deployment. */
  private readonly admin?: AdminReporting;
  /** Whether the feed head has been read for this session. See {@link resumeFeedIndex}. */
  private feedIndexResumed = false;
  /**
   * Whether every earlier session has finished writing to the topic they share.
   *
   * True from the start unless the orchestrator still tracks an earlier writer on a topic that
   * outlives its sessions. This covers a replacement and a fresh start after an earlier stop timed
   * out. See
   * {@link StreamUploaderOptions.predecessorDrained} and {@link topicOutlivesThisSession}.
   */
  private predecessorHasDrained = true;

  private manifestManager: ManifestManager;

  constructor(options: StreamUploaderOptions) {
    this.catalogAnnounceRetryMs = options.catalogAnnounceRetryMs ?? CATALOG_ANNOUNCE_RETRY_MS;
    this.metrics = options.metrics;
    this.admin = options.admin;
    if (options.predecessorDrained) {
      this.predecessorHasDrained = false;
      // Settled rather than awaited inside a manifest job, so a stuck predecessor does not occupy
      // this session's manifest queue. Publish attempts are refused while it is pending and existing
      // stale-manifest and queue signals expose the hold. The orchestrator normalizes expected drain
      // failures, so the catch is a backstop for a rejection no current caller produces.
      void options.predecessorDrained
        .catch(() => {})
        .finally(() => {
          this.predecessorHasDrained = true;
        });
    }
    this.publisher = options.publisher;
    this.bee = options.publisher.bee;
    this.streamSigner = new PrivateKey(options.streamKey);
    this.streamCatalog = options.streamCatalog;
    this.ladderRegistry = options.ladderRegistry ?? options.streamCatalog;
    this.recoveryStore = options.recoveryStore;
    this.streamId = options.streamId;
    this.stamp = options.publisher.stamp;
    this.redundancyLevel = options.redundancyLevel;
    this.mediatype = options.mediatype;
    this.ladder = options.ladder;
    this.streamRawTopic = options.streamTopic;
    // Restored in preference to the one this session was handed, so a recovered broadcast keeps the
    // wall clock its earlier segments were dated against. Taking the fresh one would restamp the
    // recording's whole history at the moment of the recovery.
    const anchor = options.restoreState?.anchor ?? options.anchor;

    this.manifestManager = new ManifestManager(anchor, options.dating);

    const restoreState = options.restoreState;
    this.resumedFromCrash = restoreState !== undefined;
    if (restoreState) {
      this.streamRawTopic = restoreState.streamRawTopic;
      this.socIndex = restoreState.socIndex;
      const restored = readinessFromPersisted(restoreState);
      this.readiness = restored.readiness;
      if (restored.repairedFrom) {
        // Loud, because this pair cannot be produced by any live sequence, so the entry on disk was
        // corrupted or hand-edited and whoever owns the deployment should know. Repaired rather than
        // refused: see the note on `readinessFromPersisted`.
        this.logger.warn(
          `[StreamUploader] Recovery entry for ${options.streamId} claims the catalog announce happened ` +
            'before its first segment, which is not reachable. Treating the stream as not yet ' +
            'announced so it is published rather than left invisible.',
        );
      }
      this.pendingDiscontinuity = restoreState.pendingDiscontinuity ?? false;
      // Restored for a sharper version of the reason the flag above is: the window between arming it
      // and the segment that consumes it is precisely one in which nothing is arriving. Lost, the
      // first segment after the encoder returned would publish at its own index with the dating the
      // broadcast opened with, and the seam across the outage would go unsaid.
      if (restoreState.resumingAfterReconnect) {
        this.manifestManager.resumeAfterReconnect();
      }
      if (restoreState.bitrate) {
        this.bitrate = restoreState.bitrate;
      }
      // The inherited prefix goes in with the segments rather than after them, because it is part of
      // what this session's recording is and `restoreState` is where that is settled.
      this.manifestManager.restoreState(restoreState.segments, restoreState.hlsHeaders, restoreState.inherited);
      // After the segments, because it is about how they are published rather than about what they
      // are: `restoreState` replays a numbering that is already in a feed, and this is the offset
      // that numbering was published under.
      if (restoreState.sequenceOffset) {
        this.manifestManager.continueFrom(restoreState.sequenceOffset);
      }
      this.logger.info(`[StreamUploader] Restored stream ${options.streamId} at SOC index ${this.socIndex}`);
    }
  }

  public handleSegment(segmentIndex: number, duration: number, data: Buffer): void {
    // Counted when queued and released however the job ends, so a stream whose uploads are failing
    // reports a backlog that drains rather than one that grows forever.
    this.queuedSeconds += duration;
    this.segmentsOffered += 1;
    recordSegment(this.bitrate, data.length, duration);
    this.segmentQueue.add(async () => {
      try {
        await this.uploadSegment(segmentIndex, duration, data);
      } finally {
        this.queuedSeconds -= duration;
      }
    });
  }

  public getQueuedSeconds(): number {
    return this.queuedSeconds;
  }

  private async uploadSegment(segmentIndex: number, duration: number, data: Buffer): Promise<void> {
    const result = await this.uploadDataToBee(data);
    if (!result) {
      // Nothing landed within the retry window, so this segment's sequence stays empty and
      // `ManifestManager` lists it as a gap entry. No discontinuity: the encoder did not restart, so
      // the media behind the hole is a continuation, and telling a player otherwise makes it flush
      // what it had buffered.
      this.consecutiveSegmentFailures += 1;
      this.logger.error(segmentUploadFailed(this.streamId, segmentIndex));
      this.metrics?.recordSegmentDropped(this.ladder?.rung.name);
      this.persistState();
      return;
    }

    this.consecutiveSegmentFailures = 0;
    const ref = result.reference.toHex();
    this.manifestManager.addSegment(segmentIndex, duration, ref, this.pendingDiscontinuity);
    this.pendingDiscontinuity = false;
    this.readiness = onFirstSegmentUploaded(this.readiness);

    this.logger.log(segmentUploaded(this.streamId, segmentIndex, ref));

    this.metrics?.recordSegmentUploaded(Date.now(), this.ladder?.rung.name);
    if (this.ladder) {
      // Beside the metric and not instead of it: the metric is an observation, this decides what the
      // master is allowed to advertise. Both want the same moment, which is a segment that landed.
      this.ladderRegistry.recordRungDelivered(this.ladder.group, this.ladder.rung.name);
    }
    this.uploadLiveManifest();
    await this.refreshBandwidthIfDrifted();
    this.persistState();
  }

  /**
   * Segments that never reached this uploader, because the engine could not download them from the
   * origin. One contiguous gap is one call, however many it spans.
   *
   * ⛔ **Reported, not marked.** The lost sequences stay empty and `ManifestManager` lists each of
   * them as a gap entry, which is what tells a player there is media there it cannot have. No
   * discontinuity, because nothing restarted the encoder: the media behind the hole carries on from
   * the media in front of it, and a break would tell a player to flush what it had buffered for a
   * join that never happened. See the gap-entry section of {@link ManifestManager}.
   *
   * Deliberately does **not** touch `consecutiveSegmentFailures`. That counter clears on the next
   * successful segment, and the engine writes a segment off and then downloads the one behind it in
   * the same pass, so the clearing success always lands before anything can read the count. The
   * signal for a loss is an age recorded by the orchestrator, which no later event makes untrue.
   */
  public handleSegmentLoss(firstIndex: number, count: number): void {
    const subject = count === 1 ? `Segment ${firstIndex}` : `${count} segments from index ${firstIndex}`;
    this.queueAnnouncement(() => this.logger.error(segmentsNeverArrived(subject, this.streamId)));
  }

  /**
   * A gap nobody reported, which the orchestrator found between the index it last accounted for and
   * the one it has just taken. Everything {@link handleSegmentLoss} does, announced as its own family.
   *
   * ⛔ **The two must not share a line.** A reported loss is the engine saying it could not fetch
   * something, which only the OME puller ever says. This is the SRS path, where a segment closed
   * while this process was dead is never posted again and the following index is the only evidence
   * there is. Scenario F waits on this family by itself to prove the gap after a crash was reported,
   * and a wait on the reported-loss wording would be satisfied by an OME broadcast losing a segment.
   *
   * @param fromIndex the last index accounted for, whose own segment is already queued or published
   * @param toIndex the index that has just arrived, which the hole runs up to
   */
  public handleInferredSegmentLoss(fromIndex: number, toIndex: number, count: number): void {
    this.queueAnnouncement(() => this.logger.error(engineSkippedSegments(fromIndex, toIndex, this.streamId, count)));
  }

  /**
   * A discontinuity the origin declared with `#EXT-X-DISCONTINUITY`, meaning the media from here on is
   * not a continuation of what came before it. An encoder restart upstream produces exactly this, and
   * a manifest that omits it tells players the join is seamless, which is what they stall on.
   *
   * ⛔ One of only two things that still arm the flag, the other being the engine's own counter
   * restarting inside `ManifestManager.placeInBroadcast`. A lost segment is not one of them: it
   * leaves a hole, and a hole is said with gap entries.
   *
   * Ordinary rather than an error, unlike a loss: nothing went wrong here and nothing was dropped.
   */
  public markDiscontinuity(): void {
    this.queueDiscontinuity(() => this.logger.info(originDeclaredDiscontinuity(this.streamId)));
  }

  /**
   * The encoder feeding this session went away and has come back inside the window that held the
   * session open, so this broadcast carries on rather than a new one starting.
   *
   * What it changes is exactly the two things that are not true across a reconnect. The media either
   * side of the gap is not continuous, so the next segment carries a break. And the encoder's clock
   * restarted while ours did not, so the dating re-anchors at the sequence the numbering resumes at,
   * through `ManifestManager.resumeAfterReconnect`. Everything else about the session is untouched:
   * the recording, the feed topic, the SOC index, the admin report, the inherited prefix.
   *
   * ⛔ **One flag rather than two, and `pendingDiscontinuity` is deliberately NOT one of them.** The
   * manifest's own one-shot declares the break where it places the seam, so arming the uploader's
   * flag as well would only mean the same break twice over — and, for an encoder that reconnects and
   * then delivers nothing, a break on a segment that has nothing in front of it to be separated from.
   * The one-shot is persisted, so a crash between the return and its first segment still owes both.
   *
   * ⛔ **Nothing countable is logged here.** The contract line belongs where the seam is actually
   * placed, or an encoder that reconnects six times and delivers nothing puts six armings into a
   * count that has to equal the breaks in the playlist. This line names the stream, which the one at
   * the placement cannot, and an operator reads the two as a pair.
   *
   * ⛔ Queued rather than applied inline, for {@link queueAnnouncement}'s own reason and one more: a
   * segment already awaiting upload when the encoder returned belongs to the run BEFORE the gap, and
   * arming inline would put the seam and the re-anchoring on that one instead of on the first segment
   * of the run after it.
   */
  public resumeAfterReconnect(): void {
    this.queueAnnouncement(() => {
      this.manifestManager.resumeAfterReconnect();
      this.logger.info(
        `[StreamUploader] The encoder feeding ${this.streamId} is back, so the next segment it delivers ` +
          'opens a resumed run rather than continuing the one before the gap',
      );
    });
  }

  /**
   * Say something about the media and write the state down, behind whatever is already queued.
   *
   * Queued rather than run inline so it takes its place behind segments already awaiting upload.
   * Inline, a loss would be announced in front of media that arrived before it, and a suite reading a
   * log window bounded by the fault would charge it to the wrong moment.
   */
  private queueAnnouncement(announce: () => void): void {
    this.segmentQueue.add(() => {
      announce();
      this.persistState();
    });
  }

  /**
   * {@link queueAnnouncement} for the one caller that also arms the break, so the marker attaches to
   * the next segment taken rather than to one that arrived before it.
   */
  private queueDiscontinuity(announce: () => void): void {
    this.queueAnnouncement(() => {
      this.pendingDiscontinuity = true;
      announce();
    });
  }

  public async notifyStart(): Promise<void> {
    if (this.admin && this.ladder) {
      // ⛔ The rung first and the ladder's state second, which is the same ordering as everywhere
      // else here: the master a viewer opens has to exist before anything says the broadcast is live.
      // `live` is a statement about the LADDER, so it waits for a master to have landed rather than
      // for this rung's own manifest — and it may be said more than once, by each rung in turn and
      // again after a restart, which is why the admin accepts `live -> live`.
      const announced = await this.announceRendition();
      if (announced && announced.masterIndex !== null) {
        await this.reportAdminState(
          { state: ADMIN_STATE_LIVE },
          'so the admin will go on showing it as a draft until the next attempt',
        );
      }
      return;
    }

    if (this.admin) {
      return this.reportAdminState(
        { state: ADMIN_STATE_LIVE },
        'so the admin will go on showing it as a draft until the next attempt',
      );
    }

    if (this.ladder) {
      await this.announceRendition();
      return;
    }

    const entry = {
      title: this.getFormattedDate(),
      owner: this.streamSigner.publicKey().address().toHex(),
      topic: this.streamRawTopic,
      state: STREAM_STATUS_LIVE,
      mediatype: this.mediatype,
      timestamp: Date.now(),
    };

    this.logger.log(addingStreamToList(JSON.stringify(entry)));
    // The flip answer is `false` for a live announce by construction, so it is discarded here rather
    // than checked. `completeFinalize` is the caller that reads it.
    await this.streamCatalog.addStream(entry);
  }

  /**
   * Finalize this session as a VOD, once, however many callers ask.
   *
   * Two of them reach here for one session and neither can see the other. A reconnect during a drain
   * retires the live session and hands it to `finalizeRetiredSession`, which deliberately stays out of
   * the orchestrator's `drainPromises` because the id belongs to the replacement by then, so the guard
   * that answers a duplicate stop with the drain already running never sees it. Unguarded, both ran the
   * body below: two VOD manifests, each its own SOC write and the postage for it, and the second
   * rewriting the catalog entry the first had published.
   *
   * A finalize that throws is shared rather than retried, which is what the callers already did with
   * the orchestrator's drain promise, and no path retries one today.
   */
  public async notifyStop(): Promise<void> {
    this.finalizing ??= this.finalize();
    return this.finalizing;
  }

  private async finalize(): Promise<void> {
    await this.segmentQueue.onIdle();
    await this.manifestQueue.onIdle();

    if (!this.manifestManager.hasSegments()) {
      // A session nobody sent anything to ends cleanly: there is no recording because there was
      // nothing to record. A session that was handed media and has none to publish is the opposite,
      // and it used to end the same way, so a broadcast whose every upload failed answered
      // `finalized` byte for byte like a healthy stop and counted as one.
      if (this.segmentsOffered > 0) {
        throw new Error(
          `Stream ${this.streamId} was handed ${this.segmentsOffered} segment(s) and published none, so it has no VOD`,
        );
      }
      this.logger.warn(`Stream ${this.streamId} has no segments, skipping VOD finalization`);
      this.clearRecoveryEntry();
      return;
    }

    const alreadyPublished = await this.publishedRecordingIndex();
    if (alreadyPublished !== null) {
      this.logger.log(finalizeResumed(this.streamId, alreadyPublished));
      return this.completeFinalize(alreadyPublished);
    }

    // Published first, and to its own slot, because the VOD manifest below renumbers the playlist
    // from zero into the same feed that live viewers are still walking. They read whatever is newest,
    // and a media sequence moving backwards restarts their player at the beginning of the recording.
    // This one ends the playlist they are already on, so they play out what they hold and stop.
    //
    // Settled before either playlist below is built, for the same reason the live path settles before
    // its own: both are built in full and only then published, and where this session's feed stands
    // decides the numbering they are built with. Ordinarily the live path settled it at the first
    // segment and this answers immediately; a broadcast whose every live publish failed arrives here
    // unsettled, and a read that still cannot answer leaves `commitManifest` refusing both writes
    // rather than publishing playlists numbered from zero over a feed that already holds some.
    await this.manifestQueue.add(() => this.settleFeedPosition());

    const closingManifest = this.manifestManager.buildClosingLiveManifest();
    if ((await this.manifestQueue.add(() => this.commitManifest(closingManifest))) === null) {
      // Not fatal to finalization. The recording below is what the catalog points at and it is still
      // worth publishing; what is lost is the clean ending for whoever is watching right now.
      this.logger.warn(
        `Failed to publish the closing live manifest for stream ${this.streamId}; viewers watching ` +
          'live will restart at the beginning of the recording rather than stopping at the end',
      );
    }

    const vodManifest = this.manifestManager.buildVODManifest();
    const vodIndex = (await this.manifestQueue.add(() => this.commitManifest(vodManifest))) ?? null;
    if (vodIndex === null) {
      throw new Error(`Failed to upload VOD manifest for stream ${this.streamId}`);
    }

    return this.completeFinalize(vodIndex);
  }

  /**
   * Everything a finalize still owes once the recording is in the feed: name it in the catalog, and
   * only then stop claiming the broadcast is recoverable.
   *
   * Shared with the resume path above rather than repeated, because the two differ in exactly one
   * thing, whether the recording had to be published, and the ordering of what follows it is the
   * whole of scenario H. The recovery entry goes last of all: it is the only record the broadcast
   * was live, so deleting it before the catalog names the recording is the one step that cannot be
   * taken back.
   *
   * @param vodIndex where the recording sits in this stream's own manifest feed, which is what the
   * catalog entry points a viewer at.
   */
  private async completeFinalize(vodIndex: number): Promise<void> {
    if (this.admin && this.ladder) {
      // ⛔ The index reported is the MASTER's, never this rung's own VOD index. A viewer in admin mode
      // is pointed at the declared topic, and for a ladder that topic holds the master playlist, so an
      // entry carrying a rung's index would name a position in a feed nobody opens.
      const announced = await this.announceRendition({
        index: vodIndex,
        duration: this.manifestManager.getTotalDuration(),
      });

      // ⛔ Reported only by the rung whose own report finished the ladder, and only once. A rung
      // draining while its siblings are still live ends its own recording and nothing more: the
      // broadcast is over when the LAST of them finalizes, which is the only report the admin answers
      // with a flip. A rung announcing the end off its own drain would take three live rungs off the
      // air in the admin's list. This is `StreamCatalog.upsertRendition`'s `flippedToVod` rule, read
      // off the other side of a wire rather than off a feed read.
      if (announced && announced.flippedToFinished && announced.masterIndex !== null) {
        await this.reportAdminState(
          {
            state: ADMIN_STATE_VOD,
            index: announced.masterIndex,
            duration: announced.duration ?? this.manifestManager.getTotalDuration(),
          },
          'so the recording is in the feed and the admin does not know it, which the recovery entry lets the next boot retry',
        );
        // ⛔⛔⛔ After the report and only when the ladder really flipped, which is the same rule the
        // standalone halves of this method both state at length: written earlier it announces a flip
        // the admin has not taken yet, and written unconditionally a resumed finalize announces a
        // second flip for one broadcast.
        this.logger.log(ladderFinalized(this.ladder.group));
      }

      this.metrics?.recordStreamFinalized();
      this.clearRecoveryEntry();
      return;
    }

    if (this.admin) {
      // ⛔ Exactly where the catalog's VOD entry is written below, and carrying exactly the two values
      // that entry would have carried, because they answer the same question: where the recording is
      // in this stream's feed and how long it plays. The recovery entry is still cleared last of all,
      // and the report is still allowed to throw, for the reason the catalog write is: it is the only
      // thing that tells anyone the broadcast became a recording, so a finalize that could not say so
      // has to leave the entry on disk for the next boot rather than report itself finished.
      await this.reportAdminState(
        { state: ADMIN_STATE_VOD, index: vodIndex, duration: this.manifestManager.getTotalDuration() },
        'so the recording is in the feed and the admin does not know it, which the recovery entry lets the next boot retry',
      );
      this.metrics?.recordStreamFinalized();
      this.clearRecoveryEntry();
      return;
    }

    if (this.ladder) {
      await this.announceRendition({ index: vodIndex, duration: this.manifestManager.getTotalDuration() });
      this.metrics?.recordStreamFinalized();
      this.clearRecoveryEntry();
      return;
    }

    const entry = {
      title: this.getFormattedDate(),
      owner: this.streamSigner.publicKey().address().toHex(),
      topic: this.streamRawTopic,
      state: STREAM_STATUS_VOD,
      index: vodIndex,
      duration: this.manifestManager.getTotalDuration(),
      mediatype: this.mediatype,
      timestamp: Date.now(),
    };

    // ⛔⛔⛔ After the write and only when the entry really flipped, which is the single-rendition
    // half of what `StreamCatalog.upsertRendition` records at length for a ladder. Both halves were
    // wrong here. Written before the write, the line announced a flip the feed had not taken yet, so
    // a crash in that gap left the log claiming a finished broadcast over an entry that honestly
    // still said `live`. Written unconditionally, a resumed finalize over a catalog that already
    // said `vod` announced a second flip for one broadcast, and `vodFinalizeCount` reads exactly
    // this line, so the fix for the double publish reported itself as the double publish.
    const flippedToVod = await this.streamCatalog.addStream(entry);
    if (flippedToVod) {
      this.logger.log(updatingStreamToVod(JSON.stringify(entry)));
    }

    // Counted here rather than by the orchestrator because `notifyStop` is memoized, so this line
    // runs exactly once however many drains ask. Counting it from a drain double-counted a session
    // that a reconnect replaced, since two drains await this one promise.
    this.metrics?.recordStreamFinalized();
    this.clearRecoveryEntry();
  }

  /**
   * Where this stream's finished recording already sits in its own manifest feed, or null when there
   * is none there and the ordinary publish has to run.
   *
   * ⛔⛔⛔ **Scenario H, measured live 2026-09-01.** `finalize` publishes the closing playlist, then
   * the VOD manifest, then writes the catalog, and deletes the recovery entry last of all. A kill
   * anywhere after the VOD manifest lands therefore leaves a recording in the feed, bought and paid
   * for, under an entry that still says the broadcast is recoverable. The next boot recovered it,
   * the recovery timer fired, and finalize ran again in full: a **second** recording at a higher
   * index, and the first one left in the feed unreachable because the catalog now names the newer.
   *
   * The feed is the only thing that knows. A recovery entry is written before the writes it
   * describes complete, so it cannot say how far the dead process got, and that is not a defect in
   * it: the crash is precisely what stopped it saying. Reading the head is a retrieval and costs no
   * postage, so this buys the answer for nothing, where guessing costs a recording.
   *
   * Only a session rebuilt off disk pays even that. A session this process announced has published
   * every index it holds and there is nothing to ask.
   *
   * ⛔ **And a recovered session stops paying it the moment it publishes something of its own.**
   * `resumedFromCrash` means built from a recovery entry, which is not the same as published nothing:
   * a rung that came back and carried on broadcasting for an hour is still flagged, and it would ask
   * the feed at the end of every one of those broadcasts. `announcedThrough` is the discriminator,
   * because it is null exactly until this session publishes a live manifest itself. Once it is set,
   * the head of the feed is this session's own live manifest, the dead process's indices are all
   * below it, and there is nothing a recording could be hiding at. The read would answer "no
   * recording" and buy that answer with the whole of its failure surface: a warming node costs the
   * broadcast its finalize, and the recovery entry it strands is a recording nobody publishes.
   */
  private async publishedRecordingIndex(): Promise<number | null> {
    // A stream that never committed a manifest has an empty feed, so there is nothing to read and
    // the closing playlist below is the first thing this topic will ever hold.
    if (!this.resumedFromCrash || this.socIndex === null || this.announcedThrough !== null) {
      return null;
    }

    const head = await this.readManifestFeedHead(RECORDING_ALREADY_PUBLISHED);
    return head !== null && isFinishedRecording(head.manifest) ? head.index : null;
  }

  /**
   * Whether this session's topic was written on before it started, so where the feed has got to has
   * to be read rather than assumed.
   *
   * Two kinds of session own a topic that outlives them, and they are the two this returns true for.
   * A **declared** stream in admin mode: the admin mints the topic when the stream is created and
   * hands it to viewers before anything has ever published on it, so one declaration is many
   * broadcasts on one feed. And a **rung** of a ladder, in either deployment: its topic is derived
   * from its ladder group and its rung name (`rungTopicFor`), so a rung that restarts mid-broadcast
   * comes back onto the feed it was already writing.
   *
   * ⛔ A standalone single-rendition stream is the one that does not, and it is the only one. Its
   * topic is a fresh `crypto.randomUUID()` per session, so the feed is empty by construction and
   * asking would spend a retrieval per broadcast to be told so.
   *
   * ⚠️ Nor does a session rebuilt from a recovery entry, whatever kind it is. That one already holds
   * the index and the numbering it published, and asking the feed now would read its own last
   * playlist — see {@link StreamState.sequenceOffset}. `publishedRecordingIndex` asks the feed the
   * sharper question a recovered session actually has.
   */
  private topicOutlivesThisSession(): boolean {
    return (this.admin !== undefined || this.ladder !== undefined) && !this.resumedFromCrash;
  }

  /**
   * Where this session's SOC writes and its playlist numbering must continue from, on a topic that
   * outlived the session before it. See {@link topicOutlivesThisSession}.
   *
   * ⛔⛔ **This is what pays for reusing a topic, and without it the second broadcast on one
   * overwrites the first.** A standalone single-rendition session mints a fresh
   * `crypto.randomUUID()` topic for exactly this reason: an empty feed starts at index 0 and cannot
   * collide with anything. Every other session opens over a feed that may already hold playlists, so
   * starting at 0 writes over them — including, at index 0, whatever the previous recording's opening
   * was.
   *
   * The feed is the only thing that knows how far the previous session got. This process may never
   * have seen it, the recovery entry was cleared when that session finalized, and the admin holds a
   * feed index for the recording rather than for the head. So the head is read, once, before anything
   * is written, and a read that does not complete **refuses the publish** rather than guessing: the
   * caller treats that as a failed manifest publish and tries again at the next segment, which costs
   * a stale live playlist for a few seconds where the other way round costs the previous recording.
   *
   * A 404 is an answer, not a failure: nothing has ever been written on this topic, so 0 is right.
   *
   * ⛔ **Two numbers come off that one read, not one.** Where the feed has got to says where this
   * session's SOC writes go. What the playlist at the head is numbered to says where this session's
   * `#EXT-X-MEDIA-SEQUENCE` carries on from — a viewer following the feed head is handed this
   * session's first playlist as the next update of the one they are playing, and hls.js reads a media
   * sequence that moved backwards as a parsing error rather than as a new broadcast. See
   * {@link continuesFrom} and `ManifestManager.continueFrom`.
   *
   * ⛔ **A third thing comes off it: the media that head holds.** The recording this session
   * finalizes opens with it, so the catalogue's head recording plays every session this feed has
   * carried rather than the last one alone. See {@link inheritedTimeline} and
   * `ManifestManager.inherit`.
   *
   * @returns whether the index is settled and a manifest may be committed.
   */
  private async resumeFeedIndex(): Promise<boolean> {
    if (!this.topicOutlivesThisSession() || this.feedIndexResumed) {
      return true;
    }

    let head: { index: number; manifest: string } | null;
    try {
      head = await this.readManifestFeedHead(FEED_HEAD_ON_START);
    } catch (error) {
      this.logger.error(getErrorMessage(error));
      return false;
    }

    // Latched only on an answer, so a read that failed is asked again at the next segment rather
    // than leaving the session permanently unable to publish.
    this.feedIndexResumed = true;
    if (head !== null) {
      this.socIndex = head.index;
      const continueAt = continuesFrom(head.manifest);
      if (continueAt !== null) {
        this.manifestManager.continueFrom(continueAt);
      }
      // Read off the same head, and only the head. What it holds is the recording this session's own
      // recording opens with, so the catalogue's head entry plays the broadcast from its first
      // session rather than from the last restart. A head that was left by a session which never
      // finalized is a live window, and only that window is here to inherit — that session's own
      // recovery entry is the path that recovers the rest of it. See `ManifestManager.inherit`.
      const prefix = inheritedTimeline(head.manifest);
      if (prefix !== null) {
        this.manifestManager.inherit(prefix);
      }
      this.logger.info(
        `[StreamUploader] Stream ${this.streamId} resumes its topic at SOC index ${head.index}, numbering ` +
          `its playlist from media sequence ${continueAt ?? 0}, so this session continues the feed rather ` +
          'than writing over the last one',
      );
      if (prefix !== null) {
        this.logger.info(
          `[StreamUploader] Stream ${this.streamId} opens its recording with the ${prefix.lines.length} ` +
            `timeline lines and ${prefix.durationSeconds.toFixed(3)}s of media already on this feed, so the ` +
            'recording it finalizes carries every session rather than this one alone',
        );
      }
    }
    // ⛔ Written here rather than left to the next segment, because this is the moment the entry
    // becomes writable at all: everything before this point was refused by {@link persistState} for
    // having nothing true to say about where this session stands in its feed. A crash between the
    // segments already held and the next one would otherwise leave no entry naming them.
    this.persistState();
    return true;
  }

  /**
   * Settle where this session stands in its feed, which every manifest it builds depends on.
   *
   * ⛔ Run **before a playlist is built** and not only before it is published. The head decides the
   * `#EXT-X-MEDIA-SEQUENCE` the playlist is written with, so a manifest built ahead of the answer
   * carries the wrong numbering however correct the index it lands at. {@link commitManifest} checks
   * the same two facts synchronously and refuses rather than settling them, so nothing built before
   * the answer can reach the feed.
   */
  private async settleFeedPosition(): Promise<boolean> {
    if (!this.predecessorHasDrained) {
      this.logger.warn(
        `[StreamUploader] Holding the manifest publish for ${this.streamId}: an earlier session is ` +
          'still finalizing onto the topic they share. Re-attempting at the next segment.',
      );
      return false;
    }
    return this.resumeFeedIndex();
  }

  /** Whether {@link settleFeedPosition} has already answered, which it has to before any publish. */
  private feedPositionSettled(): boolean {
    return this.predecessorHasDrained && (this.feedIndexResumed || !this.topicOutlivesThisSession());
  }

  /**
   * The playlist currently at the head of this stream's manifest feed, or null when the feed holds
   * nothing at all.
   *
   * ⛔ Throws rather than answering "there is nothing there" when the read fails, and it has no
   * "nothing there" to answer: the caller reaches it only for a stream holding an index it wrote
   * itself, so the feed is non-empty by construction and a read that did not complete says only
   * that it did not complete. Taking one for an empty feed reinstates the double publish this exists
   * to prevent, on exactly the node that was already having trouble. Failing instead defers the
   * finalize: the drain records it as failed and retires the uploader, which leaves the recovery
   * entry on disk, so the next boot recovers the stream and asks again. That costs a broadcast an
   * unfinalized interval and costs nothing that cannot be undone, where the other way round pays
   * twice for one recording.
   *
   * ⛔⛔ **Two calls, and neither is redundant.** The index has to be asked for, because
   * `this.socIndex` is persisted **after** the SOC write it describes, so a crash in that gap leaves
   * the entry naming an index the feed has already moved past, and reading there returns the live
   * playlist from before the finalize. Then the payload has to be asked for **at that index**,
   * because bee-js only rejoins a payload larger than one 4096 byte chunk on the indexed path, and a
   * VOD manifest naming every segment of a broadcast is far past that. Asked without an index the
   * answer for a real recording is the wrapper, which reads as "not a recording" and quietly turns
   * this whole guard off. Both shapes are the ones `StreamCatalog` already runs in production:
   * `init` takes the index this way and `fetchCurrentState` takes the payload this way.
   */
  private async readManifestFeedHead(question: FeedHeadQuestion): Promise<{ index: number; manifest: string } | null> {
    const owner = this.streamSigner.publicKey().address();
    const feedReader = this.bee.makeFeedReader(Topic.fromString(this.streamRawTopic), owner);

    try {
      const head = await this.readWithinWindow(async () => {
        try {
          return await feedReader.downloadPayload();
        } catch (error) {
          if (!isFeedHeadNotFound(error)) {
            throw error;
          }
          // The one place the two callers part company, and `emptyFeedIsAnAnswer` says which is
          // asking. For a topic this stream has already written, a 404 is inconclusive: wrapped
          // inside the retried function, because this is the only place the read's own failure is
          // still visible, and most refused slots on this deployment clear within a poll, so the
          // window turns the common transient into a finalize rather than a deferred broadcast.
          // For a declared topic nothing has ever published on, the same 404 is the answer.
          if (question.emptyFeedIsAnAnswer) {
            return null;
          }
          throw new FeedHeadNotRetrievedError(error);
        }
      });

      if (head === null) {
        return null;
      }

      // No absent-feed branch here, for either caller. The index above says something is at this
      // index, so a 404 now is a chunk that will not retrieve rather than a feed with nothing in it,
      // and answering "nothing was published" to that is the mistake this method exists to refuse.
      const update = await this.readWithinWindow(() => feedReader.downloadPayload({ index: head.feedIndex }));

      return { index: Number(head.feedIndex.toBigInt()), manifest: update.payload.toUtf8() };
    } catch (error) {
      throw new Error(
        `Cannot tell ${question.asked} for stream ${this.streamId}, because its ` +
          `manifest feed head did not read within ${FEED_HEAD_READ_WINDOW_MS}ms: ${getErrorMessage(error)}. ` +
          question.consequence,
      );
    }
  }

  private readWithinWindow<T>(read: () => Promise<T>): Promise<T> {
    return retryUntilDeadlineAsync(read, FEED_HEAD_READ_WINDOW_MS, UPLOAD_RETRY_BASE_MS, UPLOAD_RETRY_CAP_MS);
  }

  /**
   * Stop owning the crash-recovery entry under this stream id, because a newer session now holds it.
   *
   * A re-announce starts the replacement while this uploader is still finalizing, and both carry the
   * same stream id. Everything this one writes to or deletes from the recovery store after that point
   * lands on a broadcast that is still running: a save replaces the live session's state with an
   * outgoing session's, and the delete at the end of `notifyStop` discards it outright.
   *
   * ⛔ **What this does NOT stop is the SOC writes, and reading it as though it did is what let two
   * sessions onto one feed.** It gives up three things and they are all keyed by stream id — the
   * recovery entry here, the admin state report in {@link reportAdminState}, and the shared ladder
   * entry in {@link announceRendition}. A retired session goes on publishing manifests to the topic it
   * was built with, which is the whole point: its closing playlist and its VOD are what give the
   * broadcast it recorded an ending.
   *
   * ⚠️ That was safe for as long as the topic was a per-session `crypto.randomUUID()`, and this doc
   * said so — "the published media is unaffected, since each uploader owns its own feed topic". Admin
   * mode removed the premise without removing the sentence. There the topic comes from the declaration
   * and outlives every session on it, so a retired session and its replacement hold the same feed, and
   * the retired one's closing and VOD writes race the replacement's live ones for the same indexes.
   *
   * What makes it safe again is not this method: the orchestrator hands the replacement the retired
   * session's finalize, and the replacement publishes nothing until it settles. See
   * {@link StreamUploaderOptions.predecessorDrained}, and `StreamOrchestrator.startStream`'s
   * re-announce branch for where the two are tied together.
   */
  public retire(): void {
    this.ownsRecoveryEntry = false;
  }

  private clearRecoveryEntry(): void {
    if (this.ownsRecoveryEntry) {
      this.recoveryStore.remove(this.streamId);
    }
  }

  public getStreamState(): StreamState {
    const manifestState = this.manifestManager.getState();
    return {
      streamId: this.streamId,
      streamRawTopic: this.streamRawTopic,
      mediatype: this.mediatype,
      socIndex: this.socIndex,
      segments: manifestState.segments,
      hlsHeaders: manifestState.hlsHeaders,
      ...readinessToPersisted(this.readiness),
      pendingDiscontinuity: this.pendingDiscontinuity,
      liveManifestStale: this.hasStaleLiveManifest(),
      updatedAt: Date.now(),
      ladder: this.ladder,
      bitrate: this.bitrate,
      // Read from the manifest manager rather than from what this session was constructed with,
      // because a restart re-anchors it mid-session. See `ManifestManager.broadcastAnchor`.
      anchor: this.manifestManager.broadcastAnchor(),
      // Persisted for the same reason the anchor is: it is a property of the numbering already in the
      // feed, and a recovered session that lost it would publish this broadcast's history again from
      // a number a viewer has already been handed.
      sequenceOffset: this.manifestManager.publishedSequenceOffset(),
      // Persisted beside the offset because the two were read off one head, and after a crash that
      // head is this session's own live playlist. A recovered session that re-read it would glue its
      // own window in front of itself; one that simply lost this would finalize a recording naming
      // only what it had held since the crash, which is the whole defect the gluing exists to end.
      inherited: this.manifestManager.inheritedPrefix() ?? undefined,
      // Read off the manifest manager rather than mirrored here, so there is one holder of the one
      // shot and a crash between the encoder returning and its first segment landing comes back with
      // the seam and the re-anchoring still owed. See {@link resumeAfterReconnect}.
      resumingAfterReconnect: this.manifestManager.isResumingAfterReconnect(),
      // Absent outside admin mode, and absent on every entry written before admin mode existed. See
      // {@link StreamState.adminStreamId} for why a recovered session cannot resolve it again.
      adminStreamId: this.admin?.id,
    };
  }

  /**
   * What the ladder rung looks like to a player right now.
   *
   * Falls back to the encoder's configured target until segments have actually been measured, so
   * the master playlist is complete and usable from the first one rather than advertising a
   * bandwidth of zero.
   */
  private buildRendition(final?: { index: number; duration: number }): Rendition {
    const rung = this.ladder!.rung;
    const configuredBps = rung.configuredKbps * 1000;

    return {
      name: rung.name,
      width: rung.width,
      height: rung.height,
      topic: this.streamRawTopic,
      bandwidth: peakBandwidth(this.bitrate, configuredBps),
      avgBandwidth: averageBandwidth(this.bitrate, configuredBps),
      ...(final ?? {}),
    };
  }

  public hasStaleLiveManifest(): boolean {
    return this.consecutiveManifestFailures > 0;
  }

  public getConsecutiveManifestFailures(): number {
    return this.consecutiveManifestFailures;
  }

  /**
   * Segments dropped back to back, each after its retry window was already spent. Unlike a manifest
   * publish, a dropped segment is not retried later: the data is gone and its sequence is published as
   * a gap entry, so this counter is the only trace an upload failure leaves in this class.
   */
  public getConsecutiveSegmentFailures(): number {
    return this.consecutiveSegmentFailures;
  }

  /**
   * Tell the admin where this broadcast got to, and throw if it could not be told.
   *
   * ⛔ **Throws on failure, even though `AdminApiClient.reportState` never does.** That split is the
   * whole point of the client answering with a value: the client's job is to keep trying for four
   * seconds without an exception escaping into a network path, and this method's job is to make a
   * report that never landed cost the same as a catalog write that never landed. It has to cost the
   * same, because both callers are built around it doing so — `announceToCatalog` catches, records
   * the age and re-attempts on its own cadence, and `finalize` lets it propagate so the drain records
   * a failure and the recovery entry stays on disk for the next boot.
   *
   * `already-settled` is not a failure. The admin answers 409 for a transition it cannot make from
   * the state it holds, and the ordinary way to reach that is a report this stream already delivered
   * before a crash. Retrying that forever would strand the broadcast.
   *
   * ⚠️ Skipped entirely once a newer session holds this stream id, and this is sharper than the same
   * guard on `announceRendition`. Outside admin mode a retired session still owns its own feed topic,
   * so its VOD entry describes a recording nobody else is writing. In admin mode both sessions share
   * one declared stream, so a retired session reporting `vod` would mark the broadcast that replaced
   * it as finished.
   *
   * ⛔ This covers the *report* and nothing else. The retired session still publishes manifests to the
   * declared topic the two of them share, and `ownsRecoveryEntry` does not gate that — what keeps the
   * two off one feed is the replacement waiting, not this session stopping. See {@link retire}.
   */
  private async reportAdminState(report: AdminStateReport, whatIsLost: string): Promise<void> {
    const admin = this.admin!;
    if (!this.ownsRecoveryEntry) {
      this.logger.warn(
        `[StreamUploader] Not reporting ${report.state} for ${this.streamId}: a newer session holds it, ` +
          'and the admin stream is shared between them',
      );
      return;
    }

    const outcome = await admin.client.reportState(admin.id, report);
    if (!stateWasReported(outcome)) {
      throw new Error(`Could not report ${report.state} for stream ${this.streamId} to the admin API, ${whatIsLost}`);
    }
  }

  /**
   * Merge this rung into its ladder, wherever the ladder is kept, and answer what that achieved.
   *
   * @returns `null` when nothing was announced because a newer session holds this rung. Only admin
   * mode reads the announcement: standalone, the catalog carries the ladder's whole state itself and
   * a rung has nothing to do with the answer.
   */
  private async announceRendition(final?: { index: number; duration: number }): Promise<RenditionAnnouncement | null> {
    if (!this.ownsRecoveryEntry) {
      // A re-announce has handed this rung to a newer session. The catalog and master entry are keyed
      // by rung name, which this outgoing session shares, so any upsert from here overwrites the live
      // rung with a retired session's topic and a VOD index. The VOD manifest this session published
      // stands on its own feed; only the shared ladder entry is off limits. Mirrors persistState.
      return null;
    }

    const rendition = this.buildRendition(final);

    this.lastAnnounceAttemptAt = Date.now();

    this.logger.log(publishingRendition(rendition.name, this.ladder!.group));
    const announced = await this.ladderRegistry.upsertRendition(
      {
        title: this.getFormattedDate(),
        owner: this.streamSigner.publicKey().address().toHex(),
        group: this.ladder!.group,
        mediatype: this.mediatype,
        // Absent standalone, where the catalog never reads it. In admin mode it is what addresses the
        // report, and it is the ladder's rather than this rung's: one declared stream is one ladder.
        adminStreamId: this.admin?.id,
      },
      rendition,
    );

    this.driftBaselineBps = rendition.bandwidth;
    return announced;
  }

  private async refreshBandwidthIfDrifted(): Promise<void> {
    if (!this.ladder || this.readiness !== READINESS_ANNOUNCED || this.driftBaselineBps <= 0) {
      return;
    }

    if (Date.now() - this.lastAnnounceAttemptAt < BITRATE_REFRESH_INTERVAL_MS) {
      return;
    }

    const drift = Math.abs(this.bitrate.peakBps - this.driftBaselineBps) / this.driftBaselineBps;
    if (drift < BITRATE_REFRESH_RATIO) {
      return;
    }

    // Swallowed rather than propagated: the caller is an unawaited segment task that must go on to
    // persist its progress, and this is a correction to a bandwidth already published.
    try {
      await this.announceRendition();
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamUploader.refreshBandwidthIfDrifted');
    }
  }

  private uploadLiveManifest(): void {
    if (this.liveManifestQueued) {
      return;
    }

    this.liveManifestQueued = true;
    void this.manifestQueue.add(async () => {
      this.liveManifestQueued = false;
      // ⛔ Before the build and not only before the publish. Where this session's feed stands decides
      // the `#EXT-X-MEDIA-SEQUENCE` the playlist below is written with, so a manifest built ahead of
      // that answer is wrong in the one number a viewer following the feed head cannot survive being
      // wrong. Answers immediately once settled, which is after the first segment of the session.
      if (!(await this.settleFeedPosition())) {
        this.recordManifestPublishFailure();
        return;
      }
      // Unreachable from the only caller, which queues this straight after adding a segment, so the
      // manager always holds one by the time the job runs and no test can drive this branch. Kept
      // because publishing an empty manifest is a paid SOC write that tells viewers the playlist is
      // empty, which is worse than the publish this skips.
      const manifest = this.manifestManager.buildLiveManifest();
      if (!manifest) {
        return;
      }
      // Both read here, beside the build and before anything is awaited. `handleSegment` runs between
      // awaits, so either read taken after the publish returns would describe a manifest other than
      // the one being published.
      const newestNamed = this.manifestManager.liveWindowNewestIndex();
      const neverNamed =
        this.announcedThrough === null ? 0 : this.manifestManager.segmentsNeverNamed(this.announcedThrough);

      const index = await this.commitManifest(manifest);
      if (index === null) {
        this.recordManifestPublishFailure();
        return;
      }

      this.consecutiveManifestFailures = 0;
      this.reportSegmentsNeverNamed(neverNamed);
      this.announcedThrough = newestNamed;
    });
  }

  /** One live manifest that did not reach the feed, however far down the publish it got. */
  private recordManifestPublishFailure(): void {
    this.consecutiveManifestFailures += 1;
    this.metrics?.recordManifestPublishFailure();
    this.logger.warn(
      `Live manifest for stream ${this.streamId} is stale: ${this.consecutiveManifestFailures} consecutive publish failure(s)`,
    );
  }

  /**
   * Segments that were uploaded and that no manifest will ever name.
   *
   * Their bytes are in Swarm and any viewer handed the address could fetch them. A viewer learns of a
   * segment only from a manifest, and the window slid past these before one naming them was
   * published, so the media is simply missing from every playlist with not even a gap entry to mark
   * it: their sequences are filled, by segments this uploader is holding and nobody was told about.
   * That makes this the quietest way this uploader can lose a piece of a broadcast, and until now
   * nothing counted it: `recordSegmentDropped` answers a failed upload and `recordSegmentsLost`
   * answers segments the engine never had.
   *
   * The window has to outrun its own publishing for this to happen, which
   * `MANIFEST_UPLOAD_RETRY_WINDOW_MS` permits for {@link MANIFEST_UPLOAD_RETRY_WINDOW_MS}ms while the
   * segment queue keeps running.
   */
  private reportSegmentsNeverNamed(count: number): void {
    if (count === 0) {
      return;
    }
    this.segmentsNeverNamed += count;
    this.metrics?.recordSegmentsNeverNamed(count);
    this.logger.warn(
      `Stream ${this.streamId} published a live manifest that skipped ${count} uploaded segment(s): ` +
        `the window advanced past them before a manifest naming them was published, so no viewer can ` +
        `reach them. ${this.segmentsNeverNamed} total this stream.`,
    );
  }

  /** Segments uploaded but never named in any published manifest, for the life of this stream. */
  public getSegmentsNeverNamed(): number {
    return this.segmentsNeverNamed;
  }

  private async commitManifest(manifestContent: string): Promise<number | null> {
    // ⛔ Before the head read, because the head is only worth reading once it is final. The session
    // this one replaced shares the declared topic and is still writing its closing and VOD manifests
    // onto it; reading past it would hand both sessions the same next index, and its VOD would then
    // land above this session's live playlist and leave the feed head claiming a live broadcast had
    // finished.
    //
    // Refused rather than awaited or settled here, and that is the asymmetry
    // {@link settleFeedPosition} states: the caller treats a null as a failed manifest publish and
    // re-attempts at the next segment, so the cost is a stale live playlist for the length of the
    // drain. Waiting here instead would hold the manifest queue for a drain that may never finish.
    // Segments keep uploading throughout — only naming them in a playlist waits — so nothing is lost,
    // and a drain that hangs stalls the live playlist rather than corrupting the recording.
    //
    // ⛔ Synchronous, so it refuses `manifestContent` rather than settling anything: the caller built
    // that string, and it was numbered from whatever this session knew at the time. Settling here
    // would publish a playlist numbered from zero onto a feed the read has just said already holds
    // one.
    if (!this.feedPositionSettled()) {
      this.logger.warn(
        `[StreamUploader] Refusing the manifest publish for ${this.streamId}: where its feed stands is ` +
          'not settled, so this playlist was numbered without it. Re-attempting at the next segment.',
      );
      return null;
    }

    const nextIndex = this.socIndex === null ? 0 : this.socIndex + 1;
    const data = Buffer.from(manifestContent, 'utf-8');
    const result = await this.uploadDataAsSoc(nextIndex, data);

    if (!result) {
      this.logger.error(
        `Failed to upload manifest at SOC index ${nextIndex} of ${this.streamId}; will retry at the same ` +
          `index when the next segment triggers a publish`,
      );
      return null;
    }

    this.socIndex = nextIndex;

    if (needsCatalogAnnounce(this.readiness)) {
      // ⛔ Both of these are below the `feedPositionSettled` refusal above, and that ordering is what
      // stops the admin being told a stream is `live` while no recovery entry exists to flip it back.
      // See {@link persistState}.
      this.persistState();
      await this.announceToCatalog();
    }

    this.logger.log(manifestUploaded(this.streamId, nextIndex));
    this.persistState();
    return nextIndex;
  }

  /**
   * Publish this stream to the catalog, at most once per `CATALOG_ANNOUNCE_RETRY_MS`.
   *
   * The rate limit is the whole point: a failure left the stream short of `announced`, and every later
   * manifest publish then re-attempted, so a catalog that was down cost a paid feed write per segment
   * and nothing said so. Giving up instead would be worse, since the entry is the only thing that
   * makes a live broadcast discoverable, so this keeps trying at a rate set by the viewer rather than
   * by the encoder.
   */
  private async announceToCatalog(): Promise<void> {
    const now = Date.now();
    if (this.lastCatalogAnnounceAt !== null && now - this.lastCatalogAnnounceAt < this.catalogAnnounceRetryMs) {
      return;
    }

    this.lastCatalogAnnounceAt = now;
    try {
      await this.notifyStart();
      this.readiness = onCatalogAnnounced(this.readiness);
      this.catalogAnnounceFailedAt = null;
    } catch (error) {
      this.catalogAnnounceFailedAt ??= now;
      this.errorHandler.handleError(error, 'StreamUploader.notifyStart');
    }
  }

  /**
   * How long this stream has been live and absent from the catalog, or null while it is listed.
   *
   * An age rather than a count of failures, because the retry window and the segment cadence are
   * unrelated: a count says how many times the write was attempted, and the thing an operator needs
   * is how long a viewer has been unable to find a broadcast that is running.
   */
  public getMsSinceCatalogAnnounceFailed(): number | null {
    return this.catalogAnnounceFailedAt === null ? null : Date.now() - this.catalogAnnounceFailedAt;
  }

  /**
   * How long this stream's state has been failing to reach disk, or null when the last save landed.
   *
   * The failure was logged and otherwise swallowed, which made it the quietest way to lose a
   * broadcast: recovery reads whatever did land, so a crash then re-uploads or drops everything
   * written since, and until it happens the stream looks perfectly healthy.
   */
  public getMsSinceStatePersistFailed(): number | null {
    return this.statePersistFailedAt === null ? null : Date.now() - this.statePersistFailedAt;
  }

  /**
   * Write the recovery entry, once there is anything true to write in it.
   *
   * ⛔⛔ **A session whose feed position is not settled persists nothing at all, and that is the
   * safe half of the trade.** Where the head stands decides two facts this entry is the only surviving
   * record of: the media sequence this session numbers from, and the recording it opens with. Both
   * come off one head read, which runs behind the first segment's upload and is NOT awaited by the
   * segment path — `uploadLiveManifest` is fired and `persistState` follows it immediately. So an
   * entry written in between says `sequenceOffset: 0` and no inherited recording, which are not
   * "unknown yet" but a positive claim that this session opened on an empty feed. A crash there used
   * to resurrect the session on that claim: a recovered session never reads its head
   * ({@link topicOutlivesThisSession} is false for one), so it republished the broadcast's numbering
   * from a number viewers had already been handed and finalized a recording that silently dropped
   * every earlier session.
   *
   * Nothing is lost by waiting, and the ordering is what makes that true rather than luck.
   * {@link commitManifest} refuses every publish until the same two facts are settled, so a session
   * that has not settled them has told no viewer anything and there is no published history for a
   * recovery to keep faith with. The segments it uploaded are in Swarm and unnamed, which is exactly
   * what they would be had the process died one moment earlier.
   *
   * ⛔⛔ **That includes the admin, and it is load bearing rather than incidental.** The `live` report
   * is `notifyStart`'s, `notifyStart` has exactly one caller in `announceToCatalog`, and
   * `announceToCatalog` has exactly one caller in {@link commitManifest} — BELOW its
   * `feedPositionSettled` refusal, and one line below a `persistState` of its own. So the admin
   * cannot be told a stream is `live` while no recovery entry exists: by the time anything reports it,
   * the position is settled and the entry is written. Were the announce ever moved in front of that
   * gate, this refusal would strand an admin row at `live` with nothing left on the uploader side to
   * flip it, because the entry the next boot would have recovered from was never written. Keep the
   * announce behind the gate.
   *
   * A standalone single-rendition stream settles trivially — its topic is fresh per session — so it
   * persists from its first segment exactly as it always did.
   */
  private persistState(): void {
    if (!this.ownsRecoveryEntry) {
      return;
    }
    if (!this.feedPositionSettled()) {
      return;
    }
    try {
      this.recoveryStore.save(this.streamId, this.getStreamState());
      this.statePersistFailedAt = null;
    } catch (error) {
      this.statePersistFailedAt ??= Date.now();
      this.logger.error(`Failed to persist state for ${this.streamId}:`, error);
    }
  }

  private async uploadDataAsSoc(index: number, data: Uint8Array) {
    try {
      const { uploadPayload } = this.bee.makeFeedWriter(Topic.fromString(this.streamRawTopic), this.streamSigner);
      // NOT deferred, unlike the segment write below, and the asymmetry is deliberate.
      //
      // Deferred means bee acks the SOC from its own local store and push-syncs it in the
      // background, so the publish reports success while the chunk is still only local and a
      // viewer's gateway is told about a segment it cannot yet resolve. This was deferred until
      // LAT-10 measured what that costs: worst capture-to-fetchable 14.04s and 14.53s over two
      // 30-minute broadcasts, against 9.04s and 9.27s with the synchronous write, and the buffer a
      // player needs 12.08s against 7.08s.
      //
      // The comment this replaces justified deferring as avoiding an ~80s block behind the segment
      // backlog. That was a post-restart condition. In steady state the synchronous push costs
      // about 300ms and logs no retries at all.
      //
      // Safe to block: retryUntilDeadlineAsync bounds retries, not one slow call.
      return await retryUntilDeadlineAsync(
        () => uploadPayload(this.stamp, data, { index, deferred: false }),
        MANIFEST_UPLOAD_RETRY_WINDOW_MS,
        UPLOAD_RETRY_BASE_MS,
        UPLOAD_RETRY_CAP_MS,
      );
    } catch (error) {
      this.errorHandler.handleError(error, 'StreamUploader.uploadDataAsSoc');
      return null;
    }
  }

  private async uploadDataToBee(data: Uint8Array) {
    try {
      return await retryUntilDeadlineAsync(
        () => this.bee.uploadData(this.stamp, data, { redundancyLevel: this.redundancyLevel, deferred: true }),
        SEGMENT_UPLOAD_RETRY_WINDOW_MS,
        UPLOAD_RETRY_BASE_MS,
        UPLOAD_RETRY_CAP_MS,
      );
    } catch (error) {
      this.reportBatchRefusal(error);
      this.errorHandler.handleError(error, 'StreamUploader.uploadDataToBee');
      return null;
    }
  }

  /**
   * The one named line for a postage batch bee will not take a segment against.
   *
   * ⛔⛔⛔ **A filling batch does not fall silent, it ramps, and one answer from bee gets one line
   * whatever the ramp does.** Measured on the first live drain, 2026-09-04: bee refused one rung's
   * depth 17 batch four times in about fifty seconds with segments landing in between. A batch stops
   * accepting a chunk whose own bucket is full, so at the first overflow almost every bucket still has
   * room and a segment of about 300 chunks is refused with roughly a quarter of the probability,
   * rising to nearly all of it a few thousand chunks later. So a landed segment after a refusal is the
   * ramp rather than a new batch, and it must not re-arm the line: the batch id is fixed for the life
   * of this process, since `BEE_PUBLISHERS` is read once at start, and the only thing that can replace
   * it is a redeploy, which is a new process with {@link batchRefusalStatuses} empty again.
   *
   * ⛔ **Why the retry verdict decides it and not the mere fact of a failure.** A bee node that is
   * down throws with no status, spends the whole retry window, and drops the segment exactly as a
   * refused batch does. Reporting that as a refused batch would send an operator to the postage side
   * of a node that is simply gone, which is the confusion this line exists to remove rather than
   * cause. So it fires only for a status the policy refuses to retry, and it carries that status and
   * bee's own words instead of a guess at which of them means "empty".
   *
   * ⚠️ Segment uploads only, which is the `/bytes` POST. `uploadDataAsSoc` spends the same batch and a
   * refused publish is evidence of the same condition, but that one is retried at the next segment and
   * the rung goes on publishing media, so reporting it would say a rung had gone quiet while it was up.
   *
   * ⚠️ `segmentUploadFailed` still fires for every segment the ramp costs, and the per-rung drop
   * counter still climbs on each one. This line is the diagnosis, those are the consequences.
   */
  private reportBatchRefusal(error: unknown): void {
    const status = nonRetryableStatus(error);
    if (status === undefined) {
      return;
    }

    // Recorded against the publisher before the log is deduplicated, and on the process-lifetime
    // counters rather than on anything this session owns. Everything else this uploader reports is
    // read back off the orchestrator's `activeStreams`, which the end of a broadcast empties, and this
    // is the one condition that outlives the broadcast: the batch stays dead, the finalize fails on it
    // and leaves no recording, and the catalog goes on saying `live`. See `ServiceMetrics`.
    this.metrics?.recordPostageRefusal(this.publisher, status, Date.now());

    if (this.batchRefusalStatuses.has(status)) {
      return;
    }
    this.batchRefusalStatuses.add(status);
    this.logger.error(rungBatchRefused(this.stamp, this.streamId, status, beeAnswer(error)));
  }

  private getFormattedDate(): string {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `${day}/${month}/${year}`;
  }
}
