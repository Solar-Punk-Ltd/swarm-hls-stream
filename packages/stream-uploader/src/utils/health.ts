import {
  HEALTH_DEGRADED,
  HEALTH_OK,
  HEALTH_REASON_QUEUE_PRESSURE,
  HEALTH_REASON_SEGMENT_STALL,
  HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
  HEALTH_REASON_STALE_MANIFEST,
  HealthReason,
  HealthReport,
  HealthSignals,
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
 * window is spent, the data is gone and a discontinuity is marked. The count is consecutive, so it
 * clears on the next successful segment rather than latching.
 */
export const SEGMENT_FAILURE_THRESHOLD = 1;

/**
 * The whole degradation policy, kept in one pure function so every threshold is assertable without
 * a running server or a clock.
 */
export function deriveHealthStatus(signals: HealthSignals, segmentStallMs: number): HealthReport {
  const reasons: HealthReason[] = [];

  if (signals.maxConsecutiveManifestFailures >= MANIFEST_FAILURE_THRESHOLD) {
    reasons.push(HEALTH_REASON_STALE_MANIFEST);
  }

  if (signals.maxConsecutiveSegmentFailures >= SEGMENT_FAILURE_THRESHOLD) {
    reasons.push(HEALTH_REASON_SEGMENT_UPLOAD_FAILURE);
  }

  if (signals.queuePressure === PRESSURE_HIGH) {
    reasons.push(HEALTH_REASON_QUEUE_PRESSURE);
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
