import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  isContiguous,
  manifestIndicesByStream,
  parseUploaderLog,
  segmentIndicesByStream,
} from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Service — happy-path live publish with no faults. The full pipeline (SRS → uploader → bee) must
 * upload segments in a gapless run AND keep the manifest advancing in lockstep, arming no
 * discontinuity. This is the baseline the fault scenarios (A/B) deviate from.
 */

const TARGET_SEGMENTS = 6;
/**
 * Manifest publishes each rung must be seen to make. Two is the smallest number that distinguishes
 * "published once and froze" from "keeps re-publishing", which is the property this asserts.
 */
const TARGET_MANIFESTS_PER_RUNG = 2;
const SEGMENT_WAIT_MS = 120_000;
/**
 * ⛔ This wait is the fix for a red, not a timeout to tune. The case used to wait for segments and
 * then assert about manifests in the same breath, which on a four rung ladder is a race it loses:
 * six segment lines appear within a second or so of the first rung starting, a manifest publish is a
 * feed write that takes appreciably longer, and `uploadLiveManifest` coalesces while one is in
 * flight rather than queueing one per segment. It read zero manifests and blamed the uploader.
 * A test must wait for the thing it is about to assert on.
 */
const MANIFEST_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('service — happy-path publish: gapless segments + advancing manifest', () => {
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

    const rungsPublishing = async () => [...segmentIndicesByStream(await host.logsSince(uploader, startedAt)).keys()];
    const manifestsByRung = async () => manifestIndicesByStream(await host.logsSince(uploader, startedAt));
    const rungShort = async () => {
      const published = await manifestsByRung();
      return (await rungsPublishing()).filter((rung) => (published.get(rung) ?? []).length < TARGET_MANIFESTS_PER_RUNG);
    };

    await waitFor(async () => (await rungShort()).length === 0, {
      timeoutMs: MANIFEST_WAIT_MS,
      intervalMs: 2_000,
      label:
        `every rung that uploaded a segment publishes ${TARGET_MANIFESTS_PER_RUNG} manifests ` +
        `(still short: ${(await rungShort()).join(', ') || 'none'})`,
    });

    const ev = await events();
    // Judged per stream: a ladder is four counters starting at different SRS sequence numbers, so
    // the merged view holes at window boundaries while no rung has lost anything.
    for (const [streamId, indices] of segmentIndicesByStream(await host.logsSince(uploader, startedAt))) {
      assert.ok(
        isContiguous(indices),
        `happy-path segment indices of ${streamId} must be gapless; got: ${indices.join(',')}`,
      );
    }
    assert.equal(
      ev.discontinuitiesArmed,
      0,
      `no fault → no discontinuity should be armed; armed: ${
        ev.discontinuitiesArmed
      } (upload-failure segments: ${ev.discontinuitySegments.join(',')})`,
    );

    // ⛔ Per rung, for the same reason the segment check above is. `isContiguous` deduplicates, so
    // four rungs merged into one list read as contiguous whether one of them froze at index 0 or
    // none did. A rung whose manifest stops advancing is this deployment's actual failure mode, and
    // the merged check was structurally unable to see it.
    const published = await manifestsByRung();
    for (const rung of await rungsPublishing()) {
      const indices = published.get(rung) ?? [];
      assert.ok(
        indices.length >= TARGET_MANIFESTS_PER_RUNG,
        `${rung} uploaded segments but its live manifest did not keep re-publishing; ` +
          `SOC indices: ${indices.join(',') || 'none'}`,
      );
      assert.ok(
        isContiguous(indices),
        `manifest publishes of ${rung} must advance without gaps (the feed index climbs by one ` +
          `each publish); SOC indices: ${indices.join(',')}`,
      );
    }
  });
});
