import { addingStreamToList, rungAnnounced } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ManifestContract } from '../src/harness/manifestContract.js';
import {
  describeRungPlaylists,
  fragmentSecondsFor,
  rungFeedsOf,
  rungPlaylistReading,
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
 * suites under `e2e/suites/` are for. `manifestContract.test.ts` owns the contract's own rules; this
 * file owns everything around them.
 */

const CONTRACT: ManifestContract = { fragmentSeconds: FIXTURE_FRAGMENT_SECONDS, firstOfBroadcast: true };
const LADDER = 'ladder-7f21';
const TOPIC_360 = '3e2b0c8a-1111-4a1b-9c3d-000000000360';
const TOPIC_1080 = '3e2b0c8a-2222-4a1b-9c3d-000000001080';

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

describe('finding the feeds a broadcast published', () => {
  it('names one feed per rung of a ladder, with the rung the report should use', () => {
    const feeds = rungFeedsOf(
      ladderLog([
        { rung: '360p', topic: TOPIC_360 },
        { rung: '1080p', topic: TOPIC_1080 },
      ]),
    );

    assert.deepEqual(feeds, [
      { rung: '360p', streamId: 'live/stream_360p', topic: TOPIC_360 },
      { rung: '1080p', streamId: 'live/stream_1080p', topic: TOPIC_1080 },
    ]);
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

    assert.deepEqual(feeds, [{ rung: '360p', streamId: 'live/stream_360p', topic: resumed }]);
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
  const feed = { rung: '360p', streamId: 'live/stream_360p', topic: TOPIC_360 };

  it('passes a live playlist that opens at zero and steps by the fragment', () => {
    const reading = rungPlaylistReading(feed, rungPlaylist([0, 1, 2, 3]), CONTRACT);

    assert.deepEqual(reading.failures, []);
    assert.equal(reading.segments, 4);
    assert.equal(reading.mediaSequence, 0);
    assert.equal(reading.firstDate, fixtureDateOf(0));
    assert.equal(reading.lastDate, fixtureDateOf(3));
    assert.equal(reading.recording, false);
  });

  it('hashes the raw topic into the hex the gateway answers for', () => {
    assert.match(rungPlaylistReading(feed, rungPlaylist([0]), CONTRACT).topicHex, /^[0-9a-f]{64}$/);
  });

  it('reports a finished recording as one', () => {
    const reading = rungPlaylistReading(feed, rungPlaylist([0, 1, 2], { recording: true }), CONTRACT);

    assert.equal(reading.recording, true);
    assert.deepEqual(reading.failures, []);
  });

  /**
   * The closing live playlist carries an `#EXT-X-ENDLIST` too, and it is published at the feed index
   * BEFORE the recording. Reading it as a recording would then require sequence 0 of a window that
   * has legitimately slid.
   */
  it('does not call the closing live playlist a recording, whatever its ENDLIST says', () => {
    const closing = rungPlaylist([12, 13, 14], { mediaSequence: 12, closed: true });

    const reading = rungPlaylistReading(feed, closing, { ...CONTRACT, firstOfBroadcast: false });

    assert.equal(reading.recording, false);
    assert.deepEqual(reading.failures, []);
  });

  /**
   * ⛔ A recording names every segment of the broadcast, so its sequence is 0 by construction and
   * that holds however late the suite read it. Left to the caller's flag, the one playlist whose
   * numbering can always be checked would go unchecked in every suite that reads a finished
   * broadcast, which is every crash scenario that leaves one.
   */
  it('requires zero of a recording even where the suite could not promise a first playlist', () => {
    const renumbered = rungPlaylist([0, 1, 2], { mediaSequence: 580, recording: true });

    const failures = rungPlaylistReading(feed, renumbered, { ...CONTRACT, firstOfBroadcast: false }).failures;

    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /#EXT-X-MEDIA-SEQUENCE:580 rather than 0/);
  });

  it('accepts a live window that has slid, where the suite did not promise a first playlist', () => {
    const slid = rungPlaylist([12, 13, 14], { mediaSequence: 12 });

    assert.deepEqual(rungPlaylistReading(feed, slid, { ...CONTRACT, firstOfBroadcast: false }).failures, []);
  });

  it('carries the contract’s own reasons through, naming the segment it objected to', () => {
    const silent = rungPlaylist([0, 1, 3, 4]);

    const failures = rungPlaylistReading(feed, silent, CONTRACT).failures;

    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /segment 2 is dated 2 fragments after/);
  });

  /**
   * ⛔ The envelope parses as a playlist naming no segments, so a reader that trusted the parse would
   * report an empty timeline the broadcast never published. The body is quoted in the reason, because
   * "no playlist" and "a 404 from a gateway that is restarting" need different answers from a reader.
   */
  it('refuses a gateway error envelope as no playlist rather than as an empty one', () => {
    const reading = rungPlaylistReading(feed, GATEWAY_ERROR_ENVELOPE, CONTRACT);

    assert.equal(reading.playlist, null);
    assert.equal(reading.segments, 0);
    assert.equal(reading.failures.length, 1, reading.failures.join('\n'));
    assert.match(reading.failures[0], /no playlist/);
    assert.match(reading.failures[0], /Not Found/);
  });

  it('refuses an empty body, which is what a timed-out gateway read leaves', () => {
    const reading = rungPlaylistReading(feed, '', CONTRACT);

    assert.equal(reading.playlist, null);
    assert.match(reading.failures[0], /answered nothing/);
  });
});

describe('the verdict over a whole ladder', () => {
  const clean = () => [
    rungPlaylistReading(
      { rung: '360p', streamId: 'live/stream_360p', topic: TOPIC_360 },
      rungPlaylist([0, 1, 2]),
      CONTRACT,
    ),
    rungPlaylistReading(
      { rung: '1080p', streamId: 'live/stream_1080p', topic: TOPIC_1080 },
      rungPlaylist([0, 1, 2]),
      CONTRACT,
    ),
  ];

  it('passes a ladder whose every rung published a sound timeline', () => {
    assert.equal(rungPlaylistRefusal(clean()), null);
  });

  it('names the rung and the reason when one rung is wrong', () => {
    const readings = [
      ...clean(),
      rungPlaylistReading(
        { rung: '720p', streamId: 'live/stream_720p', topic: 'c0ffee0a-4444-4a1b-9c3d-000000000720' },
        rungPlaylist([0, 1, 2], { mediaSequence: 317 }),
        CONTRACT,
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
      rungPlaylistReading(
        { rung: '720p', streamId: 'live/stream_720p', topic: 'c0ffee0a-4444-4a1b-9c3d-000000000720' },
        '',
        CONTRACT,
      ),
    ];

    assert.match(rungPlaylistRefusal(readings) ?? '', /720p/);
  });
});

describe('what a wired suite prints', () => {
  it('gives one line per rung, with the sequence and the span of dates it holds', () => {
    const summary = describeRungPlaylists([
      rungPlaylistReading(
        { rung: '360p', streamId: 'live/stream_360p', topic: TOPIC_360 },
        rungPlaylist([0, 1, 2]),
        CONTRACT,
      ),
    ]);

    assert.match(summary, /360p/);
    assert.match(summary, /#EXT-X-MEDIA-SEQUENCE:0/);
    assert.match(summary, new RegExp(fixtureDateOf(0)));
    assert.match(summary, new RegExp(fixtureDateOf(2)));
    assert.match(summary, /3 segments/);
  });

  it('says which rung read a recording and which read a live playlist', () => {
    const summary = describeRungPlaylists([
      rungPlaylistReading(
        { rung: '360p', streamId: 'live/stream_360p', topic: TOPIC_360 },
        rungPlaylist([0, 1], { recording: true }),
        CONTRACT,
      ),
      rungPlaylistReading(
        { rung: '1080p', streamId: 'live/stream_1080p', topic: TOPIC_1080 },
        rungPlaylist([0, 1]),
        CONTRACT,
      ),
    ]);

    assert.match(summary, /360p.*recording/);
    assert.match(summary, /1080p.*live/);
  });

  it('says a rung read nothing rather than leaving its line blank', () => {
    const summary = describeRungPlaylists([
      rungPlaylistReading({ rung: '720p', streamId: 'live/stream_720p', topic: TOPIC_360 }, '', CONTRACT),
    ]);

    assert.match(summary, /720p/);
    assert.match(summary, /nothing/);
  });

  it('calls a single-rendition broadcast by what it is, having no rung name to use', () => {
    const summary = describeRungPlaylists([
      rungPlaylistReading({ rung: null, streamId: null, topic: TOPIC_360 }, rungPlaylist([0]), CONTRACT),
    ]);

    assert.match(summary, /single rendition/);
  });
});
