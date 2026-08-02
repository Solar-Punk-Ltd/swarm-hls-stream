import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { isContiguous, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Service — happy-path live publish with no faults. The full pipeline (SRS → uploader → bee) must
 * upload segments in a gapless run AND keep the manifest advancing in lockstep, arming no
 * discontinuity. This is the baseline the fault scenarios (A/B) deviate from.
 */

const TARGET_SEGMENTS = 6;
const SEGMENT_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

describe('service — happy-path publish: gapless segments + advancing manifest', () => {
  const cfg = loadConfig();
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

  it(`uploads ${TARGET_SEGMENTS} contiguous segments with a manifest publish for each`, async () => {
    const events = async () => parseUploaderLog(await host.logsSince(uploader, startedAt));

    await waitFor(async () => (await events()).uploadedSegments.length >= TARGET_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 2_000,
      label: `${TARGET_SEGMENTS} segments upload on the happy path (check publisher stderr if this stalls)`,
    });

    const ev = await events();
    assert.ok(
      isContiguous(ev.uploadedSegments),
      `happy-path segment indices must be gapless; got: ${ev.uploadedSegments.join(',')}`,
    );
    assert.equal(
      ev.discontinuitiesArmed.length,
      0,
      `no fault → no discontinuity should be armed; armed: ${ev.discontinuitiesArmed.join(',')}`,
    );
    assert.ok(
      ev.manifestSocIndices.length >= 2,
      `the live manifest must keep re-publishing as segments land (not freeze); ` +
        `manifest publishes: ${ev.manifestSocIndices.length}`,
    );
    assert.ok(
      isContiguous(ev.manifestSocIndices),
      `manifest publishes must advance without gaps (the feed index climbs by one each publish); ` +
        `SOC indices: ${ev.manifestSocIndices.join(',')}`,
    );
  });
});
