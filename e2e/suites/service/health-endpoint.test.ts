import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { discoverStamp, makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Service — the /health endpoint reflects the live-stream lifecycle. Exercises the operational
 * surface PR #10 leans on: activeStreams count, the engines list, and staleManifestStreams (0 for a
 * healthy stream whose manifest is publishing fine). A clean broadcaster stop returns it to idle.
 */

const WARMUP_SEGMENTS = 2;
const SEGMENT_WAIT_MS = 90_000;
const IDLE_WAIT_MS = 90_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('service — /health reflects the stream lifecycle', () => {
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

  it('reports an active healthy stream, then returns to idle after a clean stop', async () => {
    await waitFor(
      async () =>
        parseUploaderLog(await host.logsSince(uploader, startedAt)).uploadedSegments.length >= WARMUP_SEGMENTS,
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 2_000,
        label: `warmup: ${WARMUP_SEGMENTS} segments before checking /health`,
      },
    );

    const live = await uploaderHealth(host, cfg);
    assert.equal(live.status, 'ok', 'health status must be ok while streaming');
    assert.ok(live.activeStreams >= 1, `expected an active stream; got activeStreams=${live.activeStreams}`);
    assert.deepEqual(
      live.engines,
      [engine.name],
      `expected the ${engine.name} engine; got ${JSON.stringify(live.engines)}`,
    );
    assert.equal(
      live.staleManifestStreams,
      0,
      `a healthy publishing stream must not be flagged stale; got ${live.staleManifestStreams}`,
    );

    await publisher.stop();

    await waitFor(async () => (await uploaderHealth(host, cfg)).activeStreams === 0, {
      timeoutMs: IDLE_WAIT_MS,
      intervalMs: 2_000,
      label: 'activeStreams returns to 0 after the broadcaster stops (stream finalized as VOD)',
    });

    const idle = await uploaderHealth(host, cfg);
    assert.equal(idle.status, 'ok', 'health status stays ok when idle');
    assert.equal(idle.staleManifestStreams, 0, 'no stale streams when idle');
  });
});
