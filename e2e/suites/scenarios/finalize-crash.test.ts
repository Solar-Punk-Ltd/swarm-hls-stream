import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedSessionTopics, announcedVodFinalizeCount, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { recoveryEntryIds } from '../../src/harness/uploaderState.js';
import { type CatalogFeed, discoverCatalogFeed, entryCarriesTopic, fetchCatalog } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario H — the uploader is killed *inside* `finalize`, the one path that both spends and forgets.
 *
 * ## The window, read from `StreamUploader.finalize` rather than from the roadmap
 *
 * The roadmap ranked this as "the one window where the entry is gone and the VOD is not published".
 * That is not the ordering. `finalize` publishes the closing live manifest, then the VOD manifest,
 * then writes the catalog entry, and **deletes the recovery entry last of all**. So a crash cannot
 * leave the entry gone with nothing published. What it can leave is the opposite, and that is worse
 * than it sounds:
 *
 * - killed after the VOD manifest is committed and before the catalog names it: the recording is
 *   uploaded and **paid for**, the catalog still says `live`, and the recovery entry is still there.
 * - killed after the catalog says `vod` and before the entry is cleared: the entry outlives the
 *   broadcast it describes, and the next boot recovers a stream that is already finished.
 *
 * Both end at the same question, which is the one this scenario asks: **after the restart, is there
 * exactly one recording, and does the catalog point at it?** A second finalize would publish a second
 * VOD manifest at a higher feed index and pay for it, and the catalog would name the newer one while
 * the older sits in the feed, bought and unreachable.
 *
 * ## Why the trigger is a log line and not a delay
 *
 * The window is the gap between an upload and a catalog write, which is hundreds of milliseconds. A
 * wall-clock delay measured from the publisher stopping would land inside it only by luck.
 * `Updating stream in list to VOD` is logged immediately before `streamCatalog.addStream`, so waiting
 * for that line puts the kill at the start of the window rather than somewhere near it.
 *
 * ⚠️ **The race is still a race.** Reading the log costs a round trip, and the two steps after that
 * line can finish inside one. So the run reports which state it actually caught, and the assertions
 * hold for either: a scenario that quietly missed its window and passed anyway would be worth less
 * than no scenario at all.
 */

const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
const FINALIZE_WAIT_MS = 90_000;
const REBOOT_WAIT_MS = 60_000;
/** Past the 60s recovery timer, so a re-finalize triggered by recovery has run before anything is read. */
const SETTLE_PAST_RECOVERY_MS = 90_000;
const CATALOG_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('H — killed inside finalize: one recording, and the catalog points at it', () => {
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
    // The kill below does not trip a restart policy here, so a failure between it and the restart
    // would leave the deployment without its uploader for everything that runs after this file.
    await host.start(uploader).catch(() => undefined);
  });

  it('does not publish a second recording after a crash mid-finalize', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    // Scoped to broadcasts announced in our own window: scenario E's resumed stream drains past its
    // own suite, and its trailing flip inside this window once armed the kill early and then read
    // as this broadcast publishing twice, which the uploader's log disproved.
    const vodCommits = (text: string): number => announcedVodFinalizeCount(text);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before stopping the broadcaster`,
    });
    // A set, because a ladder announces one topic per rung and the catalog entry carries one of them.
    const ourTopics = new Set(announcedSessionTopics(await log()));
    assert.ok(ourTopics.size > 0, 'the uploader must have announced a live topic before the finalize');

    await publisher.stop();

    // The kill is armed on the log line rather than on a delay: see the header. Polled as fast as a
    // round trip allows, because everything after that line is what the scenario is trying to split.
    await waitFor(async () => vodCommits(await log()) >= 1, {
      timeoutMs: FINALIZE_WAIT_MS,
      intervalMs: 250,
      label: 'the uploader reaches the catalog write at the end of finalize',
    });
    await host.kill(uploader);

    // What the crash actually caught, reported either way. The entry surviving means the kill landed
    // inside the window; the entry being gone means finalize completed first, which is a real outcome
    // and not a failed run, but it is a different one and the report must not blur them.
    const entriesAfterKill = await recoveryEntryIds(host, cfg);
    const caughtTheWindow = entriesAfterKill.length > 0;
    console.log(
      caughtTheWindow
        ? `H: caught the window — ${
            entriesAfterKill.length
          } recovery entry(s) survived the kill: ${entriesAfterKill.join(', ')}`
        : 'H: finalize completed before the kill landed, so this run tests the clean ordering rather than the window',
    );

    const commitsBeforeReboot = vodCommits(await log());

    await waitFor(async () => !(await host.isRunning(uploader)), {
      timeoutMs: 15_000,
      intervalMs: 1_000,
      label: 'uploader container fully stopped after the kill',
    });
    // Stamped before the start, so the recovery pass below is read from a window that opens with
    // this boot rather than one that already holds the whole run.
    const rebootedAt = await host.nowIso();
    await host.start(uploader);
    await waitFor(
      async () => {
        try {
          return (await uploaderHealth(host, cfg)).status === 'ok';
        } catch {
          return false;
        }
      },
      { timeoutMs: REBOOT_WAIT_MS, intervalMs: 2_000, label: 'uploader reboots after the mid-finalize crash' },
    );

    // ⚠️ Waiting for `activeStreams === 0` on its own is not a wait at all here: it is already true
    // in the first poll after boot, before `recoverStreams` has registered anything. Wait for the
    // recovery pass to have declared itself first, so the idle below is the state AFTER recovery
    // rather than the state before it.
    await waitFor(
      async () => /No streams to recover|Recovering \d+ stream/.test(await host.logsSince(uploader, rebootedAt)),
      {
        timeoutMs: REBOOT_WAIT_MS,
        intervalMs: 1_000,
        label: 'the reboot reaches its recovery pass and says what it found',
      },
    );

    // Long enough for the recovery timer to fire on anything the reboot restored. A stream recovered
    // from a surviving entry is finalized by that timer, and a re-finalize is exactly what must not
    // produce a second recording.
    await waitFor(async () => (await uploaderHealth(host, cfg)).activeStreams === 0, {
      timeoutMs: SETTLE_PAST_RECOVERY_MS,
      intervalMs: 3_000,
      label: 'nothing is left active once recovery has run its course',
    });

    const finalLog = await log();
    const commitsAfterReboot = vodCommits(finalLog);
    console.log(`H: catalog writes — ${commitsBeforeReboot} before the reboot, ${commitsAfterReboot} in total`);

    assert.equal(
      commitsAfterReboot,
      1,
      `a broadcast must be finalized once. The uploader wrote the catalog ${commitsAfterReboot} times, ` +
        'so the recording was published and paid for more than once',
    );

    assert.deepEqual(
      await recoveryEntryIds(host, cfg),
      [],
      'a finished broadcast must leave no recovery entry, or every later boot recovers a stream that is over',
    );

    // Guarded, because this catalog is served through the gateway and a read during the uploader's
    // reboot answers with an error rather than a stale list. A throwing poll would fail the scenario
    // for the transport rather than for the thing it is asserting.
    const safeFetch = async () => fetchCatalog(host, cfg, feed).catch(() => []);
    await waitFor(async () => (await safeFetch()).find((e) => entryCarriesTopic(e, ourTopics))?.state === 'vod', {
      timeoutMs: CATALOG_WAIT_MS,
      intervalMs: 3_000,
      label: 'the recording surfaces as a VOD in the gateway catalog',
    });
  });
});
