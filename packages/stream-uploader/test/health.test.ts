import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HEALTH_DEGRADED,
  HEALTH_OK,
  HEALTH_REASON_QUEUE_PRESSURE,
  HEALTH_REASON_SEGMENT_STALL,
  HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
  HEALTH_REASON_STALE_MANIFEST,
  HealthSignals,
  PRESSURE_HIGH,
  PRESSURE_LOW,
  PRESSURE_MEDIUM,
} from '../src/types.js';
import { deriveHealthStatus, MANIFEST_FAILURE_THRESHOLD, SEGMENT_FAILURE_THRESHOLD } from '../src/utils/health.js';

const STALL_MS = 30_000;

function signals(overrides: Partial<HealthSignals> = {}): HealthSignals {
  return {
    activeStreams: 1,
    staleManifestStreams: 0,
    maxConsecutiveManifestFailures: 0,
    maxConsecutiveSegmentFailures: 0,
    queuePressure: PRESSURE_LOW,
    msSinceStreamActivity: 1_000,
    msSinceSegmentLoss: null,
    ...overrides,
  };
}

describe('deriveHealthStatus manifest failures', () => {
  it('is ok one failure below the threshold', () => {
    const report = deriveHealthStatus(
      signals({
        maxConsecutiveManifestFailures: MANIFEST_FAILURE_THRESHOLD - 1,
        staleManifestStreams: 1,
      }),
      STALL_MS,
    );

    assert.equal(report.status, HEALTH_OK, 'a publish failure is retried at the same index, so it self-heals');
    assert.deepEqual(report.reasons, []);
  });

  it('is degraded at the threshold', () => {
    const report = deriveHealthStatus(
      signals({ maxConsecutiveManifestFailures: MANIFEST_FAILURE_THRESHOLD, staleManifestStreams: 1 }),
      STALL_MS,
    );

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_STALE_MANIFEST]);
  });

  it('stays degraded above the threshold', () => {
    const report = deriveHealthStatus(
      signals({ maxConsecutiveManifestFailures: MANIFEST_FAILURE_THRESHOLD + 7 }),
      STALL_MS,
    );

    assert.equal(report.status, HEALTH_DEGRADED);
  });
});

describe('deriveHealthStatus segment upload failures', () => {
  it('is degraded on a single dropped segment', () => {
    const report = deriveHealthStatus(signals({ maxConsecutiveSegmentFailures: 1 }), STALL_MS);

    assert.equal(
      report.status,
      HEALTH_DEGRADED,
      'a counted segment failure is already permanent: the retry window is spent and the data is gone',
    );
    assert.deepEqual(report.reasons, [HEALTH_REASON_SEGMENT_UPLOAD_FAILURE]);
  });

  it('is ok while segments are landing', () => {
    const report = deriveHealthStatus(signals({ maxConsecutiveSegmentFailures: 0 }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
  });

  it('reports segment failures independently of manifest failures', () => {
    // The two are separate write paths. A refused segment never reaches addSegment, so it never
    // triggers a manifest publish and cannot show up in the manifest counter.
    const report = deriveHealthStatus(
      signals({ maxConsecutiveSegmentFailures: 4, maxConsecutiveManifestFailures: 0 }),
      STALL_MS,
    );

    assert.deepEqual(report.reasons, [HEALTH_REASON_SEGMENT_UPLOAD_FAILURE]);
  });
});

describe('deriveHealthStatus queue pressure', () => {
  it('is ok at medium pressure', () => {
    const report = deriveHealthStatus(signals({ queuePressure: PRESSURE_MEDIUM }), STALL_MS);

    assert.equal(report.status, HEALTH_OK, 'medium pressure is a working queue, not a fault');
  });

  it('is degraded at high pressure', () => {
    const report = deriveHealthStatus(signals({ queuePressure: PRESSURE_HIGH }), STALL_MS);

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_QUEUE_PRESSURE]);
  });
});

describe('deriveHealthStatus segment stall', () => {
  it('is ok exactly at the stall window', () => {
    const report = deriveHealthStatus(signals({ msSinceStreamActivity: STALL_MS }), STALL_MS);

    assert.equal(report.status, HEALTH_OK, 'the window is the budget, so spending all of it is not yet a stall');
  });

  it('is degraded one millisecond past the stall window', () => {
    const report = deriveHealthStatus(signals({ msSinceStreamActivity: STALL_MS + 1 }), STALL_MS);

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_SEGMENT_STALL]);
  });

  it('is ok when no stream has ever registered', () => {
    const report = deriveHealthStatus(signals({ activeStreams: 0, msSinceStreamActivity: null }), STALL_MS);

    assert.equal(report.status, HEALTH_OK, 'an idle uploader is healthy, not stalled');
  });

  it('is ok with no active streams even if an activity age is reported', () => {
    // Defends the invariant rather than the caller: an idle service must never report a stall,
    // whichever signal source is wired in later.
    const report = deriveHealthStatus(signals({ activeStreams: 0, msSinceStreamActivity: 10 * STALL_MS }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
  });
});

describe('health wire contract', () => {
  // Pinned as literals on purpose. Every other test compares constants against themselves, so
  // renaming one would rename both sides and pass. These strings are read by the e2e suite in
  // streaming-infra-manager and by anything an operator has scripted, so they cannot move silently.
  it('publishes the documented status strings', () => {
    assert.equal(HEALTH_OK, 'ok');
    assert.equal(HEALTH_DEGRADED, 'degraded');
  });

  it('publishes the documented reason strings', () => {
    assert.deepEqual(
      [
        HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
        HEALTH_REASON_STALE_MANIFEST,
        HEALTH_REASON_QUEUE_PRESSURE,
        HEALTH_REASON_SEGMENT_STALL,
      ],
      ['segment_upload_failure', 'stale_manifest', 'queue_pressure', 'segment_stall'],
    );
  });

  it('publishes the documented thresholds', () => {
    // The README states three consecutive manifest failures and one segment failure. Asserting the
    // relation either side of a constant cannot catch the constant itself changing.
    assert.equal(MANIFEST_FAILURE_THRESHOLD, 3);
    assert.equal(SEGMENT_FAILURE_THRESHOLD, 1);
  });
});

describe('deriveHealthStatus reason reporting', () => {
  it('reports every failing signal, not only the first', () => {
    const report = deriveHealthStatus(
      signals({
        maxConsecutiveManifestFailures: MANIFEST_FAILURE_THRESHOLD,
        queuePressure: PRESSURE_HIGH,
        msSinceStreamActivity: STALL_MS + 1,
      }),
      STALL_MS,
    );

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(
      report.reasons.slice().sort(),
      [HEALTH_REASON_QUEUE_PRESSURE, HEALTH_REASON_SEGMENT_STALL, HEALTH_REASON_STALE_MANIFEST].sort(),
      'an operator needs to know which signals fired, not just that one did',
    );
  });

  it('reports no reasons when healthy', () => {
    const report = deriveHealthStatus(signals(), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });
});
