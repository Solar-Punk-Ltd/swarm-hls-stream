import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, type E2EConfig, loadConfig, type ServiceName, SERVICES } from '../../src/config.js';
import { discoverStamp, type Host, makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedLiveTopics, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { recoveryEntryIds } from '../../src/harness/uploaderState.js';
import { type CatalogFeed, discoverCatalogFeed, fetchCatalog } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario I — everything restarts at once, which is what a host reboot is.
 *
 * ## Why this is not six one-container scenarios
 *
 * Every fault this suite injects today takes one service away while the rest of the deployment stays
 * healthy, and the uploader's recovery path quietly depends on that. When it reboots holding a
 * recovery entry it restores the stream and arms a 60 second timer, and when the timer fires it
 * finalizes: it builds a VOD manifest, **uploads it through bee-uploader**, and writes the catalog.
 *
 * In every existing scenario bee-uploader has been up for days by then. In a host reboot it is
 * starting from cold at the same moment, and a bee node needs tens of seconds before it will accept
 * an upload. So the recovery deadline and the storage dependency race, and nothing has ever run them
 * against each other.
 *
 * ⭐ The failure this would produce is the expensive kind: the broadcast is over, the recording is the
 * only thing left of it, and it is lost at the exact moment the operator believes the restart worked.
 *
 * ## What is asserted
 *
 * The publisher's connection dies with the engine, so the broadcast genuinely ends and there is
 * nothing to resume. What must survive is the **recording**: exactly one VOD, the catalog naming it,
 * and no recovery entry left behind to be re-finalized on the next boot.
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

describe('I — whole-stack restart: the recording survives a host reboot', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let feed: CatalogFeed;
  let startedAt: string;

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
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
    const vodCommits = (text: string): number => text.match(/Updating stream in list to VOD/g)?.length ?? 0;

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before the restart`,
    });
    const ourTopic = announcedLiveTopics(await log()).at(-1);
    assert.ok(ourTopic, 'the uploader must have announced a live stream topic before the restart');

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
    // that the restored stream is finalized, and it has to happen through a bee node that was itself
    // restarting when the recovery timer started counting.
    await waitFor(async () => vodCommits(await log()) >= 1, {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: 'the recovered stream is finalized after the restart, through a bee node that restarted too',
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
    await waitFor(async () => (await safeFetch()).find((e) => e.topic === ourTopic)?.state === 'vod', {
      timeoutMs: CATALOG_WAIT_MS,
      intervalMs: 3_000,
      label: 'the recording of the interrupted broadcast surfaces as a VOD',
    });
  });
});
