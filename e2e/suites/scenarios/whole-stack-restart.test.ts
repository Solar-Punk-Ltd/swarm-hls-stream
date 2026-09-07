import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, type E2EConfig, loadConfig, type ServiceName, SERVICES } from '../../src/config.js';
import { type Host, makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedSessionTopics, announcedVodFinalizeCount, parseUploaderLog } from '../../src/harness/logwatch.js';
import { checkPublishedTimeline, publishingRungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { recoveryEntryIds } from '../../src/harness/uploaderState.js';
import { type CatalogFeed, discoverCatalogFeed, entryCarriesTopic, fetchCatalog } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario I — everything restarts at once, which is what a host reboot is.
 *
 * ## Why this is not six one-container scenarios
 *
 * Every fault this suite injects today takes one service away while the rest of the deployment stays
 * healthy. A reboot takes them all at once, and the one recording it must leave behind can come out
 * of two different paths, which is what this scenario asserts across without saying which one ran.
 *
 * **The graceful path.** `docker restart` delivers SIGTERM, and the uploader's shutdown stops every
 * live stream before the process exits: each one is finalized to VOD, uploaded through its bee node
 * and written to the catalog, and its recovery entry is removed, all inside docker's stop grace. This
 * is what happened on the live stage on 2026-09-07: `Received SIGTERM` at 02:18:29.9Z, `finalized to
 * VOD` at 02:18:34.7Z, and the container that came back logged no recovery at all. It works because
 * the containers are restarted in sequence and the bee nodes are still up while the uploader is
 * finalizing.
 *
 * **The recovery path.** If the finalize cannot complete before the grace runs out, or a bee node is
 * already gone when the uploader reaches for it, the recovery entry survives on disk. The uploader
 * then boots holding it, restores the stream, arms a 60 second timer, and when the timer fires it
 * finalizes through a bee node that was itself starting from cold and needs tens of seconds before it
 * accepts an upload. That is the race this scenario was first written about, and nothing else in the
 * suite runs it.
 *
 * ⛔ **Which path a given run took is not asserted and not read here.** Both end in the same
 * recording, and the assertions below hold for either. On the stage as deployed the graceful path is
 * the usual one, so a green here is evidence about the shutdown finalize far more often than about
 * the recovery timer. A scenario that has to reach the recovery branch cannot use a graceful stop at
 * all, which is why `reconnect-into-recovery` (M) kills the uploader with SIGKILL the way
 * `uploader-crash-recovery` (F) does. Owner ruling of 2026-09-07: the scenario stays as it is and
 * this docblock says what it proves.
 *
 * ⭐ The failure either path would produce is the expensive kind: the broadcast is over, the
 * recording is the only thing left of it, and it is lost at the exact moment the operator believes
 * the restart worked.
 *
 * ## What is asserted
 *
 * The publisher's connection dies with the engine, so the broadcast genuinely ends and there is
 * nothing to resume. What must survive is the **recording**: exactly one VOD, the catalog naming it,
 * and no recovery entry left behind to be re-finalized on the next boot.
 *
 * ⭐ And the recording has to be a playable one, which the catalog cannot say. Its playlists are read
 * and held to the manifest contract, because the finalize that wrote them ran either under a shutdown
 * with the process about to exit, or from state restored off disk through a bee node starting from
 * cold, and neither is the ordinary end of a broadcast. See `src/harness/manifestContractLive.ts`.
 */

const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
/** Past the 60s recovery timer plus a cold bee node's own startup, which is the race under test. */
const RECOVERY_WAIT_MS = 240_000;
const REBOOT_WAIT_MS = 180_000;
const CATALOG_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

/** Only the services this profile is actually running: `ome` is absent whenever the engine is SRS. */
async function runningContainers(host: Host, cfg: E2EConfig): Promise<string[]> {
  const names = Object.values(SERVICES).map((service: ServiceName) => containerName(cfg, service));
  const running: string[] = [];
  for (const name of names) {
    if (await host.isRunning(name)) {
      running.push(name);
    }
  }
  return running;
}

const cfg = loadConfig();

describe('I — whole-stack restart: the recording survives a host reboot', () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let feed: CatalogFeed;
  let startedAt: string;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('finalizes the interrupted broadcast even though bee restarted with it', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    // Scoped to broadcasts announced in our own window, so a neighbour's flip trailing into it
    // cannot satisfy the finalize wait for a broadcast the restart actually lost.
    const vodCommits = (text: string): number => announcedVodFinalizeCount(text);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before the restart`,
    });
    // A set, because a ladder announces one topic per rung and the catalog entry carries one of them.
    const ourTopics = new Set(announcedSessionTopics(await log()));
    assert.ok(ourTopics.size > 0, 'the uploader must have announced a live topic before the restart');

    const entriesBefore = await recoveryEntryIds(host, cfg);
    assert.ok(
      entriesBefore.length > 0,
      'a live broadcast must have a recovery entry, or this scenario is restarting a stack with nothing to recover',
    );

    // One `docker restart` for every container at once, which is the point: staggering them would
    // give the uploader a bee node that is already up, and that is the case the other six scenarios
    // already cover. Scoped to this profile's own containers.
    const containers = await runningContainers(host, cfg);
    console.log(`I: restarting ${containers.length} containers together: ${containers.join(', ')}`);
    await host.run(`docker restart ${containers.join(' ')}`, REBOOT_WAIT_MS);

    await waitFor(
      async () => {
        try {
          return (await uploaderHealth(host, cfg)).status !== undefined;
        } catch {
          return false;
        }
      },
      {
        timeoutMs: REBOOT_WAIT_MS,
        intervalMs: 3_000,
        label: 'the uploader answers again after the whole-stack restart',
      },
    );

    // The engine took the publisher's connection with it, so nothing resumes. What has to happen is
    // that the broadcast is finalized exactly once, by the shutdown before the process went down or by
    // the recovery timer after it came back. See the docblock: which of the two ran is not read here.
    await waitFor(async () => vodCommits(await log()) >= 1, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: 'the interrupted broadcast is finalized, by the shutdown or by the recovery timer',
    });

    await waitFor(async () => (await uploaderHealth(host, cfg)).activeStreams === 0, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: 'nothing is left active once recovery has run its course',
    });

    assert.deepEqual(
      await recoveryEntryIds(host, cfg),
      [],
      'the finalized broadcast must leave no recovery entry, or the next boot recovers a stream that is over',
    );

    const safeFetch = async () => fetchCatalog(host, cfg, feed).catch(() => []);
    await waitFor(async () => (await safeFetch()).find((e) => entryCarriesTopic(e, ourTopics))?.state === 'vod', {
      timeoutMs: CATALOG_WAIT_MS,
      intervalMs: 3_000,
      label: 'the recording of the interrupted broadcast surfaces as a VOD',
    });

    // ⛔ The catalog naming a recording and the recording being playable are different facts, and this
    // scenario is the one where they can come apart: the finalize that wrote it ran either under a
    // shutdown or from state restored off disk through a bee node starting from cold. So the
    // playlists are read and held to the contract. A recording names every segment of its broadcast,
    // so its media sequence must be 0 however far the engine's own counter had run.
    const verdict = await checkPublishedTimeline(host, cfg, {
      owner: feed.owner,
      rungs: publishingRungFeedsOf(await log()),
      expectation: cfg.segmentExpectation,
      logAfterTheRead: log,
    });

    console.log(verdict.summary);
    assert.equal(verdict.refusal, null, verdict.refusal ?? '');
  });
});
