import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import {
  announcedSessionTopics,
  announcedVodFinalizeCount,
  catalogContinuedEmpty,
  manifestIndicesByStream,
  parseUploaderLog,
  resumedFinalizeCount,
} from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
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
 * ## Why the trigger is the finalize's own feed writes
 *
 * The window is the gap between an upload and a catalog write, which is hundreds of milliseconds. A
 * wall-clock delay measured from the publisher stopping would land inside it only by luck.
 *
 * ⛔ **It used to be armed on the flip announce, and that line moved.** `Updating stream in list to
 * VOD` and `Ladder <group> finalized to VOD` are now both written AFTER the catalog write:
 * `StreamCatalog.upsertRendition` deliberately logs outside its own feed update so that a line
 * claiming a finished ladder is only written once the entry actually says so. That fix is right and
 * it took this trigger with it. By the time either line exists the window this scenario is named for
 * has already closed, so the kill landed on a finalize that had finished.
 *
 * So the kill is armed on the two feed writes finalize makes BEFORE the catalog instead. `finalize`
 * publishes the closing live manifest, then the VOD manifest, and `commitManifest` logs
 * `Manifest of <stream> uploaded at SOC index <n>` for each. Two of those on ONE rung after the
 * broadcaster stopped means that rung's recording is in the feed and `completeFinalize` runs next,
 * which is the catalog write. Counted per rung, because a ladder is four independent uploaders and
 * the first one to reach the window is the one that opens it.
 *
 * ⚠️ **The race is still a race, and it can now also fire early.** A rung holding a buffered segment
 * when the broadcaster stopped publishes an ordinary live manifest first, so its second post-stop
 * publish can be the CLOSING playlist rather than the VOD one. A kill there lands before the
 * recording is bought at all, which is a legal outcome the assertions below already hold for: nothing
 * was published twice because nothing was published once, and the reboot finalizes from the recovery
 * entry that survived. So the run reports which state it actually caught, because a scenario that
 * quietly missed its window and passed anyway would be worth less than no scenario at all.
 */

const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
/**
 * Manifest publishes one rung must make after the broadcaster stops before the kill is fired.
 *
 * Two, because that is what `finalize` writes to the manifest feed ahead of the catalog: the closing
 * live playlist and then the VOD manifest. See the header for what a rung that was still flushing a
 * buffered segment does to this count, and why that outcome is legal rather than a missed run.
 */
const FINALIZE_MANIFEST_PUBLISHES = 2;
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
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
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
    // own suite, and its trailing flip inside this window once read as this broadcast publishing
    // twice, which the uploader's log disproved. It counts the flips and no longer arms the kill.
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

    // Read straight after the stop returns, so what the wait below counts is what finalize adds
    // rather than the whole broadcast's publishing. The engine has not fired its unpublish webhook
    // yet at this point, so nothing of the drain is in this baseline.
    const manifestsAtStop = manifestCounts(await log());

    // The kill is armed on finalize's own feed writes rather than on a delay or on the flip line:
    // see the header. Polled as fast as a round trip allows, because the catalog write that follows
    // them is exactly what the scenario is trying to split.
    await waitFor(async () => publishesSinceStop(await log(), manifestsAtStop) >= FINALIZE_MANIFEST_PUBLISHES, {
      timeoutMs: FINALIZE_WAIT_MS,
      intervalMs: 250,
      label:
        `a draining rung makes ${FINALIZE_MANIFEST_PUBLISHES} manifest publishes past the stop, which puts ` +
        "finalize's catalog write next",
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
    // The discriminator, printed before the assertions so it is in the log whichever way they go.
    const lostCatalog = catalogContinuedEmpty(finalLog);
    console.log(`H: catalog writes — ${commitsBeforeReboot} before the reboot, ${commitsAfterReboot} in total`);
    console.log(
      `H: the uploader gave up on its previous catalog state ${lostCatalog} time(s) ` +
        '(non-zero means a second finalize count is a blind read, not a second finalize)',
    );
    // Observation, never asserted. A non-zero says the kill landed inside the window AND the
    // uploader answered it by resuming at the catalog write instead of buying the recording twice.
    // Zero with a caught window means the crash beat the recording's publish, so the full path ran
    // once, which is the other correct answer.
    console.log(`H: finalizes resumed rather than republished: ${resumedFinalizeCount(finalLog)}`);

    // ⛔ What this line does and does not prove, pinned by unit tests in
    // `packages/stream-uploader/test/StreamCatalog.test.ts` on 2026-09-01. The guard behind it is
    // "the entry the catalog feed currently holds is not already VOD". Re-announcing a finished
    // rung after a crash does NOT trip it, so a second line is not recovery re-finalizing: it means
    // the reboot's catalog read came back without the entry and the guard called it the first
    // finalize. That is its own defect, because the same blind read rebuilds the ladder from the one
    // rung in hand, but it is not the second payment the old wording here claimed.
    assert.equal(
      commitsAfterReboot,
      1,
      `a broadcast must be finalized once, and the uploader announced the flip ${commitsAfterReboot} times. ` +
        'A second one means the reboot could not read its own catalog entry back, so it treated the ' +
        `finished ladder as a new one. The uploader reported losing its catalog ${lostCatalog} time(s), ` +
        'and a non-zero there is that read failing rather than a recording published twice',
    );

    // ⛔ Its own failure, whatever the count above did. Continuing from an empty catalog overwrites
    // every other stream's entry as well as this one, and the uploader says so at error level.
    assert.equal(
      lostCatalog,
      0,
      `the uploader continued from an empty catalog ${lostCatalog} time(s) during this scenario. ` +
        "Every entry the feed held was written over, not just this broadcast's",
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

    // The other half of a blind reboot read: the entry is rebuilt from whichever rung re-announced,
    // so a four rung recording comes back as a one rung recording. Reported for every run, because
    // it is what tells a reader which failure the count above was.
    const finished = (await safeFetch()).find((entry) => entryCarriesTopic(entry, ourTopics));
    const recorded = finished?.renditions?.length ?? 0;
    console.log(`H: the finished entry carries ${recorded} rendition(s), from ${ourTopics.size} announced rung(s)`);
    assert.ok(
      recorded === 0 || recorded >= ourTopics.size,
      `the recording lost renditions across the crash: ${recorded} left of ${ourTopics.size} announced. ` +
        'A reboot that cannot read its catalog entry back rebuilds the ladder from the one rung it ' +
        'holds and writes that over the finished one',
    );
  });
});

/** How many manifest publishes each rung has made in this log window, keyed by stream. */
function manifestCounts(text: string): Map<string, number> {
  return new Map([...manifestIndicesByStream(text)].map(([streamId, indices]) => [streamId, indices.length]));
}

/**
 * The most manifest publishes any ONE rung has made since the counts in `atStop` were taken.
 *
 * ⛔ Per rung and never summed. Four rungs each making one publish is four rungs still running live,
 * and summed it looks identical to the one rung that has published its closing playlist and its VOD
 * manifest. Only the second is the window this scenario kills into.
 *
 * A rung absent from `atStop` counts from zero, which is right: it published nothing before the stop.
 */
function publishesSinceStop(text: string, atStop: ReadonlyMap<string, number>): number {
  const advanced = [...manifestCounts(text)].map(([streamId, count]) => count - (atStop.get(streamId) ?? 0));
  return Math.max(0, ...advanced);
}
