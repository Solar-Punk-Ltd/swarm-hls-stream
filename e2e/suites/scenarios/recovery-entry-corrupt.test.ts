import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import {
  readRecoveryEntry,
  recoveryEntryIds,
  removeRecoveryEntry,
  writeRecoveryEntry,
} from '../../src/harness/uploaderState.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario J — a recovery entry that is corrupt or hand-edited, driven end to end for the first time.
 *
 * ## The three shapes, and they do not share a path
 *
 * `recoverStreams` and `readinessFromPersisted` sort a bad entry into one of three outcomes, and only
 * one of them is the "documented repair path" the roadmap names:
 *
 * | on disk | what happens | what it costs |
 * | --- | --- | --- |
 * | unparseable | `RecoveryStore.load` returns null and the entry is **deleted** | ⛔ the recording, silently |
 * | parseable, no `streamId` | skipped and **never deleted** | nothing, correctly |
 * | announce-before-segment | **repaired** to `SEGMENT_READY`, loudly | one extra `addStream` |
 *
 * ⛔ **The first row is the one worth knowing about.** A broadcast whose entry cannot be parsed is not
 * recovered and not left for a human to look at: it is removed on the next boot, so the recording is
 * gone and the catalog goes on saying `live` forever. That is the same end state the repair path was
 * written to avoid, reached through the door nobody checked.
 *
 * The repair exists because refusing an entry was tried and was worse. This scenario asserts the two
 * outcomes that are unambiguously right and **reports** the first, because a test that asserted the
 * recording is lost would be freezing a defect into the suite as though it were a requirement.
 */

const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
const REBOOT_WAIT_MS = 60_000;
const RECOVERY_WAIT_MS = 150_000;
const MIN_STAMP_TTL_S = 600;

/** A file recovery must not touch: parseable, in the state directory, and not a stream. */
const FOREIGN_STATE_FILE = 'e2e-not-a-stream';

describe('J — a corrupt recovery entry: repaired, skipped, or lost', () => {
  const cfg = loadConfig();
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
    await host.start(uploader).catch(() => undefined);
    // The planted file is deliberately one recovery will not clean up, so this suite has to. Left
    // behind it would make every later boot on this deployment log a skipped state file.
    await removeRecoveryEntry(host, cfg, FOREIGN_STATE_FILE).catch(() => undefined);
  });

  it('repairs the illegal readiness pair rather than leaving the broadcast invisible', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before the crash`,
    });

    await host.kill(uploader);
    await waitFor(async () => !(await host.isRunning(uploader)), {
      timeoutMs: 15_000,
      intervalMs: 1_000,
      label: 'uploader container fully stopped, so its state file is quiescent',
    });

    const ids = await recoveryEntryIds(host, cfg);
    assert.ok(ids.length > 0, 'the killed uploader must have left a recovery entry to corrupt');
    const target = ids[0];

    // The one combination no live sequence can produce: the catalog announce recorded as done before
    // the first segment. Hand-editing is exactly how it arises in the field, which is why the repair
    // is written against it.
    const original = JSON.parse(await readRecoveryEntry(host, cfg, target)) as Record<string, unknown>;
    await writeRecoveryEntry(
      host,
      cfg,
      target,
      JSON.stringify({ ...original, isFirstSegmentReady: false, isFirstManifestReady: true }),
    );

    // A file that is parseable, sits in the same directory, and is not a stream. `recoverStreams`
    // must leave it alone: the state directory is shared, and recovery deleting what it does not own
    // is how a catalog index disappears.
    await writeRecoveryEntry(host, cfg, FOREIGN_STATE_FILE, JSON.stringify({ note: 'planted by scenario J' }));

    // Stamped BEFORE the start, because everything this scenario asserts on is logged while the
    // process comes up. Reading from an instant taken after `docker start` returned would miss the
    // recovery pass entirely and fail on an absence the run itself created.
    const bootedAt = await host.nowIso();
    await host.start(uploader);
    await waitFor(
      async () => {
        try {
          return (await uploaderHealth(host, cfg)).status === 'ok';
        } catch {
          return false;
        }
      },
      { timeoutMs: REBOOT_WAIT_MS, intervalMs: 2_000, label: 'the uploader boots on a hand-edited recovery entry' },
    );

    const bootLog = await host.logsSince(uploader, bootedAt);
    assert.match(
      bootLog,
      /which is not reachable/,
      'the uploader must say loudly that it repaired an entry no live sequence could have written',
    );
    assert.match(
      bootLog,
      /Skipping non-stream state file/,
      'a parseable file that is not a stream must be skipped rather than recovered',
    );

    // ⚠️ The publisher is still running, so segments resume the moment the uploader is back and
    // `handleSegment` cancels the recovery timer. That is correct behaviour and it means the stream
    // stays live: waiting for a finalize here would wait forever. Stop the broadcaster first, so the
    // finalize below is the ordinary end-of-stream path running on a repaired entry.
    await publisher.stop();

    // The repair's whole purpose: a stream restored from this entry still announces, so it is
    // discoverable rather than live-forever-and-invisible. Finalization is what proves it got there.
    await waitFor(async () => /Updating stream in list to VOD/.test(await log()), {
      timeoutMs: RECOVERY_WAIT_MS,
      intervalMs: 3_000,
      label: 'the repaired stream is finalized rather than left invisible',
    });

    const survivors = await recoveryEntryIds(host, cfg);
    assert.ok(
      survivors.includes(FOREIGN_STATE_FILE),
      `recovery deleted ${FOREIGN_STATE_FILE}, which it does not own. Anything else sharing the state directory is at risk`,
    );
  });

  it('reports what an unparseable entry costs, which is the recording', async () => {
    await waitForIdle(host, cfg);
    const restartedAt = await host.nowIso();
    const secondPublisher = startPublisher(cfg);
    try {
      const log = async (): Promise<string> => host.logsSince(uploader, restartedAt);

      await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
        timeoutMs: WARMUP_WAIT_MS,
        intervalMs: 2_000,
        label: `warmup: ${WARMUP_SEGMENTS} segments before the second crash`,
      });

      await host.kill(uploader);
      await waitFor(async () => !(await host.isRunning(uploader)), {
        timeoutMs: 15_000,
        intervalMs: 1_000,
        label: 'uploader container fully stopped before its entry is truncated',
      });

      const ids = (await recoveryEntryIds(host, cfg)).filter((id) => id !== FOREIGN_STATE_FILE);
      assert.ok(ids.length > 0, 'the killed uploader must have left a recovery entry to truncate');
      const target = ids[0];

      // A torn write: `RecoveryStore.save` renames a complete temporary file into place, so this is
      // what a filesystem fault leaves rather than what the uploader itself can produce.
      const original = await readRecoveryEntry(host, cfg, target);
      await writeRecoveryEntry(host, cfg, target, original.slice(0, Math.floor(original.length / 2)));

      const bootedAt = await host.nowIso();
      await host.start(uploader);
      await waitFor(
        async () => {
          try {
            return (await uploaderHealth(host, cfg)).status === 'ok';
          } catch {
            return false;
          }
        },
        { timeoutMs: REBOOT_WAIT_MS, intervalMs: 2_000, label: 'the uploader boots on a truncated recovery entry' },
      );

      // The process surviving is the requirement. What happened to the broadcast is the finding, and
      // it is printed rather than asserted: see the header.
      const bootLog = await host.logsSince(uploader, bootedAt);
      const remaining = await recoveryEntryIds(host, cfg);
      const wasRemoved = !remaining.includes(target);
      const wasFinalized = /Updating stream in list to VOD/.test(bootLog);
      console.log(
        `J: truncated entry ${target} — removed on boot: ${wasRemoved}, broadcast finalized: ${wasFinalized}`,
      );
      assert.match(
        bootLog,
        /Failed to load state/,
        'an entry that cannot be parsed must at least be reported, since nothing else will notice it',
      );
    } finally {
      await secondPublisher.stop();
    }
  });
});
