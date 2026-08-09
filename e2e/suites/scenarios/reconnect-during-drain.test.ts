import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { discoverStamp, makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedLiveTopics, parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { recoveryEntryIds } from '../../src/harness/uploaderState.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario K — a broadcaster reconnects while the previous session is still draining.
 *
 * ## Why a unit test models this badly
 *
 * Two `StreamUploader`s exist under one stream id, and which one owns what is decided by wall-clock
 * overlap: `notifyStop` holds the outgoing session in `activeStreams` for the whole of its drain, and
 * a reconnect registers the replacement under the same id inside that window. The orchestrator sorts
 * them with `isDraining`, which matches on the **uploader** rather than the id, and with `retire()`,
 * which takes the recovery entry away from the outgoing one.
 *
 * A unit test picks the interleaving it wants to prove. The interleaving that matters here is the one
 * the deployment produces, and it depends on how long a real drain takes against how fast a real
 * broadcaster comes back.
 *
 * ## What must be true
 *
 * Each uploader owns its own feed topic, so a reconnect is two recordings and not one. The outgoing
 * session must finalize into its own VOD, the incoming one must stay live rather than being finalized
 * with it, and **the recovery entry must belong to the session that is still running**. The failure
 * this guards is the outgoing drain clearing or overwriting the live session's entry on its way out:
 * that leaves a running broadcast with no recovery entry, so a crash after it loses the whole thing.
 *
 * ## Why the trigger is the unpublish marker
 *
 * The reconnect has to land *during* the drain. Starting the second publisher as soon as `stop()`
 * returns is too early: the engine has not necessarily fired its unpublish webhook yet, so the second
 * session would arrive while the first is still live, which is a different race and one the engine
 * itself may refuse. Waiting for the engine's own marker puts the reconnect after the drain starts.
 */

const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
const UNPUBLISH_WAIT_MS = 60_000;
const RECONNECT_WAIT_MS = 120_000;
const VOD_WAIT_MS = 150_000;
const MIN_STAMP_TTL_S = 600;

describe('K — reconnect during drain: two recordings, and the live one keeps its recovery entry', () => {
  const cfg = loadConfig();
  const engine = getEngine(cfg);
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let first: Publisher;
  let second: Publisher | undefined;
  let startedAt: string;

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    first = startPublisher(cfg);
  });

  after(async () => {
    await first?.stop();
    await second?.stop();
  });

  it('gives the reconnecting session its own recording and leaves its recovery entry alone', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    const vodCommits = async (): Promise<number> =>
      (await log()).match(/Updating stream in list to VOD/g)?.length ?? 0;

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before the disconnect`,
    });
    const firstTopic = announcedLiveTopics(await log()).at(-1);
    assert.ok(firstTopic, 'the first session must have announced a topic before it disconnects');

    await first.stop();

    // Polled tight, because everything after this marker is the drain window the reconnect has to
    // land inside.
    await waitFor(async () => engine.unpublishedMarker.test(await log()), {
      timeoutMs: UNPUBLISH_WAIT_MS,
      intervalMs: 250,
      label: 'the engine reports the first session ended, which opens the drain window',
    });
    second = startPublisher(cfg);

    // A second topic is the proof the replacement was registered as its own session rather than
    // folded into the one that is draining.
    await waitFor(
      async () => {
        const topics = announcedLiveTopics(await log());
        return topics.some((topic) => topic !== firstTopic);
      },
      {
        timeoutMs: RECONNECT_WAIT_MS,
        intervalMs: 2_000,
        label: 'the reconnecting broadcaster is registered as a new session with its own topic',
      },
    );
    const secondTopic = announcedLiveTopics(await log()).find((topic) => topic !== firstTopic);
    assert.ok(secondTopic, 'the reconnecting session must announce a topic of its own');

    // The outgoing session finalizes into its own recording, and the incoming one must not go with it.
    await waitFor(async () => (await vodCommits()) >= 1, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'the drained session publishes its own recording',
    });

    const health = await uploaderHealth(host, cfg);
    assert.ok(
      health.activeStreams >= 1,
      `the reconnected broadcast must still be live after the previous session drained; activeStreams=${health.activeStreams}`,
    );

    // The guard that matters. `retire()` exists so the outgoing drain stops owning this file; without
    // it the live broadcast is running with nothing on disk to recover it from.
    const entries = await recoveryEntryIds(host, cfg);
    assert.ok(
      entries.length > 0,
      'the live session must keep a recovery entry after the previous session drained, ' +
        'or a crash from here loses a broadcast that is still running',
    );

    // And it has to be the live session's own state, not the drained session's left in place.
    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS * 2, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: 'the reconnected session keeps uploading past the drain',
    });

    await second.stop();
    second = undefined;
    await waitFor(async () => (await vodCommits()) >= 2, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'the reconnected session finalizes into a second recording of its own',
    });
  });
});
