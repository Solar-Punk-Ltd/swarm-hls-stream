import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
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
const SETTLE_AFTER_RESTART_MS = 5_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('ABR — engine restart: the ladder comes back whole', { skip: abrOff(cfg.abrEnabled) }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const engine = cfg.engine === 'ome' ? cfg.omeContainer : containerName(cfg, 'srs');
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
    await host.start(engine).catch(() => undefined);
  });

  it('brings every rung back after the engine restarts', async () => {
    const restartedAt = await host.nowIso();
    await host.restart(engine);
    await sleep(SETTLE_AFTER_RESTART_MS);

    await waitFor(async () => ladderRungs(await host.logsSince(uploader, restartedAt)).length >= rungsBefore.length, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: `all ${rungsBefore.length} rungs publish again after the restart`,
    });

    const after = ladderRungs(await host.logsSince(uploader, restartedAt));
    assert.deepEqual(
      [...after].sort(),
      [...rungsBefore].sort(),
      'the ladder came back a different shape, so a viewer has rungs the master does not name',
    );
  });

  /**
   * The point of the whole scenario. Scoped to after the restart, because the pre-restart group is
   * expected to differ: the uploader retires the old session and the new one is a new ladder. What
   * must not happen is the rungs of the *new* session disagreeing with each other.
   */
  it('groups the recovered rungs into one ladder, not one per rung', async () => {
    const restartedAt = await host.nowIso();
    await host.restart(engine);
    await sleep(SETTLE_AFTER_RESTART_MS);

    await waitFor(async () => ladderRungs(await host.logsSince(uploader, restartedAt)).length >= rungsBefore.length, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: 'the ladder re-forms after the restart',
    });

    const groups = new Set(publishedRenditions(await host.logsSince(uploader, restartedAt)).map((p) => p.ladder));
    assert.equal(groups.size, 1, `the recovered rungs split across ${groups.size} ladders: ${[...groups].join(', ')}`);
  });

  /**
   * A restart is a real discontinuity and the uploader is expected to arm one, so this asserts the
   * uploader kept working rather than that nothing happened. The single-rendition scenario makes the
   * same distinction; what is ABR-specific is that a stall in one rung must not stop the others.
   */
  it('keeps uploading segments after the restart rather than stalling on one rung', async () => {
    const restartedAt = await host.nowIso();
    await host.restart(engine);
    await sleep(SETTLE_AFTER_RESTART_MS);

    await waitFor(
      async () => {
        const counts = countByRung(publishedRenditions(await host.logsSince(uploader, restartedAt)));
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

function countByRung(publishes: readonly PublishedRendition[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const publish of publishes) {
    counts.set(publish.rung, (counts.get(publish.rung) ?? 0) + 1);
  }
  return counts;
}
