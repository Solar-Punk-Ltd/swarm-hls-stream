import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  ladderRungs,
  parseUploaderLog,
  type PublishedRendition,
  publishedRenditions,
} from '../../src/harness/logwatch.js';
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
 * only restarts and waits is not watching the ladder recover — it is watching it retire. The
 * uploader logs `Publishing rendition` from the finalize path as well as the announce path, so once
 * the retired sessions are finalized (by the reconnect, or by the orphan reaper if none comes) four
 * `Publishing rendition <rung> of ladder <oldGroup>` lines land after the restart naming every rung
 * of the ladder that just ended. Counting those reads a dead broadcast as a recovered one. So each
 * test restarts, stops the dying publisher, waits the engine's reconnect grace, and starts a fresh
 * one, the way `engine-restart.test.ts` does.
 *
 * ## Reading the recovered ladder apart from the retired one
 *
 * A graceful restart unpublishes the rungs, so the old ladder group is released and the reconnecting
 * session forms a new one. The retired session's finalize announces therefore carry the group that
 * was live *before* the restart, while the recovered rungs carry a group first seen *after* it. Every
 * assertion below is scoped to groups first seen after the restart ({@link renditionsInFreshLadders}),
 * so the retired session's finalize lines never count as recovery and a whole ladder is not read as a
 * split. The same scoping is what makes the suite go red when nothing recovers: with no fresh group,
 * the recovery wait times out rather than latching onto the retirement.
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
   * the ladder groups already seen by then. The dying publisher is stopped and a fresh one started
   * after the engine's own reconnect grace, so the recovered rungs form a group not in
   * `priorLadders` — which is how a caller tells recovery from the retired session finalizing.
   */
  async function restartAndReconnect(): Promise<{ restartedAt: string; priorLadders: Set<string> }> {
    const priorLadders = new Set(publishedRenditions(await host.logsSince(uploader, startedAt)).map((p) => p.ladder));
    const restartedAt = await host.nowIso();
    await host.restart(mediaContainer);
    await publisher.stop();
    await sleep(engine.reconnectGraceMs); // let the engine accept SRT again before reconnecting
    publisher = startPublisher(cfg);
    return { restartedAt, priorLadders };
  }

  const recoveredRungCount = async (restartedAt: string, priorLadders: ReadonlySet<string>): Promise<number> =>
    new Set(renditionsInFreshLadders(await host.logsSince(uploader, restartedAt), priorLadders).map((p) => p.rung))
      .size;

  it('brings every rung back after the engine restarts', async () => {
    const { restartedAt, priorLadders } = await restartAndReconnect();

    await waitFor(async () => (await recoveredRungCount(restartedAt, priorLadders)) >= rungsBefore.length, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: `all ${rungsBefore.length} rungs re-publish under a fresh ladder after the restart`,
    });

    const recovered = renditionsInFreshLadders(await host.logsSince(uploader, restartedAt), priorLadders);
    const recoveredRungs = [...new Set(recovered.map((p) => p.rung))].sort();
    assert.deepEqual(
      recoveredRungs,
      [...rungsBefore].sort(),
      'the recovered ladder does not name the same rungs it had before the restart',
    );
  });

  /**
   * The point of the whole scenario. Scoped to the groups first seen after the restart, because the
   * retired session finalizes under the pre-restart group and would otherwise read as a second ladder.
   * What must not happen is the rungs of the *recovered* session disagreeing with each other.
   */
  it('groups the recovered rungs into one ladder, not one per rung', async () => {
    const { restartedAt, priorLadders } = await restartAndReconnect();

    await waitFor(async () => (await recoveredRungCount(restartedAt, priorLadders)) >= rungsBefore.length, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: 'the ladder re-forms under a fresh group after the restart',
    });

    const recovered = renditionsInFreshLadders(await host.logsSince(uploader, restartedAt), priorLadders);
    const groups = new Set(recovered.map((p) => p.ladder));
    assert.equal(groups.size, 1, `the recovered rungs split across ${groups.size} ladders: ${[...groups].join(', ')}`);
  });

  /**
   * A restart is a real discontinuity and the uploader is expected to arm one, so this asserts the
   * uploader kept working rather than that nothing happened. The single-rendition scenario makes the
   * same distinction; what is ABR-specific is that a stall in one rung must not stop the others.
   */
  it('keeps uploading segments after the restart rather than stalling on one rung', async () => {
    const { restartedAt, priorLadders } = await restartAndReconnect();

    await waitFor(
      async () => {
        const counts = countByRung(renditionsInFreshLadders(await host.logsSince(uploader, restartedAt), priorLadders));
        return counts.size >= rungsBefore.length && [...counts.values()].every((n) => n >= 2);
      },
      {
        timeoutMs: RECOVERY_WAIT_MS,
        intervalMs: 3_000,
        label: 'every recovered rung publishes at least twice, so none is merely announced and stuck',
      },
    );

    const events = parseUploaderLog(await host.logsSince(uploader, restartedAt));
    assert.ok(events.uploadedSegments.length > 0, 'no segment uploaded after the restart, so no rung recovered');
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no ladder to restart';
}

/**
 * Rung publishes under a ladder group first seen after the restart — the recovered session, not the
 * retired one. The retired session finalizes under a group that was already live before the restart,
 * so filtering those out leaves only the ladder that came back.
 */
function renditionsInFreshLadders(log: string, priorLadders: ReadonlySet<string>): PublishedRendition[] {
  return publishedRenditions(log).filter((publish) => !priorLadders.has(publish.ladder));
}

function countByRung(publishes: readonly PublishedRendition[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const publish of publishes) {
    counts.set(publish.rung, (counts.get(publish.rung) ?? 0) + 1);
  }
  return counts;
}
