import { manifestUploaded, segmentsNeverArrived, segmentUploaded, segmentUploadFailed } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { firstManifestAtOrAfter, segmentByRef, uploadTimeline } from '../src/bench/timeline.js';
import { timestampedMessages } from '../src/harness/logwatch.js';

/** One line the uploader wrote: the instant it was written at, and the message text. */
type LoggedLine = readonly [atIso: string, message: string];

/** `Logger`'s text format, `[ts] [LEVEL] - message`. */
function asTextLog(lines: readonly LoggedLine[], level = 'LOG'): string {
  return lines.map(([atIso, message]) => `[${atIso}] [${level}] - ${message}`).join('\n');
}

/** `Logger`'s `LOG_FORMAT=json` format, which the timestamp reader has to see through. */
function asJsonLog(lines: readonly LoggedLine[], level = 'log'): string {
  return lines.map(([atIso, message]) => JSON.stringify({ ts: atIso, level, msg: message })).join('\n');
}

const STREAM = 'live/stream_720p';
/** A second rung, so a ladder log can be built with two of everything interleaved. */
const OTHER_STREAM = 'live/stream_360p';

const AT_SEGMENT_41 = Date.parse('2026-08-02T19:38:00.000Z');
const AT_MANIFEST_12 = Date.parse('2026-08-02T19:38:00.900Z');
const AT_SEGMENT_42 = Date.parse('2026-08-02T19:38:02.000Z');
const AT_MANIFEST_13 = Date.parse('2026-08-02T19:38:02.750Z');

/**
 * One rung publishing, in both envelopes `Logger` can be configured to write.
 *
 * The bench reads timestamps out of these lines, so both formats are pinned: `LOG_FORMAT` is an
 * operator's choice and neither value may quietly halve what the bench can measure.
 *
 * ⛔ Composed through the shared log contract rather than pasted from a capture, because a pasted
 * fixture tests the parser against itself. These were a 2026-08-02 capture until 2026-09-01, by
 * which point the segment line had carried a stream id for five weeks and `RE_SEGMENT_UPLOADED` had
 * not: the bench read zero segments off every real log and measured no capture-to-fetchable latency
 * at all, while these tests stayed green against the shape nothing wrote any more.
 */
const ONE_RUNG: readonly LoggedLine[] = [
  ['2026-08-02T19:38:00.000Z', segmentUploaded(STREAM, 41, '9f2c1a')],
  ['2026-08-02T19:38:00.900Z', manifestUploaded(STREAM, 12)],
  ['2026-08-02T19:38:02.000Z', segmentUploaded(STREAM, 42, 'bb0417')],
  ['2026-08-02T19:38:02.750Z', manifestUploaded(STREAM, 13)],
];

const TEXT_LOG = asTextLog(ONE_RUNG);
const JSON_LOG = asJsonLog(ONE_RUNG);

/**
 * Two rungs of a ladder in one log, each with its own segment counter and its own SOC counter.
 *
 * Both counters restart per rung, which is why the two messages carry a stream id at all. The 360p
 * rung deliberately publishes between the 720p segment landing and the 720p rung publishing, which
 * is the arrangement a stream-blind reader gets wrong.
 */
const LADDER: readonly LoggedLine[] = [
  ['2026-08-02T19:38:00.000Z', segmentUploaded(STREAM, 41, '9f2c1a')],
  ['2026-08-02T19:38:00.100Z', segmentUploaded(OTHER_STREAM, 41, '77aa01')],
  ['2026-08-02T19:38:00.400Z', manifestUploaded(OTHER_STREAM, 7)],
  ['2026-08-02T19:38:00.900Z', manifestUploaded(STREAM, 12)],
  ['2026-08-02T19:38:02.000Z', segmentUploaded(STREAM, 42, 'bb0417')],
  ['2026-08-02T19:38:02.100Z', segmentUploaded(OTHER_STREAM, 42, '77aa02')],
  ['2026-08-02T19:38:02.400Z', manifestUploaded(OTHER_STREAM, 8)],
  ['2026-08-02T19:38:02.750Z', manifestUploaded(STREAM, 13)],
];

describe('reading when the uploader did each thing', () => {
  for (const [format, log] of [
    ['text', TEXT_LOG],
    ['json', JSON_LOG],
  ] as const) {
    it(`pairs every segment with its instant, at LOG_FORMAT=${format}`, () => {
      const timeline = uploadTimeline(log);

      assert.deepEqual(timeline.segments, [
        { index: 41, streamId: STREAM, ref: '9f2c1a', atMs: AT_SEGMENT_41 },
        { index: 42, streamId: STREAM, ref: 'bb0417', atMs: AT_SEGMENT_42 },
      ]);
    });

    it(`pairs every manifest publish with its instant, at LOG_FORMAT=${format}`, () => {
      const timeline = uploadTimeline(log);

      assert.deepEqual(timeline.manifests, [
        { socIndex: 12, streamId: STREAM, atMs: AT_MANIFEST_12 },
        { socIndex: 13, streamId: STREAM, atMs: AT_MANIFEST_13 },
      ]);
    });
  }

  /**
   * The reference is the key, not the index. A playlist index repeats on every broadcast, so pairing
   * a measurement with an upload by index would happily match a previous stream's line out of the
   * same `docker logs` tail and report its latency instead.
   */
  it('finds a segment by the reference the manifest actually named', () => {
    const timeline = uploadTimeline(TEXT_LOG);

    assert.equal(segmentByRef(timeline, 'bb0417')?.index, 42);
    assert.equal(segmentByRef(timeline, 'not-a-ref'), undefined);
  });

  it('takes the first manifest published at or after an upload', () => {
    const timeline = uploadTimeline(TEXT_LOG);

    assert.equal(firstManifestAtOrAfter(timeline, STREAM, AT_SEGMENT_41)?.socIndex, 12);
    assert.equal(firstManifestAtOrAfter(timeline, STREAM, AT_MANIFEST_12)?.socIndex, 12);
    assert.equal(firstManifestAtOrAfter(timeline, STREAM, AT_MANIFEST_12 + 1)?.socIndex, 13);
  });

  it('reports no manifest rather than an earlier one when none followed', () => {
    const timeline = uploadTimeline(TEXT_LOG);

    assert.equal(firstManifestAtOrAfter(timeline, STREAM, Date.parse('2026-08-02T19:40:00.000Z')), undefined);
  });

  /**
   * The one shape that could pair a segment with a stranger's timestamp. A dropped segment logs
   * `Failed to upload segment 42 …`, which contains the same two words as a success in the same
   * order, and a discontinuity line names an index too. Composed through the same contract the
   * uploader writes them with, so a reworded failure line cannot leave this proving nothing.
   */
  it('ignores the failure lines that also name a segment', () => {
    const withFailures = asTextLog(
      [
        ['2026-08-02T19:38:00.000Z', segmentUploadFailed(STREAM, 41)],
        ['2026-08-02T19:38:01.000Z', segmentsNeverArrived('3 segments from index 42', STREAM)],
        ['2026-08-02T19:38:02.000Z', segmentUploaded(STREAM, 45, 'cc9911')],
      ],
      'ERROR',
    );

    const timeline = uploadTimeline(withFailures);

    assert.deepEqual(
      timeline.segments.map((s) => s.index),
      [45],
    );
  });
});

describe('reading a ladder, where four rungs share one log', () => {
  /**
   * Each rung counts its own segments from zero, so every index appears once per rung. A reader that
   * dropped the stream id would report index 41 twice with no way to say which rung either belonged
   * to, which is what the pre-ladder pattern here did until it stopped matching altogether.
   */
  it('keeps two interleaved rungs apart', () => {
    const timeline = uploadTimeline(asTextLog(LADDER));

    assert.deepEqual(timeline.segments, [
      { index: 41, streamId: STREAM, ref: '9f2c1a', atMs: AT_SEGMENT_41 },
      { index: 41, streamId: OTHER_STREAM, ref: '77aa01', atMs: Date.parse('2026-08-02T19:38:00.100Z') },
      { index: 42, streamId: STREAM, ref: 'bb0417', atMs: AT_SEGMENT_42 },
      { index: 42, streamId: OTHER_STREAM, ref: '77aa02', atMs: Date.parse('2026-08-02T19:38:02.100Z') },
    ]);
    assert.deepEqual(
      timeline.manifests.map((manifest) => [manifest.streamId, manifest.socIndex]),
      [
        [OTHER_STREAM, 7],
        [STREAM, 12],
        [OTHER_STREAM, 8],
        [STREAM, 13],
      ],
    );
  });

  /** Refs stay unique per segment across rungs, so the ref-keyed lookup needs no rung of its own. */
  it('still finds a segment by reference alone', () => {
    const timeline = uploadTimeline(asTextLog(LADDER));

    assert.equal(segmentByRef(timeline, '77aa02')?.streamId, OTHER_STREAM);
    assert.equal(segmentByRef(timeline, 'bb0417')?.streamId, STREAM);
  });

  /**
   * ⛔ The reason `firstManifestAtOrAfter` takes a stream. The 360p rung publishes 400ms after the
   * 720p segment lands and 500ms before the 720p rung publishes its own manifest, so a stream-blind
   * lookup times a feed write that never named this segment, and reports a `manifestPublish` hop
   * that shrinks towards zero as rungs are added.
   */
  it('times a segment against its own rung, not the next rung to publish', () => {
    const timeline = uploadTimeline(asTextLog(LADDER));

    assert.deepEqual(firstManifestAtOrAfter(timeline, STREAM, AT_SEGMENT_41), {
      socIndex: 12,
      streamId: STREAM,
      atMs: AT_MANIFEST_12,
    });
    assert.equal(firstManifestAtOrAfter(timeline, OTHER_STREAM, AT_SEGMENT_41)?.socIndex, 7);
  });

  it('reports no manifest for a rung that published none, rather than a sibling rung', () => {
    const timeline = uploadTimeline(asTextLog(LADDER));

    assert.equal(firstManifestAtOrAfter(timeline, 'live/stream_1080p', AT_SEGMENT_41), undefined);
  });
});

describe('reading the instant off a log line', () => {
  it('drops a line carrying no timestamp of its own rather than dating it from a neighbour', () => {
    const withContinuation = [
      '[2026-08-02T19:38:00.000Z] [ERROR] - Upload failed',
      '    at uploadDataToBee (foo.js:1)',
    ].join('\n');

    assert.deepEqual(
      timestampedMessages(withContinuation).map((line) => line.message),
      ['Upload failed'],
    );
  });

  it('drops a line whose timestamp is not a date, rather than reading it as NaN', () => {
    assert.deepEqual(timestampedMessages('[not-a-date] [LOG] - Segment 1 uploaded: aa'), []);
  });

  it('unwraps a JSON envelope without mistaking an embedded payload for one', () => {
    const embedded =
      '[2026-08-02T19:38:00.000Z] [INFO] - Adding stream to list: {"title":"02/08/2026","topic":"abc","state":"live"}';

    assert.equal(
      timestampedMessages(embedded)[0].message,
      'Adding stream to list: {"title":"02/08/2026","topic":"abc","state":"live"}',
    );
  });

  it('survives the truncated final line of a docker logs tail', () => {
    const truncated = [
      '{"ts":"2026-08-02T19:38:00.000Z","level":"log","msg":"Segment 1 uploaded: aa"}',
      '{"ts":"2026-08',
    ].join('\n');

    assert.equal(timestampedMessages(truncated).length, 1);
  });
});
