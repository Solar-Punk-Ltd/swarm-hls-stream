/**
 * An encoder that goes away and comes back inside the reap window keeps its broadcast.
 *
 * ## What the owner asked for, and what used to happen
 *
 * Cases 1 and 2 of `~/Documents/test-cases.md`: OBS stopped and restarted ten seconds later, and a
 * network outage of fifty seconds, are both "the same recording continues, with a discontinuity at
 * the seam and no `#EXT-X-ENDLIST` in between". What happened instead, measured live on 2026-09-22
 * against SRS 6.0.184, is that SRS ends the publish within seconds of ANY interruption — immediately
 * on a clean stop, under five seconds on a torn-down socket, under fifteen on a frozen one — and the
 * uploader answered that webhook with `stopStream`. The recording was sealed one or two seconds into
 * a gap the broadcaster was about to close, and the return opened a second one.
 *
 * ## The shape of the fix these cases pin
 *
 * `on_unpublish` reports a disconnect and ends nothing. What ends a broadcast is what always ended
 * one the engine never said anything about: `ORPHAN_REAP_MS` with no media in it. An `on_publish`
 * inside that window resumes the SAME session rather than replacing it.
 *
 * ⛔ **The half that cannot be inferred from the media, and so is the half most worth pinning.**
 * SRS keeps a source and its HLS muxer alive for `hls_dispose x 1.1` after an unpublish, so an
 * encoder returning inside sixty seconds is usually served by the same muxer and its index simply
 * carries on. `ManifestManager.placeInBroadcast`'s restart detection therefore sees nothing at all,
 * and without something telling it, the playlist would say a fifty second hole is continuous media.
 * Every case below that reads a seam is run twice for that reason: once with the index continuing
 * and once with it restarting at zero.
 *
 * ## What is deliberately not here
 *
 * - **Timings.** Every clock is injected and stepped. Nothing asserts how long anything took; see
 *   the e2e rule in `AGENTS.md`.
 * - **Reaping.** That a broadcast nothing feeds ends at the window is `StreamReaper.test.ts`, which
 *   carries the disconnect arm of it, and the recording the next one inherits is `GlueAfterReap.test.ts`.
 * - **Who may announce.** The refusal rules are unchanged and are held in `StreamTakeover.test.ts`;
 *   the one case here is that a stranger is refused during the window exactly as before.
 */

import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSrsEngine } from '../src/engines/srs.js';
import { SRS_WEBHOOK_TOKEN_PARAM } from '../src/engines/srs/webhookToken.js';
import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import {
  ADMIN_STATE_LIVE,
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStateReport,
  STATE_REPORT_ACCEPTED,
} from '../src/libs/AdminApiClient.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_AUDIO, StreamState } from '../src/types.js';

import { FakeClock } from './helpers/fakeClock.js';
import { FakeFeedHead, makeFakeRecoveryStore, makeTestOrchestrator, TEST_ANCHOR } from './helpers/fakes.js';
import { listenOnLoopback } from './helpers/loopbackServer.js';
import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

/** The silence a broadcast may go quiet for before the reaper ends it. Stepped, never waited for. */
const REAP_MS = 60_000;

/** A ceiling on a hung wait, not a measurement. The same constant and reason as in `StreamReaper.test.ts`. */
const SETTLE_CEILING_MS = 4_000;

/** Long enough for a publish to have escaped, short enough that a case meant to reach it stays cheap. */
const QUIET_WINDOW_MS = 60;

/** What each test segment declares, so the arithmetic in an assertion is legible. */
const SEGMENT_SECONDS = 2;

/** The gap a returning encoder is away for. Inside the window, and nothing about it is asserted. */
const OUTAGE_MS = 50_000;

const DECLARATION: AdminSession = { id: 'admin-stream-id', topic: 'declared-topic-0001' };
const STREAM_ID = 'audio/declared-stream';
const RUNG_NAMES = ['360p', '480p', '720p', '1080p'] as const;
const LADDER_BASE = 'audio/ladder-stream';

const VOD_TAG = '#EXT-X-PLAYLIST-TYPE:VOD';
const DISCONTINUITY_TAG = '#EXT-X-DISCONTINUITY';
const ENDLIST_TAG = '#EXT-X-ENDLIST';
const GAP_TAG = '#EXT-X-GAP';
const MEDIA_SEQUENCE_TAG = '#EXT-X-MEDIA-SEQUENCE';
const PROGRAM_DATE_TIME_TAG = '#EXT-X-PROGRAM-DATE-TIME';

/** One SOC write the uploader made, and the feed it made it to. */
interface ManifestWrite {
  index: number;
  playlist: string;
  topic: string;
}

interface ReconnectHarness {
  orchestrator: StreamOrchestrator;
  /** The monotonic clock the reaper runs on. */
  clock: FakeClock;
  /** Every manifest write, in order, across every topic. */
  writes: ManifestWrite[];
  /** Every state the admin was told, in order, so a gap that reported `vod` is visible. */
  adminStates: string[];
  /** Every recovery entry written, in order, which is what a crash would be recovered from. */
  saved: StreamState[];
  /** Announce a stream, asserting it was admitted. */
  start: (streamId?: string) => void;
  /** Announce a stream and report the verdict instead of asserting it. */
  announce: (streamId: string, claimant?: { address: string | null; isAuthenticated?: boolean }) => boolean;
  /** Hand one segment over and wait for its bytes to reach the fake bee. */
  segment: (label: string, index: number, streamId?: string) => Promise<void>;
  /**
   * Wait for a published playlist that names this segment.
   *
   * ⛔ Separate from {@link ReconnectHarness.segment} because the manifest publish is queued behind
   * the upload rather than part of it. A case that read `writes` straight after handing a segment
   * over was reading the feed before the playlist naming it had been written.
   */
  published: (label: string) => Promise<void>;
  /** Move both clocks together, which is what an outage does. */
  passTime: (ms: number) => Promise<void>;
}

/**
 * A declared stream in admin mode, optionally as a ladder, over a fake bee with one feed per topic.
 *
 * ⛔ **Two clocks, moved together by {@link ReconnectHarness.passTime}, because they answer different
 * questions and a case that moved one would prove nothing.** The injected `clock` is monotonic and is
 * what the reap window is measured on. `wallClock` is the date a playlist carries, and the whole of
 * what a re-anchored `#EXT-X-PROGRAM-DATE-TIME` is read against — `StreamOrchestratorConfig.wallClock`
 * exists precisely because the two must not be the same reading.
 */
function reconnectHarness(options: { ladder?: boolean } = {}): ReconnectHarness {
  const clock = new FakeClock();
  let wallMs = TEST_ANCHOR.startedAtMs;
  const writes: ManifestWrite[] = [];
  const adminStates: string[] = [];
  const saved: StreamState[] = [];
  const uploadedSegments: string[] = [];
  const feeds = new Map<string, FakeFeedHead>();

  const adminApi = {
    describe: () => 'http://admin.test',
    reportState: async (_id: string, report: AdminStateReport) => {
      adminStates.push(report.state);
      return STATE_REPORT_ACCEPTED;
    },
  } as unknown as AdminApiClient;

  const orchestrator = makeTestOrchestrator(
    {
      adminApi,
      clock,
      wallClock: () => wallMs,
      orphanReapMs: REAP_MS,
      ...(options.ladder ? { ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC) } : {}),
    },
    {
      uploadData: async (_stamp, data) => {
        const label = Buffer.from(data).toString('utf8');
        uploadedSegments.push(label);
        return { reference: { toHex: () => `segment-${label}` } };
      },
      feedHead: (topic) => feeds.get(topic) ?? null,
      uploadPayload: async (index, payload, topic) => {
        const playlist = String(payload);
        writes.push({ index, playlist, topic });
        feeds.set(topic, { index, manifest: playlist });
        return { reference: { toHex: () => `soc-${index}` } };
      },
    },
    makeFakeRecoveryStore({ save: (_streamId: string, state: StreamState) => saved.push(state) }),
  );

  return {
    orchestrator,
    clock,
    writes,
    adminStates,
    saved,
    start: (streamId = STREAM_ID) => {
      assert.equal(
        orchestrator.startStream(streamId, MEDIA_TYPE_AUDIO, undefined, DECLARATION),
        true,
        `the declared session ${streamId} must be admitted`,
      );
    },
    announce: (streamId, claimant) =>
      orchestrator.startStream(
        streamId,
        MEDIA_TYPE_AUDIO,
        claimant === undefined ? undefined : { address: claimant.address, isAuthenticated: claimant.isAuthenticated },
        DECLARATION,
      ),
    segment: async (label, index, streamId = STREAM_ID) => {
      assert.deepEqual(
        orchestrator.handleSegment(streamId, index, SEGMENT_SECONDS, Buffer.from(label)),
        { accepted: true },
        `segment ${label} must be taken`,
      );
      await waitFor(() => uploadedSegments.includes(label), SETTLE_CEILING_MS);
    },
    published: async (label) => {
      await waitFor(() => writesNaming(writes, label).length > 0, SETTLE_CEILING_MS);
    },
    passTime: async (ms) => {
      wallMs += ms;
      await clock.advance(ms);
    },
  };
}

function recordings(writes: readonly ManifestWrite[]): ManifestWrite[] {
  return writes.filter((write) => write.playlist.includes(VOD_TAG));
}

function closingPlaylists(writes: readonly ManifestWrite[]): ManifestWrite[] {
  return writes.filter((write) => !write.playlist.includes(VOD_TAG) && write.playlist.includes(ENDLIST_TAG));
}

function writesNaming(writes: readonly ManifestWrite[], label: string): ManifestWrite[] {
  return writes.filter((write) => write.playlist.includes(`segment-${label}`));
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

/** The `#EXT-X-PROGRAM-DATE-TIME` immediately in front of the entry naming this segment. */
function dateOfSegment(playlist: string, label: string): string {
  const lines = playlist.split('\n').map((line) => line.trim());
  const at = lines.indexOf(`segment-${label}`);
  assert.ok(at > 0, `the playlist must name segment-${label}`);
  const stamp = lines
    .slice(0, at)
    .reverse()
    .find((line) => line.startsWith(`${PROGRAM_DATE_TIME_TAG}:`));
  assert.ok(stamp, `segment-${label} must carry a program date time`);
  return stamp.slice(`${PROGRAM_DATE_TIME_TAG}:`.length);
}

/** The URI of every entry a playlist lists, gap entries included, in playlist order. */
function entryUris(playlist: string): string[] {
  const lines = playlist.split('\n').map((line) => line.trim());
  return lines.filter((line) => line.startsWith('segment-') || line.startsWith('gap-'));
}

/**
 * Drive one broadcast up to the moment its encoder has come back, and hand over the playlist the
 * first returning segment was published in.
 *
 * `returningIndex` is the case's whole subject: the same muxer carrying on (57 -> 58, modelled here
 * as 3 after 0,1,2) and a muxer that restarted (0 again) reach this code by different routes and
 * must produce the same playlist.
 */
async function disconnectedAndReturned(
  harness: ReconnectHarness,
  returningIndex: number,
): Promise<{ beforeGap: ManifestWrite; afterGap: ManifestWrite }> {
  harness.start();
  await harness.segment('a0', 0);
  await harness.segment('a1', 1);
  await harness.segment('a2', 2);
  await harness.published('a2');
  const beforeGap = writesNaming(harness.writes, 'a2').at(-1);
  assert.ok(beforeGap, 'the broadcast must have published before its encoder went away');

  harness.orchestrator.noteDisconnect(STREAM_ID);
  await harness.passTime(OUTAGE_MS);

  harness.start();
  await harness.segment('b0', returningIndex);
  await harness.published('b0');
  const afterGap = writesNaming(harness.writes, 'b0').at(-1);
  assert.ok(afterGap, 'the returning segment must have been published');

  return { beforeGap, afterGap };
}

describe('an encoder that disconnects and comes back inside the window (cases 1 and 2)', () => {
  it('holds the session open, publishing no ending of any kind, while the encoder is away', async () => {
    const harness = reconnectHarness();
    harness.start();
    await harness.segment('a0', 0);

    harness.orchestrator.noteDisconnect(STREAM_ID);
    await harness.passTime(OUTAGE_MS);
    await waitAndConfirmNothingHappened(
      () => recordings(harness.writes).length === 0 && closingPlaylists(harness.writes).length === 0,
      QUIET_WINDOW_MS,
    );

    assert.equal(harness.orchestrator.getActiveStreamCount(), 1, 'the broadcast is still live during the gap');
    assert.deepEqual(
      harness.adminStates,
      [ADMIN_STATE_LIVE],
      'the admin was told live once and nothing since, so a viewer is not sent to a recording mid-outage',
    );
  });

  for (const { name, returningIndex } of [
    { name: 'the muxer carried its index on, which is what SRS does inside the window', returningIndex: 3 },
    { name: 'the muxer restarted and numbers from zero again', returningIndex: 0 },
  ]) {
    describe(`when ${name}`, () => {
      it('keeps one session, one recording and one live playlist that only moves forwards', async () => {
        const harness = reconnectHarness();
        const { beforeGap, afterGap } = await disconnectedAndReturned(harness, returningIndex);

        assert.equal(harness.orchestrator.getActiveStreamCount(), 1, 'one session holds the id, not two');
        assert.equal(recordings(harness.writes).length, 0, 'nothing was finalized across the gap');
        assert.equal(closingPlaylists(harness.writes).length, 0, 'and no playlist was ended');
        assert.deepEqual(harness.adminStates, [ADMIN_STATE_LIVE], 'the admin never heard about the gap at all');
        assert.equal(
          new Set(harness.writes.map((write) => write.topic)).size,
          1,
          'both runs published to one feed, which is what makes them one broadcast',
        );
        assert.ok(
          mediaSequenceOf(afterGap.playlist) >= mediaSequenceOf(beforeGap.playlist),
          'a media sequence that moved backwards is what hls.js reports as a fatal parsing error',
        );
        assert.ok(afterGap.index > beforeGap.index, 'and the feed itself carried on above where it was');
      });

      it('declares exactly one break, on the first segment of the returning run', async () => {
        const harness = reconnectHarness();
        const { afterGap } = await disconnectedAndReturned(harness, returningIndex);

        assert.equal(seamCount(afterGap.playlist), 1, 'the join is declared once, never twice and never not at all');
        const lines = afterGap.playlist.split('\n').map((line) => line.trim());
        assert.equal(
          lines.slice(lines.indexOf(DISCONTINUITY_TAG)).find((line) => line.startsWith('segment-')),
          'segment-b0',
          'the break belongs in front of the first media produced after the outage',
        );
      });

      it('re-anchors the returning date on the wall clock, leaving the dates already served alone', async () => {
        const harness = reconnectHarness();
        const { beforeGap, afterGap } = await disconnectedAndReturned(harness, returningIndex);

        // The broadcast opened at the anchor and stepped one declared fragment per segment, so the
        // last segment before the gap is two fragments in. Written out rather than derived, so the
        // expectation is not built by the arithmetic under test.
        const openedAt = TEST_ANCHOR.startedAtMs;
        assert.equal(
          dateOfSegment(beforeGap.playlist, 'a2'),
          new Date(openedAt + 2 * SEGMENT_SECONDS * 1_000).toISOString(),
          'the media before the outage is dated from the broadcast′s own start',
        );
        assert.equal(
          dateOfSegment(afterGap.playlist, 'a2'),
          new Date(openedAt + 2 * SEGMENT_SECONDS * 1_000).toISOString(),
          'and it keeps that date afterwards: a viewer is holding it, so it may not be re-dated',
        );
        assert.equal(
          dateOfSegment(afterGap.playlist, 'b0'),
          new Date(openedAt + OUTAGE_MS).toISOString(),
          'the returning media is dated at the clock the encoder came back at, not at where the ' +
            'broadcast would have been had nothing happened',
        );
      });

      it('names no media it does not have, so the outage leaves no gap entries', async () => {
        const harness = reconnectHarness();
        const { afterGap } = await disconnectedAndReturned(harness, returningIndex);

        assert.equal(
          afterGap.playlist.includes(GAP_TAG),
          false,
          'nothing was lost — nothing was being produced — so there is no hole to declare',
        );
        assert.deepEqual(
          entryUris(afterGap.playlist),
          ['segment-a0', 'segment-a1', 'segment-a2', 'segment-b0'],
          'the window is the broadcast′s own media, in the order it played',
        );
        assert.equal(
          harness.orchestrator.getMetricsSnapshot().segmentsLostTotal,
          0,
          'and no segment was counted as lost across the reconnect',
        );
      });

      it('carries every segment of both runs into the recording when the broadcast really ends', async () => {
        const harness = reconnectHarness();
        await disconnectedAndReturned(harness, returningIndex);
        await harness.segment('b1', returningIndex + 1);

        await harness.orchestrator.stopStream(STREAM_ID);
        await waitFor(() => recordings(harness.writes).length === 1, SETTLE_CEILING_MS);

        const recording = recordings(harness.writes)[0].playlist;
        assert.deepEqual(
          entryUris(recording),
          ['segment-a0', 'segment-a1', 'segment-a2', 'segment-b0', 'segment-b1'],
          'one recording holds the whole broadcast, both sides of the outage',
        );
        assert.equal(seamCount(recording), 1, 'with the one break the outage really was');
        assert.deepEqual(
          harness.adminStates,
          [ADMIN_STATE_LIVE, ADMIN_STATE_VOD],
          'and the admin is told once that it is live and once that it is a recording',
        );
      });
    });
  }

  /**
   * The CON-16 hazard, reached the other way round. The duplicate filter still holds the indexes the
   * first run took, and a muxer that restarts numbers from zero again, so every opening segment of
   * the returning run comes back `{ accepted: true }` with nothing uploaded and nothing published.
   * The engine is told the segment landed, so it never retries, and accepted-as-duplicate is
   * indistinguishable from accepted-and-published to everything upstream.
   */
  it('takes index 0 again after a return, rather than swallowing it as a duplicate', async () => {
    const harness = reconnectHarness();
    harness.start();
    for (const index of [0, 1, 2]) {
      await harness.segment(`a${index}`, index);
    }

    harness.orchestrator.noteDisconnect(STREAM_ID);
    await harness.passTime(OUTAGE_MS);
    harness.start();

    for (const index of [0, 1]) {
      await harness.segment(`b${index}`, index);
    }

    await harness.orchestrator.stopStream(STREAM_ID);
    await waitFor(() => recordings(harness.writes).length === 1, SETTLE_CEILING_MS);
    assert.deepEqual(
      entryUris(recordings(harness.writes)[0].playlist),
      ['segment-a0', 'segment-a1', 'segment-a2', 'segment-b0', 'segment-b1'],
      'the returning run′s opening indexes were taken and published rather than absorbed',
    );
  });

  /** Case 6: several short outages, each followed by real video, is one recording with one seam each. */
  it('survives four disconnect-and-return cycles as one recording with one seam per return', async () => {
    const harness = reconnectHarness();
    const cycles = 4;

    harness.start();
    await harness.segment('a0', 0);

    for (let cycle = 0; cycle < cycles; cycle++) {
      harness.orchestrator.noteDisconnect(STREAM_ID);
      await harness.passTime(OUTAGE_MS);
      harness.start();
      // Numbering from zero every time, which is the harsher of the two returns: it needs the
      // duplicate filter reset on every cycle rather than only on the first.
      await harness.segment(`b${cycle}`, 0);
    }

    assert.deepEqual(harness.adminStates, [ADMIN_STATE_LIVE], 'the admin state never left live across any of them');
    assert.equal(recordings(harness.writes).length, 0, 'and no recording was published while the broadcast ran');

    await harness.orchestrator.stopStream(STREAM_ID);
    await waitFor(() => recordings(harness.writes).length === 1, SETTLE_CEILING_MS);

    const recording = recordings(harness.writes)[0].playlist;
    assert.equal(recordings(harness.writes).length, 1, 'four outages produced one recording, not five');
    assert.equal(seamCount(recording), cycles, 'one break per return, and no more');
    assert.deepEqual(
      entryUris(recording),
      ['segment-a0', 'segment-b0', 'segment-b1', 'segment-b2', 'segment-b3'],
      'with every segment of every run in the order it played',
    );
  });

  /**
   * ⛔⛔ **Every return is dated at the clock IT came back at, and the second and later ones are what
   * this is for.** The re-anchoring used to recognise a restart by whether the line it minted still
   * dated the resuming sequence as happening about now, which is true of a second outage on the same
   * rung for as long as that outage is shorter than the two minute tolerance: nothing advanced while
   * the encoder was away, so the line reaches the resuming sequence almost exactly where it was
   * written down. Driven here: the first return was dated correctly, the second landed 48 seconds
   * behind, the third 96 seconds behind, and only the fourth was right, because by then the
   * accumulated lag had finally exceeded the tolerance. The log even said the dating moved from an
   * instant to itself.
   *
   * Run with the muxer index carrying on, which is what SRS does inside the window and what leaves
   * the counter-restart detection nothing to find, so the dating rests entirely on the reconnect
   * having armed it.
   */
  it('dates each of four returns at its own wall clock, not at the first return’s', async () => {
    const harness = reconnectHarness();
    const cycles = 4;

    harness.start();
    await harness.segment('a0', 0);
    await harness.published('a0');

    const returnedAt: number[] = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      harness.orchestrator.noteDisconnect(STREAM_ID);
      await harness.passTime(OUTAGE_MS);
      returnedAt.push(TEST_ANCHOR.startedAtMs + (cycle + 1) * OUTAGE_MS);
      harness.start();
      await harness.segment(`b${cycle}`, cycle + 1);
      await harness.published(`b${cycle}`);
    }

    const recordingWrite = await (async (): Promise<string> => {
      await harness.orchestrator.stopStream(STREAM_ID);
      await waitFor(() => recordings(harness.writes).length === 1, SETTLE_CEILING_MS);
      return recordings(harness.writes)[0].playlist;
    })();

    assert.deepEqual(
      returnedAt.map((_, cycle) => dateOfSegment(recordingWrite, `b${cycle}`)),
      returnedAt.map((at) => new Date(at).toISOString()),
      'a return carried an earlier return’s date, so its media is behind real time by the outages between them',
    );
  });

  /**
   * Case 11. The two webhooks race and this service cannot order them, so an `on_unpublish` for a
   * publish session that has already been replaced lands after the reconnect. It must cost nothing:
   * it opens a window, and the next segment closes it.
   */
  it('lets the next segment cancel an unpublish that arrived after the encoder was already back', async () => {
    const harness = reconnectHarness();
    harness.start();
    await harness.segment('a0', 0);

    harness.orchestrator.noteDisconnect(STREAM_ID);
    await harness.passTime(OUTAGE_MS);
    harness.start();
    await harness.segment('b0', 0);

    // The stale webhook, arriving now, about a publish session that ended a minute ago.
    harness.orchestrator.noteDisconnect(STREAM_ID);
    assert.deepEqual(
      harness.orchestrator.getHealthSignals().disconnectedStreams,
      [STREAM_ID],
      'the stale webhook is taken at face value, because nothing here can tell it from a real one',
    );

    await harness.segment('b1', 1);
    assert.deepEqual(
      harness.orchestrator.getHealthSignals().disconnectedStreams,
      [],
      'and the media that follows it settles the question: the encoder is plainly still there',
    );
    assert.equal(recordings(harness.writes).length, 0, 'nothing was finalized on the strength of a stale webhook');
    assert.equal(harness.orchestrator.getActiveStreamCount(), 1, 'and the resumed broadcast is still live');
  });

  /**
   * The window changes who may hold an id in no way at all: `reasonToRefuseTakeover` runs first and
   * on exactly the evidence it always did. A stranger against a proven incumbent is refused whether
   * that incumbent is feeding, silent or disconnected.
   */
  it('refuses a stranger during the window by the same rule that refuses one at any other time', async () => {
    const harness = reconnectHarness();
    assert.equal(
      harness.orchestrator.startStream(
        STREAM_ID,
        MEDIA_TYPE_AUDIO,
        { address: '203.0.113.10', isAuthenticated: true },
        DECLARATION,
      ),
      true,
    );
    await harness.segment('a0', 0);

    harness.orchestrator.noteDisconnect(STREAM_ID);
    await harness.passTime(OUTAGE_MS);

    assert.equal(
      harness.announce(STREAM_ID, { address: '198.51.100.7' }),
      false,
      'an unproven announce against a proven incumbent is refused, disconnected or not',
    );
    assert.equal(
      harness.orchestrator.getMetricsSnapshot().takeoversRefusedTotal,
      1,
      'and the refusal is counted, because it is a denial of service to whoever sent it',
    );
    assert.equal(harness.orchestrator.getActiveStreamCount(), 1, 'the incumbent′s session is untouched');
  });

  /**
   * The state a crash is likeliest to land in: the encoder has announced its return and its first
   * segment has not arrived, so nothing is being uploaded and the two things that segment owes — a
   * break and a re-anchored date — exist only as flags. Both ride in the recovery entry.
   */
  it('still owes the seam after a crash between the encoder returning and its first segment', async () => {
    const harness = reconnectHarness();
    harness.start();
    await harness.segment('a0', 0);
    await harness.segment('a1', 1);

    harness.orchestrator.noteDisconnect(STREAM_ID);
    await harness.passTime(OUTAGE_MS);
    harness.start();
    await waitFor(() => harness.saved.at(-1)?.resumingAfterReconnect === true, SETTLE_CEILING_MS);

    const entry = harness.saved.at(-1);
    assert.ok(entry);
    assert.equal(entry.resumingAfterReconnect, true, 'the entry records that a returning segment is owed a seam');
    assert.equal(entry.pendingDiscontinuity, true, 'and that the break has not been attached to anything yet');

    // The crash. A second process recovers that entry and the encoder delivers into it.
    const rebuilt = await rebuildFrom(entry);
    // ⚠️ An index the restored duplicate filter does not already hold, which is the muxer carrying on
    // rather than restarting. A recovered session seeds its filter from the segments in its entry, so
    // index 0 there would be answered as a duplicate — a hazard of the recovery path that predates
    // this and is not what this case is about.
    await rebuilt.segment('b0', 5);
    await rebuilt.published('b0');

    const afterCrash = writesNaming(rebuilt.writes, 'b0').at(-1);
    assert.ok(afterCrash, 'the recovered session published the returning segment');
    assert.equal(seamCount(afterCrash.playlist), 1, 'the seam the crash interrupted is still declared');
  });
});

/**
 * A second uploader process, recovering the entry the first one wrote.
 *
 * Built here rather than in {@link reconnectHarness} because a recovery harness differs in exactly
 * one way — `listActive` and `load` answer with the entry — and threading that through every case
 * that does not recover would put a branch in the common path.
 */
async function rebuildFrom(entry: StreamState): Promise<ReconnectHarness> {
  const clock = new FakeClock();
  let wallMs = TEST_ANCHOR.startedAtMs + OUTAGE_MS;
  const writes: ManifestWrite[] = [];
  const adminStates: string[] = [];
  const saved: StreamState[] = [];
  const uploadedSegments: string[] = [];
  const feeds = new Map<string, FakeFeedHead>();

  const adminApi = {
    describe: () => 'http://admin.test',
    reportState: async (_id: string, report: AdminStateReport) => {
      adminStates.push(report.state);
      return STATE_REPORT_ACCEPTED;
    },
  } as unknown as AdminApiClient;

  const orchestrator = makeTestOrchestrator(
    { adminApi, clock, wallClock: () => wallMs, orphanReapMs: REAP_MS },
    {
      uploadData: async (_stamp, data) => {
        const label = Buffer.from(data).toString('utf8');
        uploadedSegments.push(label);
        return { reference: { toHex: () => `segment-${label}` } };
      },
      feedHead: (topic) => feeds.get(topic) ?? null,
      uploadPayload: async (index, payload, topic) => {
        const playlist = String(payload);
        writes.push({ index, playlist, topic });
        feeds.set(topic, { index, manifest: playlist });
        return { reference: { toHex: () => `soc-${index}` } };
      },
    },
    makeFakeRecoveryStore({
      listActive: () => [entry.streamId.replace(/[/\\]/g, '_')],
      load: () => entry,
      save: (_streamId: string, state: StreamState) => saved.push(state),
    }),
  );

  assert.deepEqual(await orchestrator.recoverStreams(), [entry.streamId], 'the entry must rebuild into a session');

  return {
    orchestrator,
    clock,
    writes,
    adminStates,
    saved,
    start: () => assert.fail('a recovered session is resumed by its engine′s segments, not by an announce'),
    announce: () => assert.fail('the same'),
    published: async (label) => {
      await waitFor(() => writes.some((write) => write.playlist.includes(`segment-${label}`)), SETTLE_CEILING_MS);
    },
    segment: async (label, index, streamId = entry.streamId) => {
      assert.deepEqual(orchestrator.handleSegment(streamId, index, SEGMENT_SECONDS, Buffer.from(label)), {
        accepted: true,
      });
      await waitFor(() => uploadedSegments.includes(label), SETTLE_CEILING_MS);
    },
    passTime: async (ms) => {
      wallMs += ms;
      await clock.advance(ms);
    },
  };
}

describe('an operator stop is unchanged by the window', () => {
  it('finalizes at once, with no waiting for an encoder that has just been told to go', async () => {
    const harness = reconnectHarness();
    harness.start();
    await harness.segment('a0', 0);

    await harness.orchestrator.stopStream(STREAM_ID);

    assert.equal(recordings(harness.writes).length, 1, 'the recording is published by the stop itself');
    assert.equal(harness.orchestrator.getActiveStreamCount(), 0, 'and the id is free without any clock moving');
    assert.deepEqual(harness.adminStates, [ADMIN_STATE_LIVE, ADMIN_STATE_VOD], 'the admin is told immediately');
  });
});

describe('a whole ladder whose encoder disconnects together (case 8′s neighbour)', () => {
  const rungIds = RUNG_NAMES.map((rung) => `${LADDER_BASE}_${rung}`);

  async function runLadderThroughAnOutage(harness: ReconnectHarness, returningIndex: number): Promise<void> {
    for (const streamId of rungIds) {
      harness.start(streamId);
      await harness.segment(`${streamId}-a0`, 0, streamId);
      await harness.segment(`${streamId}-a1`, 1, streamId);
    }

    // SRS stops every transcoder when the source goes, so all four rungs unpublish within a moment
    // of each other.
    for (const streamId of rungIds) {
      harness.orchestrator.noteDisconnect(streamId);
    }
    await harness.passTime(OUTAGE_MS);

    for (const streamId of rungIds) {
      harness.start(streamId);
      await harness.segment(`${streamId}-b0`, returningIndex, streamId);
    }
  }

  /**
   * ⚠️ What the master then advertises is deliberately NOT asserted here, because nothing in this
   * harness writes one: `LadderLiveness.test.ts` holds that rule directly, including the case this
   * one creates — a ladder that goes quiet together keeps every rung, because the rule counts
   * segments and an outage advances none of them.
   */
  it('holds every rung live, and finalizes nothing', async () => {
    const harness = reconnectHarness({ ladder: true });
    for (const streamId of rungIds) {
      harness.start(streamId);
      await harness.segment(`${streamId}-a0`, 0, streamId);
    }

    for (const streamId of rungIds) {
      harness.orchestrator.noteDisconnect(streamId);
    }
    await harness.passTime(OUTAGE_MS);

    assert.equal(harness.orchestrator.getActiveStreamCount(), rungIds.length, 'all four rungs are still live');
    assert.deepEqual(
      harness.orchestrator.getHealthSignals().disconnectedStreams.sort(),
      [...rungIds].sort(),
      'and every one of them says so, which is what tells a whole-encoder outage from one dead transcoder',
    );
    assert.equal(recordings(harness.writes).length, 0, 'nothing was finalized');
    assert.equal(closingPlaylists(harness.writes).length, 0, 'and no rung ended its playlist');
  });

  /**
   * ⛔⛔ **The rung this loses is the 1080p one, and losing it is permanent.** Rungs come back a few
   * seconds apart, because SRS restarts four transcoders and the slowest to start is also the slowest
   * to cut a segment. A rung whose announce lands near the end of the window and whose first segment
   * lands just past it is reaped while its siblings resume: its recording is sealed, its id is freed,
   * and every segment it then delivers is refused — so the master carries three rungs for the rest of
   * the broadcast and a viewer on that quality is moved off it.
   */
  it('keeps a rung that comes back later than its siblings, and its first segment after that', async () => {
    const harness = reconnectHarness({ ladder: true });
    for (const streamId of rungIds) {
      harness.start(streamId);
      await harness.segment(`${streamId}-a0`, 0, streamId);
    }

    for (const streamId of rungIds) {
      harness.orchestrator.noteDisconnect(streamId);
    }

    // SRS restarts four transcoders and they all re-publish with three seconds of the window left.
    // What differs is when each one cuts its first segment: the fast three at once, the slowest five
    // seconds later, which is past the window.
    const fast = rungIds.slice(0, 3);
    const slow = rungIds[rungIds.length - 1];
    await harness.passTime(REAP_MS - 3_000);
    for (const streamId of rungIds) {
      harness.start(streamId);
    }
    for (const streamId of fast) {
      await harness.segment(`${streamId}-b0`, 1, streamId);
    }

    await harness.passTime(5_000);
    assert.equal(
      harness.orchestrator.getActiveStreamCount(),
      rungIds.length,
      'the slow rung was reaped while its siblings resumed, so the master is short a quality for good',
    );
    await harness.segment(`${slow}-b0`, 1, slow);

    assert.equal(recordings(harness.writes).length, 0, 'and nothing was finalized on any rung');
    assert.equal(harness.orchestrator.getActiveStreamCount(), rungIds.length, 'all four are still live');
  });

  it('mints one dating line for the whole ladder when its rungs come back', async () => {
    const harness = reconnectHarness({ ladder: true });
    await runLadderThroughAnOutage(harness, 2);

    for (const streamId of rungIds) {
      await harness.published(`${streamId}-b0`);
    }
    const returningDates = rungIds.map((streamId) => {
      const write = writesNaming(harness.writes, `${streamId}-b0`).at(-1);
      assert.ok(write, `${streamId} must have published its returning segment`);
      return dateOfSegment(write.playlist, `${streamId}-b0`);
    });

    assert.equal(
      new Set(returningDates).size,
      1,
      'four rungs dating one instant four ways is what hls.js reads as the rungs covering different media',
    );
    assert.equal(
      returningDates[0],
      new Date(TEST_ANCHOR.startedAtMs + OUTAGE_MS).toISOString(),
      'and the one line they share is the wall clock the encoder came back at',
    );
  });

  it('puts the seam on the same sequence in every rung', async () => {
    const harness = reconnectHarness({ ladder: true });
    await runLadderThroughAnOutage(harness, 2);

    for (const streamId of rungIds) {
      await harness.published(`${streamId}-b0`);
    }
    const seamSequences = rungIds.map((streamId) => {
      const write = writesNaming(harness.writes, `${streamId}-b0`).at(-1);
      assert.ok(write);
      assert.equal(seamCount(write.playlist), 1, `${streamId} declares the join once`);
      // The window opens at the media sequence of its first entry and lists them consecutively, so
      // the returning segment's own sequence is that plus the entries in front of it.
      const uris = entryUris(write.playlist);
      return mediaSequenceOf(write.playlist) + uris.indexOf(`segment-${streamId}-b0`);
    });

    assert.equal(
      new Set(seamSequences).size,
      1,
      'the rungs of one ladder must break at one instant, or a level switch lands on the wrong side of it',
    );
  });
});

/**
 * The SRS webhook's own wiring, one layer above everything else here: which orchestrator call each
 * role's `on_unpublish` makes.
 *
 * ⛔ The only thing these assert is WHICH call, because that is the whole of the engine's part in
 * this. What the call then does is every case above.
 */
describe('what an SRS unpublish asks the orchestrator to do', () => {
  const TEST_WEBHOOK_TOKEN = 'srs-webhook-token-0123456789abcdef';
  const ABR_VHOST = 'abr.local';
  const LOOPBACK_IP = '127.0.0.1';

  interface OrchestratorCalls {
    disconnected: string[];
    stopped: string[];
    started: string[];
  }

  interface SrsPost {
    action: 'on_publish' | 'on_unpublish';
    app: string;
    stream: string;
    vhost?: string;
    ip?: string;
  }

  /** Posts one webhook against a real SRS router and reports what the orchestrator was asked to do. */
  async function postToSrs(posts: readonly SrsPost[], withLadder: boolean): Promise<OrchestratorCalls> {
    const calls: OrchestratorCalls = { disconnected: [], stopped: [], started: [] };
    const orchestrator = {
      startStream: (streamId: string) => {
        calls.started.push(streamId);
        return true;
      },
      stopStream: async (streamId: string) => void calls.stopped.push(streamId),
      noteDisconnect: (streamId: string) => calls.disconnected.push(streamId),
      recordAuthRejection: () => undefined,
    } as unknown as StreamOrchestrator;

    const engine = createSrsEngine('/srv/media', {
      webhookToken: TEST_WEBHOOK_TOKEN,
      ...(withLadder ? { abr: { vhost: ABR_VHOST, ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC) } } : {}),
    });
    const app = express();
    app.use(express.json());
    app.use(engine.prefix, engine.createRouter(orchestrator));

    const { server, baseUrl } = await listenOnLoopback(app);
    try {
      for (const post of posts) {
        const response = await fetch(
          `${baseUrl}${engine.prefix}/streams?${SRS_WEBHOOK_TOKEN_PARAM}=${TEST_WEBHOOK_TOKEN}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vhost: '__defaultVhost__', param: '', ...post }),
          },
        );
        assert.equal(await response.json(), 0, `SRS must be acknowledged for ${post.action} of ${post.stream}`);
      }
    } finally {
      server.close();
    }
    return calls;
  }

  it('notes a disconnect for a single stream, and stops nothing', async () => {
    const calls = await postToSrs([{ action: 'on_unpublish', app: 'video', stream: 'demo' }], false);

    assert.deepEqual(calls.disconnected, ['video/demo'], 'the session is told its encoder went away');
    assert.deepEqual(calls.stopped, [], 'and nothing is finalized, which is the whole of the change');
  });

  it('notes a disconnect for a rung SRS dialled from loopback, and stops nothing', async () => {
    const calls = await postToSrs(
      [
        { action: 'on_publish', app: 'video', stream: 'demo', ip: '203.0.113.10' },
        {
          action: 'on_unpublish',
          app: 'video',
          stream: `demo_${RUNG_NAMES[0]}`,
          vhost: ABR_VHOST,
          ip: LOOPBACK_IP,
        },
      ],
      true,
    );

    assert.deepEqual(calls.disconnected, [`video/demo_${RUNG_NAMES[0]}`], 'the rung is told too');
    assert.deepEqual(calls.stopped, [], 'and a rung is no longer finalized on its own webhook either');
  });

  it('acts on neither for a rung that did not come from the transcode loopback', async () => {
    const calls = await postToSrs(
      [
        { action: 'on_publish', app: 'video', stream: 'demo', ip: '203.0.113.10' },
        {
          action: 'on_unpublish',
          app: 'video',
          stream: `demo_${RUNG_NAMES[0]}`,
          vhost: ABR_VHOST,
          ip: '198.51.100.7',
        },
      ],
      true,
    );

    assert.deepEqual(calls.disconnected, [], 'the loopback origin is the gate, and it is unchanged by this');
    assert.deepEqual(calls.stopped, []);
  });

  it('leaves the ladder source alone, which never had a session of its own to end', async () => {
    const calls = await postToSrs(
      [
        { action: 'on_publish', app: 'video', stream: 'demo', ip: '203.0.113.10' },
        { action: 'on_unpublish', app: 'video', stream: 'demo', ip: '203.0.113.10' },
      ],
      true,
    );

    assert.deepEqual(calls.started, [], 'the uploader ingests the rungs, never the untranscoded source');
    assert.deepEqual(calls.disconnected, [], 'so there is nothing to report a disconnect against');
    assert.deepEqual(calls.stopped, []);
  });

  it('acts on neither for a name that is no configured rung', async () => {
    const calls = await postToSrs(
      [{ action: 'on_unpublish', app: 'video', stream: 'not-a-rung', vhost: ABR_VHOST, ip: LOOPBACK_IP }],
      true,
    );

    assert.deepEqual(calls.disconnected, [], 'a stray is ingested by nothing and so ends nothing');
    assert.deepEqual(calls.stopped, []);
  });
});
