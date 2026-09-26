import { StartGateWarning } from '../types.js';

/**
 * Counters that outlive every stream they describe.
 *
 * `/health` reports the streams that exist right now, which is exactly why it answers `ok` with
 * `activeStreams: 0` at the moment a live session has been wrongly killed: there is nothing left to
 * describe, so the healthiest possible reading is also the worst possible state. See OBS-17. These
 * are process-lifetime totals, so what happened stays readable after the stream it happened to is
 * gone, which is the whole reason they are separate from `HealthSignals`.
 *
 * Monotonic counters only, never decremented, so a scraper can take a rate over them. Live readings
 * that can go down, such as queue depth, are gauges the orchestrator supplies at scrape time rather
 * than state kept here.
 */
export class ServiceMetrics {
  private segmentsUploaded = 0;
  private segmentsDropped = 0;
  private segmentsLost = 0;
  private manifestPublishFailures = 0;
  private streamsFinalized = 0;
  private streamsFailed = 0;
  private streamsReaped = 0;
  private segmentDurationsUnread = 0;
  private segmentsSkipped = 0;
  private openingSegmentsWithheld = 0;
  private segmentsNeverNamed = 0;
  private authRejections = 0;
  private takeoversRefused = 0;
  /**
   * Uploads per ABR rung, which the totals above cannot give.
   *
   * ⛔ Four rungs at 0.5s segments need 2.00 uploads a second each, and one shared Bee node was
   * measured delivering 5.61 across all four rather than 8.00. Whether one node per rung fixes that
   * is a per-rung question, and until 2026-08-31 the only reading was a grep of this service's log.
   *
   * Unbounded in principle, bounded in practice by ABR_LADDER, which the engine and this service both
   * refuse to start on if it is malformed. A rung only appears once it has uploaded something.
   */
  private readonly segmentsUploadedByRung = new Map<string, number>();
  /**
   * Losses per ABR rung, which `segmentsDropped` cannot give and which a drained postage batch is read
   * off.
   *
   * ⛔ Each rung publishes through its own bee with its own prepaid batch, so a batch that runs dry
   * costs one quality and leaves the other three publishing. The total climbs identically whether one
   * rung of four lost everything or all four lost a little, so on a ladder it cannot say which quality
   * a viewer stopped being offered. Read next to `segmentsUploadedByRung`: one rung's drops climbing
   * while its uploads thin out is the drained-batch signature, and they thin rather than stop because
   * a filling batch refuses a growing share of segments over a minute or two rather than all of them
   * at once.
   *
   * Keyed and bounded exactly as its sibling above, and a rung only appears once it has lost something.
   */
  private readonly segmentsDroppedByRung = new Map<string, number>();
  /**
   * Publishers bee has refused a paid write on, keyed by {@link publisherKey}.
   *
   * ⛔⛔⛔ **Keyed by publisher rather than by stream, and that is the whole of the fix.** Every other
   * reading `/health` gives is folded over the orchestrator's `activeStreams`, and a broadcast ending
   * empties its entry out of that map. A batch that filled mid-broadcast therefore took its only alarm
   * with it at exactly the moment it did the most damage: the finalize failed on that same dead batch,
   * the recovery entry was retained, no recording was published, the catalog went on saying `live`, and
   * `/health` answered 200 with nothing wrong. A refused batch is a fact about a node and a batch id,
   * never about the broadcast that happened to discover it.
   *
   * ⛔ **Nothing here ever clears it, and nothing should.** `BEE_PUBLISHERS` is read once at process
   * start, so the batch a rung spends cannot change while this process lives. Only a redeploy carrying
   * a different batch id clears this, because a redeploy is a different process with this map empty.
   * A segment landing afterwards is the ramp rather than a recovery: a filling batch refuses the chunks
   * whose own bucket is full, so it loses a growing share of segments over a minute or two rather than
   * all of them at once. See `StreamUploader.reportBatchRefusal` for the measurement behind that.
   */
  private readonly postageRefusals = new Map<string, PostageRefusal>();
  private startGateWarnings: StartGateWarning[] = [];
  private lastSegmentAt: number | null = null;
  private lastAuthRejectionAt: number | null = null;

  /**
   * A segment whose payload reached Swarm.
   *
   * `rung` is the ABR rung it belongs to, absent on a single-rendition stream. Absent is not folded
   * into a placeholder rung: a segment that belongs to no rung is counted in the total and nowhere in
   * the breakdown, because inventing a rung for it would make the breakdown's sum look complete while
   * naming a rung the deployment does not have.
   */
  public recordSegmentUploaded(at: number, rung?: string): void {
    this.segmentsUploaded += 1;
    this.lastSegmentAt = at;
    if (rung !== undefined) {
      this.segmentsUploadedByRung.set(rung, (this.segmentsUploadedByRung.get(rung) ?? 0) + 1);
    }
  }

  /**
   * A segment that reached the uploader and was never stored, counted the same for both ways that
   * happens. Either the upload was retried until its window was spent, which is what a bee node that
   * went away produces, or bee refused it with a status the uploader does not retry, which is a
   * postage batch filling up and costs the segment on the first answer with no window spent at all.
   * The data is gone either way.
   *
   * `rung` is read exactly as {@link recordSegmentUploaded} reads it: absent on a single-rendition
   * stream, and absent means counted in the total and nowhere in the breakdown rather than counted
   * under a rung the deployment does not have. The two breakdowns are label-comparable because of it,
   * which is what makes "this rung's drops climbing while its uploads thin out" a readable query.
   */
  public recordSegmentDropped(rung?: string): void {
    this.segmentsDropped += 1;
    if (rung !== undefined) {
      this.segmentsDroppedByRung.set(rung, (this.segmentsDroppedByRung.get(rung) ?? 0) + 1);
    }
  }

  /**
   * Segments the engine could never obtain, so they never reached an uploader at all. Counted by the
   * size of the gap rather than once per report, because the origin picks that size.
   */
  public recordSegmentsLost(count: number): void {
    this.segmentsLost += count;
  }

  public recordManifestPublishFailure(): void {
    this.manifestPublishFailures += 1;
  }

  public recordStreamFinalized(): void {
    this.streamsFinalized += 1;
  }

  /** A stop whose finalize never published. There is no VOD for that broadcast and no retry. */
  public recordStreamFailed(): void {
    this.streamsFailed += 1;
  }

  /**
   * A broadcast the reaper GAVE UP ON because its engine went silent, rather than because anything
   * asked. See #86.
   *
   * ⛔ This counts the reaper's decision, not the finalize that follows it. The increment happens
   * before `stopStream`, which is fired and forgotten, so a rise here means "this many broadcasts were
   * abandoned by their engine", never "this many VODs were published". Its siblings
   * `recordStreamFinalized` and `recordStreamFailed` both count outcomes, which is the distinction the
   * word "finalized" used to blur here.
   *
   * The call site stays where it is deliberately: it is the engine-health signal the reaper exists to
   * provide, and moving it behind a successful stop would lose it in exactly the case an operator most
   * needs it, an engine dying while Bee is also refusing writes. A reap whose finalize fails also
   * increments `streamsFailed`, so the two counters together separate "engine died" from "and we could
   * not publish the recording either".
   *
   * Worth a counter of its own rather than folding into the finalize total, because every one of these
   * is an engine that died without sending `on_unpublish`. A deployment where this is routine has a
   * sick engine, and before the reaper existed that condition was invisible: the stream simply stayed
   * live forever and nothing counted it.
   */
  public recordStreamReaped(): void {
    this.streamsReaped += 1;
  }

  /**
   * A segment whose own timestamps could not be read, so the engine's claim about it was published.
   *
   * Counted rather than only logged because **no shipped deployment should ever reach it**, and a
   * thing that should never happen needs a rate rather than a line. Both engines deliver MPEG-TS:
   * SRS writes it, and OME is pulled from `ts:playlist.m3u8` rather than its fMP4 playlist. So any
   * rise means `readVideoPts` found no video PES where there should be one, and every `#EXTINF`
   * since is the engine's claim rather than the media. On SRS that claim measured 20 to 25% long.
   *
   * The log line beside this fires once per stream, so it says a stream had the problem and cannot
   * say for how much of it. That is what this counter is for.
   */
  public recordSegmentDurationUnread(): void {
    this.segmentDurationsUnread += 1;
  }

  /**
   * Segments the CON-20 handover floor discarded on purpose, counted once per playlist index.
   *
   * The floor deliberately leaves the high-water where it is during a handover, so the same indexes
   * are re-examined on every poll. Counting per pass would turn a five-segment window into hundreds.
   */
  public recordSegmentsSkipped(count: number): void {
    this.segmentsSkipped += count;
  }

  /**
   * A segment withheld because the broadcast had not produced any video yet, counted once per index.
   *
   * Read it next to `segments_uploaded_total`, which is the whole reason it is separate from
   * `segments_skipped_total`. Climbing for a few seconds at the start of a broadcast and then
   * stopping is the guard working. Climbing while uploads stay flat is a publisher that never sent a
   * frame, and the ceiling below it will hand the broadcast back within ten seconds either way.
   */
  public recordOpeningSegmentWithheld(): void {
    this.openingSegmentsWithheld += 1;
  }

  /**
   * Segments uploaded successfully that no published manifest ever named.
   *
   * Distinct from all three counters above, and the distinction is the whole reason it exists. These
   * were not dropped, the engine did have them, and nothing chose to discard them: they are in Swarm
   * and retrievable, and the live window advanced past them before a manifest naming them was
   * published, so no viewer is ever told the address. Nothing else in this class can be non-zero when
   * this is, which is what makes it worth reading on its own.
   */
  public recordSegmentsNeverNamed(count: number): void {
    this.segmentsNeverNamed += count;
  }

  /** A request a credential gate refused. Never reset, so a scraper can take a rate over it. */
  public recordAuthRejection(at: number): void {
    this.authRejections += 1;
    this.lastAuthRejectionAt = at;
  }

  /**
   * An announce refused because another publisher holds that stream id, either by still feeding it
   * or by having proved the stream's publish key. See `reasonToRefuseTakeover` for which.
   *
   * Counted because the refusal is otherwise a log line, and it is the one control here that takes a
   * broadcaster off the air on evidence that can be wrong: two publishers behind one egress address
   * look like one, and one publisher whose address changed looks like two.
   *
   * **It cannot say which of those it is counting.** An attack and a legitimate broadcaster being
   * locked out of their own id produce the identical count, so this is a prompt to go and look at who
   * holds the stream, not a verdict. `POST /stream/stop` is what frees an id held by the wrong
   * session. See SEC-26 and SEC-28.
   */
  public recordTakeoverRefused(): void {
    this.takeoversRefused += 1;
  }

  /**
   * A paid write bee answered with a status the upload policy will not retry, which is a postage
   * batch that has stopped accepting chunks.
   *
   * `at` is the caller's instant and is kept only for the first refusal on a publisher, because what
   * an operator needs is when the batch started failing rather than when it last did. The statuses
   * accumulate instead, for the reason `StreamUploader.batchRefusalStatuses` keeps a set rather than a
   * flag: a different status is a different condition, and keeping only the first would let an early
   * 400 or 404 stand in the payload while the postage refusal that followed it went unnamed.
   */
  public recordPostageRefusal(publisher: PublisherIdentity, status: number, at: number): void {
    const key = publisherKey(publisher);
    const seen = this.postageRefusals.get(key);
    if (seen === undefined) {
      this.postageRefusals.set(key, {
        rung: publisher.rung,
        url: publisher.url,
        stamp: publisher.stamp,
        statuses: [status],
        firstRefusedAt: at,
      });
      return;
    }
    if (!seen.statuses.includes(status)) {
      this.postageRefusals.set(key, { ...seen, statuses: [...seen.statuses, status] });
    }
  }

  /**
   * Deliberately not part of `MetricsCounters`, which is exactly the set `/metrics` renders. This
   * feeds the `/health` policy, which needs an age rather than an instant.
   */
  public getLastAuthRejectionAt(): number | null {
    return this.lastAuthRejectionAt;
  }

  /**
   * Every publisher bee has refused a paid write on, in the order they were first refused.
   *
   * Carries the node URL and the batch id as configured. `/metrics` renders the count of these and
   * never their contents, and `/health` reports them through the orchestrator, which renders each one
   * off `BeePublisherPool.routing` so an unauthenticated reader is told exactly what the `publishers`
   * block already tells them and no more.
   */
  public getPostageRefusals(): readonly PostageRefusal[] {
    return [...this.postageRefusals.values()];
  }

  /**
   * What the last startup gate pass warned about, replacing whatever the pass before it left.
   *
   * Replaced rather than accumulated, unlike the refusals above, because the gates are read again on
   * every attempt of a node wait: a rung that was unreachable on attempt one and fine on attempt two
   * is not something to report about the service that is now running. The pass that clears is the
   * pass that empties this. After the boot the chequebook's share is replaced the same way by each of
   * `ChequebookRecheck`'s reads, which keep the rest.
   */
  public setStartGateWarnings(warnings: readonly StartGateWarning[]): void {
    this.startGateWarnings = [...warnings];
  }

  public getStartGateWarnings(): readonly StartGateWarning[] {
    return this.startGateWarnings;
  }

  public getCounters(): MetricsCounters {
    return {
      segmentsUploadedTotal: this.segmentsUploaded,
      segmentsUploadedByRung: Object.fromEntries(this.segmentsUploadedByRung),
      segmentsDroppedTotal: this.segmentsDropped,
      segmentsDroppedByRung: Object.fromEntries(this.segmentsDroppedByRung),
      segmentsLostTotal: this.segmentsLost,
      segmentsSkippedTotal: this.segmentsSkipped,
      openingSegmentsWithheldTotal: this.openingSegmentsWithheld,
      segmentsNeverNamedTotal: this.segmentsNeverNamed,
      manifestPublishFailuresTotal: this.manifestPublishFailures,
      streamsFinalizedTotal: this.streamsFinalized,
      streamsFailedTotal: this.streamsFailed,
      streamsReapedTotal: this.streamsReaped,
      segmentDurationsUnreadTotal: this.segmentDurationsUnread,
      authRejectionsTotal: this.authRejections,
      takeoversRefusedTotal: this.takeoversRefused,
      postageRefusedPublishers: this.postageRefusals.size,
      lastSegmentAt: this.lastSegmentAt,
    };
  }
}

/**
 * One rung's Bee node and the postage batch it spends there. `BeePublisher` satisfies this.
 *
 * Declared here rather than imported so this class keeps depending on nothing, the way
 * `PostageGate.StampedPublisher` is declared beside its own use.
 */
interface PublisherIdentity {
  readonly rung: string;
  readonly url: string;
  readonly stamp: string;
}

/** One publisher's postage refusals, as {@link ServiceMetrics.getPostageRefusals} reports them. */
interface PostageRefusal extends PublisherIdentity {
  /** Every distinct status bee answered with on this publisher, in the order they were first seen. */
  readonly statuses: readonly number[];
  /** Epoch milliseconds of the first refusal, which is when this rung's postage stopped working. */
  readonly firstRefusedAt: number;
}

/**
 * The node and the batch, which is the identity `PostageGate.distinctByNodeAndStamp` already checks a
 * batch under, plus the rung it is routed to so the payload can name the quality an operator lost.
 * One node can hold several batches and two rungs can be pointed at one, so no part of this is
 * redundant.
 */
function publisherKey(publisher: PublisherIdentity): string {
  return `${publisher.rung} ${publisher.url} ${publisher.stamp}`;
}

interface MetricsCounters {
  segmentsUploadedTotal: number;
  /**
   * Uploads per ABR rung. Empty on a single-rendition deployment, where a segment belongs to no rung.
   *
   * ⚠️ These do **not** have to sum to `segmentsUploadedTotal`, and a check that insists they do is
   * wrong: a single-rendition stream and a ladder stream can both be live at once, and the first
   * contributes to the total alone.
   */
  segmentsUploadedByRung: Readonly<Record<string, number>>;
  segmentsDroppedTotal: number;
  /**
   * Drops per ABR rung. Empty on a single-rendition deployment, and empty on a ladder that has lost
   * nothing, which are the same reading and both correct.
   *
   * ⚠️ These do not have to sum to `segmentsDroppedTotal`, for the reason the uploaded breakdown does
   * not sum to its own total: a single-rendition stream contributes to the total alone.
   */
  segmentsDroppedByRung: Readonly<Record<string, number>>;
  segmentsLostTotal: number;
  /** Segments the CON-20 handover floor discarded on purpose. Correct behaviour, not a failure. */
  segmentsSkippedTotal: number;
  /** Opening segments withheld because the broadcast had produced no video yet. See task #41. */
  openingSegmentsWithheldTotal: number;
  segmentsNeverNamedTotal: number;
  manifestPublishFailuresTotal: number;
  streamsFinalizedTotal: number;
  streamsFailedTotal: number;
  /** Broadcasts finalized because their engine went silent rather than because anything asked. See #86. */
  streamsReapedTotal: number;
  /** Segments published with the engine's declared duration because their own timestamps were unreadable. */
  segmentDurationsUnreadTotal: number;
  /** Requests refused by a credential gate, across every gate in the process. */
  authRejectionsTotal: number;
  /** Announces refused because a live session on that stream id is still producing. See SEC-26. */
  takeoversRefusedTotal: number;
  /**
   * Publishers bee has refused a paid write on, which is how many rungs have lost their postage.
   *
   * A set size rather than a count of events, so it never double-counts the same dead batch however
   * many segments it goes on refusing, and never decreases, because nothing in this process can make
   * a refused batch usable again.
   */
  postageRefusedPublishers: number;
  /** Epoch milliseconds of the newest segment that reached Swarm, or null while none has. */
  lastSegmentAt: number | null;
}

/** Everything `/metrics` reports: the counters above, plus readings taken at scrape time. */
export interface MetricsSnapshot extends MetricsCounters {
  activeStreams: number;
  /** Segments waiting to upload, across every registered stream. */
  queueDepth: number;
  /**
   * Playing time of everything still waiting to upload, in seconds, for the worst stream.
   *
   * The number an operator actually wants, and the one `queuePressure` could not give: a depth is
   * only meaningful next to `MAX_QUEUE_SIZE`, which has no relationship to how far behind live a
   * viewer is. A 39 deep backlog reported `low` at roughly 78 seconds behind live. See OBS-9.
   */
  queueBacklogSeconds: number;
}
