/**
 * What happens to a live stream whose engine stops talking and never comes back. Task #86.
 *
 * An engine that dies does not send `on_unpublish`, so nothing tells the uploader the broadcast is
 * over. The stream stayed in `activeStreams` for the life of the process: `/health` answered
 * `degraded` with `segment_stall` forever, the catalog entry stayed live for a broadcast that had
 * ended, and no VOD was ever published. Detection was already correct and there was no way out of it.
 *
 * The recovery path has had this control since the beginning, in `scheduleRecoveryFinalize`: a
 * stream rebuilt after a process restart waits `recoveryTimeout` for the engine and is finalized if
 * it never arrives. These tests pin the same control for a stream that was live all along, which is
 * the case that had it missing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, STREAM_STATUS_VOD, StreamState } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import {
  makeFakeCatalog,
  makeFakeRecoveryStore,
  makeRecordingCatalog,
  makeRecoveredState,
  makeTestOrchestrator,
  toRecoveryFileId,
} from './helpers/fakes.js';
import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

const STREAM_ID = 'live/stream';

/** The window an engine is given to come back before its stream is finalized. */
const REAP_MS = 60_000;
/** The recovery timer's own window, kept distinct so a test cannot pass by confusing the two. */
const RECOVERY_MS = 20_000;
const STALL_MS = 30_000;

/** A ceiling on a hung wait, not a measurement. See the note on the same constant in `StreamOrchestrator.test.ts`. */
const SETTLE_CEILING_MS = 4_000;
/** Long enough for a finalize to have started, short enough that a test meant to reach it stays cheap. */
const NOTHING_HAPPENED_MS = 300;

interface PublishedEntry {
  state: string;
}

interface Harness {
  orch: StreamOrchestrator;
  clock: FakeClock;
  /** Every catalog write, so a finalize is observable as the VOD it publishes. */
  published: PublishedEntry[];
  saved: StreamState[];
}

function makeHarness(): Harness {
  const clock = new FakeClock();
  const published: PublishedEntry[] = [];
  const saved: StreamState[] = [];
  const orch = makeTestOrchestrator(
    { orphanReapMs: REAP_MS, recoveryTimeout: RECOVERY_MS, segmentStallMs: STALL_MS, clock },
    {},
    makeFakeRecoveryStore({ save: (_streamId: string, state: StreamState) => saved.push(state) }),
    makeRecordingCatalog(published as unknown[]),
  );
  return { orch, clock, published, saved };
}

function hasFinalized(published: readonly PublishedEntry[]): boolean {
  return published.some((entry) => entry.state === STREAM_STATUS_VOD);
}

async function startAndFeed(harness: Harness, index: number): Promise<void> {
  const { orch, saved } = harness;
  const before = saved.length;
  orch.handleSegment(STREAM_ID, index, 2, Buffer.from(`seg${index}`));
  await waitFor(() => saved.length > before, SETTLE_CEILING_MS);
}

describe('a live stream whose engine dies without saying so (#86)', () => {
  it('finalizes the broadcast as a VOD once the engine has been silent for the reap window', async () => {
    const harness = makeHarness();
    const { orch, clock, published } = harness;

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);
    await startAndFeed(harness, 0);
    assert.equal(orch.getActiveStreamCount(), 1, 'the broadcast is live before the engine dies');

    // The engine dies here. Nothing calls stopStream, because nothing knows.
    await clock.advance(REAP_MS + 1);
    await waitFor(() => hasFinalized(published), SETTLE_CEILING_MS);

    assert.equal(hasFinalized(published), true, 'the broadcast must be published as a VOD rather than left live');
    assert.equal(orch.getActiveStreamCount(), 0, 'the orphaned stream must not keep holding its id');
  });

  /**
   * `streams_reaped_total` counts the moment the reaper decides, not the finalize that follows it, and
   * this pins that so the wording and the behaviour cannot drift apart again. Both had said "finalized"
   * while the increment sat one line above a fire-and-forget `stopStream`.
   *
   * The call site is deliberately left where it is. It is the engine-health signal the reaper was built
   * to provide, and moving it behind a successful stop would lose that signal in exactly the situation
   * where an operator most needs it: an engine dying while Bee is also refusing writes. The cost of
   * keeping it is that a reap is not a finalize, and the pair below is how an operator tells them
   * apart, so the pair is what the test asserts.
   */
  it('counts the reap decision, and the failed finalize separately, when the VOD write is refused', async () => {
    const clock = new FakeClock();
    const saved: StreamState[] = [];
    // Only the VOD write is refused, so the broadcast starts and runs exactly as it always does and the
    // failure lands precisely where the reaper's own finalize is.
    const catalog = makeFakeCatalog({
      addStream: async (entry: { state?: string }) => {
        if (entry?.state === STREAM_STATUS_VOD) {
          throw new Error('fake catalog refused the VOD write');
        }
      },
    });
    const orch = makeTestOrchestrator(
      { orphanReapMs: REAP_MS, recoveryTimeout: RECOVERY_MS, segmentStallMs: STALL_MS, clock },
      {},
      makeFakeRecoveryStore({ save: (_streamId: string, state: StreamState) => saved.push(state) }),
      catalog,
    );

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);
    orch.handleSegment(STREAM_ID, 0, 2, Buffer.from('seg0'));
    await waitFor(() => saved.length > 0, SETTLE_CEILING_MS);

    await clock.advance(REAP_MS + 1);
    await waitFor(() => orch.getMetricsSnapshot().streamsFailedTotal > 0, SETTLE_CEILING_MS);

    const snapshot = orch.getMetricsSnapshot();
    assert.equal(snapshot.streamsReapedTotal, 1, 'the reap is counted even though nothing was finalized');
    assert.equal(snapshot.streamsFailedTotal, 1, 'and the finalize that failed is counted as a failure');
  });

  /**
   * The symptom the task was filed for. Both readings below fed `deriveHealthStatus`, and together
   * they are what made `/health` answer `degraded` with `segment_stall` until someone restarted the
   * process by hand.
   */
  it('clears the permanent degraded health reading that the orphan produced', async () => {
    const harness = makeHarness();
    const { orch, clock } = harness;

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);
    await startAndFeed(harness, 0);

    await clock.advance(STALL_MS + 1);
    assert.equal(orch.getActiveStreamCount(), 1, 'past the stall window the orphan is still held');
    assert.notEqual(orch.getMsSinceStreamActivity(), null, 'and it is reported as stalled, which is correct');

    await clock.advance(REAP_MS + 1);
    await waitFor(() => orch.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

    assert.equal(orch.getMsSinceStreamActivity(), null, 'nothing is left to report a stall against');
  });

  it('leaves a stream alone while its engine is still delivering', async () => {
    const harness = makeHarness();
    const { orch, clock, published } = harness;

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);

    // Well past the reap window in total, but never silent for a whole one.
    for (let index = 0; index < 6; index++) {
      await startAndFeed(harness, index);
      await clock.advance(REAP_MS / 2);
    }

    assert.equal(hasFinalized(published), false, 'a broadcast that is still being fed must not be finalized');
    assert.equal(orch.getActiveStreamCount(), 1, 'and it must still hold its id');
  });

  /**
   * The regression this is most likely to cause. A twenty second write outage froze a viewer and
   * recovered correctly, and an engine that pauses inside its own retry window is ordinary. Reaping
   * on the stall threshold rather than the reconnect window would end both.
   */
  it('does not end a broadcast over a silence shorter than the reap window', async () => {
    const harness = makeHarness();
    const { orch, clock, published } = harness;

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);
    await startAndFeed(harness, 0);

    await clock.advance(REAP_MS - 1);
    await waitAndConfirmNothingHappened(() => !hasFinalized(published), NOTHING_HAPPENED_MS);
    assert.equal(orch.getActiveStreamCount(), 1, 'a silence one millisecond short of the window is survivable');

    // And the engine coming back resets the window rather than merely postponing the end.
    await startAndFeed(harness, 1);
    await clock.advance(REAP_MS - 1);
    assert.equal(hasFinalized(published), false, 'a resumed engine must buy a fresh window, not the remainder of one');
    assert.equal(orch.getActiveStreamCount(), 1);
  });

  it('does not finalize a second time when the stream was already stopped', async () => {
    const harness = makeHarness();
    const { orch, clock, published } = harness;

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);
    await startAndFeed(harness, 0);
    await orch.stopStream(STREAM_ID);

    const finalizedByStop = published.filter((entry) => entry.state === STREAM_STATUS_VOD).length;
    assert.equal(finalizedByStop, 1, 'the explicit stop publishes exactly one VOD');

    await clock.advance(REAP_MS * 2);
    await waitAndConfirmNothingHappened(
      () => published.filter((entry) => entry.state === STREAM_STATUS_VOD).length === finalizedByStop,
      NOTHING_HAPPENED_MS,
    );

    assert.equal(
      published.filter((entry) => entry.state === STREAM_STATUS_VOD).length,
      finalizedByStop,
      'a reaper firing after a clean stop would rewrite the feed entry the stop published',
    );
  });

  /**
   * The one behaviour this fix takes away, stated here rather than left to be discovered.
   *
   * SEC-28 gave a proven publish key an unconditional hold on its stream id: an unproven announce was
   * refused however long the incumbent had been quiet, because the incumbent session lived for as
   * long as the process did. Now that broadcast ends when its engine does, and `retireSession` drops
   * the claim with it, so the id becomes free.
   *
   * **That narrowing is deliberate.** An id is worth holding while there is a live broadcast behind
   * it, and after the reaper there is not: the VOD is published and the session is over. The key
   * holder is never locked out either way, because an authenticated announce is allowed against any
   * incumbent. What an operator gives up is squatting protection on an id whose broadcast has already
   * ended, and what they get back is that the broadcast ends at all.
   */
  it('frees a proven incumbent id once the reaper has ended that broadcast (narrows SEC-28)', async () => {
    const harness = makeHarness();
    const { orch, clock } = harness;

    orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: '203.0.113.10', isAuthenticated: true });
    await startAndFeed(harness, 0);

    await clock.advance(STALL_MS + 1);
    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: '198.51.100.7' }),
      false,
      'while the broadcast is live the proven key still refuses a stranger, however quiet it has gone',
    );

    await clock.advance(REAP_MS + 1);
    await waitFor(() => orch.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: '198.51.100.7' }),
      true,
      'once the broadcast has been finalized there is no longer a session to protect',
    );
  });

  /**
   * A stream restored after a process restart is handed to `scheduleRecoveryFinalize`, and its engine
   * resumes it by **sending segments rather than by announcing**: OME restarts its puller with no
   * admission behind it and SRS's publish session never closed, so neither calls `startStream` again.
   * The segment that resumes it cancels the recovery timer, and from that moment the stream is
   * ordinary and live with nothing watching it.
   *
   * So arming the reaper only where a stream is first spawned would leave every stream that has
   * survived one crash unprotected for the rest of its life, which is the longest-lived case of the
   * bug rather than an edge of it.
   */
  it('protects a recovered stream that its engine resumed with segments and then abandoned', async () => {
    const clock = new FakeClock();
    const published: PublishedEntry[] = [];
    const saved: StreamState[] = [];
    const orch = makeTestOrchestrator(
      { orphanReapMs: REAP_MS, recoveryTimeout: RECOVERY_MS, segmentStallMs: STALL_MS, clock },
      {},
      makeFakeRecoveryStore({
        listActive: () => [toRecoveryFileId(STREAM_ID)],
        load: () => makeRecoveredState(STREAM_ID),
        save: (_streamId: string, state: StreamState) => saved.push(state),
      }),
      makeRecordingCatalog(published as unknown[]),
    );
    const harness: Harness = { orch, clock, published, saved };

    assert.deepEqual(await orch.recoverStreams(), [STREAM_ID], 'the stream is restored and waiting for its engine');

    // Resumed by a segment, which cancels the recovery timer. No announce is ever made. Inside the
    // recovery window on purpose: past it the recovery timer would finalize the stream first and this
    // would be testing that instead.
    await clock.advance(RECOVERY_MS / 2);
    await startAndFeed(harness, 1);

    // And now the engine dies for good, with no recovery timer left to catch it.
    await clock.advance(REAP_MS + 1);
    await waitFor(() => hasFinalized(published), SETTLE_CEILING_MS);

    assert.equal(orch.getActiveStreamCount(), 0, 'a resumed stream that is abandoned again must still be reaped');
  });
});
