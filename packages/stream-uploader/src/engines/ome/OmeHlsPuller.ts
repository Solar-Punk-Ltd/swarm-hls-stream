import { Logger } from '../../libs/Logger.js';
import { StreamOrchestrator } from '../../libs/StreamOrchestrator.js';
import { getErrorMessage } from '../../utils/common.js';

import { Fetcher, PlaylistEntry, PullerOptions } from './interfaces.js';
import { isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist } from './utils.js';

const logger = Logger.getInstance();

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * How many consecutive passes may fail on the same segment before it is written off. Retrying forever
 * parks the live edge behind one bad segment, and by this many attempts the origin has usually rolled
 * it out of its window anyway, so the honest answer is to announce the gap and move on.
 */
export const SEGMENT_RETRY_LIMIT = 3;

/** How long a playlist may keep answering 404 before the puller gives up on the stream. */
export const DEFAULT_HALT_AFTER_NOT_FOUND_MS = 60_000;

/**
 * How long an unusable origin is retried at the ordinary poll interval before the puller slows to one
 * poll per this long. At the 500ms default interval that turns the halt window's 120 requests into 21.
 *
 * Two-speed rather than immediate because a cold start is a 404: the puller polls from the moment the
 * admission lands, and OME publishes the playlist a moment later, so the commonest run of failures
 * belongs to a stream that is about to work. Backing off from the first one would add startup latency
 * to every stream in exchange for sparing an origin that does not need sparing.
 *
 * Well under the halt window, since the halt is only checked on a retry and so cannot fire more than
 * one slow poll late. It does not have to stay under `RECOVERY_TIMEOUT`, which has a floor of 1ms:
 * `retryDelayMs` refuses to slow down at all while a recovery finalize is riding on the polls.
 */
export const DEFAULT_SLOW_POLL_AFTER_MS = 5_000;

/**
 * How long every segment in the playlist may sit under the handover floor, with nothing delivered,
 * before the floor is given up as wrong. Comfortably longer than any real handover, which is over
 * within one playlist window, and far shorter than a broadcast.
 */
export const DEFAULT_ABANDON_FLOOR_AFTER_MS = 30_000;

/**
 * `AbortSignal.timeout` aborts with a `TimeoutError` DOMException, and an explicit `controller.abort()`
 * with an `AbortError`. Both mean the request was cut off rather than answered, which is the case an
 * operator needs to see at error level: it is indistinguishable from a healthy stream in every other log.
 */
function isAbortedRequest(error: unknown): boolean {
  const name = (error as { name?: string } | null | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export class OmeHlsPuller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private lastSeq = -1;
  /**
   * First playlist index this puller ever saw. `lastSeq` cannot serve as the floor for a gap report
   * until something is delivered, and a puller that fails from its very first segment never delivers
   * anything, so without this the losses at a cold start are the ones that go unreported.
   */
  private baselineSeq: number | null = null;
  private failingSeq: number | null = null;
  private failedAttempts = 0;
  private notFoundSince: number | null = null;
  /** Whether the last poll renewed a pending recovery finalize, which is what makes the poll rate matter. */
  private isDeferringRecovery = false;
  private readonly masterUrl: string;
  private mediaPlaylistUrl: string | null = null;

  /**
   * Newest segment start this puller has seen advertised, whether or not it delivered it. What the
   * origin was *serving* is what the replacement has to skip past, so a high-water over delivered
   * segments alone would leave the tail this puller never got to.
   */
  private newestProgramDateTime: number | null = null;
  /** Highest index already logged as skipped, so an unchanged playlist is not re-announced every poll. */
  private highestSkipLogged: number | null = null;
  private floorMatchedEverythingSince: number | null = null;

  private readonly onHalt?: () => void;
  private readonly onSegmentTimeObserved?: (newest: number | null) => void;
  private readonly fetcher: Fetcher;
  private readonly fetchTimeoutMs: number;
  private readonly haltAfterNotFoundMs: number;
  private readonly abandonFloorAfterMs: number;
  private readonly slowPollAfterMs: number;
  private staleBefore: number | null;

  constructor(
    private streamId: string,
    app: string,
    stream: string,
    hlsBaseUrl: string,
    private intervalMs: number,
    private orchestrator: StreamOrchestrator,
    options: PullerOptions = {},
  ) {
    this.onHalt = options.onHalt;
    // Resolved per call rather than captured, so instrumentation that replaces globalThis.fetch after
    // construction is still seen. Capturing it here would silently opt this class out of an APM agent.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.haltAfterNotFoundMs = options.haltAfterNotFoundMs ?? DEFAULT_HALT_AFTER_NOT_FOUND_MS;
    this.abandonFloorAfterMs = options.abandonFloorAfterMs ?? DEFAULT_ABANDON_FLOOR_AFTER_MS;
    this.slowPollAfterMs = options.slowPollAfterMs ?? DEFAULT_SLOW_POLL_AFTER_MS;
    this.staleBefore = options.staleBefore ?? null;
    this.onSegmentTimeObserved = options.onSegmentTimeObserved;
    const base = hlsBaseUrl.replace(/\/+$/, '');
    this.masterUrl = `${base}/${app}/${stream}/ts:playlist.m3u8`;
  }

  /**
   * Read through an accessor rather than testing `state` inline, because `stop()` is called from
   * outside this class while a pass is awaiting a fetch. Narrowing on a field convinces the compiler
   * the value cannot have changed across that await, and it is precisely the value that does.
   */
  private get isStopped(): boolean {
    return this.state === 'stopped';
  }

  start(): void {
    if (this.state !== 'idle') {
      return;
    }

    this.state = 'running';
    logger.info(`[OME] HLS puller started for ${this.streamId} -> ${this.masterUrl}`);
    this.scheduleNext(0);
  }

  stop(): void {
    this.state = 'stopped';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info(`[OME] HLS puller stopped for ${this.streamId}`);
  }

  private scheduleNext(delayMs: number): void {
    if (this.isStopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.tick().catch((error) => {
        const msg = getErrorMessage(error);
        if (isAbortedRequest(error)) {
          logger.error(`[OME] Puller request aborted after ${this.fetchTimeoutMs}ms for ${this.streamId}: ${msg}`);
        } else {
          logger.warn(`[OME] Puller tick error for ${this.streamId}: ${msg}`);
        }
        // Every failure that is not a 404 arrives here: a refused connection, a 5xx, a timeout, a
        // playlist that would not parse. They are the same thing to the stream as a 404 is, so they
        // have to reach the same accounting, or the deferral misses the outage it exists for and the
        // halt never fires on an origin that is permanently broken rather than merely absent.
        if (this.noteOriginUnusable('the origin')) {
          return;
        }
        this.scheduleNext(this.retryDelayMs);
      });
    }, delayMs);
  }

  /**
   * How long to wait before retrying an origin that has not given us usable media. Ordinary interval
   * while the outage is young, then one poll per `slowPollAfterMs`. See `DEFAULT_SLOW_POLL_AFTER_MS`
   * for why it is two-speed rather than growing from the first failure.
   */
  private get retryDelayMs(): number {
    // Slowing down is only safe while nothing is riding on the poll rate, and a crash-recovered stream
    // is: its finalize is deferred one `RECOVERY_TIMEOUT` per poll and by nothing else, so polling
    // slower than that window finalizes a live broadcast under its own puller. `RECOVERY_TIMEOUT` has
    // a floor of 1ms and this puller cannot see it, so the deferral says when it is load-bearing
    // instead, which is what `keepAlive` answers.
    if (this.isDeferringRecovery) {
      return this.intervalMs;
    }

    const unusableForMs = this.notFoundSince === null ? 0 : Date.now() - this.notFoundSince;
    if (unusableForMs < this.slowPollAfterMs) {
      return this.intervalMs;
    }
    // An operator who polls slower than this would otherwise be sped up by the origin breaking.
    return Math.max(this.intervalMs, this.slowPollAfterMs);
  }

  private resetRetryCounter(): void {
    this.notFoundSince = null;
  }

  /**
   * Every HTTP call the puller makes goes through here, so the abort window cannot be forgotten at a
   * new call site. A fresh signal per call, because a shared one would abort later requests the moment
   * the first window elapsed.
   */
  private fetchWithTimeout(url: string): Promise<Response> {
    return this.fetcher(url, { signal: AbortSignal.timeout(this.fetchTimeoutMs) });
  }

  private async tick(): Promise<void> {
    if (this.isStopped) {
      return;
    }

    const playlistData = await this.fetchPlaylistData();

    if (!playlistData) {
      return;
    }

    this.resetRetryCounter();
    await this.processPlaylist(playlistData, this.mediaPlaylistUrl as string);

    this.scheduleNext(this.intervalMs);
  }

  private async fetchPlaylistData(): Promise<string | null> {
    if (!this.mediaPlaylistUrl) {
      const playlistUrl = await this.fetchMediaPlaylistUrl();
      if (!playlistUrl) {
        // If not ready yet (404)
        return null;
      }
    }

    const url = this.mediaPlaylistUrl as string;
    const rawPlaylistResponse = await this.fetchWithTimeout(url);

    if (rawPlaylistResponse.status === 404) {
      this.handleNotFound('media playlist');
      // re-resolve on the next tick.
      this.mediaPlaylistUrl = null;
      return null;
    }

    if (!rawPlaylistResponse.ok) {
      throw new Error(`Media playlist HTTP ${rawPlaylistResponse.status}`);
    }

    const body = await rawPlaylistResponse.text();

    // The URL we latched onto can turn out to be a master (variant) playlist — e.g. our first poll
    // landed on an early stub before OME published the master, so we fell back to the master URL.
    // Parsing a master as a media playlist yields zero segments forever, so re-resolve and follow the
    // variant instead of polling a dead URL.
    if (isMasterPlaylist(body)) {
      this.setMediaPlaylistUrl(body);
      this.scheduleNext(this.intervalMs);
      return null;
    }

    return body;
  }

  /**
   * `lastSeq` advances only past a segment that actually reached the orchestrator, so every failure
   * ends this pass and the next tick re-pulls the same index. Continuing instead would advance past
   * the failed segment on the next success, and its own `seq <= lastSeq` guard would then drop that
   * index forever: a hole in the manifest that no health signal can see, since a segment that never
   * arrives is a segment that never failed to upload.
   *
   * The two ways out of a hold both go through `reportSegmentLoss`, so an index is either delivered
   * or announced, never merely stepped over.
   */
  private async processPlaylist(playlist: string, url: string): Promise<void> {
    const segments = parseMediaPlaylist(playlist);
    this.recordNewestProgramDateTime(segments);
    let skipped = 0;

    for (const segment of segments) {
      if (this.isStopped) {
        return;
      }
      if (segment.seq <= this.lastSeq) {
        continue;
      }
      // Before the baseline is taken and before any loss is reported, because media from the session
      // this puller replaced is neither this session's starting point nor a gap in it.
      if (this.belongsToReplacedSession(segment)) {
        skipped++;
        // Once this session has delivered something the handover is behind us, so a straggler under
        // the floor is not a gap in this session's media. Leaving the high-water where it is makes
        // `reportSegmentsRolledOutBefore` announce the skipped index as rolled-out media: an error
        // line and a discontinuity in the manifest for a segment that was deliberately dropped and
        // was sitting in the playlist a tick earlier.
        if (this.lastSeq >= 0) {
          this.lastSeq = segment.seq;
        }
        continue;
      }

      if (this.baselineSeq === null) {
        this.baselineSeq = segment.seq;
      }

      this.reportSegmentsRolledOutBefore(segment.seq);

      const segmentUrl = new URL(segment.uri, url).toString();
      try {
        const segmentResponse = await this.fetchWithTimeout(segmentUrl);

        if (!segmentResponse.ok) {
          logger.warn(`[OME] Segment ${segment.seq} fetch failed for ${this.streamId}: HTTP ${segmentResponse.status}`);
          if (this.holdsForRetry(segment.seq)) {
            return;
          }
          continue;
        }

        const segmentBuffer = Buffer.from(await segmentResponse.arrayBuffer());

        if (this.isStopped) {
          // Same reason `reportSegmentLoss` refuses to report after a stop: this download started
          // before it and answered after, so by now the id can belong to a different session, and
          // handing this over would publish one session's media into another's manifest.
          logger.warn(`[OME] Segment ${segment.seq} arrived for ${this.streamId} after the puller stopped, discarding`);
          return;
        }

        const result = this.orchestrator.handleSegment(
          this.streamId,
          segment.seq,
          segment.duration,
          segmentBuffer,
          segment.discontinuity,
        );

        if (!result.accepted) {
          logger.warn(`[OME] Segment ${segment.seq} not accepted for ${this.streamId}: ${result.reason}`);
          // Backpressure/rejection: leave lastSeq unchanged so the next tick re-pulls this segment in order.
          // Not a download failure, so it does not count against the retry limit.
          return;
        }

        this.lastSeq = segment.seq;
        this.failingSeq = null;
        this.failedAttempts = 0;
      } catch (error) {
        const msg = getErrorMessage(error);
        if (isAbortedRequest(error)) {
          logger.error(
            `[OME] Segment ${segment.seq} aborted after ${this.fetchTimeoutMs}ms for ${this.streamId}: ${msg}`,
          );
        } else {
          logger.warn(`[OME] Segment ${segment.seq} fetch error for ${this.streamId}: ${msg}`);
        }
        if (this.holdsForRetry(segment.seq)) {
          return;
        }
      }
    }

    this.retireFloorIfItIsSwallowingTheStream(skipped, segments.length);
  }

  private recordNewestProgramDateTime(segments: PlaylistEntry[]): void {
    for (const segment of segments) {
      if (
        segment.programDateTime !== undefined &&
        segment.programDateTime > (this.newestProgramDateTime ?? -Infinity)
      ) {
        this.newestProgramDateTime = segment.programDateTime;
      }
    }
    this.onSegmentTimeObserved?.(this.newestProgramDateTime);
  }

  /**
   * A floor above everything the origin serves discards the entire broadcast, and does it silently and
   * without end: nothing is delivered, so no gap is ever reported, and the playlist keeps answering
   * 200, so the not-found halt never fires either. The stream looks alive and records nothing, and at
   * close it publishes no VOD at all.
   *
   * The only thing that produces a floor that high is a floor that was wrong when it was handed over,
   * which an origin clock stepping backwards between two sessions does. Give it up rather than keep
   * discarding, and say so loudly: losing the handover costs one playlist window, losing the floor's
   * judgement costs the broadcast.
   */
  private retireFloorIfItIsSwallowingTheStream(skipped: number, advertised: number): void {
    // No exemption once this session has delivered something. A straggler pass cannot reach here,
    // because a skip past the handover steps the high-water and the next pass absorbs it before the
    // floor is consulted, so arriving here at all means the origin keeps producing new media the floor
    // keeps rejecting, which is the same broken boundary whether or not something landed earlier.
    if (this.staleBefore === null || advertised === 0 || skipped < advertised) {
      this.floorMatchedEverythingSince = null;
      return;
    }

    const now = Date.now();
    if (this.floorMatchedEverythingSince === null) {
      this.floorMatchedEverythingSince = now;
      return;
    }
    if (now - this.floorMatchedEverythingSince <= this.abandonFloorAfterMs) {
      return;
    }

    logger.error(
      `[OME] Every segment ${this.streamId} advertised has been older than the session this puller replaced for ${this.abandonFloorAfterMs}ms, so that boundary cannot be right. Giving it up and taking what the origin serves.`,
    );
    this.staleBefore = null;
    this.floorMatchedEverythingSince = null;
  }

  /**
   * Whether this segment was already being served by the session this puller took over from.
   *
   * A replacement puller starts with no high-water and a duplicate filter the orchestrator has just
   * reset, so on a reconnect it would otherwise ingest whatever the origin still had up: measured
   * against a real OME as a full five-segment window of the previous broadcast, for the five seconds
   * it takes the dropped SRT session to be reaped. See CON-20.
   *
   * Nothing is skipped without a date-time to judge it by. That an origin publishes none is reported
   * by the engine when it builds the replacement, which is where the absence is knowable for the
   * whole session rather than one segment at a time.
   */
  private belongsToReplacedSession(segment: PlaylistEntry): boolean {
    if (this.staleBefore === null || segment.programDateTime === undefined) {
      return false;
    }

    if (segment.programDateTime > this.staleBefore) {
      return false;
    }

    // Once per index, not once per poll. The skip deliberately does not advance the high-water during
    // a handover, so the same segments are re-examined on every tick, and logging each time turns a
    // five-segment window into a line every hundred milliseconds for as long as the origin serves it.
    if (segment.seq > (this.highestSkipLogged ?? -Infinity)) {
      this.highestSkipLogged = segment.seq;
      logger.info(
        `[OME] Skipping segment ${segment.seq} for ${this.streamId}: it belongs to the session this puller replaced`,
      );
    }
    return true;
  }

  /**
   * Records a failed download of `seq` and answers whether to end the pass here, so the next tick
   * re-pulls that same index. A `false` answer means the segment has just been written off and
   * reported, and the loop is free to carry on to the ones behind it.
   */
  private holdsForRetry(seq: number): boolean {
    this.failedAttempts = seq === this.failingSeq ? this.failedAttempts + 1 : 1;
    this.failingSeq = seq;

    if (this.failedAttempts < SEGMENT_RETRY_LIMIT) {
      return true;
    }

    return !this.reportSegmentLoss(seq, seq, `${this.failedAttempts} consecutive download failures`);
  }

  /**
   * Indexes between the last delivered segment and `nextSeq` are gone from the origin's playlist, so
   * no later tick can fetch them. Reporting them is what keeps a rolled-out gap off the silent path.
   *
   * Announced as one range rather than one report per index, because the origin picks the size of that
   * gap: a restarted OME serving a high `#EXT-X-MEDIA-SEQUENCE` would otherwise cost a log line and a
   * queued job per missing index, millions of each. The uploader needs a discontinuity and a count,
   * and neither is any truer for being delivered a million times.
   *
   * Nothing is reported before the first delivery, because a playlist legitimately starts at whatever
   * media sequence the origin is serving when the puller joins.
   */
  private reportSegmentsRolledOutBefore(nextSeq: number): void {
    const firstMissing = this.lastSeq >= 0 ? this.lastSeq + 1 : this.baselineSeq;
    if (firstMissing === null || nextSeq <= firstMissing) {
      return;
    }

    this.reportSegmentLoss(firstMissing, nextSeq - 1, 'the origin rolled it out of its playlist window');
  }

  /**
   * Segments that will never be delivered, `firstSeq` through `lastSeq` inclusive. `lastSeq` advances
   * past an undelivered segment only here, so the gap reaches the uploader instead of appearing as a
   * silent hole: `handleSegmentLoss` marks the next segment as a discontinuity and moves the counter
   * `/health` reads.
   */
  private reportSegmentLoss(firstSeq: number, lastSeq: number, cause: string): boolean {
    const count = lastSeq - firstSeq + 1;
    const subject = count === 1 ? `Segment ${firstSeq}` : `Segments ${firstSeq} to ${lastSeq}`;

    if (this.isStopped) {
      // A fetch started before the stop can answer after it, and by then the id may belong to a new
      // session. Reporting there degrades a healthy stream and marks its first segment with a
      // discontinuity that never happened.
      logger.warn(`[OME] ${subject} lost for ${this.streamId} after the puller stopped, not reporting`);
      return false;
    }

    if (!this.orchestrator.handleSegmentLoss(this.streamId, firstSeq, count)) {
      // Nothing recorded the gap, so stepping over it would lose these indexes with no trace at all,
      // which is the failure this whole path exists to prevent. Hold and let the next tick retry.
      logger.warn(`[OME] ${subject} lost for ${this.streamId} but no stream is registered to record it`);
      return false;
    }

    logger.error(`[OME] ${subject} lost for ${this.streamId} after ${cause}, marking a discontinuity`);
    this.lastSeq = lastSeq;
    this.failingSeq = null;
    this.failedAttempts = 0;
    return true;
  }

  private async fetchMediaPlaylistUrl(): Promise<boolean> {
    const res = await this.fetchWithTimeout(this.masterUrl);

    if (res.status === 404) {
      this.handleNotFound('master playlist');
      return false;
    }

    if (!res.ok) {
      throw new Error(`Master playlist HTTP ${res.status}`);
    }

    const playlist = await res.text();
    this.setMediaPlaylistUrl(playlist);

    return true;
  }

  private setMediaPlaylistUrl(playlist: string): void {
    if (isMasterPlaylist(playlist)) {
      const variantUri = parseMasterPlaylist(playlist);
      this.mediaPlaylistUrl = new URL(variantUri, this.masterUrl).toString();
      logger.info(`[OME] Resolved variant playlist for ${this.streamId}: ${this.mediaPlaylistUrl}`);
    } else {
      this.mediaPlaylistUrl = this.masterUrl;
      logger.info(`[OME] Using master URL as media playlist for ${this.streamId}`);
    }
  }

  private handleNotFound(target: string): void {
    if (this.noteOriginUnusable(target)) {
      return;
    }

    this.scheduleNext(this.retryDelayMs);
  }

  /**
   * The origin did not give us usable media this poll, whatever the reason. Answers whether the puller
   * has now given up, so the caller knows not to schedule another tick.
   *
   * A 404 is only one of the ways an origin goes quiet, and it is not the likeliest. A restarting
   * container refuses the connection, and one behind a proxy answers 502 or 503, both of which reject
   * or throw rather than reaching a status check. Routing every one of them through here is what makes
   * the two effects below cover the case they were written for. See CON-10 and OBS-18.
   */
  private noteOriginUnusable(target: string): boolean {
    if (this.isStopped) {
      // This poll started before the stop and answered after it, so by now the id can belong to the
      // session that replaced this puller, and both effects below reach outside this object.
      // `keepAlive` would defer that session's recovery finalize. `onHalt` is worse: the engine wires
      // it to `pullers.delete(streamId)`, which drops the **live** puller out of its registry, and to
      // `orchestrator.stopStream(streamId)`, which finalizes a running broadcast as a VOD.
      //
      // Reported as given up, because a stopped puller has, which is also what keeps the caller from
      // scheduling another poll.
      return true;
    }

    const now = Date.now();
    if (this.notFoundSince === null) {
      this.notFoundSince = now;
      logger.warn(
        `[OME] ${target} not answering for ${this.streamId}, retrying for up to ${this.haltAfterNotFoundMs}ms`,
      );
    }

    // A crash-recovered stream is the one most likely to be here, because the engine and the uploader
    // come back on their own schedules. Without this the recovery timer finalized the broadcast as a
    // VOD while this puller was still retrying for it, and the two windows are the same 60s by default,
    // so an OME restart only had to be marginally slow.
    //
    // The deferral is bounded by the halt below and by nothing else, which is why `notFoundSince` has
    // to accumulate across every kind of failure. It previously did not: `fetchMediaPlaylistUrl` reset
    // it on a master that answered, so a master serving 200 with a variant serving 404 deferred the
    // finalize on every poll and never halted. That stream was never finalized at all, and a stream
    // awaiting recovery is excluded from the stall signal, so nothing said so.
    this.isDeferringRecovery = this.orchestrator.keepAlive(this.streamId);

    if (now - this.notFoundSince > this.haltAfterNotFoundMs) {
      logger.info(`[OME] ${target} gone for ${this.streamId}, halting puller`);
      this.stop();
      this.onHalt?.();
      return true;
    }

    return false;
  }
}
