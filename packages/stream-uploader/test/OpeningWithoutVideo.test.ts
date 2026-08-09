import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '../src/libs/Logger.js';
import { LOG_LEVEL_ERROR, LogLevel } from '../src/libs/logLevels.js';
import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO } from '../src/types.js';

import { makeFakeRecoveryStore, makeRecoveredState, makeTestOrchestrator, toRecoveryFileId } from './helpers/fakes.js';
import { audioOnlySegment, videoSegment } from './helpers/transportStream.js';
import { waitFor } from './helpers/waiting.js';

/**
 * What the first fragment a player parses is allowed to be. Task #41.
 *
 * **A player fixes its codec set from the first fragment and never revises it.** A broadcast that
 * opens with segments carrying no video therefore plays audio over a blank picture for its whole
 * length, and every video sample after it is refused with a warning marked non-fatal, so nothing
 * fails and nobody is told. One real 209 second recording did exactly that. See
 * `docs/bench/a-recording-that-opens-without-video-2026-08-09.md`.
 *
 * These pin the four things that make withholding safe rather than just effective: it stops at the
 * first segment with video, it never touches a segment later in the broadcast, it never applies to
 * an audio stream, and it gives up rather than withholding a broadcast forever.
 */

const STREAM_ID = 'live/one';
const SETTLE_CEILING_MS = 4_000;

/** Eight frames at 30fps, which is what a fragment at the shipping profile holds. */
const FRAMES = 8;
const DECLARED_SECONDS = 0.32;

/** Long enough that five of them reach the ten second withhold ceiling exactly. */
const LONG_DECLARED_SECONDS = 2;

function extinfCount(manifest: string): number {
  return manifest.split('\n').filter((line) => line.startsWith('#EXTINF')).length;
}

/** Run against the shared logger with a captured sink, restoring whatever was configured before. */
function withCapturedLog(run: (lines: string[], levels: LogLevel[]) => void): void {
  const lines: string[] = [];
  const levels: LogLevel[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({
    sink: (level, line) => {
      levels.push(level);
      lines.push(line);
    },
  });
  try {
    run(lines, levels);
  } finally {
    logger.configure(previous);
  }
}

function orchestratorPublishingInto(published: string[], recoveryStore = makeFakeRecoveryStore()) {
  return makeTestOrchestrator(
    {},
    {
      uploadPayload: async (index, payload) => {
        published.push(String(payload));
        return { reference: { toHex: () => `soc${index}` } };
      },
    },
    recoveryStore,
  );
}

describe('a broadcast whose opening segments carry no video', () => {
  it('withholds them and publishes from the first segment that does carry video', async () => {
    const published: string[] = [];
    const orch = orchestratorPublishingInto(published);
    await orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);

    orch.handleSegment(STREAM_ID, 0, DECLARED_SECONDS, audioOnlySegment(FRAMES));
    orch.handleSegment(STREAM_ID, 1, DECLARED_SECONDS, audioOnlySegment(FRAMES));
    orch.handleSegment(STREAM_ID, 2, DECLARED_SECONDS, videoSegment(FRAMES));

    await waitFor(() => published.length > 0, SETTLE_CEILING_MS);
    const manifest = published[published.length - 1];

    assert.equal(extinfCount(manifest), 1, `only the segment carrying video may be named, got:\n${manifest}`);
    assert.equal(
      orch.getMetricsSnapshot().openingSegmentsWithheldTotal,
      2,
      'a withheld segment nothing counts is media discarded silently',
    );

    await orch.stopStream(STREAM_ID);
  });

  it('uploads nothing for a withheld segment, so no stamp is spent on media no viewer is told about', async () => {
    const published: string[] = [];
    const orch = orchestratorPublishingInto(published);
    await orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);

    orch.handleSegment(STREAM_ID, 0, DECLARED_SECONDS, audioOnlySegment(FRAMES));
    await waitFor(() => orch.getMetricsSnapshot().openingSegmentsWithheldTotal === 1, SETTLE_CEILING_MS);
    assert.equal(orch.getMetricsSnapshot().segmentsUploadedTotal, 0, 'a withheld segment must not be uploaded');

    // The discriminating half. Without it a zero above is equally consistent with an orchestrator
    // that uploads nothing at all, which is the shape this whole test would take if the fake bee
    // were wired wrong.
    orch.handleSegment(STREAM_ID, 1, DECLARED_SECONDS, videoSegment(FRAMES));
    await waitFor(() => orch.getMetricsSnapshot().segmentsUploadedTotal === 1, SETTLE_CEILING_MS);

    await orch.stopStream(STREAM_ID);
  });

  it('publishes a segment with no video once the broadcast has already shown some', async () => {
    const published: string[] = [];
    const orch = orchestratorPublishingInto(published);
    await orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);

    orch.handleSegment(STREAM_ID, 0, DECLARED_SECONDS, videoSegment(FRAMES));
    orch.handleSegment(STREAM_ID, 1, DECLARED_SECONDS, audioOnlySegment(FRAMES));

    await waitFor(() => published.length > 0 && extinfCount(published[published.length - 1]) === 2, SETTLE_CEILING_MS);
    assert.equal(
      orch.getMetricsSnapshot().openingSegmentsWithheldTotal,
      0,
      'the codec set is fixed by then, so withholding here would lose media and fix nothing',
    );

    await orch.stopStream(STREAM_ID);
  });

  it('never withholds an audio stream, whose every segment carries no video by definition', async () => {
    const published: string[] = [];
    const orch = orchestratorPublishingInto(published);
    await orch.startStream(STREAM_ID, MEDIA_TYPE_AUDIO);

    orch.handleSegment(STREAM_ID, 0, DECLARED_SECONDS, audioOnlySegment(FRAMES));

    await waitFor(() => published.length > 0, SETTLE_CEILING_MS);
    assert.equal(extinfCount(published[published.length - 1]), 1, 'an audio broadcast must publish its own media');
    assert.equal(orch.getMetricsSnapshot().openingSegmentsWithheldTotal, 0);

    await orch.stopStream(STREAM_ID);
  });

  it('gives up at the ceiling and publishes anyway, rather than withholding a broadcast forever', async () => {
    const published: string[] = [];
    const orch = orchestratorPublishingInto(published);
    await orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);

    withCapturedLog((lines, levels) => {
      for (let index = 0; index < 6; index++) {
        orch.handleSegment(STREAM_ID, index, LONG_DECLARED_SECONDS, audioOnlySegment(FRAMES));
      }
      const gaveUp = lines.findIndex((line) => line.includes('is being published anyway'));
      assert.notEqual(gaveUp, -1, `expected the ceiling to be reported, got:\n${lines.join('\n')}`);
      assert.equal(levels[gaveUp], LOG_LEVEL_ERROR, 'a broadcast that never produced video is not a warning');
    });

    await waitFor(() => published.length > 0, SETTLE_CEILING_MS);
    assert.equal(
      orch.getMetricsSnapshot().openingSegmentsWithheldTotal,
      5,
      'five segments of two seconds is the ten second ceiling, and the sixth must be published',
    );

    await orch.stopStream(STREAM_ID);
  });

  it('does not withhold after recovery, where a player has already fixed its codec set', async () => {
    const published: string[] = [];
    const state = makeRecoveredState(STREAM_ID);
    const orch = orchestratorPublishingInto(
      published,
      makeFakeRecoveryStore({
        listActive: () => [toRecoveryFileId(STREAM_ID)],
        load: () => state,
      }),
    );

    await orch.recoverStreams();
    orch.handleSegment(STREAM_ID, 1, DECLARED_SECONDS, audioOnlySegment(FRAMES));

    await waitFor(() => published.length > 0, SETTLE_CEILING_MS);
    assert.equal(
      orch.getMetricsSnapshot().openingSegmentsWithheldTotal,
      0,
      'the restored manifest already named a segment, so no player is still waiting for its first',
    );

    await orch.stopStream(STREAM_ID);
  });
});
