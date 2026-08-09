import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HEALTH_DEGRADED,
  HEALTH_OK,
  HEALTH_REASON_INGEST_REFUSED,
  HEALTH_REASON_QUEUE_PRESSURE,
  HEALTH_REASON_SEGMENT_LOSS,
  HEALTH_REASON_SEGMENT_STALL,
  HEALTH_REASON_SEGMENT_UPLOAD_FAILURE,
  HEALTH_REASON_STALE_MANIFEST,
  HEALTH_REASON_STATE_NOT_PERSISTED,
  HEALTH_REASON_UNLISTED_STREAM,
  HEALTH_REASON_UNRECOVERABLE_STREAM,
  HealthSignals,
  PRESSURE_HIGH,
  PRESSURE_LOW,
  PRESSURE_MEDIUM,
} from '../src/types.js';
import { deriveHealthStatus, MANIFEST_FAILURE_THRESHOLD, SEGMENT_FAILURE_THRESHOLD } from '../src/utils/health.js';

const STALL_MS = 30_000;
/** Named apart from STALL_MS so the backlog cases read as judged against the same window, not a new one. */
const STALL_MS_FOR_BACKLOG = STALL_MS;

function signals(overrides: Partial<HealthSignals> = {}): HealthSignals {
  return {
    activeStreams: 1,
    staleManifestStreams: 0,
    maxConsecutiveManifestFailures: 0,
    maxConsecutiveSegmentFailures: 0,
    queuePressure: PRESSURE_LOW,
    msSinceStreamActivity: 1_000,
    msSinceSegmentLoss: null,
    msSinceCatalogAnnounceFailed: null,
    msSinceStatePersistFailed: null,
    queueBacklogSeconds: 0,
    msSinceAuthRejection: null,
    // A service that has ingested media, so an unrelated case cannot pick up `ingest_refused` by
    // default. The OBS-15 cases below set both fields explicitly.
    hasIngestedMedia: true,
    segmentsSkipped: 0,
    segmentsNeverNamed: 0,
    quarantinedRecoveryEntries: 0,
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
        HEALTH_REASON_SEGMENT_LOSS,
        HEALTH_REASON_UNLISTED_STREAM,
        HEALTH_REASON_STATE_NOT_PERSISTED,
        HEALTH_REASON_INGEST_REFUSED,
        HEALTH_REASON_UNRECOVERABLE_STREAM,
      ],
      [
        'segment_upload_failure',
        'stale_manifest',
        'queue_pressure',
        'segment_stall',
        'segment_loss',
        'unlisted_stream',
        'state_not_persisted',
        'ingest_refused',
        'unrecoverable_stream',
      ],
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

describe('deriveHealthStatus segment loss', () => {
  // The only other coverage of this reason drives it at an age of about zero, which cannot tell a
  // window from an unconditional raise, nor a `<=` from a `<`, nor the age being computed backwards.
  it('is degraded while a loss is inside the visibility window', () => {
    const report = deriveHealthStatus(signals({ msSinceSegmentLoss: 1 }), STALL_MS);

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_SEGMENT_LOSS]);
  });

  it('is still degraded exactly at the window edge', () => {
    const report = deriveHealthStatus(signals({ msSinceSegmentLoss: STALL_MS }), STALL_MS);

    assert.deepEqual(report.reasons, [HEALTH_REASON_SEGMENT_LOSS]);
  });

  it('is ok one millisecond past the window, so a loss clears rather than latching', () => {
    const report = deriveHealthStatus(signals({ msSinceSegmentLoss: STALL_MS + 1 }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });

  it('is ok when no loss has been reported', () => {
    const report = deriveHealthStatus(signals({ msSinceSegmentLoss: null }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
  });

  it('reports a loss independently of the upload-failure counter', () => {
    // The two are different facts: one segment never arrived, the other arrived and failed to upload.
    const report = deriveHealthStatus(
      signals({ msSinceSegmentLoss: 1, maxConsecutiveSegmentFailures: SEGMENT_FAILURE_THRESHOLD }),
      STALL_MS,
    );

    assert.deepEqual(report.reasons.sort(), [HEALTH_REASON_SEGMENT_LOSS, HEALTH_REASON_SEGMENT_UPLOAD_FAILURE].sort());
  });
});

describe('deriveHealthStatus unlisted stream (CON-3)', () => {
  /**
   * No threshold, unlike the manifest counter, because a failure that reaches this signal has already
   * survived `StreamCatalog`'s own 10 second retry window. There is no hiccup left to ride out: the
   * broadcast is running and no viewer can find it, and it stays that way until the next announce.
   */
  it('degrades as soon as a live stream is absent from the catalog', () => {
    const report = deriveHealthStatus(signals({ msSinceCatalogAnnounceFailed: 1 }), STALL_MS);

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_UNLISTED_STREAM]);
  });

  it('is ok while every live stream is listed', () => {
    const report = deriveHealthStatus(signals({ msSinceCatalogAnnounceFailed: null }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });

  /**
   * The media path and the discovery path fail independently: a stream can publish every segment on
   * time into a manifest nobody can find. Reporting one must not stand in for the other.
   */
  it('reports being unlisted separately from a stalled or failing media path', () => {
    const report = deriveHealthStatus(
      signals({ msSinceCatalogAnnounceFailed: 5_000, msSinceStreamActivity: STALL_MS + 1 }),
      STALL_MS,
    );

    assert.deepEqual(report.reasons.sort(), [HEALTH_REASON_SEGMENT_STALL, HEALTH_REASON_UNLISTED_STREAM].sort());
  });
});

describe('deriveHealthStatus unpersisted state (OBS-4, OBS-5)', () => {
  /**
   * The quietest failure in the service: the running process is perfectly healthy and stays that way,
   * because it holds the right state in memory. The damage arrives whole at the next restart, as a
   * stream resuming from stale segments or a catalog feed forked at an index readers have passed.
   */
  it('degrades while state is not reaching disk', () => {
    const report = deriveHealthStatus(signals({ msSinceStatePersistFailed: 1 }), STALL_MS);

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_STATE_NOT_PERSISTED]);
  });

  it('is ok while every write is landing', () => {
    const report = deriveHealthStatus(signals({ msSinceStatePersistFailed: null }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });

  it('reports unpersisted state separately from being unlisted', () => {
    // Both are written by the same process into the same STATE_DIR, and they still say different
    // things: one is a broadcast nobody can find now, the other a restart that will do the wrong
    // thing later. Collapsing them would let a fixed catalog imply a healthy disk.
    const report = deriveHealthStatus(
      signals({ msSinceStatePersistFailed: 10, msSinceCatalogAnnounceFailed: 10 }),
      STALL_MS,
    );

    assert.deepEqual(report.reasons.sort(), [HEALTH_REASON_STATE_NOT_PERSISTED, HEALTH_REASON_UNLISTED_STREAM].sort());
  });
});

describe('deriveHealthStatus queue backlog (OBS-9)', () => {
  /**
   * The measured case from the register: a 39 deep queue against a `MAX_QUEUE_SIZE` of 100 is a ratio
   * of 0.39, so the pressure band reports `low` and the service reports `ok`, while a viewer is 78
   * seconds behind live. The ceiling the ratio is measured against has no relationship to how stale a
   * playlist anybody will sit through, which is why the seconds are what the policy judges.
   */
  it('degrades on a backlog the pressure ratio calls low', () => {
    const report = deriveHealthStatus(
      signals({ queuePressure: PRESSURE_LOW, queueBacklogSeconds: 78 }),
      STALL_MS_FOR_BACKLOG,
    );

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_QUEUE_PRESSURE]);
  });

  it('is ok at the window and degrades one second past it', () => {
    const atTheWindow = deriveHealthStatus(
      signals({ queueBacklogSeconds: STALL_MS_FOR_BACKLOG / 1000 }),
      STALL_MS_FOR_BACKLOG,
    );
    const pastIt = deriveHealthStatus(
      signals({ queueBacklogSeconds: STALL_MS_FOR_BACKLOG / 1000 + 1 }),
      STALL_MS_FOR_BACKLOG,
    );

    assert.equal(atTheWindow.status, HEALTH_OK);
    assert.equal(pastIt.status, HEALTH_DEGRADED);
  });

  /**
   * The ratio still has to fire on its own. A queue near `MAX_QUEUE_SIZE` is about to start refusing
   * segments outright, whatever the playing time behind it, and that is a different failure from
   * being behind live.
   */
  it('still degrades on a full queue holding almost no playing time', () => {
    const report = deriveHealthStatus(
      signals({ queuePressure: PRESSURE_HIGH, queueBacklogSeconds: 0 }),
      STALL_MS_FOR_BACKLOG,
    );

    assert.deepEqual(report.reasons, [HEALTH_REASON_QUEUE_PRESSURE]);
  });
});

/**
 * The one reason that has to fire on a service where nothing has ever run. Every other reason here
 * is computed from a registered stream or from a counter a stream moved, so a credential wrong from
 * startup leaves all of them at their healthy value: no `on_publish` succeeds, nothing registers, and
 * `deploy/scripts/health.sh` prints a green check over a deployment that has never worked.
 */
describe('deriveHealthStatus refused ingest (OBS-15)', () => {
  /** The state the row was measured in: rejections in-process, and every other signal spotless. */
  function neverIngested(overrides: Partial<HealthSignals> = {}): HealthSignals {
    return signals({ activeStreams: 0, msSinceStreamActivity: null, hasIngestedMedia: false, ...overrides });
  }

  it('degrades when a gate refused a request and no media has ever been ingested', () => {
    const report = deriveHealthStatus(neverIngested({ msSinceAuthRejection: 50 }), STALL_MS);

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_INGEST_REFUSED]);
  });

  /** A service with nothing registered and nothing refused is idle, which is not a failure. */
  it('is ok on a service that has ingested nothing and refused nothing', () => {
    const report = deriveHealthStatus(neverIngested(), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });

  /**
   * A public port collects 401s from scanners forever. Once a segment has landed the credential is
   * proven, so a refusal after that is the internet rather than a misconfiguration, and a rotation
   * mid-run is what `segment_stall` already catches.
   */
  it('is ok when a request was refused but media has already been ingested', () => {
    const report = deriveHealthStatus(signals({ msSinceAuthRejection: 50, hasIngestedMedia: true }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });

  /**
   * Latched rather than aged out, and this is the case that decides it. A broadcaster refused at
   * startup retries on its own schedule, so any window wide enough to be quiet between retries lets
   * exactly the from-startup failure fade back to `ok` while the deployment stays broken.
   */
  it('stays degraded however long ago the refusal was, while nothing has been ingested', () => {
    const report = deriveHealthStatus(neverIngested({ msSinceAuthRejection: STALL_MS * 100 }), STALL_MS);

    assert.deepEqual(report.reasons, [HEALTH_REASON_INGEST_REFUSED]);
  });
});

describe('deriveHealthStatus deliberate discards (OBS-16)', () => {
  /**
   * A skip is the handover floor working, so it carries no threshold and raises no reason. It is on
   * `HealthSignals` to be read, not to be judged: a floor matching zero segments and a floor holding
   * correctly were indistinguishable from outside, and one number separates them.
   */
  it('does not degrade on segments the handover floor discarded on purpose', () => {
    const report = deriveHealthStatus(signals({ segmentsSkipped: 25 }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });

  /**
   * Segments no manifest will ever name are the quietest way a broadcast loses a piece of itself:
   * the bytes are in Swarm and no playlist points at them, so a viewer simply never sees that media
   * and there is no discontinuity marking the hole.
   *
   * ⛔ **Deliberately does not degrade the verdict, and that is a decision rather than an
   * oversight.** The compose healthcheck acts on this status, so a broadcast that lost a few
   * segments could take a running stack down. It is here to be READ, exactly as `segmentsSkipped`
   * is. Changing it to raise a reason is the owner's call.
   */
  it('does not degrade on segments no manifest will ever name, which is a decision not an oversight', () => {
    const report = deriveHealthStatus(signals({ segmentsNeverNamed: 40 }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });
});

/**
 * ⛔ Task #38. One entry the recovery store could not parse is one whole broadcast that this process
 * cannot finalize: its recording is stranded and its catalog entry says `live` until someone
 * intervenes by hand. It is reported by an operator's standards, which is why it needs no threshold
 * and no window.
 */
describe('deriveHealthStatus quarantined recovery entries', () => {
  it('is ok while every entry on disk could be read', () => {
    const report = deriveHealthStatus(signals({ quarantinedRecoveryEntries: 0 }), STALL_MS);

    assert.equal(report.status, HEALTH_OK);
    assert.deepEqual(report.reasons, []);
  });

  it('degrades on the first entry it could not read', () => {
    const report = deriveHealthStatus(signals({ quarantinedRecoveryEntries: 1 }), STALL_MS);

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_UNRECOVERABLE_STREAM]);
  });

  /**
   * Nothing this process does later makes a stranded recording recoverable, so unlike every aged
   * signal here it must not fade back to `ok` while the entry is still sitting in quarantine.
   */
  it('stays degraded on an otherwise idle uploader with nothing running', () => {
    const report = deriveHealthStatus(
      signals({ quarantinedRecoveryEntries: 2, activeStreams: 0, msSinceStreamActivity: null }),
      STALL_MS,
    );

    assert.equal(report.status, HEALTH_DEGRADED);
    assert.deepEqual(report.reasons, [HEALTH_REASON_UNRECOVERABLE_STREAM]);
  });
});
