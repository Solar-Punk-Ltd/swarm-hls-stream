/**
 * One glued recording when the broadcast before it was ended by the **stall reaper**.
 *
 * ## Why this path and not the re-announce one
 *
 * `sharedFeedDrain.test.ts` and `AdminStreamSession.test.ts` already hold the handover where an
 * engine **re-announces**: `startStream` finds a live session under the id, retires it and spawns its
 * replacement in the same turn. That is the polite case, and it is not the one production mostly
 * takes. An engine that dies sends no `on_unpublish` and makes no second announce, so nothing at all
 * tells this service the broadcast is over — the only thing that ends it is `scheduleStallReap`
 * firing after `orphanReapMs` of silence (task #86). Whatever comes next on that topic comes after
 * the reaper's own `stopStream`, through a code path the glue tests had never been run down:
 *
 * - it is the **reaper** that hands the outgoing session's write completion to `trackSharedFeedWrites`,
 *   so the gate a successor waits on is registered from a timer handler rather than from an announce;
 * - a successor that announces after the drain has finished is an **ordinary fresh start** rather than
 *   a replacement, because the reaper's drain has already called `retireSession`, so it reaches
 *   `spawnUploader` through the branch none of the existing handover cases takes;
 * - a successor that announces while that drain is still running is the takeover branch again, but
 *   over a session the reaper gave up on rather than one the announce itself retired;
 * - and the head either of them reads is the recording the reaper published, which must be the
 *   recording and never the closing live window written one index below it.
 *
 * ## What each case pins
 *
 * 1. The reaper really is what ends A: nothing here calls `stopStream`, and `streams_reaped_total`
 *    counts the decision.
 * 2. B continues the numbering the reaper's recording left, with the seam declared on B's own first
 *    segment, so a viewer following the feed head is handed a media sequence that moves forwards.
 * 3. B's recording is A's recording verbatim, one `#EXT-X-DISCONTINUITY`, then B's own media, and the
 *    length reported for it is the whole broadcast rather than B's share.
 * 4. The same, for a **ladder rung**, whose topic is derived rather than declared and is therefore
 *    stable across the two sessions for a different reason.
 * 5. And the race: B announced while the reaper's recording write is still in flight publishes
 *    nothing and reads no head until that write lands, then inherits the recording.
 *
 * ## What these deliberately do not cover
 *
 * - **Timings.** Every clock here is a `FakeClock` stepped by the case. Nothing asserts how long a
 *   reap, a drain or a publish took; see the e2e rule in `AGENTS.md`.
 * - **Recovery across a process restart.** A session rebuilt from a recovery entry re-applies its
 *   inherited prefix off disk rather than off the feed, which is `FinalizeResume.test.ts`.
 * - **The master playlist.** A rung here publishes its own feed; what the admin folds four rungs into
 *   is `AdminLadderRegistry.test.ts`.
 * - **More than two sessions.** Chaining is `ManifestManager`'s and is held there; this file is about
 *   the handover the reaper opens.
 */

import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import {
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStateReport,
  STATE_REPORT_ACCEPTED,
} from '../src/libs/AdminApiClient.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_AUDIO } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { FakeFeedHead, makeTestOrchestrator } from './helpers/fakes.js';
import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

/** The silence a broadcast may go quiet for before the reaper ends it. Short, since the clock is fake. */
const REAP_MS = 60_000;

/** A ceiling on a hung wait, not a measurement. The same constant and reason as in `StreamReaper.test.ts`. */
const SETTLE_CEILING_MS = 4_000;

/** Long enough for a held publish to have escaped, short enough that a case meant to reach it stays cheap. */
const QUIET_WINDOW_MS = 60;

/** What each test segment declares, so the arithmetic in an assertion is legible. */
const SEGMENT_SECONDS = 2;

const DECLARATION: AdminSession = { id: 'admin-stream-id', topic: 'declared-topic-0001' };
const SINGLE_STREAM_ID = 'audio/declared-stream';
const RUNG_NAME = '360p';
const RUNG_STREAM_ID = `audio/ladder-stream_${RUNG_NAME}`;

const VOD_TAG = '#EXT-X-PLAYLIST-TYPE:VOD';
const DISCONTINUITY_TAG = '#EXT-X-DISCONTINUITY';
const ENDLIST_TAG = '#EXT-X-ENDLIST';
const MEDIA_SEQUENCE_TAG = '#EXT-X-MEDIA-SEQUENCE';

/** The media the first broadcast publishes, and the second. Labelled so a playlist names its source. */
const A_SEGMENTS = ['a0', 'a1', 'a2'];
const B_SEGMENTS = ['b0', 'b1'];

/** One SOC write the uploader made, and the feed it made it to. */
interface ManifestWrite {
  index: number;
  playlist: string;
  topic: string;
}

/** One promise a test controls without exposing its resolver before construction. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface GlueHarness {
  orchestrator: StreamOrchestrator;
  clock: FakeClock;
  streamId: string;
  /** Every manifest write, in order, across every topic. */
  writes: ManifestWrite[];
  /**
   * Every head the fake feed was asked for, in order, so a case can say WHICH playlist a session read
   * rather than only that it read one.
   *
   * ⚠️ One answered head read is **two** entries here. `StreamUploader.readManifestFeedHead` asks
   * without an index for the position and then again at that index for the payload, because bee-js
   * only rejoins an over-sized payload on the indexed path. A read that 404s is one entry, since the
   * empty-feed answer returns before the second call.
   */
  headsRead: (FakeFeedHead | null)[];
  /** Every length the admin was told a finished recording plays for, in order. */
  reportedRecordingSeconds: number[];
  start: () => void;
  /** Hand one segment to the orchestrator and wait for its bytes to reach the fake bee. */
  segment: (label: string, index: number) => Promise<void>;
  /** Wait for a published playlist that names this segment. */
  published: (label: string) => Promise<void>;
  /** Advance past the reap window and wait for the reaper to have decided. Nothing calls `stopStream`. */
  reap: () => Promise<void>;
  /** Whether the held recording write has been entered, so a case knows the gate is really armed. */
  recordingWriteStarted: () => boolean;
  /** Let the held recording write complete. Safe to call when nothing is held. */
  releaseRecording: () => void;
}

/**
 * A declared stream in admin mode, optionally as one rung of a ladder, over a fake bee that keeps one
 * feed per topic.
 *
 * ⛔ The per-topic feed is what makes the inheritance assertions mean anything. A fake with one feed
 * for every topic answers B's head read with A's recording whether or not the two are really on one
 * topic, and "the two sessions land on one topic" is the whole of what a declared topic and a derived
 * rung topic buy. See `topicKey` in `helpers/fakes.ts`.
 */
function glueHarness(options: { blockRecording?: boolean; ladder?: boolean } = {}): GlueHarness {
  const clock = new FakeClock();
  const writes: ManifestWrite[] = [];
  const headsRead: (FakeFeedHead | null)[] = [];
  const uploadedSegments: string[] = [];
  const reportedRecordingSeconds: number[] = [];
  const feeds = new Map<string, FakeFeedHead>();
  const heldRecording = deferred();
  const streamId = options.ladder ? RUNG_STREAM_ID : SINGLE_STREAM_ID;
  let blockRecording = options.blockRecording === true;
  let recordingWriteStarted = false;

  const adminApi = {
    describe: () => 'http://admin.test',
    reportState: async (_id: string, report: AdminStateReport) => {
      if (report.state === ADMIN_STATE_VOD) {
        reportedRecordingSeconds.push(report.duration);
      }
      return STATE_REPORT_ACCEPTED;
    },
  } as unknown as AdminApiClient;

  const orchestrator = makeTestOrchestrator(
    {
      adminApi,
      clock,
      orphanReapMs: REAP_MS,
      ...(options.ladder ? { ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC) } : {}),
    },
    {
      uploadData: async (_stamp, data) => {
        const label = Buffer.from(data).toString('utf8');
        uploadedSegments.push(label);
        return { reference: { toHex: () => `segment-${label}` } };
      },
      feedHead: (topic) => {
        const head = feeds.get(topic) ?? null;
        headsRead.push(head);
        return head;
      },
      uploadPayload: async (index, payload, topic) => {
        const playlist = String(payload);
        // Held at the recording and not at the closing playlist, so the head a successor would read
        // ungated is the closing live window one index below the recording — which is exactly the
        // wrong one, and exactly what the gate exists to stop it reading.
        if (blockRecording && playlist.includes(VOD_TAG)) {
          blockRecording = false;
          recordingWriteStarted = true;
          await heldRecording.promise;
        }
        writes.push({ index, playlist, topic });
        // The head moves only once a write has completed, which is the whole of what the gate is
        // about: a reader that gets in first reads the playlist before this one.
        feeds.set(topic, { index, manifest: playlist });
        return { reference: { toHex: () => `soc-${index}` } };
      },
    },
  );

  return {
    orchestrator,
    clock,
    streamId,
    writes,
    headsRead,
    reportedRecordingSeconds,
    start: () => {
      assert.equal(
        orchestrator.startStream(streamId, MEDIA_TYPE_AUDIO, undefined, DECLARATION),
        true,
        'the declared session must be admitted',
      );
    },
    segment: async (label, index) => {
      assert.deepEqual(orchestrator.handleSegment(streamId, index, SEGMENT_SECONDS, Buffer.from(label)), {
        accepted: true,
      });
      await waitFor(() => uploadedSegments.includes(label), SETTLE_CEILING_MS);
    },
    published: async (label) => {
      await waitFor(() => writesNaming(writes, label).length > 0, SETTLE_CEILING_MS);
    },
    reap: async () => {
      const decidedBefore = orchestrator.getMetricsSnapshot().streamsReapedTotal;
      // The engine dies here. Nothing calls stopStream, because nothing knows.
      await clock.advance(REAP_MS + 1);
      await waitFor(() => orchestrator.getMetricsSnapshot().streamsReapedTotal > decidedBefore, SETTLE_CEILING_MS);
    },
    recordingWriteStarted: () => recordingWriteStarted,
    releaseRecording: heldRecording.resolve,
  };
}

function writesNaming(writes: readonly ManifestWrite[], label: string): ManifestWrite[] {
  return writes.filter((write) => write.playlist.includes(`segment-${label}`));
}

function recordings(writes: readonly ManifestWrite[]): ManifestWrite[] {
  return writes.filter((write) => write.playlist.includes(VOD_TAG));
}

/**
 * Whole `#EXT-X-DISCONTINUITY` lines, which is not what a substring count answers: the header tag
 * `#EXT-X-DISCONTINUITY-SEQUENCE` starts with the same characters.
 */
function seamCount(playlist: string): number {
  return playlist.split('\n').filter((line) => line.trim() === DISCONTINUITY_TAG).length;
}

function mediaSequenceOf(playlist: string): number {
  const declared = new RegExp(`^${MEDIA_SEQUENCE_TAG}:(\\d+)$`, 'm').exec(playlist);
  assert.ok(declared, `every playlist this service publishes declares ${MEDIA_SEQUENCE_TAG}`);
  return Number(declared[1]);
}

/** How many entries a playlist lists, counted the way `continuesFrom` counts them: one `#EXTINF` each. */
function entryCount(playlist: string): number {
  return playlist.split('\n').filter((line) => line.startsWith('#EXTINF:')).length;
}

/**
 * A recording's media, as bytes: everything between the blank line that ends its header block and its
 * `#EXT-X-ENDLIST`.
 *
 * Read out of the playlist by hand rather than through `inheritedTimeline`, so that the expectation a
 * case checks is not built by the same function the behaviour under test used to build it.
 */
function recordedMediaOf(recording: string): string {
  const headersEnd = recording.indexOf('\n\n');
  const endList = recording.indexOf(ENDLIST_TAG);
  assert.ok(headersEnd !== -1, 'a playlist separates its header block from its media with a blank line');
  assert.ok(endList > headersEnd, 'a recording ends its playlist');
  return recording.slice(headersEnd + 2, endList);
}

/**
 * Wait until a live manifest publish has been refused, which is how the hold is visible from outside.
 *
 * `settleFeedPosition` answers a held session by refusing and `commitManifest` refuses the playlist
 * that was built before it, and the caller counts either as a failed manifest publish — the same
 * counter a Bee outage moves, because from the stream's point of view both are a playlist that did
 * not reach the feed. Nothing else in these cases fails a publish, so the first one is the hold.
 *
 * Counted from zero rather than from a reading taken here, because a refusal that had already
 * happened would otherwise leave this waiting for a second one, and a held publish is re-attempted
 * at the next segment rather than on a timer.
 */
async function refusedAPublish(harness: GlueHarness): Promise<void> {
  await waitFor(() => harness.orchestrator.getMetricsSnapshot().manifestPublishFailuresTotal > 0, SETTLE_CEILING_MS);
}

interface GluedScenario {
  harness: GlueHarness;
  /** The recording the reaper published for the first broadcast. */
  aRecording: ManifestWrite;
  /** The first live playlist the second broadcast published, which a viewer is handed next. */
  bFirstLive: ManifestWrite;
}

/**
 * The whole path: a broadcast fed and then abandoned, ended by the reaper, and a second broadcast
 * announced afterwards on the same declared or derived topic and fed in its turn.
 *
 * Deliberately no `stopStream` anywhere. The only thing that ends the first broadcast is the timer.
 */
async function reapedThenSucceeded(harness: GlueHarness): Promise<GluedScenario> {
  harness.start();
  for (const [index, label] of A_SEGMENTS.entries()) {
    await harness.segment(label, index);
  }
  await harness.published(A_SEGMENTS[A_SEGMENTS.length - 1]);

  await harness.reap();
  await waitFor(() => recordings(harness.writes).length === 1, SETTLE_CEILING_MS);
  // The drain is over only once the id has left the live maps, and that is also when the shared-feed
  // entry the successor would have waited on has been cleared. Waiting for it keeps this helper's
  // successor an ordinary fresh start rather than a sometimes-gated one.
  await waitFor(() => harness.orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

  harness.start();
  for (const [index, label] of B_SEGMENTS.entries()) {
    await harness.segment(label, index);
  }
  await harness.published(B_SEGMENTS[B_SEGMENTS.length - 1]);

  return {
    harness,
    aRecording: recordings(harness.writes)[0],
    bFirstLive: writesNaming(harness.writes, B_SEGMENTS[0])[0],
  };
}

describe('a broadcast the stall reaper ended, and the one that follows it on the same feed', () => {
  it('ends the first broadcast from the reaper alone, with no stop and no re-announce', async () => {
    const harness = glueHarness();

    harness.start();
    await harness.segment(A_SEGMENTS[0], 0);
    await harness.published(A_SEGMENTS[0]);
    assert.equal(harness.orchestrator.getActiveStreamCount(), 1, 'the broadcast is live before the engine dies');

    await harness.reap();
    await waitFor(() => recordings(harness.writes).length === 1, SETTLE_CEILING_MS);

    const snapshot = harness.orchestrator.getMetricsSnapshot();
    assert.equal(snapshot.streamsReapedTotal, 1, 'the reaper is what decided this broadcast was over');
    assert.equal(snapshot.streamsFinalizedTotal, 1, 'and its finalize published the recording');
    // Two writes close the broadcast and their order is the product decision: the closing live
    // playlist ends the playlist a viewer is already on, and the recording renumbers from zero one
    // index above it. A successor reading the lower of the two is the defect the gate prevents.
    const closing = harness.writes.at(-2);
    const recording = harness.writes.at(-1);
    assert.ok(closing && recording);
    assert.equal(closing.playlist.includes(VOD_TAG), false, 'the closing playlist is not the recording');
    assert.ok(closing.playlist.trimEnd().endsWith(ENDLIST_TAG), 'it ends the live playlist');
    assert.equal(recording.index, closing.index + 1, 'and the recording sits one index above it');
  });

  it('numbers the successor′s live playlist on from the recording the reaper left, and seams it', async () => {
    const { harness, aRecording, bFirstLive } = await reapedThenSucceeded(glueHarness());

    assert.ok(bFirstLive.index > aRecording.index, 'the successor must publish above the reaper′s recording');
    assert.equal(
      mediaSequenceOf(bFirstLive.playlist),
      mediaSequenceOf(aRecording.playlist) + entryCount(aRecording.playlist),
      'a media sequence that moved backwards is what hls.js reports as a fatal parsing error',
    );
    assert.equal(seamCount(bFirstLive.playlist), 1, 'the join between the two broadcasts is declared once');

    // And it is declared on the successor′s own first segment rather than anywhere else in the window.
    const lines = bFirstLive.playlist.split('\n').map((line) => line.trim());
    const seamAt = lines.indexOf(DISCONTINUITY_TAG);
    assert.equal(
      lines.slice(seamAt).find((line) => line.startsWith('segment-')),
      `segment-${B_SEGMENTS[0]}`,
      'the break belongs in front of the first media this session produced',
    );
    assert.equal(
      harness.writes.every((write) => write.topic === harness.writes[0].topic),
      true,
      'both broadcasts published to one feed, which is the whole reason either of them had to resume',
    );
  });

  it('finalizes the successor as one recording carrying both broadcasts', async () => {
    const { harness, aRecording } = await reapedThenSucceeded(glueHarness());

    await harness.orchestrator.stopStream(harness.streamId);
    await waitFor(() => recordings(harness.writes).length === 2, SETTLE_CEILING_MS);

    const bRecording = recordings(harness.writes)[1].playlist;
    assert.ok(
      bRecording.includes(`${recordedMediaOf(aRecording.playlist)}${DISCONTINUITY_TAG}\n`),
      'the earlier recording′s entries go in verbatim, and the seam directly after them',
    );
    assert.equal(seamCount(bRecording), 1, 'one join between the two broadcasts, never two');
    assert.equal(
      entryCount(bRecording),
      A_SEGMENTS.length + B_SEGMENTS.length,
      'every segment of both broadcasts is named, and none of them twice',
    );
    assert.equal(
      mediaSequenceOf(bRecording),
      mediaSequenceOf(aRecording.playlist),
      'the recording starts where the broadcast started, not where this session joined it',
    );
    assert.ok(bRecording.trimEnd().endsWith(ENDLIST_TAG), 'and it is a finished playlist');

    const uris = bRecording
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('segment-'));
    assert.deepEqual(
      uris,
      [...A_SEGMENTS, ...B_SEGMENTS].map((label) => `segment-${label}`),
      'in the order the broadcast played',
    );
  });

  it('reports the whole broadcast′s length for the glued recording', async () => {
    const harness = glueHarness();
    await reapedThenSucceeded(harness);

    await harness.orchestrator.stopStream(harness.streamId);
    await waitFor(() => harness.reportedRecordingSeconds.length === 2, SETTLE_CEILING_MS);

    const [reaped, glued] = harness.reportedRecordingSeconds;
    assert.equal(reaped, A_SEGMENTS.length * SEGMENT_SECONDS, 'the reaper reported the broadcast it ended');
    assert.equal(
      glued,
      reaped + B_SEGMENTS.length * SEGMENT_SECONDS,
      'and the glued recording is reported as both, since that is what a viewer is handed',
    );
  });

  /**
   * The head the successor read has to be the recording and not the closing live window one index
   * below it. Here that is true because the reaper′s drain finished before the successor announced;
   * the case that holds it under a drain still running is at the bottom of this file.
   */
  it('resumes from the recording at the head rather than from anything earlier in the feed', async () => {
    const { harness, aRecording } = await reapedThenSucceeded(glueHarness());

    const answered = harness.headsRead.filter((head): head is FakeFeedHead => head !== null);
    assert.ok(answered.length > 0, 'the successor read the head of the feed it was continuing');
    assert.deepEqual(
      answered.at(-1),
      { index: aRecording.index, manifest: aRecording.playlist },
      'the playlist it resumed from is the recording the reaper published',
    );
    // The first broadcast′s own read is the other one, and it is what a declared topic nothing has
    // published on answers: 404, which `FEED_HEAD_ON_START` treats as the answer rather than a
    // failure. It is one entry rather than two because the payload is never asked for.
    assert.equal(harness.headsRead[0], null, 'the first broadcast opened on an empty feed');
    assert.equal(
      harness.headsRead.length,
      3,
      'one 404 for the first broadcast and one answered read for the second, which latches it: a ' +
        'session that asked the feed again would be paying a retrieval per segment for an answer it holds',
    );
  });

  /**
   * The same handover on the arm production actually takes now: the encoder disconnected, its
   * `on_unpublish` reported that and ended nothing, and nothing came back inside the window.
   *
   * ⛔ **A disconnect must reach the reaper's own path rather than a shorter one.** It ends nothing
   * itself, so what finalizes the broadcast is the same timer that finalizes one whose engine died —
   * and the glue on the far side of it has to be identical, since a viewer cannot tell the two
   * apart. A build that finalized on the webhook would pass every other case in this file and fail
   * here, because its recording would land a whole window earlier than the reap this waits for.
   */
  it('glues onto a recording the reaper published after the encoder disconnected', async () => {
    const harness = glueHarness();

    harness.start();
    for (const [index, label] of A_SEGMENTS.entries()) {
      await harness.segment(label, index);
    }
    await harness.published(A_SEGMENTS[A_SEGMENTS.length - 1]);

    harness.orchestrator.noteDisconnect(SINGLE_STREAM_ID);
    await waitAndConfirmNothingHappened(() => recordings(harness.writes).length === 0, QUIET_WINDOW_MS);

    await harness.reap();
    await waitFor(() => recordings(harness.writes).length === 1, SETTLE_CEILING_MS);
    await waitFor(() => harness.orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);

    // The encoder comes back, too late. That is a new broadcast, and it opens with the one before it.
    harness.start();
    for (const [index, label] of B_SEGMENTS.entries()) {
      await harness.segment(label, index);
    }
    await harness.published(B_SEGMENTS[B_SEGMENTS.length - 1]);

    const aRecording = recordings(harness.writes)[0];
    const bFirstLive = writesNaming(harness.writes, B_SEGMENTS[0])[0];
    assert.equal(
      mediaSequenceOf(bFirstLive.playlist),
      mediaSequenceOf(aRecording.playlist) + entryCount(aRecording.playlist),
      'the returning broadcast numbered over the recording the reaper left',
    );
    assert.equal(seamCount(bFirstLive.playlist), 1, 'with the join declared once');

    await harness.orchestrator.stopStream(harness.streamId);
    await waitFor(() => recordings(harness.writes).length === 2, SETTLE_CEILING_MS);
    assert.ok(
      recordings(harness.writes)[1].playlist.includes(`${recordedMediaOf(aRecording.playlist)}${DISCONTINUITY_TAG}\n`),
      'and the recording at the feed head carries both broadcasts, oldest first',
    );
  });

  /**
   * ⛔ A rung′s topic is derived from its ladder group and its rung name rather than declared, so it
   * is stable across the two sessions for a different reason from the single declared stream above —
   * and the reaper releases the ladder on its way out, so the successor derives the topic again from
   * the declaration rather than finding it remembered. Same glue, different route to one topic.
   */
  it('glues a ladder rung whose topic is derived rather than declared', async () => {
    const harness = glueHarness({ ladder: true });
    const { aRecording, bFirstLive } = await reapedThenSucceeded(harness);

    assert.equal(
      harness.writes.every((write) => write.topic === harness.writes[0].topic),
      true,
      'the rung came back onto the feed it was already publishing, which is what deriving the topic buys',
    );
    assert.notEqual(
      harness.writes[0].topic,
      Topic.fromString(DECLARATION.topic).toHex(),
      'and that feed is the rung′s own, never the declared topic, which is where the master lives',
    );
    assert.ok(bFirstLive.index > aRecording.index, 'the second session continues the feed rather than writing over it');
    assert.equal(seamCount(bFirstLive.playlist), 1, 'with the restart declared as a break');

    await harness.orchestrator.stopStream(harness.streamId);
    await waitFor(() => recordings(harness.writes).length === 2, SETTLE_CEILING_MS);

    const bRecording = recordings(harness.writes)[1].playlist;
    assert.ok(
      bRecording.includes(`${recordedMediaOf(aRecording.playlist)}${DISCONTINUITY_TAG}\n`),
      'so the recording at this rung′s feed head carries both of its sessions',
    );
    assert.equal(entryCount(bRecording), A_SEGMENTS.length + B_SEGMENTS.length);
  });

  /**
   * ⛔⛔ The race, on the reaper′s drain rather than on a re-announce′s.
   *
   * `sharedFeedDrain.test.ts` holds this shape where the drain was started **by** the second
   * announce. Here the reaper started it first, from a timer handler with no announce anywhere near
   * it, and the announce arrives into a drain that is already running: the id is still in
   * `activeStreams` for the length of that drain, so `startStream` takes its takeover branch and
   * retires a session the reaper had already given up on. That is an ordinary production sequence —
   * SRS reconnecting a publisher after the reaper has fired but while Bee is still writing the
   * recording — and it is the one the glue had never been run down. `trackSharedFeedWrites` is the
   * same call either way; nothing about the gate should depend on which caller reached it, and this
   * is what says so.
   *
   * The successor must publish nothing and, more sharply, must **not read the head at all**:
   * `settleFeedPosition` refuses ahead of `resumeFeedIndex`, so a read that happened would prove the
   * refusal had been passed. At this moment the head is the closing live window, one index below the
   * recording still in flight, and a successor that latched it would choose the recording′s own next
   * index for its live playlists.
   */
  it('holds a successor announced while the reaper′s recording write is still in flight', async () => {
    const harness = glueHarness({ blockRecording: true });
    try {
      harness.start();
      await harness.segment(A_SEGMENTS[0], 0);
      await harness.published(A_SEGMENTS[0]);

      await harness.reap();
      await waitFor(harness.recordingWriteStarted, SETTLE_CEILING_MS);
      assert.equal(
        recordings(harness.writes).length,
        0,
        'the recording has not landed, so the head is still the closing live window',
      );

      harness.start();
      const readsBefore = harness.headsRead.length;
      const writesBefore = harness.writes.length;
      await harness.segment(B_SEGMENTS[0], 0);

      // Waited for rather than assumed, so this case is about a publish that was **refused** rather
      // than about one that had not been attempted yet. Without it a successor that published
      // perfectly happily could still satisfy the quiet window below, just by being slower than it.
      await refusedAPublish(harness);

      await waitAndConfirmNothingHappened(
        () => harness.headsRead.length === readsBefore && harness.writes.length === writesBefore,
        QUIET_WINDOW_MS,
      );
    } finally {
      harness.releaseRecording();
    }
  });

  it('lets the held successor inherit the recording once that write lands, never the closing window', async () => {
    const harness = glueHarness({ blockRecording: true });
    try {
      harness.start();
      await harness.segment(A_SEGMENTS[0], 0);
      await harness.published(A_SEGMENTS[0]);

      await harness.reap();
      await waitFor(harness.recordingWriteStarted, SETTLE_CEILING_MS);

      harness.start();
      await harness.segment(B_SEGMENTS[0], 0);
      // The release below has to come after the refusal, or this case would be about a successor that
      // simply had not got to its head read yet rather than about one that was held back from it.
      await refusedAPublish(harness);

      const closing = harness.writes.at(-1);
      assert.ok(closing && !closing.playlist.includes(VOD_TAG), 'the closing live window is what is at the head');

      harness.releaseRecording();
      await waitFor(() => recordings(harness.writes).length === 1, SETTLE_CEILING_MS);

      // A publish is re-attempted at the next segment rather than retried on a timer, so the held
      // session needs one more segment before it says anything. The first is not lost: it is in the
      // playlist that follows, behind the seam.
      await harness.segment(B_SEGMENTS[1], 1);
      await harness.published(B_SEGMENTS[0]);

      const aRecording = recordings(harness.writes)[0];
      const bFirstLive = writesNaming(harness.writes, B_SEGMENTS[0])[0];
      assert.ok(
        bFirstLive.index > aRecording.index,
        'the successor publishes above the recording rather than claiming its index',
      );

      const answered = harness.headsRead.filter((head): head is FakeFeedHead => head !== null);
      assert.deepEqual(
        answered.at(-1),
        { index: aRecording.index, manifest: aRecording.playlist },
        'and the playlist it read was the recording, not the closing window it would have found earlier',
      );
      assert.equal(
        answered.some((head) => !head.manifest.includes(VOD_TAG)),
        false,
        'no read of this feed was ever answered with the closing live window',
      );
      assert.equal(
        mediaSequenceOf(bFirstLive.playlist),
        mediaSequenceOf(aRecording.playlist) + entryCount(aRecording.playlist),
        'so its numbering carries on from the recording',
      );
      assert.equal(seamCount(bFirstLive.playlist), 1);
    } finally {
      harness.releaseRecording();
    }
  });
});
