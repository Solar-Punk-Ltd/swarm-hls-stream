import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { isContiguous, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario A — bee-uploader outage SHORTER than the segment retry window (15s).
 * Expectation: segment uploads back-pressure and buffer in order, then flush on recovery.
 * No segment lost (indices stay gapless), and NO discontinuity is armed.
 *
 * Uses `docker pause`/`unpause`, NOT stop/start: stop+restart-readiness alone is ~20-30s (bee must
 * reboot and become reachable again), which can never be a sub-15s outage. Pause freezes bee
 * instantly and unpause resumes it instantly, giving a precise, deterministic outage window.
 *
 * Logs are scoped with `--since <host time captured at start>` because each publish session
 * restarts segment numbering at 0. Publishes a real stream + freezes a real container + uses the
 * live stamp — run with the profile deployed and a funded stamp.
 */

const OUTAGE_MS = 8_000;
const WARMUP_SEGMENTS = 3;
const POST_OUTAGE_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 90_000;
const MIN_STAMP_TTL_S = 600;

describe('A — bee outage < retry window: buffer, zero loss, no discontinuity', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const bee = containerName(cfg, 'bee-uploader');
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
    // Make sure bee is unfrozen even if the test bailed mid-outage.
    await host.unpause(bee).catch(() => undefined);
  });

  it('loses no segments across an 8s outage and arms no discontinuity', async () => {
    const uploaded = async (): Promise<number[]> =>
      parseUploaderLog(await host.logsSince(uploader, startedAt)).uploadedSegments;

    await waitFor(async () => (await uploaded()).length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before outage (check publisher stderr if this stalls)`,
    });

    const resumeTarget = Math.max(...(await uploaded())) + POST_OUTAGE_SEGMENTS;

    await host.pause(bee);
    await sleep(OUTAGE_MS);
    await host.unpause(bee);

    await waitFor(
      async () => {
        const ups = await uploaded();
        return ups.length > 0 && Math.max(...ups) >= resumeTarget;
      },
      { timeoutMs: SEGMENT_WAIT_MS, intervalMs: 2_000, label: 'segments resume + advance after recovery' },
    );

    const events = parseUploaderLog(await host.logsSince(uploader, startedAt));
    assert.equal(
      events.discontinuitiesArmed,
      0,
      `an ${OUTAGE_MS / 1000}s outage (< 15s window) must not arm a discontinuity; armed: ${
        events.discontinuitiesArmed
      } (upload-failure segments: ${events.discontinuitySegments.join(',')})`,
    );
    assert.ok(
      isContiguous(events.uploadedSegments),
      `segment indices must be gapless through the outage; got: ${events.uploadedSegments.join(',')}`,
    );
  });
});
