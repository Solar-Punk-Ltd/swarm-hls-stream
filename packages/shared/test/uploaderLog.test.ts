import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ladderFinalized,
  ladderFinalizedPattern,
  manifestUploaded,
  manifestUploadedPattern,
  publishingRendition,
  publishingRenditionPattern,
  replacedSessionFinalized,
  replacedSessionFinalizedPattern,
  rungAnnounced,
  rungAnnouncedPattern,
  segmentUploaded,
  segmentUploadedPattern,
  streamStopped,
  streamStoppedPattern,
  updatingStreamToVod,
  updatingStreamToVodPattern,
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
