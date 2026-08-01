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
  private segmentsSkipped = 0;
  private authRejections = 0;
  private lastSegmentAt: number | null = null;
  private lastAuthRejectionAt: number | null = null;

  /** A segment whose payload reached Swarm. */
  public recordSegmentUploaded(at: number): void {
    this.segmentsUploaded += 1;
    this.lastSegmentAt = at;
  }

  /** A segment that reached the uploader and whose upload retry window was spent. The data is gone. */
  public recordSegmentDropped(): void {
    this.segmentsDropped += 1;
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
   * Segments the CON-20 handover floor discarded on purpose, counted once per playlist index.
   *
   * The floor deliberately leaves the high-water where it is during a handover, so the same indexes
   * are re-examined on every poll. Counting per pass would turn a five-segment window into hundreds.
   */
  public recordSegmentsSkipped(count: number): void {
    this.segmentsSkipped += count;
  }

  /** A request a credential gate refused. Never reset, so a scraper can take a rate over it. */
  public recordAuthRejection(at: number): void {
    this.authRejections += 1;
    this.lastAuthRejectionAt = at;
  }

  /**
   * Deliberately not part of `MetricsCounters`, which is exactly the set `/metrics` renders. This
   * feeds the `/health` policy, which needs an age rather than an instant.
   */
  public getLastAuthRejectionAt(): number | null {
    return this.lastAuthRejectionAt;
  }

  public getCounters(): MetricsCounters {
    return {
      segmentsUploadedTotal: this.segmentsUploaded,
      segmentsDroppedTotal: this.segmentsDropped,
      segmentsLostTotal: this.segmentsLost,
      segmentsSkippedTotal: this.segmentsSkipped,
      manifestPublishFailuresTotal: this.manifestPublishFailures,
      streamsFinalizedTotal: this.streamsFinalized,
      streamsFailedTotal: this.streamsFailed,
      authRejectionsTotal: this.authRejections,
      lastSegmentAt: this.lastSegmentAt,
    };
  }
}

export interface MetricsCounters {
  segmentsUploadedTotal: number;
  segmentsDroppedTotal: number;
  segmentsLostTotal: number;
  /** Segments the CON-20 handover floor discarded on purpose. Correct behaviour, not a failure. */
  segmentsSkippedTotal: number;
  manifestPublishFailuresTotal: number;
  streamsFinalizedTotal: number;
  streamsFailedTotal: number;
  /** Requests refused by a credential gate, across every gate in the process. */
  authRejectionsTotal: number;
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
