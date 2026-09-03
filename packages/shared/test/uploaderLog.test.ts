import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addingStreamToList,
  addingStreamToListPattern,
  catalogStateLost,
  catalogStateLostPattern,
  datingReanchored,
  datingReanchoredPattern,
  finalizeResumed,
  finalizeResumedPattern,
  ladderFinalized,
  ladderFinalizedPattern,
  manifestUploaded,
  manifestUploadedPattern,
  omeSegmentLossReported,
  omeSegmentLossReportedPattern,
  originDeclaredDiscontinuity,
  originDeclaredDiscontinuityPattern,
  publishingRendition,
  publishingRenditionPattern,
  replacedSessionFinalized,
  replacedSessionFinalizedPattern,
  rungAnnounced,
  rungAnnouncedPattern,
  segmentDurationUnread,
  segmentsNeverArrived,
  segmentsNeverArrivedPattern,
  segmentUploaded,
  segmentUploadedPattern,
  segmentUploadFailed,
  segmentUploadFailedPattern,
  streamStopped,
  streamStoppedPattern,
  updatingStreamToVod,
  updatingStreamToVodPattern,
  videolessSegmentPattern,
} from '../src/uploaderLog.js';

/**
 * The composer and the matcher are one definition read two ways, so these tests are about the join
 * between them rather than about either half. A message the harness cannot match is the failure this
 * module exists to make impossible.
 */
describe('the rendition publish message', () => {
  it('round-trips a rung and a ladder through the pattern derived from it', () => {
    const found = publishingRenditionPattern().exec(publishingRendition('720p', 'group-1'));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], '720p');
    assert.equal(found[2], 'group-1');
  });

  it('finds every rung of a ladder in one log, in the order they published', () => {
    const log = ['360p', '480p', '720p', '1080p'].map((rung) => publishingRendition(rung, 'g1')).join('\n');

    const rungs = [...log.matchAll(publishingRenditionPattern('g'))].map((match) => match[1]);

    assert.deepEqual(rungs, ['360p', '480p', '720p', '1080p']);
  });

  it('does not match a line that merely mentions a rendition, so a failure is not read as a publish', () => {
    assert.equal(publishingRenditionPattern().test('Failed to publish rendition 720p of ladder g1'), false);
  });

  /**
   * The pattern is assembled from the composer's own output, so the literal half is escaped and the
   * placeholders are the only things that become groups. Written as an assertion because the failure
   * mode is silent: a stray unescaped metacharacter matches nothing and reads as "the uploader never
   * published a rung".
   */
  it('reads the fixed half of the message as literal text', () => {
    const pattern = publishingRenditionPattern();

    assert.ok(pattern.exec(publishingRendition('720p', 'g1')));
    assert.equal(pattern.exec('Publishing rendition X of ladder Y extra')?.[2], 'Y');
    assert.equal(pattern.test('Publishing rendition of ladder g1'), false, 'a missing rung must not match');
  });

  it('captures a name carrying a dot, which a resolution-style rung would', () => {
    const found = publishingRenditionPattern().exec(publishingRendition('720p.hi', 'g.1'));

    assert.equal(found?.[1], '720p.hi');
    assert.equal(found?.[2], 'g.1');
  });
});

describe('the segment upload message', () => {
  /**
   * The stream id is in the message because a ladder is four independent segment counters, and
   * without it four interleaved `Segment N uploaded` lines are indistinguishable. Found 2026-08-27:
   * both per-rung gap checks in the e2e suite read the interleaved mess as chaos, and an operator
   * reading the log cannot attribute a failure to a rung either.
   */
  it('round-trips the index, stream and reference through the derived pattern', () => {
    const found = segmentUploadedPattern().exec(segmentUploaded('live/stream_720p', 42, 'abc123'));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], '42');
    assert.equal(found[2], 'live/stream_720p');
    assert.equal(found[3], 'abc123');
  });

  it('scopes indices to one stream across an interleaved ladder log', () => {
    const log = [
      segmentUploaded('live/stream_720p', 1, 'r1'),
      segmentUploaded('live/stream_360p', 1, 'r2'),
      segmentUploaded('live/stream_720p', 2, 'r3'),
    ].join('\n');

    const of720p = [...log.matchAll(segmentUploadedPattern('g'))]
      .filter((m) => m[2] === 'live/stream_720p')
      .map((m) => Number(m[1]));

    assert.deepEqual(of720p, [1, 2]);
  });

  it('does not match a failed upload, so a retry is not read as a success', () => {
    assert.equal(segmentUploadedPattern().test('Failed to upload segment 5 of live/stream_720p'), false);
  });

  it('does not match the pre-ladder message shape, which carried no stream', () => {
    assert.equal(segmentUploadedPattern().test('Segment 5 uploaded: abc123'), false);
  });
});

describe('the manifest publish message', () => {
  /**
   * ⛔ The same defect the segment line was fixed for on 2026-08-27, left standing on this one until
   * 2026-09-01. A ladder is four independent SOC counters as surely as it is four segment counters,
   * and `Manifest uploaded at SOC index 3` names neither the rung nor the stream. So one rung's
   * manifest publishing could freeze for an entire broadcast while the other three climbed, and the
   * only check on it deduplicated four counters into one set and saw an unbroken run.
   */
  it('round-trips the index and the stream through the derived pattern', () => {
    const found = manifestUploadedPattern().exec(manifestUploaded('live/stream_720p', 7));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    // Stream first, index second: the reverse of the segment pattern, because the words are.
    assert.equal(found[1], 'live/stream_720p');
    assert.equal(found[2], '7');
  });

  it('scopes SOC indices to one rung across an interleaved ladder log', () => {
    const log = [
      manifestUploaded('live/stream_1080p', 0),
      manifestUploaded('live/stream_360p', 0),
      manifestUploaded('live/stream_1080p', 1),
      manifestUploaded('live/stream_360p', 1),
      manifestUploaded('live/stream_360p', 2),
    ].join('\n');

    const of1080p = [...log.matchAll(manifestUploadedPattern('g'))]
      .filter((m) => m[1] === 'live/stream_1080p')
      .map((m) => Number(m[2]));

    assert.deepEqual(of1080p, [0, 1]);
  });

  it('does not match a failed publish, so a retry is not read as a success', () => {
    assert.equal(manifestUploadedPattern().test('Failed to upload manifest at SOC index 4 of live/stream_720p'), false);
  });
});

describe('the rung announce message', () => {
  /**
   * Byte-identical to the line `StreamOrchestrator` has always written, so the pattern derived here
   * matches deployments that predate this composer. It is the only line that carries the topic, and
   * the topic is what tells a recovered session from a retired one: the ladder group survives an
   * engine restart by design, so a matcher scoped to fresh groups reads a healthy recovery as
   * nothing happening (found live 2026-08-27).
   */
  it('round-trips stream, rung, ladder and topic through the derived pattern', () => {
    const found = rungAnnouncedPattern().exec(rungAnnounced('live/stream_480p', '480p', 'g-1', 't-9'));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], 'live/stream_480p');
    assert.equal(found[2], '480p');
    assert.equal(found[3], 'g-1');
    assert.equal(found[4], 't-9');
  });

  it('matches the exact line the deployed orchestrator writes', () => {
    const deployed =
      'live/stream_720p is rung 720p of ladder 5af2be1c-b3be-42f1-a7f3-57324759deb5, topic 48d5696c-f90f-43f5-85f4-62485bd14e40';

    const found = rungAnnouncedPattern().exec(deployed);

    assert.ok(found, 'the composer has drifted from the line the orchestrator writes');
    assert.equal(found[2], '720p');
    assert.equal(found[4], '48d5696c-f90f-43f5-85f4-62485bd14e40');
  });

  it('does not match an unpublish or a mere mention of a rung', () => {
    assert.equal(rungAnnouncedPattern().test('Rung unpublished: live/stream_720p'), false);
    assert.equal(rungAnnouncedPattern().test('live/stream_720p is rung 720p of ladder g-1'), false);
  });
});

describe('the VOD finalize messages', () => {
  it('round-trips the single-rendition entry through the derived pattern, byte-identical to the deployed line', () => {
    const json = '{"topic":"t-1","state":"vod"}';

    const found = updatingStreamToVod(json).match(updatingStreamToVodPattern());

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[0].startsWith('Updating stream in list to VOD: '), true);
    assert.equal(found[1], json);
  });

  /**
   * A ladder flips to VOD only when its last live rung finalizes, and until this line existed the
   * flip was visible nowhere but the catalog feed: an operator could not grep for when a ladder
   * ended, and the clean-stop scenario waited on the single-rendition line forever (2026-08-27).
   */
  it('round-trips the ladder flip through the derived pattern', () => {
    const found = ladderFinalized('group-9').match(ladderFinalizedPattern());

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], 'group-9');
  });

  it('does not read a live ladder upsert as a finalize', () => {
    assert.equal(ladderFinalizedPattern().test('Publishing rendition 720p of ladder group-9'), false);
  });
});

describe('the session-end messages', () => {
  it('round-trip their stream ids and match the exact deployed lines', () => {
    assert.equal(streamStoppedPattern().exec(streamStopped('live/stream_720p'))?.[1], 'live/stream_720p');
    assert.equal(
      replacedSessionFinalizedPattern().exec('Finalized the replaced session for live/stream_360p')?.[1],
      'live/stream_360p',
    );
    assert.equal(streamStoppedPattern().exec('[StreamOrchestrator] Stopped stream: live/stream')?.[1], 'live/stream');
  });

  it('does not read a failed replacement finalize as a success', () => {
    assert.equal(
      replacedSessionFinalizedPattern().test('The session replaced under live/stream_720p was not finalized'),
      false,
    );
  });
});

describe('the catalog announce message', () => {
  const ENTRY = '{"title":"x","owner":"0xabc","topic":"t-1","state":"live"}';

  it('round-trips the entry through the derived pattern, byte-identical to the deployed line', () => {
    const found = addingStreamToListPattern().exec(addingStreamToList(ENTRY));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[0].startsWith('Adding stream to list: '), true);
    assert.equal(found[1], ENTRY);
  });

  /**
   * ⛔ The capture stops at the closing brace rather than at the end of the line, which is what
   * separates this from {@link updatingStreamToVodPattern}. Whatever comes out goes straight into
   * `JSON.parse`, and a parse that throws is caught and skipped, so a capture running past the entry
   * reads as a broadcast the uploader never announced.
   */
  it('captures the entry alone when something follows it on the line', () => {
    const found = addingStreamToListPattern().exec(`${addingStreamToList(ENTRY)} (queued)`);

    assert.equal(found?.[1], ENTRY);
    assert.doesNotThrow(() => JSON.parse(String(found?.[1])));
  });

  it('finds one announce per line across a log holding several', () => {
    const log = ['{"topic":"a","state":"live"}', '{"topic":"b","state":"live"}'].map(addingStreamToList).join('\n');

    assert.equal([...log.matchAll(addingStreamToListPattern('g'))].length, 2);
  });

  it('does not read the VOD update as a fresh announce', () => {
    assert.equal(addingStreamToListPattern().test(updatingStreamToVod(ENTRY)), false);
  });
});

/**
 * ⛔ The property every zero-arm assertion in the e2e suite rests on. `parseUploaderLog` sums matches
 * across these five patterns, and that sum is the number of discontinuities armed only while each
 * message matches exactly one of them. Asserted message by message rather than left to the reader: a
 * pattern that grew into a sibling's line would double a count six suites assert is zero, and a
 * count that is never zero fails nothing, it just stops meaning anything.
 */
describe('the five messages that mean a discontinuity was armed', () => {
  const STREAM = 'live/stream_720p';
  const ARMING: readonly (readonly [string, string])[] = [
    ['a spent retry window', segmentUploadFailed(STREAM, 41)],
    ['one segment that never arrived', segmentsNeverArrived('Segment 42', STREAM)],
    ['several segments that never arrived', segmentsNeverArrived('3 segments from index 42', STREAM)],
    ['the origin declaring one', originDeclaredDiscontinuity(STREAM)],
    ['the OME puller reporting a loss', omeSegmentLossReported('Segments 5 to 7', STREAM, '3 download failures')],
    [
      "the engine's own counter restarting",
      datingReanchored(42, '2026-09-03T12:00:00.000Z', '2026-09-03T12:09:41.317Z'),
    ],
  ];

  const armingPatterns = (): RegExp[] => [
    segmentUploadFailedPattern('g'),
    segmentsNeverArrivedPattern('g'),
    originDeclaredDiscontinuityPattern('g'),
    omeSegmentLossReportedPattern('g'),
    datingReanchoredPattern('g'),
  ];

  for (const [name, message] of ARMING) {
    it(`counts ${name} exactly once across the five patterns`, () => {
      const hits = armingPatterns().reduce((total, re) => total + [...message.matchAll(re)].length, 0);

      assert.equal(hits, 1, `"${message}" matched ${hits} of the five patterns, so the armed count is not a count`);
    });
  }

  it('counts a whole log as the number of messages in it, not as the number of patterns', () => {
    const log = ARMING.map(([, message]) => message).join('\n');
    const hits = armingPatterns().reduce((total, re) => total + [...log.matchAll(re)].length, 0);

    assert.equal(hits, ARMING.length);
  });

  it('round-trips the index and the stream off the one message that names a segment', () => {
    const found = segmentUploadFailedPattern().exec(segmentUploadFailed(STREAM, 41));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    // Index first, stream second: the message names them in that order and the groups follow it.
    assert.equal(found[1], '41');
    assert.equal(found[2], STREAM);
  });

  it('reads no index off the four that name no segment, so a caller cannot invent one', () => {
    for (const message of [
      segmentsNeverArrived('Segment 42', STREAM),
      originDeclaredDiscontinuity(STREAM),
      omeSegmentLossReported('Segment 5', STREAM, 'the origin rolled it out of its playlist window'),
      // A playlist sequence rather than a segment index, and the two are different numbers on
      // purpose. A caller reading this as an index would name the engine's counter, which is what
      // the sequence exists to replace.
      datingReanchored(42, '2026-09-03T12:00:00.000Z', '2026-09-03T12:09:41.317Z'),
    ]) {
      assert.equal(segmentUploadFailedPattern().test(message), false, message);
    }
  });

  it('round-trips the sequence and the two instants off the re-anchoring message', () => {
    const found = datingReanchoredPattern().exec(
      datingReanchored(42, '2026-09-03T12:00:00.000Z', '2026-09-03T12:09:41.317Z'),
    );

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], '42');
    assert.equal(found[2], '2026-09-03T12:00:00.000Z');
    assert.equal(found[3], '2026-09-03T12:09:41.317Z');
  });

  it('round-trips the stream off the origin-declared message', () => {
    assert.equal(originDeclaredDiscontinuityPattern().exec(originDeclaredDiscontinuity(STREAM))?.[1], STREAM);
  });

  it('round-trips the stream off the puller report, whose cause carries spaces', () => {
    const cause = '3 consecutive download failures';
    const found = omeSegmentLossReportedPattern().exec(omeSegmentLossReported('Segments 5 to 7', STREAM, cause));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[2], STREAM);
    assert.equal(found[3], cause);
  });

  /** The puller writes two other lines about the same loss, and neither of them armed anything. */
  it('does not read the puller lines that report a loss it declined to record', () => {
    for (const message of [
      `[OME] Segment 5 lost for ${STREAM} after the puller stopped, not reporting`,
      `[OME] Segment 5 lost for ${STREAM} but no stream is registered to record it`,
    ]) {
      const hits = armingPatterns().reduce((total, re) => total + [...message.matchAll(re)].length, 0);

      assert.equal(hits, 0, message);
    }
  });

  it('does not read an ordinary upload or a mere mention of a discontinuity as an arm', () => {
    const hits = [segmentUploaded(STREAM, 41, 'abc123'), 'Cleared the pending discontinuity for live/stream_720p']
      .map((message) => armingPatterns().reduce((total, re) => total + [...message.matchAll(re)].length, 0))
      .reduce((a, b) => a + b, 0);

    assert.equal(hits, 0);
  });
});

describe('the message for the catalog giving up on its own previous state', () => {
  it('round-trips the feed index and the read count through the derived pattern', () => {
    const found = catalogStateLostPattern().exec(catalogStateLost('12', 3));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], '12');
    assert.equal(found[2], '3');
  });

  /**
   * ⛔ Anchored on the conclusion rather than on the warning. The attempts before it read almost the
   * same and they KEPT the catalog, so a matcher that took them would report a loss that never
   * happened, and the finalize-crash scenario would call a correct finalize count a blind read.
   */
  it('does not read the attempts that still refused to continue', () => {
    const retry =
      '[StreamCatalog] State at index 12 did not read (chunk not found); attempt 2 of 3 before it counts as gone';

    assert.equal(catalogStateLostPattern().test(retry), false);
  });

  it('counts each occurrence, because one boot can lose the catalog more than once', () => {
    const log = [catalogStateLost('12', 3), catalogStateLost('13', 3)].join('\n');

    assert.equal([...log.matchAll(catalogStateLostPattern('g'))].length, 2);
  });
});

describe('the message for a finalize that resumed rather than republished', () => {
  it('round-trips the stream and the SOC index through the derived pattern', () => {
    const found = finalizeResumedPattern().exec(finalizeResumed('live/stream_1080p', 42));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], 'live/stream_1080p');
    assert.equal(found[2], '42');
  });

  /**
   * ⛔ The whole point of the line is that it is NOT a second flip. A reader counting finalizes must
   * not take this one, or the fix for the double publish would read as the double publish.
   */
  it('is not read as a ladder flip or as a single-rendition flip', () => {
    const message = finalizeResumed('live/stream_1080p', 42);

    assert.equal(ladderFinalizedPattern().test(message), false);
    assert.equal(updatingStreamToVodPattern().test(message), false);
  });

  it('counts each occurrence, because a ladder resumes one rung at a time', () => {
    const log = [finalizeResumed('live/stream_720p', 8), finalizeResumed('live/stream_1080p', 9)].join('\n');

    assert.equal([...log.matchAll(finalizeResumedPattern('g'))].length, 2);
  });
});

/**
 * ⛔ Task #40, and the one message here whose reader REFUSES rather than counts. A recording whose
 * opening segments hold no video plays as sound over a blank picture for its whole length, because a
 * player fixes its codec set from the first fragment it parses. `e2e/browser/make-recording.ts` will
 * not hand such a recording back, and it learns of the fault from this line alone.
 *
 * Two faults share the line and only one of them costs the picture, so the pattern is narrowed to the
 * reason. A matcher taking both would refuse a watchable recording and send someone looking for a
 * video problem that is not there.
 */
describe('the message for a segment whose duration could not be read', () => {
  const STREAM = 'live/stream';
  /** The reason `measureSpanTicks` fails a segment with when it carries no video at all. */
  const NO_VIDEO =
    'cannot measure how much media this segment holds: it holds no video packets, so the media never reached the far end';
  /** The other reason the same warning fires: a readable segment whose timestamps are not a segment. */
  const BAD_TIMESTAMPS = 'its timestamps span 95443.7s, which is not a segment';

  it('round-trips the index, stream, declared duration and reason through the derived pattern', () => {
    const found = videolessSegmentPattern().exec(segmentDurationUnread(STREAM, 3, 2.082, NO_VIDEO));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], '3');
    assert.equal(found[2], STREAM);
    assert.equal(found[3], '2.082');
    assert.equal(found[4], NO_VIDEO);
  });

  /**
   * ⛔ The composer has to write the line the deployment already writes, or the migration is a
   * reword: every historical log stops parsing and `make:recording` starts calling a videoless
   * recording good. Copied from a real warning of 2026-08-09.
   */
  it('composes the line the uploader has always written, byte for byte', () => {
    const deployed =
      "[StreamOrchestrator] Cannot read how much media segment 3 of live/stream holds, so 2.082s is being published on the engine's word: cannot measure how much media this segment holds: it holds no video packets, so the media never reached the far end. Reported once per stream; see the segment_durations_unread_total counter for the rate";

    assert.equal(segmentDurationUnread(STREAM, 3, 2.082, NO_VIDEO), deployed);
    assert.equal(videolessSegmentPattern().exec(deployed)?.[1], '3');
  });

  it('does not name a segment whose timestamps were merely unusable', () => {
    assert.equal(videolessSegmentPattern().test(segmentDurationUnread(STREAM, 3, 2, BAD_TIMESTAMPS)), false);
  });

  it('reads an integer declared duration as readily as a fractional one', () => {
    assert.equal(videolessSegmentPattern().exec(segmentDurationUnread(STREAM, 7, 2, NO_VIDEO))?.[1], '7');
  });

  it('scopes the index to the right stream across an interleaved ladder log', () => {
    const log = [
      segmentDurationUnread('live/stream_360p', 4, 1, NO_VIDEO),
      segmentDurationUnread('live/stream_1080p', 9, 1, BAD_TIMESTAMPS),
      segmentDurationUnread('live/stream_720p', 6, 1, NO_VIDEO),
    ].join('\n');

    const found = [...log.matchAll(videolessSegmentPattern('g'))];

    assert.deepEqual(
      found.map((match) => [match[2], Number(match[1])]),
      [
        ['live/stream_360p', 4],
        ['live/stream_720p', 6],
      ],
    );
  });

  it('does not read an ordinary upload or a withheld opening segment as one', () => {
    for (const message of [
      segmentUploaded(STREAM, 3, 'abc123'),
      `[StreamOrchestrator] Segment 3 of ${STREAM} carries no video, so it is withheld rather than published`,
    ]) {
      assert.equal(videolessSegmentPattern().test(message), false, message);
    }
  });
});
