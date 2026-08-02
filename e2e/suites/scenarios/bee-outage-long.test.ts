import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { isContiguous, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario B — bee-uploader CRASH outage longer than the retry window (15s).
 * Expectation: the segment in flight when bee crashed exhausts its retry window and is dropped;
 * the uploader arms a discontinuity so the next good segment carries #EXT-X-DISCONTINUITY, then
 * uploads resume. Result: >=1 discontinuity armed, a gap in uploaded indices, clean resume.
 *
 * Uses stop/start, NOT pause: a crashed bee refuses connections (ECONNREFUSED), which fails FAST
 * and trips the 15s retry deadline. A pause only *hangs* the request (it completes on unpause and
 * never arms a discontinuity — that is the frozen-but-alive case, exercised by scenario A). Since
 * bee 2.8.1 a stopped node restarts fast enough that stop + 8s + readiness fits INSIDE the 15s
 * window (zero loss, nothing to assert), so the sleep is 25s to keep the fail-fast outage
 * comfortably past the window.
 *
 * Also guards the manifest-freeze regression: feed writes are deferred (bee 2.8.1 honors
 * swarm-deferred-upload on /soc), so manifest publishes must resume within seconds of the node
 * returning — a direct-write regression shows up here as a ~80s publish hold.
 */

const STOP_SLEEP_MS = 25_000;
const MANIFEST_RESUME_WAIT_MS = 45_000;
const WARMUP_SEGMENTS = 3;
const POST_OUTAGE_SEGMENTS = 3;
const SEGMENT_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

describe('B — bee crash > retry window: discontinuity, clean skip, resume', () => {
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
    await host.start(bee).catch(() => undefined);
  });

  it('arms a discontinuity for the dropped segment and resumes cleanly', async () => {
    const events = async () => parseUploaderLog(await host.logsSince(uploader, startedAt));

    await waitFor(async () => (await events()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before crash`,
    });

    const preOutage = await events();
    const preMax = Math.max(...preOutage.uploadedSegments);
    const preOutageManifestMax = preOutage.manifestSocIndices.length ? Math.max(...preOutage.manifestSocIndices) : -1;

    await host.stop(bee);
    await sleep(STOP_SLEEP_MS);
    await host.start(bee);

    await waitFor(
      async () => {
        const manifests = (await events()).manifestSocIndices;
        return manifests.length > 0 && Math.max(...manifests) > preOutageManifestMax;
      },
      {
        timeoutMs: MANIFEST_RESUME_WAIT_MS,
        intervalMs: 2_000,
        label: 'manifest publishes resume promptly after the node returns (freeze regression guard)',
      },
    );

    await waitFor(
      async () => {
        const ups = (await events()).uploadedSegments;
        return ups.length > 0 && Math.max(...ups) >= preMax + POST_OUTAGE_SEGMENTS;
      },
      { timeoutMs: SEGMENT_WAIT_MS, intervalMs: 2_000, label: 'segments resume after the crash outage' },
    );

    const ev = await events();
    assert.ok(
      ev.discontinuitiesArmed >= 1,
      `a crash outage (> 15s window) must arm at least one discontinuity; armed: ${
        ev.discontinuitiesArmed
      } (upload-failure segments: ${ev.discontinuitySegments.join(',')})`,
    );
    assert.ok(
      !isContiguous(ev.uploadedSegments),
      `the dropped segment must leave a gap in uploaded indices; got: ${ev.uploadedSegments.join(',')}`,
    );
  });
});
