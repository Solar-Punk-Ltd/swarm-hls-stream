import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import {
  announcedSessionTopics,
  announcedVodFinalizeCount,
  parseUploaderLog,
  sessionEnds,
} from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
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

const cfg = loadConfig();

describe('K — reconnect during drain: two recordings, and the live one keeps its recovery entry', () => {
  const engine = getEngine(cfg);
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let first: Publisher;
  let second: Publisher | undefined;
  let startedAt: string;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
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
    // Scoped to broadcasts announced in our own window, so a neighbour's trailing flip is not read
    // as one of this scenario's two recordings.
    const vodCommits = async (): Promise<number> => announcedVodFinalizeCount(await log());

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before the disconnect`,
    });
    // A set, because a ladder announces one topic per rung; any topic outside it is a new session.
    const firstTopics = new Set(announcedSessionTopics(await log()));
    assert.ok(firstTopics.size > 0, 'the first session must have announced a topic before it disconnects');

    await first.stop();

    // Polled tight, because everything after this marker is the drain window the reconnect has to
    // land inside.
    await waitFor(async () => engine.unpublishedMarker.test(await log()), {
      timeoutMs: UNPUBLISH_WAIT_MS,
      intervalMs: 250,
      label: 'the engine reports the first session ended, which opens the drain window',
    });
    // The host's own clock, taken here so the log below can be scoped to the reconnected session
    // alone. Read the reason at the wait that uses it.
    const reconnectedAt = await host.nowIso();
    second = startPublisher(cfg);

    // A second topic is the proof the replacement was registered as its own session rather than
    // folded into the one that is draining.
    await waitFor(async () => announcedSessionTopics(await log()).some((topic) => !firstTopics.has(topic)), {
      timeoutMs: RECONNECT_WAIT_MS,
      intervalMs: 2_000,
      label: 'the reconnecting broadcaster is registered as a new session with its own topic',
    });
    const secondTopic = announcedSessionTopics(await log()).find((topic) => !firstTopics.has(topic));
    assert.ok(secondTopic, 'the reconnecting session must announce a topic of its own');

    // The outgoing session finalizes into its own recording, and the incoming one must not go with
    // it. The evidence differs by mode: a single rendition flips its own catalog entry to VOD, while
    // a ladder's entry is shared with the live replacement and deliberately never flips mid-group,
    // so the outgoing rungs are seen ending session by session, whichever way each one's
    // drain-versus-reconnect race went.
    //
    // ⛔ What the ladder branch CANNOT tell apart, and nothing at these lines can fix. `sessionEnds`
    // returns stream ids, and a reconnect republishes to the same stream path, so the second
    // session's rungs carry the same ids as the first session's. The set therefore counts rung
    // names, not sessions: four distinct ids is equally consistent with all four of the outgoing
    // rungs draining and with two of them draining while two of the INCOMING rungs died early. The
    // topic is the only thing that separates the sessions and this line family does not carry it.
    // The `activeStreams >= 1` assertion just below is the backstop: a second session that died
    // during the drain leaves nothing live, so it fails there.
    const outgoingFinalized = async (): Promise<boolean> => {
      if (!cfg.abrEnabled) {
        return (await vodCommits()) >= 1;
      }
      return new Set(sessionEnds(await log())).size >= cfg.abrRungs.length;
    };
    await waitFor(outgoingFinalized, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'the drained session finalizes into its own recording',
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
    //
    // ⛔ Counted from the reconnect rather than from the suite's own start. The old count was every
    // segment logged since the suite began reaching `WARMUP_SEGMENTS * 2`, and on a four rung ladder
    // the FIRST session clears that on its own before the disconnect: four rungs times four warmup
    // segments is sixteen against a target of eight. The wait was therefore already satisfied when
    // the reconnect happened, and would have passed had the second session never uploaded a byte.
    // Scoped to the window that opens when the second publisher starts, the only other thing that
    // can land in it is the first session's remaining drain, which is bounded by what it had
    // buffered rather than by how long this waits.
    const sinceReconnect = async (): Promise<number> =>
      parseUploaderLog(await host.logsSince(uploader, reconnectedAt)).uploadedSegments.length;
    await waitFor(async () => (await sinceReconnect()) >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: 'the reconnected session itself keeps uploading past the drain',
    });

    await second.stop();
    second = undefined;
    // Single rendition: a second catalog flip. Ladder: the shared entry flips exactly once, when the
    // reconnected session's last rung drains with nothing replacing it, so one flip is the proof.
    const expectedFlips = cfg.abrEnabled ? 1 : 2;
    await waitFor(async () => (await vodCommits()) >= expectedFlips, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'the reconnected session finalizes into a second recording of its own',
    });
  });
});
