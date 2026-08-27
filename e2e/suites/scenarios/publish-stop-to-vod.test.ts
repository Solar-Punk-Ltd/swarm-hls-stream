import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario D — a clean broadcaster stop finalizes the stream as a VOD.
 * When ffmpeg/OBS stops, the engine fires its unpublish/closing webhook → stopStream → the uploader
 * drains and publishes the VOD manifest + flips the catalog entry to VOD. This is the normal
 * end-of-stream (immediate, via the webhook — not the 60s recovery timer).
 */

const WARMUP_SEGMENTS = 3;
const SEGMENT_WAIT_MS = 90_000;
const VOD_WAIT_MS = 90_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('D — clean broadcaster stop: finalize as VOD', () => {
  const engine = getEngine(cfg);
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
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

    await waitFor(async () => /Updating stream in list to VOD/.test(await log()), {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'stream finalizes as a VOD after unpublish',
    });

    const finalLog = await log();
    assert.match(finalLog, engine.unpublishedMarker, `the ${engine.name} engine must report the stream ended`);
    assert.match(finalLog, /Updating stream in list to VOD/, 'the uploader must finalize the VOD catalog entry');
  });
});
