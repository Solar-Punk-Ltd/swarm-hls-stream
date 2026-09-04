import { segmentUploaded, segmentUploadFailed } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ArmedStageReading,
  armedStageRefusal,
  DEFAULT_DRAIN_RUNG,
  describeDrainRamp,
  DRAIN_BATCH_DEPTH,
  drainRampOf,
  drainRung,
  drainRungRefusal,
  DROPPED_SEGMENTS_METRIC,
  droppedSegmentsRefusal,
  parseUploaderProcess,
  segmentUploadFailureRefusal,
  singleRefusalRefusal,
  type UploaderProcess,
  uploaderProcessCommand,
  uploaderRestartRefusal,
  drainNotDeclared,
} from '../src/harness/batchDrain.js';
import { COORDINATOR_RUNG } from '../src/harness/publishers.js';

/**
 * The questions a batch-drain run has to answer before any of its readings mean anything.
 *
 * ## What a batch drain is, in one sentence
 *
 * Each rung of the ABR ladder uploads through its own Bee node with its own prepaid postage batch, so
 * an operator can put a deliberately tiny batch behind one rung, let a broadcast fill it in about
 * twenty seconds, and watch that rung go quiet while the other three carry on publishing.
 *
 * ## ⛔ Why the gate below exists at all
 *
 * The stage is armed OUTSIDE the harness, by `deploy/scripts/drain-stage.sh arm`, which rewrites one
 * rung's entry in `BEE_PUBLISHERS` and redeploys the uploader. Nothing in a suite can do that, and
 * nothing in a suite can tell an armed stage from an ordinary one except by reading it. An unarmed
 * stage does not fail the drain suites, it makes them wait out their whole ceiling for a refusal that
 * was never going to come and then blame the uploader for a batch nobody drained. Every minute of
 * that is a paid broadcast.
 *
 * The second case is worse and is the reason utilization is judged here rather than displayed. A
 * depth 17 batch is spent after one run, and it stays on the node afterwards as a dead entry. Armed
 * again on the same batch, the rung refuses its FIRST upload, so the refusal line arrives before the
 * four rungs have all published and the suite reads a stage that never had four rungs as one that
 * lost a rung.
 *
 * ## ⛔ Why the target is never the coordinator
 *
 * 360p is the lowest rung and the pool's coordinator, so the catalog, every ladder master and the
 * end-of-broadcast recording announce are all written through ITS batch. That batch running dry takes
 * the master rewrite down for all four rungs, which is the one case the dead-rung rule does not
 * handle and which no code in this repo implements a failover for. Decision 2 of
 * `docs/e2e-batch-drain-plan.md` files it as a known product gap, priced separately.
 *
 * These cover the rules rather than the readings, because the rules are the part that decides. The
 * readings are wiring over `/health`, `/stamps`, `/metrics` and `docker inspect`, and cannot run
 * without a deployment.
 */

const ARMED_BATCH = 'a1b2c3d4';

function armed(over: Partial<ArmedStageReading> = {}): ArmedStageReading {
  return {
    rung: DEFAULT_DRAIN_RUNG,
    port: 11075,
    batch: ARMED_BATCH,
    state: 'held',
    depth: DRAIN_BATCH_DEPTH,
    utilization: 0,
    ttlS: 172_800,
    problem: null,
    ...over,
  };
}

describe('drainRungRefusal', () => {
  it('accepts the isolated rung the dead-rung rule was designed around', () => {
    assert.equal(drainRungRefusal('1080p'), null);
    assert.equal(drainRungRefusal('720p'), null);
    assert.equal(drainRungRefusal('480p'), null);
  });

  /**
   * ⛔ The one refusal that is about the product rather than about the run. Draining the coordinator
   * is a real failure mode with no failover, so a suite pointed at it would be measuring a gap the
   * repo has already recorded rather than the feature the drain suites are about.
   */
  it('refuses the coordinator, naming what its batch also writes', () => {
    const refusal = drainRungRefusal(COORDINATOR_RUNG);

    assert.ok(refusal, 'the coordinator has to be refused rather than drained');
    assert.match(refusal, /coordinator/);
    assert.match(refusal, /master/);
    assert.match(refusal, /catalog/);
  });

  it('refuses a rung the deployment does not have, rather than arming nothing', () => {
    const refusal = drainRungRefusal('4320p');

    assert.ok(refusal, 'a rung that is not on the ladder has to be refused');
    assert.match(refusal, /4320p/);
    assert.match(refusal, /E2E_DRAIN_RUNG/);
  });
});

describe('drainRung', () => {
  it('is the isolated top rung when nothing named one', () => {
    assert.equal(drainRung({}), DEFAULT_DRAIN_RUNG);
  });

  it('takes the rung the run named', () => {
    assert.equal(drainRung({ E2E_DRAIN_RUNG: '720p' }), '720p');
  });

  it('reads a blank value as nothing named, the way every other env knob here does', () => {
    assert.equal(drainRung({ E2E_DRAIN_RUNG: '  ' }), DEFAULT_DRAIN_RUNG);
  });

  it('throws the refusal rather than returning a rung nobody may drain', () => {
    assert.throws(() => drainRung({ E2E_DRAIN_RUNG: COORDINATOR_RUNG }), /coordinator/);
  });
});

describe('armedStageRefusal', () => {
  it('clears a rung holding a fresh, unspent depth 17 batch', () => {
    assert.equal(armedStageRefusal(armed()), null);
  });

  /**
   * ⛔ First, because nothing else on the reading can be read. A node that does not hold the
   * configured batch is a stage whose depth and fill are both unknown, and the two later refusals
   * would then be about a batch nobody has.
   */
  it('refuses a node that does not hold the batch its rung is configured with', () => {
    const refusal = armedStageRefusal(
      armed({ state: 'absent', depth: null, utilization: null, problem: 'lists none' }),
    );

    assert.ok(refusal, 'a rung whose configured batch is missing cannot be drained');
    assert.match(refusal, /drain-stage\.sh arm/);
    assert.match(refusal, /lists none/);
  });

  it('refuses a configured batch bee will not stamp with, however fresh it looks', () => {
    const refusal = armedStageRefusal(armed({ state: 'unusable', problem: 'usable=false exists=true' }));

    assert.ok(refusal, 'an unusable batch cannot be filled by a broadcast');
    assert.match(refusal, /drain-stage\.sh arm/);
    assert.match(refusal, /usable=false/);
  });

  /**
   * The ordinary stage, and the most likely thing to be pointed at by mistake. A profile's own batch
   * is depth 24 or deeper and would take days of broadcast to fill.
   */
  it('refuses an ordinary batch, because a broadcast cannot fill one', () => {
    const refusal = armedStageRefusal(armed({ depth: 24, utilization: 3 }));

    assert.ok(refusal, 'a full-size batch is not an armed stage');
    assert.match(refusal, /depth 24/);
    assert.match(refusal, new RegExp(`depth ${DRAIN_BATCH_DEPTH}`));
    assert.match(refusal, /drain-stage\.sh arm/);
  });

  /**
   * ⛔⛔ The spent drain batch, which is the failure this gate was written for. It is depth 17, bee
   * still lists it as usable while it has TTL, and it refuses the rung's first upload.
   */
  it('refuses a drain batch a previous run already spent', () => {
    const refusal = armedStageRefusal(armed({ utilization: 2 }));

    assert.ok(refusal, 'a batch with chunks already stamped on it is a spent one');
    assert.match(refusal, /Restore and arm again with a fresh batch/);
    assert.match(refusal, /drain-stage\.sh/);
  });

  it('names the rung and the node in every refusal, so an operator knows which one to arm', () => {
    for (const reading of [
      armed({ state: 'absent', depth: null, utilization: null }),
      armed({ depth: 24 }),
      armed({ utilization: 1 }),
    ]) {
      const refusal = armedStageRefusal(reading) ?? '';

      assert.match(refusal, new RegExp(DEFAULT_DRAIN_RUNG));
      assert.match(refusal, /11075/);
      assert.match(refusal, new RegExp(ARMED_BATCH));
    }
  });

  /**
   * ⛔ A batch bee lists as held with no readable depth refuses rather than passing. Depth is what
   * decides whether a broadcast can fill it at all, and an unknown one is not a small one.
   */
  it('refuses a held batch whose depth could not be read', () => {
    const refusal = armedStageRefusal(armed({ depth: null }));

    assert.ok(refusal, 'an unreadable depth is not a depth 17 batch');
    assert.match(refusal, /drain-stage\.sh arm/);
  });
});

describe('singleRefusalRefusal', () => {
  const DRAINED = 'stream_1080p';
  const SURVIVORS = ['stream_360p', 'stream_480p', 'stream_720p'];

  it('clears exactly one refusal on the drained stream and none on the others', () => {
    assert.equal(
      singleRefusalRefusal([{ streamId: DRAINED, batch: ARMED_BATCH, status: 402, message: 'payment required' }], {
        drainedStreamId: DRAINED,
        survivingStreamIds: SURVIVORS,
      }),
      null,
    );
  });

  it('refuses a run in which the drained rung was never refused', () => {
    const refusal = singleRefusalRefusal([], { drainedStreamId: DRAINED, survivingStreamIds: SURVIVORS });

    assert.ok(refusal, 'no refusal line at all is not a drain');
    assert.match(refusal, new RegExp(DRAINED));
  });

  /**
   * ⚠️ The line is written once per stream for the life of an uploader process and a segment that
   * lands does not re-arm it, so a second one means a second process or a second session of that
   * stream: a redeploy mid-run, or an engine reconnect that built a fresh uploader for the same id.
   */
  it('refuses two refusals on one stream, which means two uploader processes in the window', () => {
    const twice = [
      { streamId: DRAINED, batch: ARMED_BATCH, status: 402, message: 'payment required' },
      { streamId: DRAINED, batch: ARMED_BATCH, status: 402, message: 'payment required' },
    ];

    const refusal = singleRefusalRefusal(twice, { drainedStreamId: DRAINED, survivingStreamIds: SURVIVORS });

    assert.ok(refusal, 'two drains in one broadcast is not the fault this suite arms');
    assert.match(refusal, /2/);
  });

  /**
   * ⛔⛔⛔ The refusal that would have been worth a sitting. The 2026-09-04 drain lost the uploader's
   * container log to the restore that followed it, so all anyone had afterwards was a count of
   * refusals, which says nothing about which batch bee refused or what bee answered. Every branch
   * quotes the entries, and this holds each one to it.
   */
  for (const [what, refusals] of [
    [
      'nothing on the drained stream',
      [{ streamId: 'stream_from_somewhere_else', batch: 'ffffffff', status: 400, message: 'batch is not usable' }],
    ],
    [
      'a second refusal on the drained stream',
      [
        { streamId: DRAINED, batch: ARMED_BATCH, status: 402, message: 'payment required' },
        { streamId: DRAINED, batch: ARMED_BATCH, status: 400, message: 'batch is not usable' },
      ],
    ],
    [
      'a refusal on a surviving rung',
      [
        { streamId: DRAINED, batch: ARMED_BATCH, status: 402, message: 'payment required' },
        { streamId: 'stream_720p', batch: 'ffffffff', status: 400, message: 'batch is not usable' },
      ],
    ],
    [
      'a refusal on a stream nobody accounted for',
      [
        { streamId: DRAINED, batch: ARMED_BATCH, status: 402, message: 'payment required' },
        { streamId: 'stream_from_somewhere_else', batch: 'ffffffff', status: 400, message: 'batch is not usable' },
      ],
    ],
  ] as const) {
    it(`quotes the stream, the batch, the status and bee's own words for ${what}`, () => {
      const refusal = singleRefusalRefusal([...refusals], {
        drainedStreamId: DRAINED,
        survivingStreamIds: SURVIVORS,
      });

      assert.ok(refusal, `${what} has to fail this run`);
      for (const entry of refusals) {
        assert.match(refusal, new RegExp(entry.streamId));
        assert.match(refusal, new RegExp(entry.batch));
        assert.match(refusal, new RegExp(String(entry.status)));
        assert.match(refusal, new RegExp(entry.message));
      }
    });
  }

  /**
   * ⛔⛔ The assertion the whole feature rests on. One batch running out must cost one quality, so a
   * refusal on any other rung means the split is not isolating anything.
   */
  it('refuses a refusal on a rung nobody drained', () => {
    const spread = [
      { streamId: DRAINED, batch: ARMED_BATCH, status: 402, message: 'payment required' },
      { streamId: 'stream_720p', batch: 'ffffffff', status: 402, message: 'payment required' },
    ];

    const refusal = singleRefusalRefusal(spread, { drainedStreamId: DRAINED, survivingStreamIds: SURVIVORS });

    assert.ok(refusal, 'a refusal on a surviving rung has to fail this run');
    assert.match(refusal, /stream_720p/);
  });

  /** A stream nobody named is neither the drained one nor a survivor, and is reported rather than dropped. */
  it('reports a refusal on a stream this run never accounted for', () => {
    const stranger = [
      { streamId: DRAINED, batch: ARMED_BATCH, status: 402, message: 'payment required' },
      { streamId: 'stream_from_somewhere_else', batch: 'ffffffff', status: 402, message: 'payment required' },
    ];

    const refusal = singleRefusalRefusal(stranger, { drainedStreamId: DRAINED, survivingStreamIds: SURVIVORS });

    assert.ok(refusal, 'a refusal on an unaccounted stream has to be surfaced');
    assert.match(refusal, /stream_from_somewhere_else/);
  });
});

/**
 * ⛔⛔⛔ The reading the model was wrong about, which is why it is measured on every run.
 *
 * Until the first live drain on 2026-09-04 the story was "a batch runs dry and the rung falls
 * silent". What bee actually did was refuse the rung's batch four times in about fifty seconds with
 * segments landing in between, because a chunk is refused only when the bucket its own address falls
 * in is full. So the shape worth filing is not when the rung died, it is how it declined: what landed
 * and what was lost in each ten seconds after the first refusal.
 *
 * ⛔ Nothing asserts on any of it, per the owner ruling of 2026-08-29. These tests hold the
 * arithmetic, not a threshold.
 */
describe('drainRampOf', () => {
  const DRAINED = 'live/stream_1080p';
  const REFUSED_AT = Date.parse('2026-09-04T14:22:00.000Z');
  const at = (offsetS: number, message: string) => ({ atMs: REFUSED_AT + offsetS * 1_000, message });
  const landed = (offsetS: number, index: number, streamId = DRAINED) =>
    at(offsetS, segmentUploaded(streamId, index, 'ref'));
  const dropped = (offsetS: number, index: number, streamId = DRAINED) =>
    at(offsetS, segmentUploadFailed(streamId, index));

  it('buckets what landed and what was lost by ten seconds from the first refusal', () => {
    const ramp = drainRampOf([landed(1, 10), dropped(2, 11), dropped(3, 12), dropped(14, 13)], DRAINED, REFUSED_AT);

    assert.deepEqual(ramp.buckets, [
      { fromS: 0, landed: 1, dropped: 2 },
      { fromS: 10, landed: 0, dropped: 1 },
    ]);
  });

  it('reports how long after the first refusal the rung last landed anything', () => {
    const ramp = drainRampOf([dropped(1, 10), landed(27.5, 11), dropped(31, 12)], DRAINED, REFUSED_AT);

    assert.equal(ramp.lastLandedAfterS, 27.5);
  });

  /** A rung that was already silent when bee first answered has no ramp, and that is a reading too. */
  it('says nothing landed where nothing did', () => {
    const ramp = drainRampOf([dropped(1, 10), dropped(2, 11)], DRAINED, REFUSED_AT);

    assert.equal(ramp.lastLandedAfterS, null);
  });

  /**
   * ⛔ A quiet stretch is a row of zeros rather than a missing row. The gap is the interesting part
   * of a ramp, and a table that skipped it would read as a rung declining smoothly.
   */
  it('keeps the empty buckets in between, so a quiet stretch is visible', () => {
    const ramp = drainRampOf([dropped(1, 10), landed(25, 11)], DRAINED, REFUSED_AT);

    assert.deepEqual(
      ramp.buckets.map((bucket) => bucket.fromS),
      [0, 10, 20],
    );
    assert.deepEqual(ramp.buckets[1], { fromS: 10, landed: 0, dropped: 0 });
  });

  /** ⛔ One rung of four. The other three publish throughout, and counting them would be a ladder's rate. */
  it('counts the drained stream alone, not the rungs that kept their postage', () => {
    const ramp = drainRampOf(
      [landed(1, 10), landed(1, 40, 'live/stream_720p'), dropped(2, 41, 'live/stream_720p')],
      DRAINED,
      REFUSED_AT,
    );

    assert.deepEqual(ramp.buckets, [{ fromS: 0, landed: 1, dropped: 0 }]);
  });

  /** ⛔ Everything before the refusal belongs to a healthy rung, and the ramp starts at the refusal. */
  it('ignores the segments the rung published before bee refused anything', () => {
    const ramp = drainRampOf([landed(-30, 1), landed(-5, 2), dropped(1, 3)], DRAINED, REFUSED_AT);

    assert.deepEqual(ramp.buckets, [{ fromS: 0, landed: 0, dropped: 1 }]);
  });

  it('reads as a person can, with the tail said in words where nothing landed', () => {
    const said = describeDrainRamp(drainRampOf([landed(1, 10), dropped(2, 11)], DRAINED, REFUSED_AT));

    assert.match(said, /0-10s 1 landed, 1 dropped/);
    assert.match(said, /last segment landed 1\.0s after the first refusal/);
    assert.match(describeDrainRamp(drainRampOf([], DRAINED, REFUSED_AT)), /neither landed nor lost/);
    assert.match(
      describeDrainRamp(drainRampOf([dropped(1, 10)], DRAINED, REFUSED_AT)),
      /nothing of that stream landed after the first refusal/,
    );
  });
});

describe('parseUploaderProcess', () => {
  it('reads the start instant and the restart count docker prints', () => {
    assert.deepEqual(parseUploaderProcess('2026-09-04T10:00:00.123456789Z 0\n', 'uploader'), {
      startedAt: '2026-09-04T10:00:00.123456789Z',
      restartCount: 0,
    });
  });

  it('reads a container docker has restarted', () => {
    assert.equal(parseUploaderProcess('2026-09-04T10:00:00Z 3', 'uploader').restartCount, 3);
  });

  /**
   * ⛔ A missing half refuses rather than defaulting. A restart count invented where docker said
   * nothing reads as a process that stayed up, which is the conclusion the pair exists to justify.
   */
  it('refuses an answer carrying no restart count', () => {
    assert.throws(() => parseUploaderProcess('2026-09-04T10:00:00Z', 'uploader'), /not a start instant/);
  });

  it('refuses an empty answer, which is a container docker could not find', () => {
    assert.throws(() => parseUploaderProcess('\n', 'uploader'), /uploader/);
  });

  it('refuses a restart count that is not a whole number', () => {
    assert.throws(() => parseUploaderProcess('2026-09-04T10:00:00Z <no value>', 'uploader'), /not a start instant/);
  });
});

describe('uploaderProcessCommand', () => {
  it('asks for both facts in one inspect, so the pair describes one instant', () => {
    const command = uploaderProcessCommand('streamer1-stream-uploader-1');

    assert.match(command, /\.State\.StartedAt/);
    assert.match(command, /\.RestartCount/);
    assert.match(command, /streamer1-stream-uploader-1/);
  });
});

describe('uploaderRestartRefusal', () => {
  const before: UploaderProcess = { startedAt: '2026-09-04T10:00:00.000000000Z', restartCount: 0 };

  it('clears a process that stayed up across the whole drain', () => {
    assert.equal(uploaderRestartRefusal(before, { ...before }), null);
  });

  /**
   * ⛔ A drained batch must cost one rung and never the service. A restart drops every live broadcast
   * to re-run a recovery that changes nothing about the batch, and it would also hide the fault: a
   * restarted uploader re-reads `BEE_PUBLISHERS` and starts the whole drain again.
   */
  it('refuses a restart docker counted', () => {
    const refusal = uploaderRestartRefusal(before, { ...before, restartCount: 1 });

    assert.ok(refusal, 'a counted restart has to fail this run');
    assert.match(refusal, /restart/i);
  });

  /** A replaced container keeps its restart count at zero, so the start instant is the other witness. */
  it('refuses a process that was replaced rather than restarted', () => {
    const refusal = uploaderRestartRefusal(before, { startedAt: '2026-09-04T10:04:12.000000000Z', restartCount: 0 });

    assert.ok(refusal, 'a fresh start instant has to fail this run');
    assert.match(refusal, /2026-09-04T10:00:00/);
    assert.match(refusal, /2026-09-04T10:04:12/);
  });
});

describe('segmentUploadFailureRefusal', () => {
  it('clears a degraded uploader whose reason is the dropped segment', () => {
    assert.equal(
      segmentUploadFailureRefusal({
        status: 'degraded',
        reasons: ['segment_upload_failure'],
        activeStreams: 4,
        staleManifestStreams: 0,
        queuePressure: 'ok',
        quarantinedRecoveryEntries: 0,
        engines: ['srs'],
      }),
      null,
    );
  });

  /**
   * ⛔ A healthy uploader is the wrong answer here, not a better one. The rung dropped every segment
   * it was handed, and a service reporting that as fine is a service whose operator will never know.
   */
  it('refuses an uploader that still calls itself healthy', () => {
    const refusal = segmentUploadFailureRefusal({
      status: 'ok',
      reasons: [],
      activeStreams: 4,
      staleManifestStreams: 0,
      queuePressure: 'ok',
      quarantinedRecoveryEntries: 0,
      engines: ['srs'],
    });

    assert.ok(refusal, 'a drained rung has to show on /health');
    assert.match(refusal, /segment_upload_failure/);
    assert.match(refusal, /ok/);
  });

  it('refuses a degraded uploader whose reason is something else entirely', () => {
    const refusal = segmentUploadFailureRefusal({
      status: 'degraded',
      reasons: ['stale_manifest'],
      activeStreams: 4,
      staleManifestStreams: 1,
      queuePressure: 'ok',
      quarantinedRecoveryEntries: 0,
      engines: ['srs'],
    });

    assert.ok(refusal, 'the reason has to be the one the drain produces');
    assert.match(refusal, /stale_manifest/);
  });
});

describe('droppedSegmentsRefusal', () => {
  const survivors = ['360p', '480p', '720p'];

  it('clears a drop count that climbed on the drained rung alone', () => {
    const counted = new Map([
      ['1080p', 12],
      ['360p', 0],
      ['480p', 0],
      ['720p', 0],
    ]);

    assert.equal(droppedSegmentsRefusal(counted, { drainedRung: DEFAULT_DRAIN_RUNG, survivingRungs: survivors }), null);
  });

  /**
   * ⛔ A rung with no label in the family at all reads as zero, and that is the right reading: the
   * counter is only labelled once a rung has lost something.
   */
  it('clears surviving rungs that carry no label at all', () => {
    assert.equal(
      droppedSegmentsRefusal(new Map([['1080p', 12]]), {
        drainedRung: DEFAULT_DRAIN_RUNG,
        survivingRungs: survivors,
      }),
      null,
    );
  });

  it('refuses a drained rung whose drop count never moved', () => {
    const refusal = droppedSegmentsRefusal(new Map([['1080p', 0]]), {
      drainedRung: DEFAULT_DRAIN_RUNG,
      survivingRungs: survivors,
    });

    assert.ok(refusal, 'a drained rung that lost nothing is not drained');
    assert.match(refusal, new RegExp(DROPPED_SEGMENTS_METRIC));
    assert.match(refusal, new RegExp(DEFAULT_DRAIN_RUNG));
  });

  it('refuses a surviving rung that lost segments of its own', () => {
    const counted = new Map([
      ['1080p', 12],
      ['720p', 3],
    ]);

    const refusal = droppedSegmentsRefusal(counted, {
      drainedRung: DEFAULT_DRAIN_RUNG,
      survivingRungs: survivors,
    });

    assert.ok(refusal, 'a survivor losing segments has to fail this run');
    assert.match(refusal, /720p/);
    assert.match(refusal, /3/);
  });

  /**
   * ⛔ An empty family refuses. On a ladder deployment the counter is labelled the moment anything is
   * lost, so nothing at all means the reading failed rather than that nothing was lost, and the
   * drained rung's own zero above would have said so anyway.
   */
  it('refuses a metrics read that produced no labels at all', () => {
    const refusal = droppedSegmentsRefusal(new Map(), {
      drainedRung: DEFAULT_DRAIN_RUNG,
      survivingRungs: survivors,
    });

    assert.ok(refusal, 'an empty reading is not a passing one');
    assert.match(refusal, new RegExp(DROPPED_SEGMENTS_METRIC));
  });
});

describe('whether this run is a drain sitting at all', () => {
  /**
   * ⛔ The case that pays for this file. `test:e2e` globs suites/scenarios and suites/viewer, so
   * both drain suites are in every full suite whatever the drain script lists, and on an ordinary
   * stage their setup refuses. An hour of paid broadcast then reports two failures that say nothing
   * about the product.
   */
  it('skips a run that armed nothing, naming what a drain sitting is', () => {
    const reason = drainNotDeclared({});

    assert.notEqual(reason, false, 'a run with no declaration would have joined every full suite');
    assert.match(String(reason), /E2E_DRAIN_ARMED/);
    assert.match(String(reason), /drain-stage\.sh arm/);
  });

  it('runs when a drain script declared the arming', () => {
    assert.equal(drainNotDeclared({ E2E_DRAIN_ARMED: '1' }), false);
  });

  /** Blank, zero and false all read as nothing declared, the way every other knob here treats one. */
  it('reads an empty, zero or false declaration as no declaration', () => {
    for (const value of ['', '   ', '0', 'false']) {
      assert.notEqual(drainNotDeclared({ E2E_DRAIN_ARMED: value }), false, `'${value}' let the suites run`);
    }
  });
});
