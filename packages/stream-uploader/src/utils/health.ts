import {
  HEALTH_DEGRADED,
  HEALTH_OK,
  HEALTH_REASON_FRAGMENT_MISMATCH,
  HEALTH_REASON_FRAGMENT_PUBLISHER_GOP,
  HEALTH_REASON_INGEST_REFUSED,
  HEALTH_REASON_NODE_UNAVAILABLE,
  HEALTH_REASON_POSTAGE_REFUSED,
  HEALTH_REASON_QUEUE_PRESSURE,
  HEALTH_REASON_SEGMENT_LOSS,
  HEALTH_REASON_SEGMENT_STALL,
  HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
  HEALTH_REASON_STALE_MANIFEST,
  HEALTH_REASON_START_GATE_WARNED,
  HEALTH_REASON_STATE_NOT_PERSISTED,
  HEALTH_REASON_UNLISTED_STREAM,
  HEALTH_REASON_UNRECOVERABLE_STREAM,
  HEALTH_WAITING_FOR_NODE,
  HealthReason,
  HealthReport,
  HealthSignals,
  NodeWaitReport,
  PRESSURE_HIGH,
} from '../types.js';

/**
 * A failed live-manifest publish is retried at the same SOC index when the next segment arrives, so
 * one or two consecutive failures are a hiccup that self-heals. Three mean the live playlist has
 * stopped advancing for viewers, which is worth waking someone for.
 */
export const MANIFEST_FAILURE_THRESHOLD = 3;

/**
 * One is the threshold because a segment failure is already permanent when it is counted: the retry
 * window is spent, the data is gone and its sequence is published as a gap entry. The count is
 * consecutive, so it clears on the next successful segment rather than latching.
 *
 * This counts uploads that failed, not segments the engine never obtained. Those are reported as an
 * age instead, see `HealthSignals.msSinceSegmentLoss`, because a consecutive counter cannot express
 * them: the puller writes a segment off and downloads the next one in the same pass, so the success
 * that clears the counter always lands before anything can read it.
 */
export const SEGMENT_FAILURE_THRESHOLD = 1;

const MS_PER_SECOND = 1_000;

/**
 * The whole degradation policy, kept in one pure function so every threshold is assertable without
 * a running server or a clock.
 */
export function deriveHealthStatus(
  signals: HealthSignals,
  segmentStallMs: number,
  /** The boot's own state, and absent for a service whose boot has finished. See `libs/NodeWait.ts`. */
  nodeWait: NodeWaitReport | null = null,
): HealthReport {
  // ⛔ Before every threshold below and alone, because none of them has anything to describe yet. A
  // service still waiting for its node has read no catalog, recovered no stream and uploaded no
  // segment, so every signal is the zero it was initialised with and reads as a healthy service.
  // Answering `ok` there is the one answer nothing downstream would question.
  if (nodeWait !== null) {
    return { status: HEALTH_WAITING_FOR_NODE, reasons: [HEALTH_REASON_NODE_UNAVAILABLE] };
  }

  const reasons: HealthReason[] = [];

  // First of the running service's reasons, because it is the only one about the boot rather than
  // about the media: a gate that warned instead of refusing is a chequebook or a batch this service
  // was started on anyway, and nothing it does later will clear it. One reason however many rungs
  // warned, since the names are on the payload and a reason per rung would read as several faults.
  if (signals.startGateWarnings.length > 0) {
    reasons.push(HEALTH_REASON_START_GATE_WARNED);
  }

  if (signals.maxConsecutiveManifestFailures >= MANIFEST_FAILURE_THRESHOLD) {
    reasons.push(HEALTH_REASON_STALE_MANIFEST);
  }

  if (signals.maxConsecutiveSegmentFailures >= SEGMENT_FAILURE_THRESHOLD) {
    reasons.push(HEALTH_REASON_SEGMENT_UPLOAD_FAILURE);
  }

  // The diagnosis for the symptom above, which is why it sits next to it, and it is latched rather
  // than counted because the two answer different questions. The counter above is consecutive and per
  // stream, so it clears on the next segment that lands and it disappears entirely when the broadcast
  // ends: a batch filling bucket by bucket made it flap, and a batch that was dead when the stream
  // stopped left `/health` reporting `ok` while the finalize failed on that same batch, no recording
  // was published and the catalog went on saying `live`. This one is a fact about a publisher rather
  // than about a stream, so no threshold and no window can apply to it.
  if (signals.postageRefusedPublishers > 0) {
    reasons.push(HEALTH_REASON_POSTAGE_REFUSED);
  }

  // Two triggers for one reason, because they answer different questions. The ratio says the queue is
  // near the ceiling where `handleSegment` starts refusing segments outright. The backlog says how
  // far behind live the stream already is, judged against the same window a silence is judged against,
  // since a viewer cannot tell a playlist that stopped from one that is a minute stale.
  const isBacklogged = signals.queueBacklogSeconds * MS_PER_SECOND > segmentStallMs;
  if (signals.queuePressure === PRESSURE_HIGH || isBacklogged) {
    reasons.push(HEALTH_REASON_QUEUE_PRESSURE);
  }

  // A loss stays visible for as long as a silence would have to last before it counted as a stall.
  // One knob rather than two, and long enough that any monitor sampling for a stall also sees a loss.
  const hasRecentLoss = signals.msSinceSegmentLoss !== null && signals.msSinceSegmentLoss <= segmentStallMs;
  if (hasRecentLoss) {
    reasons.push(HEALTH_REASON_SEGMENT_LOSS);
  }

  // No threshold, unlike the manifest counter, because a failure that reaches this signal has already
  // survived `StreamCatalog`'s own 10 second retry window: there is no hiccup left to ride out, and
  // the state it reports is a broadcast that is running and that no viewer can find.
  if (signals.msSinceCatalogAnnounceFailed !== null) {
    reasons.push(HEALTH_REASON_UNLISTED_STREAM);
  }

  // No threshold either, and for a different reason from the one above: nothing is wrong with the
  // running process while this is set, so there is no failure to ride out. The damage is entirely in
  // the future, and it arrives whole at the next restart.
  if (signals.msSinceStatePersistFailed !== null) {
    reasons.push(HEALTH_REASON_STATE_NOT_PERSISTED);
  }

  // The one reason that can fire while nothing is registered and nothing has ever run, which is what
  // every other reason here structurally cannot do: a credential wrong from startup means no
  // `on_publish` ever succeeds, so `activeStreams` stays 0, every counter stays 0, and no threshold
  // below can reach. See OBS-15.
  //
  // Latched rather than aged out, and cleared by the first segment rather than by time. A refusal on
  // a service that has never ingested anything is indistinguishable from a secret this deployment
  // has wrong, so a window would let exactly the from-startup case fade back to `ok` between a
  // broadcaster's retries. Once media flows the credential is proven and later refusals are the
  // internet, or a mid-run rotation, which `segment_stall` already catches.
  if (signals.msSinceAuthRejection !== null && !signals.hasIngestedMedia) {
    reasons.push(HEALTH_REASON_INGEST_REFUSED);
  }

  // No threshold and no window, and it never fades on its own. One entry recovery could not read is
  // one whole broadcast this process cannot finalize: its recording is stranded and its catalog entry
  // says `live` until an operator repairs or removes the file by hand. That repair is also the only
  // thing that clears this: the signal is read off the state directory at every snapshot, so it
  // survives restarts and goes quiet exactly when the file does.
  if (signals.quarantinedRecoveryEntries > 0) {
    reasons.push(HEALTH_REASON_UNRECOVERABLE_STREAM);
  }

  // No threshold, because the count already is one: a stream reaches this signal only after eight of
  // its segments have been measured and their median has missed the configured length. Nothing about
  // the running process is failing while it is set, which is what kept it invisible. The dates follow
  // the media, so what is wrong is the deployment rather than the recording's clock: every gap entry
  // is still sized at a length nothing is cutting, and so is the rung GOP the ladder was pinned on.
  if (signals.fragmentMismatchStreams > 0) {
    reasons.push(HEALTH_REASON_FRAGMENT_MISMATCH);
  }

  // The same reading with the ladder off, where it is the publisher's keyframe interval rather than a
  // stale container, and its own reason rather than a second trigger for the one above, because the
  // two send an operator to different levers. Reported at all because the consequence does not depend
  // on the cause: a stage cutting a length nobody declared sizes every gap entry wrong either way.
  if (signals.publisherGopStreams.length > 0) {
    reasons.push(HEALTH_REASON_FRAGMENT_PUBLISHER_GOP);
  }

  const isStalled = signals.msSinceStreamActivity !== null && signals.msSinceStreamActivity > segmentStallMs;
  if (signals.activeStreams > 0 && isStalled) {
    reasons.push(HEALTH_REASON_SEGMENT_STALL);
  }

  return {
    status: reasons.length === 0 ? HEALTH_OK : HEALTH_DEGRADED,
    reasons,
  };
}
