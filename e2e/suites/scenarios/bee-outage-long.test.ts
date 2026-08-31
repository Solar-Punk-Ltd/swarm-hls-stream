import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, containerNameFor, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { isContiguous, parseUploaderLog, segmentIndicesByStream } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { nodesBehind, publisherServices } from '../../src/harness/publishers.js';
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
 * ⛔ **Everything here is counted per rung, never merged.** See {@link WARMUP_SEGMENTS}: the merged
 * view answers a different question and gets this suite wrong at any segment length where the rungs
 * do not warm up together.
 *
 * Also guards the manifest-freeze regression: feed writes are deferred (bee 2.8.1 honors
 * swarm-deferred-upload on /soc), so manifest publishes must resume within seconds of the node
 * returning — a direct-write regression shows up here as a ~80s publish hold.
 */

const STOP_SLEEP_MS = 25_000;
const MANIFEST_RESUME_WAIT_MS = 45_000;
/**
 * Segments each rung must have uploaded before bee is killed.
 *
 * ⛔ **Per rung, and that is the whole point of the number.** Counted across the merged view this
 * gate trips as soon as any three segments exist anywhere on the ladder, which at two second
 * segments is before the 1080p rung has uploaded even one. That rung then has no pre-outage index
 * at all, its first surviving index is whatever came after the outage, and the hole the outage tore
 * has nothing on its left to make it visible. Live, 2026-08-29: the discontinuity was armed and the
 * product was correct, and this suite failed on `got: 5,6,7,8`.
 */
const WARMUP_SEGMENTS = 3;
const POST_OUTAGE_SEGMENTS = 3;
const SEGMENT_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('B — bee crash > retry window: discontinuity, clean skip, resume', () => {
  const host = makeHost(cfg);
  /**
   * ⛔⛔⛔ EVERY publisher node, not `bee-uploader` alone, and that is what this suite got wrong on a
   * four-node stage. It stopped one container and asserted below that **every** rung shows a hole.
   * `bee-uploader` now carries 360p only, so 480p came back `0,1,2 … 72` unbroken and the suite failed
   * against a rung whose node was never touched. Read off the uploader's own routing, so a node added
   * to the stage cannot be one the fault misses.
   */
  let bees: string[] = [];
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    bees = publisherServices(nodesBehind((await uploaderHealth(host, cfg)).publishers, cfg.ports.beeUploaderApi)).map(
      (service) => containerNameFor(cfg.profile, service),
    );

    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
    await Promise.all(bees.map((bee) => host.start(bee).catch(() => undefined)));
  });

  it('arms a discontinuity for the dropped segment and resumes cleanly', async () => {
    const events = async () => parseUploaderLog(await host.logsSince(uploader, startedAt));
    const byStream = async () => segmentIndicesByStream(await host.logsSince(uploader, startedAt));
    const expectedStreams = cfg.abrEnabled ? cfg.abrRungs.length : 1;

    await waitFor(
      async () => {
        const streams = await byStream();
        return streams.size >= expectedStreams && [...streams.values()].every((idx) => idx.length >= WARMUP_SEGMENTS);
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 2_000,
        label: `warmup: ${WARMUP_SEGMENTS} segments on each of ${expectedStreams} stream(s) before crash`,
      },
    );

    const preOutage = await events();
    const preOutageMaxOf = new Map([...(await byStream())].map(([id, idx]) => [id, Math.max(...idx)]));
    const preOutageManifestMax = preOutage.manifestSocIndices.length ? Math.max(...preOutage.manifestSocIndices) : -1;

    // Together rather than in sequence: staggering them would give the rungs different outage
    // windows, and the assertion below is that they all lost the same stretch.
    await Promise.all(bees.map((bee) => host.stop(bee)));
    await sleep(STOP_SLEEP_MS);
    await Promise.all(bees.map((bee) => host.start(bee)));

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

    // Per stream, for the same reason the warmup is. The gap assertion below reads every rung, so
    // waiting on the fastest one would check a rung that has not resumed yet and read its unbroken
    // pre-outage run as an outage that tore no hole.
    await waitFor(
      async () => {
        const streams = await byStream();
        return [...preOutageMaxOf].every(([id, preMax]) => {
          const resumed = streams.get(id) ?? [];
          return resumed.length > 0 && Math.max(...resumed) >= preMax + POST_OUTAGE_SEGMENTS;
        });
      },
      { timeoutMs: SEGMENT_WAIT_MS, intervalMs: 2_000, label: 'every stream resumes after the crash outage' },
    );

    const ev = await events();
    assert.ok(
      ev.discontinuitiesArmed >= 1,
      `a crash outage (> 15s window) must arm at least one discontinuity; armed: ${
        ev.discontinuitiesArmed
      } (upload-failure segments: ${ev.discontinuitySegments.join(',')})`,
    );
    // Per stream, and every stream: bee was down past the retry window for the whole deployment, so
    // each rung dropped its own segments and each rung's own sequence must show the hole. The merged
    // view cannot be trusted in either direction: a sibling's healthy index fills a real gap, and
    // window boundaries invent one.
    const perStream = [...(await byStream())];
    assert.ok(perStream.length > 0, 'no attributable segment uploads at all, so nothing here survived the outage');
    for (const [streamId, indices] of perStream) {
      assert.ok(
        !isContiguous(indices),
        `the dropped segments must leave a gap in ${streamId}'s indices; got: ${indices.join(',')}`,
      );
    }
  });
});
