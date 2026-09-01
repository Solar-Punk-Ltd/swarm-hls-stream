import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, containerNameFor, loadConfig } from '../../src/config.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { isContiguous, parseUploaderLog, segmentIndicesByStream } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { nodesBehind, publisherServices } from '../../src/harness/publishers.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
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
 *
 * ⛔ **Counted per rung and waited for per rung, never merged.** The claim here is that nothing was
 * lost, so every reading has to be of a rung that has finished flushing the backlog the pause built
 * up. Waiting on the merged fastest rung clears as soon as ONE rung is past the outage, and the
 * contiguity and discontinuity checks then run against slower rungs that are still catching up: a
 * loss or a discontinuity landing seconds later is a green this suite has already printed. That is a
 * false pass in the one scenario whose entire claim is zero loss, and it is why the per-rung
 * structure its sibling `bee-outage-long` carries belongs here too.
 */

const OUTAGE_MS = 8_000;
const WARMUP_SEGMENTS = 3;
const POST_OUTAGE_SEGMENTS = 4;
/** Sized as `bee-outage-long` sizes it: the waits are per rung now, so the slowest rung is the clock. */
const SEGMENT_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('A — bee outage < retry window: buffer, zero loss, no discontinuity', () => {
  const host = makeHost(cfg);
  /**
   * ⛔⛔⛔ EVERY publisher node, and this suite is why that matters more here than in its sibling.
   * It asserts NOTHING was lost, so on a four-node stage where only `bee-uploader` was paused three
   * rungs were never faulted at all and the assertion was trivially true of them. **It passed while
   * testing nothing**, which is worse than the red its sibling produced, and only that red made it
   * visible. Read off the uploader's own routing so a node added to the stage cannot be missed.
   */
  let bees: string[] = [];
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    bees = publisherServices(nodesBehind((await uploaderHealth(host, cfg)).publishers, cfg.ports.beeUploaderApi)).map(
      (service) => containerNameFor(cfg.profile, service),
    );

    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
    // Make sure every node is unfrozen even if the test bailed mid-outage.
    await Promise.all(bees.map((bee) => host.unpause(bee).catch(() => undefined)));
  });

  it('loses no segments across an 8s outage and arms no discontinuity', async () => {
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
        label:
          `warmup: ${WARMUP_SEGMENTS} segments on each of ${expectedStreams} stream(s) before the outage ` +
          '(check publisher stderr if this stalls)',
      },
    );

    const preOutageMaxOf = new Map([...(await byStream())].map(([id, idx]) => [id, Math.max(...idx)]));

    // Together rather than in sequence: a staggered pause gives the rungs different outage windows,
    // and what this asserts is that none of them lost anything over the same one.
    await Promise.all(bees.map((bee) => host.pause(bee)));
    await sleep(OUTAGE_MS);
    await Promise.all(bees.map((bee) => host.unpause(bee)));

    // Per stream, and every stream, for the reason the warmup is. Waiting on the fastest rung reads
    // a slower rung's still-pending backlog as nothing pending: the gap it is about to log has not
    // been written yet, so the checks below see an unbroken run and call the outage lossless.
    await waitFor(
      async () => {
        const streams = await byStream();
        return [...preOutageMaxOf].every(([id, preMax]) => {
          const resumed = streams.get(id) ?? [];
          return resumed.length > 0 && Math.max(...resumed) >= preMax + POST_OUTAGE_SEGMENTS;
        });
      },
      { timeoutMs: SEGMENT_WAIT_MS, intervalMs: 2_000, label: 'every stream resumes and advances after the outage' },
    );

    // ⛔ One log read for both verdicts below, so they describe the same moment. Off two fetches
    // they describe two, and a discontinuity arming in between is absent from the count while the
    // hole it left is present in the indices, which reads as the two checks contradicting each
    // other rather than as the one finding it is.
    const settled = await host.logsSince(uploader, startedAt);
    const events = parseUploaderLog(settled);
    assert.equal(
      events.discontinuitiesArmed,
      0,
      `an ${OUTAGE_MS / 1000}s outage (< 15s window) must not arm a discontinuity; armed: ${
        events.discontinuitiesArmed
      } (upload-failure segments: ${events.discontinuitySegments.join(',')})`,
    );
    // Per stream: the merged view of a ladder's four counters holes at window boundaries while no
    // rung has lost anything, and can mask a real one-rung gap behind a sibling's healthy index.
    for (const [streamId, indices] of segmentIndicesByStream(settled)) {
      assert.ok(
        isContiguous(indices),
        `segment indices of ${streamId} must be gapless through the outage; got: ${indices.join(',')}`,
      );
    }
  });
});
