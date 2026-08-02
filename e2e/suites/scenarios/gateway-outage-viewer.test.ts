import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { isContiguous, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario G — a bee-GATEWAY (viewer-side) outage must NOT affect UPLOADING.
 * The uploader writes through bee-uploader; the gateway only serves viewers. Stopping the gateway
 * should leave segment uploads completely unaffected — no stall, no loss, no discontinuity.
 * (Stop/start keeps the same container, so the client nginx-cached-IP 502 gotcha does not apply.)
 */

const OUTAGE_MS = 10_000;
const WARMUP_SEGMENTS = 3;
const POST_OUTAGE_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 90_000;
const MIN_STAMP_TTL_S = 600;

describe('G — gateway (viewer-side) outage: uploads unaffected', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const gateway = containerName(cfg, 'bee-gateway');
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
    await host.start(gateway).catch(() => undefined);
  });

  it('keeps uploading segments while the viewer gateway is down', async () => {
    const uploaded = async (): Promise<number[]> =>
      parseUploaderLog(await host.logsSince(uploader, startedAt)).uploadedSegments;

    await waitFor(async () => (await uploaded()).length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before gateway outage`,
    });

    const preMax = Math.max(...(await uploaded()));

    await host.stop(gateway);
    await sleep(OUTAGE_MS);
    const duringMax = Math.max(...(await uploaded())); // measured while the gateway is still down
    await host.start(gateway);

    await waitFor(async () => Math.max(...(await uploaded())) >= preMax + POST_OUTAGE_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 2_000,
      label: 'uploads advance past the target after the gateway returns',
    });

    const events = parseUploaderLog(await host.logsSince(uploader, startedAt));
    assert.ok(
      duringMax > preMax,
      'segments must keep uploading WHILE the gateway is down (upload path is independent)',
    );
    assert.equal(
      events.discontinuitiesArmed,
      0,
      `a viewer-side outage must not arm a discontinuity; armed: ${
        events.discontinuitiesArmed
      } (upload-failure segments: ${events.discontinuitySegments.join(',')})`,
    );
    assert.ok(
      isContiguous(events.uploadedSegments),
      `uploads stay gapless during a gateway outage; got: ${events.uploadedSegments.join(',')}`,
    );
  });
});
