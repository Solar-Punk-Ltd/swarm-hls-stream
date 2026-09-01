import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { isContiguous, parseUploaderLog, segmentIndicesByStream } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario G — a bee-GATEWAY (viewer-side) outage must NOT affect UPLOADING.
 * The uploader writes through bee-uploader; the gateway only serves viewers. Stopping the gateway
 * should leave segment uploads completely unaffected — no stall, no loss, no discontinuity.
 * (Stop/start keeps the same container, so the client nginx-cached-IP 502 gotcha does not apply.)
 *
 * ⛔ **Every reading is per rung, and the merged view is what was taken out of it.** It got both
 * directions wrong at once here. "Uploads kept going" read off a merged maximum is satisfied by one
 * healthy rung out of four, so three rungs stalling on a viewer-side outage would have printed the
 * pass this suite exists to produce. Contiguity read off the merged list is the documented false
 * red: a ladder is four counters that start at different SRS sequence numbers, and their merged
 * indices hole at every log-window boundary while no rung has lost a thing. `segmentIndicesByStream`
 * is the sound unit in both directions, the way `bee-outage-long` uses it.
 */

const OUTAGE_MS = 10_000;
const WARMUP_SEGMENTS = 3;
const POST_OUTAGE_SEGMENTS = 4;
/** Sized as `bee-outage-long` sizes it: the waits are per rung now, so the slowest rung is the clock. */
const SEGMENT_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('G — gateway (viewer-side) outage: uploads unaffected', () => {
  const host = makeHost(cfg);
  const gateway = containerName(cfg, 'bee-gateway');
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
    await host.start(gateway).catch(() => undefined);
  });

  it('keeps uploading segments while the viewer gateway is down', async () => {
    const byStream = async () => segmentIndicesByStream(await host.logsSince(uploader, startedAt));
    const maxOf = (streams: Map<string, number[]>): Map<string, number> =>
      new Map([...streams].map(([id, idx]) => [id, Math.max(...idx)]));
    const expectedStreams = cfg.abrEnabled ? cfg.abrRungs.length : 1;

    // Per stream, and every stream must be here before the fault. A rung with no pre-outage index is
    // a rung the loop below never looks up, so the assertion would simply not be made about it.
    await waitFor(
      async () => {
        const streams = await byStream();
        return streams.size >= expectedStreams && [...streams.values()].every((idx) => idx.length >= WARMUP_SEGMENTS);
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 2_000,
        label: `warmup: ${WARMUP_SEGMENTS} segments on each of ${expectedStreams} stream(s) before the gateway outage`,
      },
    );

    const preMaxOf = maxOf(await byStream());

    await host.stop(gateway);
    await sleep(OUTAGE_MS);
    const duringMaxOf = maxOf(await byStream()); // measured while the gateway is still down
    await host.start(gateway);

    // Each rung past its OWN target, so the contiguity check below reads rungs that have caught up
    // rather than rungs whose next line has not been written yet.
    await waitFor(
      async () => {
        const streams = await byStream();
        return [...preMaxOf].every(([id, preMax]) => {
          const advanced = streams.get(id) ?? [];
          return advanced.length > 0 && Math.max(...advanced) >= preMax + POST_OUTAGE_SEGMENTS;
        });
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 2_000,
        label: 'every stream advances past its own target after the gateway returns',
      },
    );

    // The headline, asked of every rung. Merged, one rung that kept going vouches for the three that
    // did not, which is the whole claim of this suite handed to it by a single healthy counter.
    for (const [streamId, preMax] of preMaxOf) {
      const duringMax = duringMaxOf.get(streamId);
      assert.ok(
        duringMax !== undefined && duringMax > preMax,
        `${streamId} must keep uploading WHILE the gateway is down (the upload path is independent). ` +
          `Its last index before the outage was ${preMax}, and during the outage ` +
          `${duringMax === undefined ? 'it logged no segment at all' : `it reached ${duringMax}`}`,
      );
    }

    // ⛔ One log read for both verdicts below, so the discontinuity count and the per-rung indices
    // describe the same moment rather than two fetches apart.
    const settled = await host.logsSince(uploader, startedAt);
    const events = parseUploaderLog(settled);
    assert.equal(
      events.discontinuitiesArmed,
      0,
      `a viewer-side outage must not arm a discontinuity; armed: ${
        events.discontinuitiesArmed
      } (upload-failure segments: ${events.discontinuitySegments.join(',')})`,
    );
    for (const [streamId, indices] of segmentIndicesByStream(settled)) {
      assert.ok(
        isContiguous(indices),
        `uploads of ${streamId} stay gapless during a gateway outage; got: ${indices.join(',')}`,
      );
    }
  });
});
