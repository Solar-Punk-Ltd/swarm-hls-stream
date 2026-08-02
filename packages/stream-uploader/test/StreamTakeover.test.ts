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
import { MEDIA_TYPE_VIDEO, REJECT_DRAINING, STREAM_STATUS_VOD, StreamState } from '../src/types.js';

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
   * otherwise be locked out of their own id until someone stopped it by hand. The window is
   * `segmentStallMs`, shared with `/health`, but it is applied to a different reading: see
   * `hasStalled` for why "a publisher is still there" and "segments are still being uploaded" are
   * not the same question.
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
   *
   * The incumbent takes the default rather than an explicit `{ address: null }`, which is the shape
   * `POST /stream/start` produces. That also puts `ANONYMOUS_CLAIMANT`'s own contents under test:
   * mutation found that replacing it with `{}` survived the whole suite, because `undefined` compares
   * equal to `undefined` and every other test here has it on both sides of the comparison. Against a
   * named newcomer it does not, and an operator-started stream would refuse the broadcaster.
   */
  it('allows a takeover when only the newcomer was named', async () => {
    const harness = makeHarness();
    const { orch, published } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO), true);
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
   * The window has to measure whether a publisher is still there, and a segment being *refused* is
   * still a publisher being there. `handleSegment` returns early for a duplicate and for a full
   * queue, both above the point where progress is recorded, so a broadcaster whose uploads are
   * backlogged or whose puller is re-serving the origin's window looks idle while still connected.
   * That is the worst possible moment to hand their id to whoever retries next, and it needs no
   * timing precision from the attacker: they retry, and the service's own degradation lets them in.
   */
  it('keeps the id with a publisher whose segments are arriving but being refused', async () => {
    const clock = new FakeClock();
    const harness = makeHarness(clock);
    const { orch } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    // Well past the window, with a duplicate arriving inside every one of its spans. A duplicate is
    // answered `accepted` and records no progress, which is exactly the shape the old reading missed.
    for (let elapsed = 0; elapsed < STALL_MS * 3; elapsed += STALL_MS / 2) {
      await clock.advance(STALL_MS / 2);
      assert.deepEqual(orch.handleSegment(STREAM_ID, 0, 2, Buffer.from('again')), { accepted: true });
    }

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      false,
      'segments still arriving means the publisher is still there, whatever the uploader did with them',
    );

    await orch.cleanup();
  });

  /**
   * The other direction, and the one that locked out a legitimate broadcaster. A draining session
   * has already stopped: `handleSegment` answers `draining` to anything it sends. Judging a takeover
   * against its last accepted segment refused the reconnecting broadcaster for up to the whole
   * window, while the object one method away agreed the session was over.
   */
  it('lets a new address take an id whose session is already draining', async () => {
    const harness = makeHarness();
    const { orch } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    const draining = orch.stopStream(STREAM_ID);
    assert.deepEqual(
      orch.handleSegment(STREAM_ID, 1, 2, Buffer.from('late')),
      { accepted: false, reason: REJECT_DRAINING },
      'the session has to actually be draining for this test to mean anything',
    );

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      true,
      'a session that has stopped is not holding the id, whatever its last accepted segment says',
    );

    await draining;
    await orch.cleanup();
  });

  /**
   * The stamp a session is registered with has to come from the injected clock, and "it is written"
   * is not the same assertion as "it is written in the right units". Deleting the write fails the
   * boundary test above; writing `Date.now()` instead did not, because every other stall test
   * overwrites the stamp with a segment before reading it.
   *
   * `systemClock.now()` is `performance.now()`, so the two differ by about 1.77e12. A stream
   * registered on the wall clock is never stalled by an injected one, and on the real clock the sign
   * runs the other way: a publisher that announces and then dies before its first segment would hold
   * the id against everyone for the life of the process.
   */
  it('measures a session that has sent nothing from the clock it was registered on', async () => {
    const clock = new FakeClock();
    const { orch } = makeHarness(clock);

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);

    await clock.advance(STALL_MS + 1);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      true,
      'a session that announced and then sent nothing must age out on the injected clock',
    );

    await orch.cleanup();
  });

  /**
   * Which claimant an accepted takeover records. Every other test here stops at the boolean, so
   * recording the *outgoing* session's claimant instead of the newcomer's survived the whole suite:
   * after any takeover the guard would protect the publisher who had just left, refusing the new
   * owner's next reconnect for a full window and letting the displaced one walk back in.
   */
  it('records the session that won a takeover, not the one it replaced', async () => {
    const clock = new FakeClock();
    const harness = makeHarness(clock);
    const { orch } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    // Setup, not the assertion: the stranger only gets in because the incumbent went quiet.
    await clock.advance(STALL_MS + 1);
    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 1);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }),
      false,
      'the session that was displaced must not still be the one the guard protects',
    );

    await orch.cleanup();
  });

  /**
   * A replacement registered under an id its predecessor was stopped on is live, and is protected.
   *
   * The sharper case is deliberately **not** claimed by this title: `hasStalled` matches the drain by
   * uploader identity rather than by stream id, which only matters while a predecessor's drain is
   * still in flight under an id a replacement already holds. Matching by id would call that live
   * replacement draining and hand it to anyone for up to `DRAIN_TIMEOUT_MS`. Replacing
   * `isDraining(streamId, uploader)` with `drainPromises.has(streamId)` still passes everything here,
   * and it is left uncovered rather than covered in name only: the drain settles through these fakes
   * before the assertion whatever is done to the upload, so the window cannot be held open from a
   * test at this level. `isDraining`'s own doc is the argument for the identity match.
   */
  it('protects a replacement registered under an id its predecessor was stopped on', async () => {
    const harness = makeHarness();
    const { orch } = harness;

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 0);

    void orch.stopStream(STREAM_ID);
    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
    await waitFor(() => orch.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
    await publishOneSegment(harness, 1);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      false,
      'the replacement is live and being fed, whatever its predecessor is doing under the same id',
    );

    await orch.cleanup();
  });

  function makeRecoveringHarness(clock: FakeClock): Harness {
    const published: PublishedEntry[] = [];
    const saved: StreamState[] = [];
    const orch = makeTestOrchestrator(
      { segmentStallMs: STALL_MS, recoveryTimeout: 60_000, clock },
      {},
      makeFakeRecoveryStore({
        listActive: () => [toRecoveryFileId(STREAM_ID)],
        load: () => makeRecoveredState(STREAM_ID),
        save: (_streamId: string, state: StreamState) => saved.push(state),
      }),
      makeRecordingCatalog(published as unknown[]),
    );
    return { orch, published, saved };
  }

  /**
   * The path production actually takes, and the one the first version of this file did not.
   *
   * A recovered stream is resumed by **segments**, not by an announce: OME's `resumeRecoveredStream`
   * restarts the puller with no admission behind it, and SRS's publish session never closed, so
   * neither engine calls `startStream` again. Nothing therefore records who owns it, and reading an
   * absent record as "nobody owns this" left the guard off for the whole remaining broadcast.
   *
   * Three separate lenses of the PR #65 gate found this, each from a different question.
   */
  it('refuses a stranger against a recovered stream that resumed by segments', async () => {
    const clock = new FakeClock();
    const harness = makeRecoveringHarness(clock);
    const { orch } = harness;

    await orch.recoverStreams();
    assert.equal(orch.getActiveStreamCount(), 1, 'the recovered stream is waiting for its engine');

    // Segments, and no announce. This is what cancels the recovery timer in production.
    await publishOneSegment(harness, 99);

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: STRANGER }),
      false,
      'an owner nobody recorded is unknown, not absent, and a live recovered stream is not free',
    );
    assert.equal(orch.getMetricsSnapshot().takeoversRefusedTotal, 1);

    await orch.cleanup();
  });

  /**
   * The cost of the rule above, stated so it cannot be lost. Nothing can identify the owner of a
   * recovered stream, so the real broadcaster reconnecting to one is a stranger by every test here
   * and waits out the stall window like any other. That is bounded and it only follows a restart.
   */
  it('lets a recovered stream be reclaimed once it stops being fed', async () => {
    const clock = new FakeClock();
    const harness = makeRecoveringHarness(clock);
    const { orch } = harness;

    await orch.recoverStreams();
    await publishOneSegment(harness, 99);
    await clock.advance(STALL_MS + 1);

    assert.equal(orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);

    await orch.cleanup();
  });

  /**
   * And once an announce does reach a recovered stream, that session becomes the incumbent, so the
   * announce after it is judged against a real address rather than against the unknown-owner rule.
   */
  it('makes the session that resumed a recovered stream the incumbent', async () => {
    const clock = new FakeClock();
    const { orch } = makeRecoveringHarness(clock);

    await orch.recoverStreams();
    assert.equal(orch.getActiveStreamCount(), 1, 'the recovered stream is waiting for its engine');

    assert.equal(
      orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }),
      true,
      'a recovered stream nothing has fed yet is inside no stall window',
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
