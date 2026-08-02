/**
 * Who is allowed to take a stream id that another session is already publishing on. See SEC-26.
 *
 * The behaviour under test is a narrowing of CON-16, so both halves are pinned here rather than only
 * the new refusal: a build that refuses every re-announce would close the hole and break every
 * reconnect, and a build that accepts every one is what SEC-26 describes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, STREAM_STATUS_VOD, StreamState } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import {
  makeFakeRecoveryStore,
  makeRecordingCatalog,
  makeRecoveredState,
  makeTestOrchestrator,
  toRecoveryFileId,
} from './helpers/fakes.js';
import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

const STREAM_ID = 'live/stream';
const BROADCASTER = '203.0.113.10';
const STRANGER = '198.51.100.7';

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
  /** Every catalog write, so a finalize of the live session is observable as the VOD it publishes. */
  published: PublishedEntry[];
  /** Every persisted state. Each session owns a fresh feed topic, which is what tells their writes apart. */
  saved: StreamState[];
}

function makeHarness(clock?: FakeClock): Harness {
  const published: PublishedEntry[] = [];
  const saved: StreamState[] = [];
  const orch = makeTestOrchestrator(
    { segmentStallMs: STALL_MS, clock },
    {},
    makeFakeRecoveryStore({ save: (_streamId: string, state: StreamState) => saved.push(state) }),
    makeRecordingCatalog(published as unknown[]),
  );
  return { orch, published, saved };
}

function hasFinalized(published: readonly PublishedEntry[]): boolean {
  return published.some((entry) => entry.state === STREAM_STATUS_VOD);
}

/** Publish one segment and wait for the state it persists, so the live session's topic can be read. */
async function publishOneSegment({ orch, saved }: Harness, index: number): Promise<string> {
  const before = saved.length;
  orch.handleSegment(STREAM_ID, index, 2, Buffer.from(`seg${index}`));
  await waitFor(() => saved.length > before, SETTLE_CEILING_MS);
  return saved[saved.length - 1].streamRawTopic;
}

describe('taking over a stream id that is already being published', () => {
  /**
   * SEC-26. The app and stream are public, since they are in every HLS URL, so this costs the attacker
   * one connect. What made it work is that the opening path never asked who was announcing: the live
   * session was retired and finalized as a VOD before anything compared the newcomer to it.
   */
  it('refuses an announce from a different address while the stream is still producing', async () => {
    const harness = makeHarness();
    const { orch, published } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    const broadcasterTopic = await publishOneSegment(harness, 0);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      false,
      'a stranger announcing a live stream id must be refused',
    );

    await waitAndConfirmNothingHappened(() => !hasFinalized(published), NOTHING_HAPPENED_MS);
    assert.equal(orch.getActiveStreamCount(), 1, 'exactly one session holds the id');
    // The refusal is a denial of service to whoever sent it, and the evidence behind it can be wrong
    // in both directions, so it has to be countable rather than only logged.
    assert.equal(orch.getMetricsSnapshot().takeoversRefusedTotal, 1, 'the refusal must reach `/metrics`');
    assert.equal(
      await publishOneSegment(harness, 1),
      broadcasterTopic,
      'the session still publishing under this id must be the one that was there first',
    );

    await orch.cleanup();
  });

  /**
   * CON-16's case, which this must not break. A media engine restarted without sending its unpublish
   * re-announces the same broadcaster, and rejecting that leaves them unable to resume at all.
   */
  it('lets the same address take the id back, and finalizes the session it replaces', async () => {
    const harness = makeHarness();
    const { orch, published } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    const firstTopic = await publishOneSegment(harness, 0);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }),
      true,
      'a reconnecting broadcaster must still be accepted',
    );

    await waitFor(() => hasFinalized(published), SETTLE_CEILING_MS);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    assert.notEqual(
      await publishOneSegment(harness, 0),
      firstTopic,
      'the re-announce must have started a fresh session rather than left the old one running',
    );

    await orch.cleanup();
  });

  /**
   * The escape hatch, and the reason the refusal above is conditional. A broadcaster whose address
   * changed between sessions, which a mobile network or a re-issued lease both produce, would
   * otherwise be locked out of their own id until someone stopped it by hand. The service already has
   * a definition of a stream that is not producing, `segmentStallMs`, and this reuses it rather than
   * introducing a second one that could disagree with `/health`.
   */
  it('lets any address take over once the stream has been stalled for longer than the stall window', async () => {
    const clock = new FakeClock();
    const harness = makeHarness(clock);
    const { orch, published } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    await clock.advance(STALL_MS + 1);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      true,
      'a stream nothing has fed for longer than the stall window is not held against a new publisher',
    );
    await waitFor(() => hasFinalized(published), SETTLE_CEILING_MS);

    await orch.cleanup();
  });

  /**
   * The window is measured, not merely present. Refusing at one millisecond short of it and at one
   * past it are the two sides the comparison can be written backwards between, and a build that
   * allowed the takeover the moment any time had passed would satisfy the test above on its own.
   */
  it('still refuses a stranger one millisecond short of the stall window', async () => {
    const clock = new FakeClock();
    const { orch } = makeHarness(clock);

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);

    await clock.advance(STALL_MS - 1);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      false,
      'the stall window must be reached before a stranger may take the id',
    );

    await orch.cleanup();
  });

  /**
   * The guard is strict only with evidence on both sides, which is the same rule the closing path
   * already applies in `isProvablyNotTheLiveSession`. An engine that reports no publisher address
   * leaves nothing to compare, and refusing on that would turn a missing field into an outage for
   * every reconnect on that engine.
   *
   * This is also why the parameter has a default: it fails open, so the ~30 announces elsewhere in
   * this suite keep the behaviour they were written against, and a new caller that forgets to name
   * its claimant loses the protection rather than the service.
   */
  it('allows a takeover when neither announce named an address', async () => {
    const harness = makeHarness();
    const { orch, published } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO), true, 'no evidence must not mean refused');
    await waitFor(() => hasFinalized(published), SETTLE_CEILING_MS);

    await orch.cleanup();
  });

  /**
   * The mirror of the case below, and not redundant with it. The comparison is written over two
   * operands and each has its own null check, so dropping either one leaves the other test passing:
   * with only the incumbent's check gone, `null !== BROADCASTER` reads as proof of a stranger, and
   * this is the only test that reaches it.
   */
  it('allows a takeover when only the newcomer was named', async () => {
    const harness = makeHarness();
    const { orch, published } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: null }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => hasFinalized(published), SETTLE_CEILING_MS);

    await orch.cleanup();
  });

  it('allows a takeover when only the incumbent was named', async () => {
    const harness = makeHarness();
    const { orch, published } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: null }), true);
    await waitFor(() => hasFinalized(published), SETTLE_CEILING_MS);

    await orch.cleanup();
  });

  /**
   * A recovered stream is one this process restored after its own restart, so nothing on record says
   * who was broadcasting it. That first announce cannot be judged and is not. What must not follow is
   * that the stream stays claimable for the rest of its life: the session that resumed it becomes the
   * incumbent, so the announce after it is judged like any other.
   */
  it('makes the session that resumed a recovered stream the incumbent', async () => {
    const clock = new FakeClock();
    const published: PublishedEntry[] = [];
    const orch = makeTestOrchestrator(
      { segmentStallMs: STALL_MS, recoveryTimeout: 60_000, clock },
      {},
      makeFakeRecoveryStore({
        listActive: () => [toRecoveryFileId(STREAM_ID)],
        load: () => makeRecoveredState(STREAM_ID),
      }),
      makeRecordingCatalog(published as unknown[]),
    );

    await orch.recoverStreams();
    assert.equal(orch.getActiveStreamCount(), 1, 'the recovered stream is waiting for its engine');

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }),
      true,
      'the announce that resumes a recovered stream has nothing to be judged against',
    );
    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      false,
      'the session that resumed it holds it, so the next announce is judged',
    );

    await orch.cleanup();
  });

  /**
   * A refused announce must leave nothing behind. The claimant record is written where the session is
   * spawned, so a refusal that still recorded the newcomer would hand them the id on their second
   * try, which turns one blocked attack into a two-request one.
   */
  it('does not record the refused claimant, so repeating the announce does not succeed', async () => {
    const harness = makeHarness();
    const { orch } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }), false);
    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      false,
      'a second attempt from the same stranger must be refused for the same reason as the first',
    );

    await orch.cleanup();
  });
});
