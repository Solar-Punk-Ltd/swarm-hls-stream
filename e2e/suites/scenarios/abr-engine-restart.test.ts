import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { type AnnouncedRung, announcedRungs, ladderRungs, segmentUploads } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario — the engine restarts mid-broadcast while transcoding a ladder.
 *
 * The ABR counterpart to `engine-restart.test.ts`, and it asks one question that scenario cannot:
 * **do the rungs come back as the same ladder?** A ladder's group is derived when the uploader first
 * sees a rung, so a re-announce that grouped them differently would leave a viewer with two ladders
 * of two rungs where there was one of four. hls.js would then read a master naming half the rungs and
 * ABR would have nowhere to step up to, with nothing in the logs calling it an error.
 *
 * It also covers the re-announce path directly, which is where CON-1 lived: a re-announce that left
 * `activeStreams` empty refused the next segment as `unknown_stream` and eventually started a session
 * that was never retired. Four rungs re-announcing at once is the widest version of that window.
 *
 * ## The broadcaster has to be reconnected, or the suite tests retirement
 *
 * Restarting the engine drops ffmpeg's SRT with no auto-reconnect, exactly as the single-rendition
 * scenario records, so the pre-restart publisher dies and nothing re-publishes on its own. A test that
 * only restarts and waits is not watching the ladder recover, it is watching it retire: the retired
 * sessions still finalize and log while no fresh announce ever lands. So each test restarts, stops
 * the dying publisher, waits the engine's reconnect grace, and starts a fresh one, the way
 * `engine-restart.test.ts` does.
 *
 * ## Reading the recovered session apart from the retired one
 *
 * The ladder group is the wrong lens for this. `StreamOrchestrator.groupFor` reuses the standing
 * group for a stream base, and `releaseLadder` keeps it alive until the last rung's session has
 * ended, precisely so a source that restarts while a sibling is still draining is not handed a
 * second group. An engine restart therefore brings every rung back under the SAME group, on
 * purpose, and a matcher scoped to fresh groups reads that healthy recovery as nothing happening.
 * Not a theory: the first live run of this suite (2026-08-27) timed out all three waits while the
 * log showed the ladder fully re-formed 22 seconds after the restart.
 *
 * What does rotate per session is the topic. Every rung announce carries it, a retired session
 * never announces again, and its finalize lines carry no topic at all, so announces on topics first
 * seen after the restart are exactly the recovered session and nothing else. The same scoping is
 * what makes the suite go red when nothing recovers: with no fresh topic, the wait times out rather
 * than latching onto the retirement.
 *
 * ## Why a restart rather than a per-rung outage
 *
 * The fault worth having is one rung going quiet while the others carry on, which is exactly what
 * `BEE_PUBLISHERS` exists to contain: one node and one postage batch per rung, so a drained batch
 * costs one rung rather than the stage. **That scenario is not written here**, because inducing it
 * needs the harness to know which bee container serves which rung, and `BEE_PUBLISHERS` maps a rung
 * to a URL rather than to a container. Pausing the shared bee on a single-node deployment stops every
 * rung at once, which is a stage outage wearing a rung outage's name. Recorded as the gap it is
 * rather than approximated.
 *
 * ⛔ Requires a deployed profile and a funded stamp. Nothing in CI runs these.
 */

const WARMUP_WAIT_MS = 180_000;
const RECOVERY_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('ABR — engine restart: the ladder comes back whole', { skip: abrOff(cfg.abrEnabled) }, () => {
  const host = makeHost(cfg);
  const engine = getEngine(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const mediaContainer = engine.mediaContainer(cfg);
  let publisher: Publisher;
  let startedAt: string;
  let rungsBefore: string[] = [];

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    assert.ok(
      cfg.abrRungs.length > 1,
      'ABR_LADDER names fewer than two rungs, so a split ladder would be indistinguishable from a whole one',
    );
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);

    await waitFor(async () => ladderRungs(await host.logsSince(uploader, startedAt)).length >= cfg.abrRungs.length, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 3_000,
      label: `all ${cfg.abrRungs.length} rungs publish before the restart`,
    });
    rungsBefore = ladderRungs(await host.logsSince(uploader, startedAt));
  });

  after(async () => {
    await publisher?.stop();
    // Left running whatever happened above, or every later suite inherits a stopped engine.
    await host.start(mediaContainer).catch(() => undefined);
  });

  /**
   * Restart the engine and bring the broadcaster back, returning the instant the restart began and
   * the session topics already seen by then. The dying publisher is stopped and a fresh one started
   * after the engine's own reconnect grace, so the recovered rungs announce on topics not in
   * `priorTopics`, which is how a caller tells recovery from the retired session finalizing.
   */
  async function restartAndReconnect(): Promise<{ restartedAt: string; priorTopics: Set<string> }> {
    const priorTopics = new Set(announcedRungs(await host.logsSince(uploader, startedAt)).map((a) => a.topic));
    const restartedAt = await host.nowIso();
    await host.restart(mediaContainer);
    await publisher.stop();
    await sleep(engine.reconnectGraceMs); // let the engine accept SRT again before reconnecting
    publisher = startPublisher(cfg);
    return { restartedAt, priorTopics };
  }

  /** Announces on topics first seen after the restart: the recovered session, never the retired one. */
  const recoveredAnnounces = async (restartedAt: string, priorTopics: ReadonlySet<string>): Promise<AnnouncedRung[]> =>
    announcedRungs(await host.logsSince(uploader, restartedAt)).filter((a) => !priorTopics.has(a.topic));

  const recoveredRungCount = async (restartedAt: string, priorTopics: ReadonlySet<string>): Promise<number> =>
    new Set((await recoveredAnnounces(restartedAt, priorTopics)).map((a) => a.rung)).size;

  it('brings every rung back after the engine restarts', async () => {
    const { restartedAt, priorTopics } = await restartAndReconnect();

    await waitFor(async () => (await recoveredRungCount(restartedAt, priorTopics)) >= rungsBefore.length, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: `all ${rungsBefore.length} rungs re-announce on fresh topics after the restart`,
    });

    const recovered = await recoveredAnnounces(restartedAt, priorTopics);
    const recoveredRungs = [...new Set(recovered.map((a) => a.rung))].sort();
    assert.deepEqual(
      recoveredRungs,
      [...rungsBefore].sort(),
      'the recovered ladder does not name the same rungs it had before the restart',
    );
  });

  /**
   * The point of the whole scenario. The recovered announces may carry the old group, when a sibling
   * was still draining and `releaseLadder` kept it, or one fresh group, when every session ended
   * first; both are one ladder and both are legal. What must not happen is the recovered rungs
   * disagreeing with each other: a viewer would hold a master naming half the rungs, and ABR would
   * have nowhere to step up to, with nothing in the logs calling it an error.
   */
  it('groups the recovered rungs into one ladder, not one per rung', async () => {
    const { restartedAt, priorTopics } = await restartAndReconnect();

    await waitFor(async () => (await recoveredRungCount(restartedAt, priorTopics)) >= rungsBefore.length, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: 'the ladder re-forms on fresh topics after the restart',
    });

    const recovered = await recoveredAnnounces(restartedAt, priorTopics);
    const groups = new Set(recovered.map((a) => a.ladder));
    assert.equal(groups.size, 1, `the recovered rungs split across ${groups.size} ladders: ${[...groups].join(', ')}`);
  });

  /**
   * A restart is a real discontinuity and the uploader is expected to arm one, so this asserts the
   * uploader kept working rather than that nothing happened. What is ABR-specific is that a stall in
   * one rung must not stop the others: every recovered rung has to keep its own segment counter
   * moving, which the segment lines can be scoped to because they carry the stream id.
   */
  it('keeps uploading segments after the restart rather than stalling on one rung', async () => {
    const { restartedAt, priorTopics } = await restartAndReconnect();

    await waitFor(async () => (await recoveredRungCount(restartedAt, priorTopics)) >= rungsBefore.length, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: 'every rung re-announces on a fresh topic after the restart',
    });

    const recoveredStreams = new Set((await recoveredAnnounces(restartedAt, priorTopics)).map((a) => a.streamId));
    await waitFor(
      async () => {
        const byStream = new Map<string, number>();
        for (const upload of segmentUploads(await host.logsSince(uploader, restartedAt))) {
          if (recoveredStreams.has(upload.streamId)) {
            byStream.set(upload.streamId, (byStream.get(upload.streamId) ?? 0) + 1);
          }
        }
        return byStream.size >= recoveredStreams.size && [...byStream.values()].every((count) => count >= 2);
      },
      {
        timeoutMs: RECOVERY_WAIT_MS,
        intervalMs: 3_000,
        label: 'every recovered rung uploads at least two segments, so none is merely announced and stuck',
      },
    );
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no ladder to restart';
}
