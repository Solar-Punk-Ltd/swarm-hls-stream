import {
  ladderFinalized,
  publishingRendition,
  rungAnnounced,
  segmentUploaded,
  updatingStreamToVod,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  announcedRungs,
  announcedSessionTopics,
  announcedVodFinalizeCount,
  ladderRungs,
  lastUploadedSegmentRefByRung,
  publishedRenditions,
  segmentIndicesByStream,
  segmentUploads,
  sessionEnds,
  vodFinalizeCount,
  vodFinalizeCountFor,
} from '../src/harness/logwatch.js';

/**
 * The ladder half of the log parsers, which arrived with the ABR merge and had nothing reading it.
 *
 * ⛔ The fixtures are built with `publishingRendition`, the same composer the uploader logs through,
 * not with a hand-typed copy of the sentence. A hand-typed fixture tests the parser against itself:
 * both halves can drift away from the uploader together and stay green while the harness matches
 * nothing on a real log. That is the exact shape `logwatch.ts` was already bitten by over JSON
 * envelopes, where a scenario blamed the uploader for never announcing a stream it had announced.
 */

/** `Logger`'s text format: `[ts] [LEVEL] - message`. */
function textLine(message: string): string {
  return `[2026-08-25T09:14:05.123Z] [INFO] - ${message}`;
}

/** `Logger`'s `LOG_FORMAT=json` format, which the parsers have to see through. */
function jsonLine(message: string): string {
  return JSON.stringify({ ts: '2026-08-25T09:14:05.123Z', level: 'info', msg: message });
}

const LADDER = 'group-7';
const RUNGS = ['360p', '480p', '720p', '1080p'];

describe('publishedRenditions', () => {
  it('reads a rung and its ladder out of the text format', () => {
    const log = textLine(publishingRendition('720p', LADDER));

    assert.deepEqual(publishedRenditions(log), [{ rung: '720p', ladder: LADDER }]);
  });

  it('reads them out of the JSON format too, since a deployment chooses which one it writes', () => {
    const log = jsonLine(publishingRendition('720p', LADDER));

    assert.deepEqual(publishedRenditions(log), [{ rung: '720p', ladder: LADDER }]);
  });

  it('keeps every publish, in order, so a rung that stopped publishing is visible', () => {
    const log = [...RUNGS, '360p', '480p'].map((rung) => textLine(publishingRendition(rung, LADDER))).join('\n');

    assert.deepEqual(
      publishedRenditions(log).map((p) => p.rung),
      [...RUNGS, '360p', '480p'],
    );
  });

  it('finds nothing in a single-rendition broadcast, which logs no rung at all', () => {
    const log = [textLine('Segment 3 uploaded: bzz://a1b2c3'), textLine('Manifest uploaded at SOC index 4')].join('\n');

    assert.deepEqual(publishedRenditions(log), []);
  });

  it('is not fooled by a failure line mentioning the same words', () => {
    const log = textLine('Failed to publish rendition 720p of ladder group-7 after 3 attempts');

    assert.deepEqual(publishedRenditions(log), []);
  });
});

describe('ladderRungs', () => {
  it('deduplicates, so the answer is how wide the ladder is and not how long it ran', () => {
    const log = [...RUNGS, ...RUNGS, ...RUNGS].map((rung) => textLine(publishingRendition(rung, LADDER))).join('\n');

    assert.deepEqual(ladderRungs(log), RUNGS);
  });

  it('scopes to one ladder, so a second broadcast in the same log is not counted into the first', () => {
    const log = [
      ...RUNGS.map((rung) => publishingRendition(rung, LADDER)),
      ...['360p', '720p'].map((rung) => publishingRendition(rung, 'group-8')),
    ]
      .map(textLine)
      .join('\n');

    assert.deepEqual(ladderRungs(log, LADDER), RUNGS);
    assert.deepEqual(ladderRungs(log, 'group-8'), ['360p', '720p']);
  });

  it('reports every ladder when asked for none, which is what a preflight wants', () => {
    const log = [publishingRendition('360p', LADDER), publishingRendition('720p', 'group-8')].map(textLine).join('\n');

    assert.deepEqual(ladderRungs(log).sort(), ['360p', '720p']);
  });

  it('answers empty for a ladder that never published, rather than falling back to all of them', () => {
    const log = RUNGS.map((rung) => textLine(publishingRendition(rung, LADDER))).join('\n');

    assert.deepEqual(ladderRungs(log, 'group-never'), []);
  });
});

describe('announcedRungs', () => {
  const announce = (stream: string, rung: string, topic: string): string =>
    `[StreamOrchestrator] ${rungAnnounced(stream, rung, LADDER, topic)}`;

  it('reads stream, rung, ladder and topic out of the text format, prefix and all', () => {
    const log = textLine(announce('live/stream_720p', '720p', 'topic-1'));

    assert.deepEqual(announcedRungs(log), [
      { streamId: 'live/stream_720p', rung: '720p', ladder: LADDER, topic: 'topic-1' },
    ]);
  });

  it('reads the JSON format too', () => {
    const log = jsonLine(announce('live/stream_360p', '360p', 'topic-2'));

    assert.equal(announcedRungs(log)[0]?.topic, 'topic-2');
  });

  it('keeps every announce, so a recovered session is visible as the same rung on a fresh topic', () => {
    const log = [announce('live/stream_720p', '720p', 'before'), announce('live/stream_720p', '720p', 'after')]
      .map(textLine)
      .join('\n');

    assert.deepEqual(
      announcedRungs(log).map((a) => a.topic),
      ['before', 'after'],
    );
  });

  it('is not fooled by an unpublish naming the same stream', () => {
    assert.deepEqual(announcedRungs(textLine('[SRS] Rung unpublished: live/stream_720p')), []);
  });
});

describe('segmentUploads', () => {
  it('scopes indices to their stream across an interleaved ladder log', () => {
    const log = [
      segmentUploaded('live/stream_720p', 1, 'r1'),
      segmentUploaded('live/stream_360p', 1, 'r2'),
      segmentUploaded('live/stream_720p', 2, 'r3'),
      segmentUploaded('live/stream_360p', 3, 'r4'),
    ]
      .map(textLine)
      .join('\n');

    const uploads = segmentUploads(log);

    assert.deepEqual(
      uploads.filter((u) => u.streamId === 'live/stream_720p').map((u) => u.index),
      [1, 2],
    );
    assert.deepEqual(
      uploads.filter((u) => u.streamId === 'live/stream_360p').map((u) => u.index),
      [1, 3],
    );
  });

  it('reads the JSON format', () => {
    const log = jsonLine(segmentUploaded('live/stream', 7, 'ref'));

    assert.deepEqual(segmentUploads(log), [{ streamId: 'live/stream', index: 7, reference: 'ref' }]);
  });

  /**
   * The pre-ladder line named no stream, so it cannot be attributed and is deliberately not parsed:
   * a harness pointed at a deployment older than the contract must read zero segments and fail
   * loudly in warmup, not attribute every rung's segments to nobody.
   */
  it('reads nothing from the pre-ladder line shape', () => {
    assert.deepEqual(segmentUploads(textLine('Segment 5 uploaded: bzz://a1b2c3')), []);
  });
});

describe('vodFinalizeCount', () => {
  it('counts a single-rendition finalize and a ladder flip as one each, in either format', () => {
    const log = [
      textLine(updatingStreamToVod('{"topic":"t","state":"vod"}')),
      jsonLine(ladderFinalized('group-3')),
    ].join('\n');

    assert.equal(vodFinalizeCount(log), 2);
  });

  it('counts a ladder once, not once per rung publish', () => {
    const log = [
      textLine(publishingRendition('360p', 'g1')),
      textLine(publishingRendition('720p', 'g1')),
      textLine(ladderFinalized('g1')),
    ].join('\n');

    assert.equal(vodFinalizeCount(log), 1);
  });
});

/**
 * ⛔ The unscoped count above reads EVERY broadcast's flip in the window. Scenario H went red on
 * exactly that on 2026-08-28: the two-streams scenario's flips trailed into H's window, H counted
 * a neighbour and reported one recording published twice, which the uploader's log disproved.
 */
describe('vodFinalizeCountFor', () => {
  it('does not count a neighbouring broadcast whose flip trails into the window', () => {
    const log = [
      textLine(`[StreamOrchestrator] ${rungAnnounced('live/stream_720p', '720p', 'g-ours', 't-ours')}`),
      jsonLine(ladderFinalized('g-neighbour')),
      textLine(ladderFinalized('g-ours')),
    ].join('\n');

    assert.equal(vodFinalizeCountFor(log, ['t-ours']), 1);
  });

  it('still counts the same ladder flipping twice, the double publish it exists to catch', () => {
    const log = [
      textLine(`[StreamOrchestrator] ${rungAnnounced('live/stream_720p', '720p', 'g-ours', 't-ours')}`),
      textLine(ladderFinalized('g-ours')),
      textLine(ladderFinalized('g-ours')),
    ].join('\n');

    assert.equal(vodFinalizeCountFor(log, ['t-ours']), 2);
  });

  it('counts a recovery that republished under a fresh group, when its topics are given', () => {
    const log = [
      textLine(`[StreamOrchestrator] ${rungAnnounced('live/stream_720p', '720p', 'g1', 't-before')}`),
      textLine(ladderFinalized('g1')),
      textLine(`[StreamOrchestrator] ${rungAnnounced('live/stream_720p', '720p', 'g2', 't-recovered')}`),
      textLine(ladderFinalized('g2')),
    ].join('\n');

    assert.equal(vodFinalizeCountFor(log, ['t-before', 't-recovered']), 2);
  });

  it('scopes the single-rendition flip by the topic inside its entry JSON', () => {
    const log = [
      textLine(updatingStreamToVod('{"topic":"t-ours","state":"vod"}')),
      textLine(updatingStreamToVod('{"topic":"t-other","state":"vod"}')),
    ].join('\n');

    assert.equal(vodFinalizeCountFor(log, ['t-ours']), 1);
  });
});

describe('announcedVodFinalizeCount', () => {
  it('counts the flips of broadcasts announced in the window and nothing else', () => {
    const log = [
      textLine(`[StreamOrchestrator] ${rungAnnounced('live/stream_720p', '720p', 'g-ours', 't-ours')}`),
      textLine(ladderFinalized('g-neighbour')),
      textLine(ladderFinalized('g-ours')),
    ].join('\n');

    assert.equal(announcedVodFinalizeCount(log), 1);
  });
});

describe('announcedSessionTopics', () => {
  it('prefers the single-rendition announce when one exists', () => {
    const log = textLine(
      'Adding stream to list: {"topic":"single-t","owner":"o","state":"live","title":"x","mediatype":"video","timestamp":1,"index":0}',
    );

    assert.deepEqual(announcedSessionTopics(log), ['single-t']);
  });

  it('falls back to the rung topics under a ladder, which never writes the single announce', () => {
    const log = [
      textLine(`[StreamOrchestrator] ${rungAnnounced('live/stream_720p', '720p', 'g', 't-720')}`),
      textLine(`[StreamOrchestrator] ${rungAnnounced('live/stream_360p', '360p', 'g', 't-360')}`),
    ].join('\n');

    assert.deepEqual(announcedSessionTopics(log), ['t-720', 't-360']);
  });
});

describe('sessionEnds', () => {
  it('reads both ways a session ends, with their stream ids', () => {
    const log = [
      textLine('[StreamOrchestrator] Stopped stream: live/stream_720p'),
      textLine('[StreamOrchestrator] Finalized the replaced session for live/stream_360p'),
      textLine(
        '[StreamOrchestrator] The session replaced under live/stream_480p was not finalized, so its broadcast has no VOD: x',
      ),
    ].join('\n');

    assert.deepEqual(sessionEnds(log).sort(), ['live/stream_360p', 'live/stream_720p']);
  });
});

describe('segmentIndicesByStream', () => {
  it('keeps each stream its own ordered sequence out of an interleaved log', () => {
    const log = [
      segmentUploaded('live/stream_720p', 35, 'r'),
      segmentUploaded('live/stream_360p', 41, 'r'),
      segmentUploaded('live/stream_720p', 36, 'r'),
    ]
      .map(textLine)
      .join('\n');

    const byStream = segmentIndicesByStream(log);

    assert.deepEqual(byStream.get('live/stream_720p'), [35, 36]);
    assert.deepEqual(byStream.get('live/stream_360p'), [41]);
  });
});

/**
 * ⛔⛔ What a finished recording is judged complete against, and why it is the LAST line per rung.
 *
 * SRS's segment counter runs on across broadcasts, so a log window opened at a broadcast's start also
 * carries the previous broadcast's final segments at indices that continue the sequence. Anything
 * counting lines in that window counts a neighbour's stragglers as this broadcast's media, and on
 * 2026-09-02 exactly one such line made a complete four rung recording read as 2.4s short.
 */
describe('lastUploadedSegmentRefByRung', () => {
  it('takes the last reference each rung published, not the first', () => {
    const log = [
      segmentUploaded('live/stream_1080p', 823, 'ref-823'),
      segmentUploaded('live/stream_360p', 823, 'ref-360-823'),
      segmentUploaded('live/stream_1080p', 824, 'ref-824'),
    ]
      .map(textLine)
      .join('\n');

    const byRung = lastUploadedSegmentRefByRung(log);

    assert.equal(byRung.get('1080p'), 'ref-824');
    assert.equal(byRung.get('360p'), 'ref-360-823');
  });

  /** ⭐ The straggler. It precedes this broadcast's own segments, so the last line is still ours. */
  it('is not reached by a straggler from the broadcast before', () => {
    const log = [
      segmentUploaded('live/stream_1080p', 823, 'the-previous-broadcasts-last-segment'),
      segmentUploaded('live/stream_1080p', 824, 'ours-first'),
      segmentUploaded('live/stream_1080p', 838, 'ours-last'),
    ]
      .map(textLine)
      .join('\n');

    assert.equal(lastUploadedSegmentRefByRung(log).get('1080p'), 'ours-last');
  });

  it('reads the JSON format too, since a deployment chooses which one it writes', () => {
    const log = jsonLine(segmentUploaded('live/stream_480p', 12, 'ref-12'));

    assert.equal(lastUploadedSegmentRefByRung(log).get('480p'), 'ref-12');
  });

  /** A stream id naming no rung is not a rung of a ladder, and keying it by its whole id would say it was. */
  it('leaves out a stream whose id names no rung', () => {
    const log = [segmentUploaded('live/demo', 3, 'ref-3'), segmentUploaded('live/stream_720p', 3, 'ref-720')]
      .map(textLine)
      .join('\n');

    assert.deepEqual([...lastUploadedSegmentRefByRung(log).keys()], ['720p']);
  });
});
