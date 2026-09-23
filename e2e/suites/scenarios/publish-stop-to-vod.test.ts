import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedVodFinalizeCount, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { vodFinalizeWaitMs } from '../../src/harness/recording.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario D — a clean broadcaster stop finalizes the stream as a VOD.
 *
 * ⛔ **Not immediately, and the delay is the feature rather than latency.** SRS fires its unpublish
 * the moment ffmpeg/OBS stops, and on the SRS path the uploader answers it with `noteDisconnect`,
 * which ends nothing: the session is held open so an encoder that comes back inside the window
 * rejoins the broadcast it left, with one `#EXT-X-DISCONTINUITY` at the seam and no ending written in
 * between. What finalizes a stream is `ORPHAN_REAP_MS` of no media, so a clean stop reaches its
 * recording about a reap window plus a drain after the publisher goes, through exactly the same
 * finalize an engine that died reaches. OME's closing webhook still stops immediately.
 *
 * So this scenario is still "the broadcaster stops and the recording appears", and what changed is
 * the size of the wait it needs. Nothing here asserts how long it took; see `AGENTS.md`.
 */

const WARMUP_SEGMENTS = 3;
const SEGMENT_WAIT_MS = 90_000;
/**
 * ⛔ A reap window and a drain, plus room for the last segment, because a clean stop now ends at the
 * reaper. Sized from `harness/recording.ts`, which derives the same bound for `make:recording`, rather
 * than from the 90_000 that was here when an unpublish finalized the stream itself.
 */
const VOD_WAIT_MS = vodFinalizeWaitMs({ segmentSeconds: null, pollMs: 2_000 });
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('D — clean broadcaster stop: finalize as VOD', () => {
  const engine = getEngine(cfg);
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('finalizes a VOD when the broadcaster stops', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before stopping the broadcaster`,
    });

    await publisher.stop();

    // Scoped to our own broadcast, so a neighbour's flip trailing into the window cannot stand in
    // for this stream's finalize.
    await waitFor(async () => announcedVodFinalizeCount(await log()) >= 1, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'stream finalizes as a VOD after unpublish',
    });

    const finalLog = await log();
    assert.match(finalLog, engine.unpublishedMarker, `the ${engine.name} engine must report the stream ended`);
    assert.ok(announcedVodFinalizeCount(finalLog) >= 1, 'the uploader must finalize the VOD catalog entry');
  });
});
