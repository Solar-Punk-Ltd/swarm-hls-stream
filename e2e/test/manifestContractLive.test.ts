import { addingStreamToList, rungAnnounced, segmentUploaded } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type E2EConfig, loadConfig } from '../src/config.js';
import type { Host } from '../src/harness/host.js';
import type { ManifestContract } from '../src/harness/manifestContract.js';
import {
  checkPublishedTimeline,
  describeRungPlaylists,
  fragmentSecondsFor,
  judgeRungPlaylists,
  namesEverySegmentPublished,
  publishedCountsOf,
  publishedFor,
  publishingRungFeedsOf,
  type RungFeed,
  rungFeedsOf,
  rungPlaylistParse,
  rungPlaylistRefusal,
  UNCHECKED_WITHOUT_FRAGMENT,
} from '../src/harness/manifestContractLive.js';
import { SEGMENT_ANY } from '../src/segmentLength.js';

import {
  FIXTURE_FRAGMENT_SECONDS,
  fixtureDateOf,
  GATEWAY_ERROR_ENVELOPE,
  rungPlaylist,
} from './helpers/rungPlaylistFixtures.js';

/**
 * The live half of the playlist-timeline check: finding a broadcast's feeds, reading what came back,
 * and saying what is wrong with it.
 *
 * ⛔ Every case here is built from log text and playlist text, so it is free and it runs in CI. What
 * it cannot do is prove a stage publishes such a playlist, which is the paid half and is what the
 * suites under `e2e/suites/` are for. `manifestContract.test.ts` owns the contract's own rules. This
 * file owns everything around them.
 */

const FIRST_PLAYLIST: ManifestContract = { fragmentSeconds: FIXTURE_FRAGMENT_SECONDS, firstOfBroadcast: true };
const SLID_WINDOW: ManifestContract = { fragmentSeconds: FIXTURE_FRAGMENT_SECONDS, firstOfBroadcast: false };
const LADDER = 'ladder-7f21';
const TOPIC_360 = '3e2b0c8a-1111-4a1b-9c3d-000000000360';
const TOPIC_1080 = '3e2b0c8a-2222-4a1b-9c3d-000000001080';
const TOPIC_720 = 'c0ffee0a-4444-4a1b-9c3d-000000000720';

function feedOf(rung: string, topic: string): RungFeed {
  return { rung, streamId: `live/stream_${rung}`, topic };
}

function ladderLog(announces: readonly { rung: string; topic: string }[]): string {
  return announces
    .map(
      (announce) =>
        `[2026-09-03T10:00:00.000Z] [LOG] - [StreamOrchestrator] ${rungAnnounced(
          `live/stream_${announce.rung}`,
          announce.rung,
          LADDER,
          announce.topic,
        )}`,
    )
    .join('\n');
}

function uploadLines(streamId: string, count: number): string {
  return Array.from(
    { length: count },
    (_unused, index) => `[2026-09-03T10:00:00.000Z] [LOG] - ${segmentUploaded(streamId, index, 'a'.repeat(64))}`,
  ).join('\n');
}

/** The two phases in one call, for the cases where the split itself is not what is under test. */
function readingOf(feed: RungFeed, body: string, contract: ManifestContract) {
  return judgeRungPlaylists([rungPlaylistParse(feed, body)], contract)[0];
}

describe('finding the feeds a broadcast published', () => {
  it('names one feed per rung of a ladder, with the rung the report should use', () => {
    const feeds = rungFeedsOf(
      ladderLog([
        { rung: '360p', topic: TOPIC_360 },
        { rung: '1080p', topic: TOPIC_1080 },
      ]),
    );

    assert.deepEqual(feeds, [feedOf('360p', TOPIC_360), feedOf('1080p', TOPIC_1080)]);
  });

  /**
   * ⛔ The last announce per rung, for the reason `lastUploadedSegmentRefByRung` records: a session
   * that was replaced announces again on a fresh topic while the retired one keeps its own, and the
   * retired feed is being finalized as the read happens. The newest announce is the session a suite
   * asking "what is this broadcast publishing" means.
   */
  it('keeps the newest topic when a rung announced twice, which is a session that was replaced', () => {
    const resumed = 'b71c0c8a-3333-4a1b-9c3d-000000000360';

    const feeds = rungFeedsOf(
      ladderLog([
        { rung: '360p', topic: TOPIC_360 },
        { rung: '360p', topic: resumed },
      ]),
    );

    assert.deepEqual(feeds, [feedOf('360p', resumed)]);
  });

  /**
   * A single-rendition deployment never writes a rung announce, so its feed comes off the catalog
   * announce, which is the only line carrying a broadcast's own topic.
   */
  it('names the one feed of a single-rendition broadcast, with no rung to call it by', () => {
    const entry = JSON.stringify({ title: 'stream', topic: TOPIC_360, owner: 'a'.repeat(40), state: 'live' });

    assert.deepEqual(rungFeedsOf(`[2026-09-03T10:00:00.000Z] [LOG] - ${addingStreamToList(entry)}`), [
      { rung: null, streamId: null, topic: TOPIC_360 },
    ]);
  });

  it('finds nothing in a log that announced nothing', () => {
    assert.deepEqual(rungFeedsOf('[2026-09-03T10:00:00.000Z] [LOG] - Uploader started'), []);
  });
});

/**
 * ⛔ The scope that stops this check inventing a red. `service/happy-path` asserts about "every rung
 * that uploaded a segment", and scenario I warms up on a merged count one fast rung can satisfy
 * alone, so a rung that announced and has yet to publish must not be refused for an empty feed.
 */
describe('scoping to the rungs that actually published', () => {
  const announces = ladderLog([
    { rung: '360p', topic: TOPIC_360 },
    { rung: '1080p', topic: TOPIC_1080 },
  ]);

  it('keeps a rung whose stream uploaded and drops the one that only announced', () => {
    const feeds = publishingRungFeedsOf(`${announces}\n${uploadLines('live/stream_360p', 3)}`);

    assert.deepEqual(feeds, [feedOf('360p', TOPIC_360)]);
  });

  it('keeps every rung once they have all published', () => {
    const log = [announces, uploadLines('live/stream_360p', 3), uploadLines('live/stream_1080p', 2)].join('\n');

    assert.deepEqual(publishingRungFeedsOf(log), [feedOf('360p', TOPIC_360), feedOf('1080p', TOPIC_1080)]);
  });

  it('finds nothing where a ladder announced and published nothing at all', () => {
    assert.deepEqual(publishingRungFeedsOf(announces), []);
  });

  it('counts the uploads each stream made, which is what a slid window is weighed against', () => {
    const log = [uploadLines('live/stream_360p', 3), uploadLines('live/stream_1080p', 2)].join('\n');

    assert.deepEqual(
      [...publishedCountsOf(log)],
      [
        ['live/stream_360p', 3],
        ['live/stream_1080p', 2],
      ],
    );
  });
});

describe('the step a run declared', () => {
  it('hands back the seconds a run pinned', () => {
    assert.equal(fragmentSecondsFor(2), 2);
  });

  it('hands back null for a run that declared it pins no length, which is not a gap', () => {
    assert.equal(fragmentSecondsFor(SEGMENT_ANY), null);
  });

  it('hands back null for a run that declared nothing at all', () => {
    assert.equal(fragmentSecondsFor('undeclared'), null);
  });

  it('says what is left unchecked without one, naming the variable that fixes it', () => {
    assert.match(UNCHECKED_WITHOUT_FRAGMENT, /E2E_EXPECT_SEGMENT_S/);
  });
});

describe('reading one rung playlist back', () => {
  const feed = feedOf('360p', TOPIC_360);

  it('reads back what a live playlist says about itself', () => {
    const parse = rungPlaylistParse(feed, rungPlaylist([0, 1, 2, 3]));

    assert.equal(parse.segments, 4);
    assert.equal(parse.mediaSequence, 0);
    assert.equal(parse.firstDate, fixtureDateOf(0));
    assert.equal(parse.lastDate, fixtureDateOf(3));
    assert.equal(parse.recording, false);
    assert.equal(parse.unreadable, null);
  });

  it('hashes the raw topic into the hex the gateway answers for', () => {
    assert.match(rungPlaylistParse(feed, rungPlaylist([0])).topicHex, /^[0-9a-f]{64}$/);
  });

  it('reports a finished recording as one', () => {
    assert.equal(rungPlaylistParse(feed, rungPlaylist([0, 1, 2], { recording: true })).recording, true);
  });

  /**
   * The closing live playlist carries an `#EXT-X-ENDLIST` too, and it is published at the feed index
   * BEFORE the recording. Reading it as a recording would then require sequence 0 of a window that
   * has legitimately slid.
   */
  it('does not call the closing live playlist a recording, whatever its ENDLIST says', () => {
    const closing = rungPlaylist([12, 13, 14], { mediaSequence: 12, closed: true });

    assert.equal(rungPlaylistParse(feed, closing).recording, false);
    assert.deepEqual(readingOf(feed, closing, SLID_WINDOW).failures, []);
  });

  /**
   * ⛔ The envelope parses as a playlist naming no segments, so a reader that trusted the parse would
   * report an empty timeline the broadcast never published. The body is quoted in the reason, because
   * "no playlist" and "a 404 from a gateway that is restarting" need different answers from a reader.
   */
  it('refuses a gateway error envelope as no playlist rather than as an empty one', () => {
    const parse = rungPlaylistParse(feed, GATEWAY_ERROR_ENVELOPE);

    assert.equal(parse.playlist, null);
    assert.equal(parse.segments, 0);
    assert.match(parse.unreadable ?? '', /no playlist/);
    assert.match(parse.unreadable ?? '', /Not Found/);
  });

  it('refuses an empty body, which is what a timed-out gateway read leaves', () => {
    const parse = rungPlaylistParse(feed, '');

    assert.equal(parse.playlist, null);
    assert.match(parse.unreadable ?? '', /answered nothing/);
  });

  it('carries the transport reason into the failures a suite asserts on', () => {
    assert.match(readingOf(feed, '', FIRST_PLAYLIST).failures[0], /answered nothing/);
  });
});

describe('holding a playlist to the contract', () => {
  const feed = feedOf('360p', TOPIC_360);

  it('passes a live playlist that opens at zero and steps by the fragment', () => {
    assert.deepEqual(readingOf(feed, rungPlaylist([0, 1, 2, 3]), FIRST_PLAYLIST).failures, []);
  });

  /**
   * ⛔ A recording names every segment of the broadcast, so its sequence is 0 by construction and
   * that holds however late the suite read it. Left to the caller's flag, the one playlist whose
   * numbering can always be checked would go unchecked in every suite that reads a finished
   * broadcast, which is every crash scenario that leaves one.
   */
  it('requires zero of a recording even where the suite could not promise a first playlist', () => {
    const renumbered = rungPlaylist([0, 1, 2], { mediaSequence: 580, recording: true });

    const failures = readingOf(feed, renumbered, SLID_WINDOW).failures;

    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /#EXT-X-MEDIA-SEQUENCE:580 rather than 0/);
  });

  it('accepts a live window that has slid, where the suite did not promise a first playlist', () => {
    const slid = rungPlaylist([12, 13, 14], { mediaSequence: 12 });

    assert.deepEqual(readingOf(feed, slid, SLID_WINDOW).failures, []);
  });

  it('carries the contract’s own reasons through, naming the segment it objected to', () => {
    const failures = readingOf(feed, rungPlaylist([0, 1, 3, 4]), FIRST_PLAYLIST).failures;

    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /segment 2 is dated 2 fragments after/);
  });

  it('asks per rung whether the window still starts at the broadcast’s first segment', () => {
    const parses = [
      rungPlaylistParse(feedOf('360p', TOPIC_360), rungPlaylist([12, 13, 14], { mediaSequence: 12 })),
      rungPlaylistParse(feedOf('1080p', TOPIC_1080), rungPlaylist([0, 1, 2], { mediaSequence: 9 })),
    ];

    const readings = judgeRungPlaylists(parses, FIRST_PLAYLIST, (parse) => parse.rung === '1080p');

    assert.deepEqual(readings[0].failures, [], 'the rung nobody vouched for is left alone');
    assert.match(readings[1].failures[0] ?? '', /#EXT-X-MEDIA-SEQUENCE:9 rather than 0/);
  });
});

/**
 * ⛔ The one derivation that settles sequence zero without a stopwatch. A suite reading "early" is
 * green on the wall clock rather than on the product, and the live window is a byte budget that
 * slides at a segment count no clock knows.
 */
describe('whether a playlist can only be the broadcast’s first', () => {
  const feed = feedOf('360p', TOPIC_360);

  it('says yes where the playlist names every segment the rung has published', () => {
    assert.equal(namesEverySegmentPublished(rungPlaylistParse(feed, rungPlaylist([0, 1, 2, 3])), 4), true);
  });

  it('says no where the rung published more than the playlist names, which is a slid window', () => {
    const parse = rungPlaylistParse(feed, rungPlaylist([12, 13, 14], { mediaSequence: 12 }));

    assert.equal(namesEverySegmentPublished(parse, 15), false);
  });

  /** A count read after the playlist can only be too high, which costs an assertion, never a red. */
  it('says yes where the log counted fewer than the playlist names', () => {
    assert.equal(namesEverySegmentPublished(rungPlaylistParse(feed, rungPlaylist([0, 1, 2, 3])), 2), true);
  });

  it('says no where no playlist was read at all', () => {
    assert.equal(namesEverySegmentPublished(rungPlaylistParse(feed, ''), 0), false);
  });

  it('takes the count of the rung’s own stream', () => {
    const counts = new Map([
      ['live/stream_360p', 3],
      ['live/stream_1080p', 9],
    ]);

    assert.equal(publishedFor(rungPlaylistParse(feed, rungPlaylist([0])), counts), 3);
  });

  /** One rendition means one stream, so there is nothing else the uploads could belong to. */
  it('takes the one stream’s count for a broadcast with no rung name', () => {
    const single = rungPlaylistParse({ rung: null, streamId: null, topic: TOPIC_360 }, rungPlaylist([0]));

    assert.equal(publishedFor(single, new Map([['live/stream', 4]])), 4);
  });

  it('refuses to guess between two streams when the feed names none', () => {
    const single = rungPlaylistParse({ rung: null, streamId: null, topic: TOPIC_360 }, rungPlaylist([0]));
    const counts = new Map([
      ['live/stream', 4],
      ['live/other', 7],
    ]);

    assert.equal(publishedFor(single, counts), null);
  });

  it('answers null for a rung the log holds no uploads for', () => {
    assert.equal(publishedFor(rungPlaylistParse(feed, rungPlaylist([0])), new Map()), null);
  });
});

describe('the verdict over a whole ladder', () => {
  const clean = () =>
    judgeRungPlaylists(
      [
        rungPlaylistParse(feedOf('360p', TOPIC_360), rungPlaylist([0, 1, 2])),
        rungPlaylistParse(feedOf('1080p', TOPIC_1080), rungPlaylist([0, 1, 2])),
      ],
      FIRST_PLAYLIST,
    );

  it('passes a ladder whose every rung published a sound timeline', () => {
    assert.equal(rungPlaylistRefusal(clean()), null);
  });

  it('names the rung and the reason when one rung is wrong', () => {
    const readings = [
      ...clean(),
      ...judgeRungPlaylists(
        [rungPlaylistParse(feedOf('720p', TOPIC_720), rungPlaylist([0, 1, 2], { mediaSequence: 317 }))],
        FIRST_PLAYLIST,
      ),
    ];

    const refusal = rungPlaylistRefusal(readings);

    assert.match(refusal ?? '', /720p/);
    assert.match(refusal ?? '', /#EXT-X-MEDIA-SEQUENCE:317 rather than 0/);
  });

  /**
   * ⛔ An empty list is a check that was never made, and it must not read as a check that passed.
   * A suite whose log window held no announce reaches here with nothing, and the whole point of
   * wiring the contract into a paid sitting is lost if that is green.
   */
  it('refuses a run that read no playlist at all rather than passing it', () => {
    assert.match(rungPlaylistRefusal([]) ?? '', /no rung feed/);
  });

  it('refuses a ladder where one rung could not be read, however sound the others are', () => {
    const readings = [
      ...clean(),
      ...judgeRungPlaylists([rungPlaylistParse(feedOf('720p', TOPIC_720), '')], FIRST_PLAYLIST),
    ];

    assert.match(rungPlaylistRefusal(readings) ?? '', /720p/);
  });
});

describe('what a wired suite prints', () => {
  it('gives one line per rung, with the sequence and the span of dates it holds', () => {
    const summary = describeRungPlaylists([rungPlaylistParse(feedOf('360p', TOPIC_360), rungPlaylist([0, 1, 2]))]);

    assert.match(summary, /360p/);
    assert.match(summary, /#EXT-X-MEDIA-SEQUENCE:0/);
    assert.match(summary, new RegExp(fixtureDateOf(0)));
    assert.match(summary, new RegExp(fixtureDateOf(2)));
    assert.match(summary, /3 segments/);
  });

  it('says which rung read a recording and which read a live playlist', () => {
    const summary = describeRungPlaylists([
      rungPlaylistParse(feedOf('360p', TOPIC_360), rungPlaylist([0, 1], { recording: true })),
      rungPlaylistParse(feedOf('1080p', TOPIC_1080), rungPlaylist([0, 1])),
    ]);

    assert.match(summary, /360p.*recording/);
    assert.match(summary, /1080p.*live/);
  });

  it('says a rung read nothing rather than leaving its line blank', () => {
    const summary = describeRungPlaylists([rungPlaylistParse(feedOf('720p', TOPIC_720), '')]);

    assert.match(summary, /720p/);
    assert.match(summary, /nothing/);
  });

  it('calls a single-rendition broadcast by what it is, having no rung name to use', () => {
    const summary = describeRungPlaylists([
      rungPlaylistParse({ rung: null, streamId: null, topic: TOPIC_360 }, rungPlaylist([0])),
    ]);

    assert.match(summary, /single rendition/);
  });
});

const roots: string[] = [];

after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function config(env: NodeJS.ProcessEnv = {}): E2EConfig {
  const rootDir = mkdtempSync(join(tmpdir(), 'e2e-manifest-live-'));
  roots.push(rootDir);
  return loadConfig({ env, rootDir });
}

/** What one gateway read was asked for, and when it happened relative to the log re-read. */
type Step = { readonly feed: string } | { readonly log: true };

/** A Host that answers every feed read with one playlist and records the order it was asked. */
function stubHost(playlist: string, steps: Step[]): Host {
  return {
    localText: async (_port: number, path: string) => {
      steps.push({ feed: path });
      return playlist;
    },
  } as unknown as Host;
}

describe('the one call a live suite makes', () => {
  const cfg = config({ E2E_EXPECT_ABR: 'true', E2E_EXPECT_SEGMENT_S: String(FIXTURE_FRAGMENT_SECONDS) });
  const OWNER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

  /**
   * ⛔⛔ The ordering rule, pinned because getting it wrong reds a correct product rather than
   * failing loudly. A count read before the playlists can be lower than what the broadcast had
   * published by the time they were fetched, which calls a slid window a first playlist and then
   * demands a sequence of 0 the uploader was right to have moved past.
   */
  it('re-reads the log only once every playlist is in hand', async () => {
    const steps: Step[] = [];
    const host = stubHost(rungPlaylist([0, 1, 2]), steps);

    await checkPublishedTimeline(host, cfg, {
      owner: OWNER,
      rungs: [feedOf('360p', TOPIC_360), feedOf('1080p', TOPIC_1080)],
      expectation: cfg.segmentExpectation,
      logAfterTheRead: async () => {
        steps.push({ log: true });
        return uploadLines('live/stream_360p', 3);
      },
    });

    assert.deepEqual(
      steps.map((step) => ('log' in step ? 'log' : 'feed')),
      ['feed', 'feed', 'log'],
    );
  });

  it('passes a ladder whose rungs each named every segment they published', async () => {
    const verdict = await checkPublishedTimeline(stubHost(rungPlaylist([0, 1, 2]), []), cfg, {
      owner: OWNER,
      rungs: [feedOf('360p', TOPIC_360)],
      expectation: cfg.segmentExpectation,
      logAfterTheRead: async () => uploadLines('live/stream_360p', 3),
    });

    assert.equal(verdict.refusal, null);
    assert.match(verdict.summary, /360p/);
  });

  /**
   * Without the counts nothing can show a live window has not slid, so sequence 0 is asked of
   * recordings alone. A live playlist opening on the engine's own counter passes here, and that is
   * the assertion a suite gives up by not re-reading its log rather than a hole in the contract.
   */
  it('leaves a live playlist’s sequence alone when the suite offers no counts', async () => {
    const engineCounter = rungPlaylist([0, 1, 2], { mediaSequence: 580 });

    const verdict = await checkPublishedTimeline(stubHost(engineCounter, []), cfg, {
      owner: OWNER,
      rungs: [feedOf('360p', TOPIC_360)],
      expectation: cfg.segmentExpectation,
    });

    assert.equal(verdict.refusal, null);
  });

  it('refuses that same playlist once the counts show the window has not slid', async () => {
    const engineCounter = rungPlaylist([0, 1, 2], { mediaSequence: 580 });

    const verdict = await checkPublishedTimeline(stubHost(engineCounter, []), cfg, {
      owner: OWNER,
      rungs: [feedOf('360p', TOPIC_360)],
      expectation: cfg.segmentExpectation,
      logAfterTheRead: async () => uploadLines('live/stream_360p', 3),
    });

    assert.match(verdict.refusal ?? '', /#EXT-X-MEDIA-SEQUENCE:580 rather than 0/);
  });

  /** `E2E_EXPECT_SEGMENT_S=any` is a declaration, so it is printed and nothing is read at all. */
  it('reads nothing and says so when the run pinned no segment length', async () => {
    const steps: Step[] = [];
    const anyLength = config({ E2E_EXPECT_ABR: 'true', E2E_EXPECT_SEGMENT_S: SEGMENT_ANY });

    const verdict = await checkPublishedTimeline(stubHost(rungPlaylist([0]), steps), anyLength, {
      owner: OWNER,
      rungs: [feedOf('360p', TOPIC_360)],
      expectation: anyLength.segmentExpectation,
    });

    assert.deepEqual(steps, []);
    assert.equal(verdict.refusal, null);
    assert.match(verdict.summary, /E2E_EXPECT_SEGMENT_S/);
  });

  it('refuses a broadcast that announced no rung feed rather than reporting a pass', async () => {
    const verdict = await checkPublishedTimeline(stubHost(rungPlaylist([0]), []), cfg, {
      owner: OWNER,
      rungs: [],
      expectation: cfg.segmentExpectation,
    });

    assert.match(verdict.refusal ?? '', /no rung feed/);
  });
});
