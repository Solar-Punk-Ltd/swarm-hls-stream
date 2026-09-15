import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { FRAGMENT_SAMPLE_COUNT } from '../src/libs/fragmentAgreement.js';
import { Logger } from '../src/libs/Logger.js';
import { LOG_LEVEL_ERROR, LOG_LEVEL_WARN, LogLevel } from '../src/libs/logLevels.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { HEALTH_REASON_FRAGMENT_MISMATCH, MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO } from '../src/types.js';
import { deriveHealthStatus } from '../src/utils/health.js';

import { makeTestOrchestrator } from './helpers/fakes.js';
import { audioOnlySegment, videoSegment } from './helpers/transportStream.js';

/**
 * What the uploader does when the engine in front of it is cutting a different length from the one
 * this uploader dates by.
 *
 * `HLS_FRAGMENT` reaches two containers from one env file and only the engine is recreated when an
 * operator changes it, so an uploader on 0.5 behind an engine on 1.0 is a state this deployment has
 * reached twice. Nothing refuses a segment over it. The point is that it stops being silent.
 */

/** A rung of the shipped ladder, so the stream is grouped and routed the way a real one is. */
const RUNG_ID = 'live/one_1080p';
const SINGLE_STREAM_ID = 'live/one';

/** 30fps, so a segment of this many frames holds exactly one second of media. */
const FRAMES_PER_SECOND = 30;

/** What the deployment told the uploader, and what the engine was really cutting on 2026-09-04. */
const CONFIGURED_SECONDS = 0.5;
const ENGINE_WAS_CUTTING_SECONDS = 1;

/** What SRS declares on `on_hls`, which is not the media and must not be what this gate reads. */
const DECLARED_SECONDS = 0.5;

function withCapturedLog(run: (lines: string[], levels: LogLevel[]) => Promise<void>): Promise<void> {
  const lines: string[] = [];
  const levels: LogLevel[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({
    sink: (level, line) => {
      levels.push(level);
      lines.push(line);
    },
  });
  return run(lines, levels).finally(() => {
    logger.configure(previous);
  });
}

/** Whether `/health` would answer 503 naming this fault, which is what an operator actually sees. */
function reportsMismatch(orchestrator: StreamOrchestrator): boolean {
  const report = deriveHealthStatus(orchestrator.getHealthSignals(), orchestrator.getSegmentStallMs());
  return report.reasons.includes(HEALTH_REASON_FRAGMENT_MISMATCH);
}

/** Feeds a full sample of segments, each holding `seconds` of media at 30fps. */
function feedSegments(orchestrator: StreamOrchestrator, streamId: string, seconds: number): void {
  for (let index = 0; index < FRAGMENT_SAMPLE_COUNT; index++) {
    orchestrator.handleSegment(streamId, index, DECLARED_SECONDS, videoSegment(seconds * FRAMES_PER_SECOND));
  }
}

/**
 * The same, in bytes holding no video, so every reading falls back on `declared`.
 *
 * The declared value disagrees with the configured length on purpose. Equal to it, this fixture
 * would pass whether the fallback readings were counted or not.
 */
function feedUnmeasurableSegments(orchestrator: StreamOrchestrator, streamId: string, declared: number): void {
  for (let index = 0; index < FRAGMENT_SAMPLE_COUNT; index++) {
    orchestrator.handleSegment(streamId, index, declared, audioOnlySegment(FRAMES_PER_SECOND));
  }
}

function ladderOrchestrator(): StreamOrchestrator {
  return makeTestOrchestrator({
    fragmentSeconds: CONFIGURED_SECONDS,
    ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
  });
}

describe('a rung whose segments are not the length this uploader dates by', () => {
  it('raises fragment_mismatch on /health once a full sample disagrees', async () => {
    await withCapturedLog(async (lines, levels) => {
      const orch = ladderOrchestrator();
      orch.startStream(RUNG_ID, MEDIA_TYPE_VIDEO);

      assert.equal(reportsMismatch(orch), false, 'nothing has been measured yet, so there is nothing to report');

      feedSegments(orch, RUNG_ID, ENGINE_WAS_CUTTING_SECONDS);

      assert.equal(orch.getHealthSignals().fragmentMismatchStreams, 1);
      assert.equal(reportsMismatch(orch), true, 'a recording being dated wrong for ever has to reach /health');

      const reported = lines.filter((line) => line.includes('HLS_FRAGMENT'));
      assert.equal(reported.length, 1, `the fault is reported once per stream, got:\n${reported.join('\n')}`);
      assert.equal(levels[lines.indexOf(reported[0])], LOG_LEVEL_ERROR);
      assert.match(reported[0], /Redeploy the stale one/);

      await orch.stopStream(RUNG_ID);
    });
  });

  it('says nothing while the engine is cutting the configured length', async () => {
    await withCapturedLog(async (lines) => {
      const orch = ladderOrchestrator();
      orch.startStream(RUNG_ID, MEDIA_TYPE_VIDEO);

      feedSegments(orch, RUNG_ID, CONFIGURED_SECONDS);

      assert.equal(orch.getHealthSignals().fragmentMismatchStreams, 0);
      assert.equal(reportsMismatch(orch), false);
      assert.deepEqual(
        lines.filter((line) => line.includes('HLS_FRAGMENT')),
        [],
        'a gate that fires on a correct stage is worse than no gate',
      );

      await orch.stopStream(RUNG_ID);
    });
  });

  it('clears when the stream ends, because the next broadcast is a new measurement', async () => {
    await withCapturedLog(async () => {
      const orch = ladderOrchestrator();
      orch.startStream(RUNG_ID, MEDIA_TYPE_VIDEO);
      feedSegments(orch, RUNG_ID, ENGINE_WAS_CUTTING_SECONDS);
      assert.equal(reportsMismatch(orch), true);

      await orch.stopStream(RUNG_ID);

      assert.equal(orch.getHealthSignals().fragmentMismatchStreams, 0);
      assert.equal(reportsMismatch(orch), false, 'a latch that outlives its stream reports a stage nobody is running');
    });
  });

  it('counts a reading only where the segment itself answered, never the engine claim', async () => {
    // A segment this cannot parse falls back on the engine's declared duration, and that claim was
    // measured at 0.3205s against 0.2667s of media. A gate reading claims would report the same
    // deployment differently depending on how readable its bytes were.
    await withCapturedLog(async (lines) => {
      const orch = ladderOrchestrator();
      orch.startStream(SINGLE_STREAM_ID, MEDIA_TYPE_AUDIO);

      feedUnmeasurableSegments(orch, SINGLE_STREAM_ID, ENGINE_WAS_CUTTING_SECONDS);

      assert.equal(orch.getHealthSignals().fragmentMismatchStreams, 0);
      assert.deepEqual(
        lines.filter((line) => line.includes('HLS_FRAGMENT')),
        [],
      );

      await orch.stopStream(SINGLE_STREAM_ID);
    });
  });
});

describe('a single rendition whose publisher cuts longer than the configured length', () => {
  it('warns once and raises no health reason, because the publisher decides the segment there', async () => {
    await withCapturedLog(async (lines, levels) => {
      const orch = makeTestOrchestrator({ fragmentSeconds: CONFIGURED_SECONDS });
      orch.startStream(SINGLE_STREAM_ID, MEDIA_TYPE_VIDEO);

      feedSegments(orch, SINGLE_STREAM_ID, ENGINE_WAS_CUTTING_SECONDS);

      assert.equal(
        orch.getHealthSignals().fragmentMismatchStreams,
        0,
        'HLS_FRAGMENT is a floor with the ladder off, so a longer segment is the stage working',
      );
      assert.equal(reportsMismatch(orch), false);

      const warned = lines.filter((line) => line.includes('HLS_FRAGMENT'));
      assert.equal(warned.length, 1, `the notice is said once per stream, got:\n${warned.join('\n')}`);
      assert.equal(levels[lines.indexOf(warned[0])], LOG_LEVEL_WARN);

      await orch.stopStream(SINGLE_STREAM_ID);
    });
  });
});
