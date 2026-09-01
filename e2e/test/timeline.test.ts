import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { firstManifestAtOrAfter, segmentByRef, uploadTimeline } from '../src/bench/timeline.js';
import { timestampedMessages } from '../src/harness/logwatch.js';

/**
 * Both fixtures are output of the uploader's own `formatLine`, captured on 2026-08-02 rather than
 * transcribed from the format string. The bench reads timestamps out of these lines, so the two
 * formats a deployment can be configured into are both pinned: `LOG_FORMAT` is an operator's choice
 * and neither value may quietly halve what the bench can measure.
 *
 * ⚠️ The manifest lines were rewritten by hand on 2026-09-01 when the message gained its stream id,
 * so they are composed rather than captured. The segment lines are still the 2026-08-02 capture and
 * carry the **pre-ladder** shape, which is a live defect rather than an old fixture: the bench's
 * `RE_SEGMENT_UPLOADED` still matches only that shape, so on a ladder it reads zero segments and
 * measures nothing. Recapture both against a ladder deployment.
 */
const TEXT_LOG = [
  '[2026-08-02T19:38:00.000Z] [LOG] - Segment 41 uploaded: 9f2c1a',
  '[2026-08-02T19:38:00.900Z] [LOG] - Manifest of live/stream_720p uploaded at SOC index 12',
  '[2026-08-02T19:38:02.000Z] [LOG] - Segment 42 uploaded: bb0417',
  '[2026-08-02T19:38:02.750Z] [LOG] - Manifest of live/stream_720p uploaded at SOC index 13',
].join('\n');

const JSON_LOG = [
  '{"ts":"2026-08-02T19:38:00.000Z","level":"log","msg":"Segment 41 uploaded: 9f2c1a"}',
  '{"ts":"2026-08-02T19:38:00.900Z","level":"log","msg":"Manifest of live/stream_720p uploaded at SOC index 12"}',
  '{"ts":"2026-08-02T19:38:02.000Z","level":"log","msg":"Segment 42 uploaded: bb0417"}',
  '{"ts":"2026-08-02T19:38:02.750Z","level":"log","msg":"Manifest of live/stream_720p uploaded at SOC index 13"}',
].join('\n');

const AT_SEGMENT_41 = Date.parse('2026-08-02T19:38:00.000Z');
const AT_MANIFEST_12 = Date.parse('2026-08-02T19:38:00.900Z');

describe('reading when the uploader did each thing', () => {
  for (const [format, log] of [
    ['text', TEXT_LOG],
    ['json', JSON_LOG],
  ] as const) {
    it(`pairs every segment with its instant, at LOG_FORMAT=${format}`, () => {
      const timeline = uploadTimeline(log);

      assert.deepEqual(timeline.segments, [
        { index: 41, ref: '9f2c1a', atMs: AT_SEGMENT_41 },
        { index: 42, ref: 'bb0417', atMs: Date.parse('2026-08-02T19:38:02.000Z') },
      ]);
    });

    it(`pairs every manifest publish with its instant, at LOG_FORMAT=${format}`, () => {
      const timeline = uploadTimeline(log);

      assert.deepEqual(timeline.manifests, [
        { socIndex: 12, streamId: 'live/stream_720p', atMs: AT_MANIFEST_12 },
        { socIndex: 13, streamId: 'live/stream_720p', atMs: Date.parse('2026-08-02T19:38:02.750Z') },
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

    assert.equal(firstManifestAtOrAfter(timeline, AT_SEGMENT_41)?.socIndex, 12);
    assert.equal(firstManifestAtOrAfter(timeline, AT_MANIFEST_12)?.socIndex, 12);
    assert.equal(firstManifestAtOrAfter(timeline, AT_MANIFEST_12 + 1)?.socIndex, 13);
  });

  it('reports no manifest rather than an earlier one when none followed', () => {
    const timeline = uploadTimeline(TEXT_LOG);

    assert.equal(firstManifestAtOrAfter(timeline, Date.parse('2026-08-02T19:40:00.000Z')), undefined);
  });

  /**
   * The one shape that could pair a segment with a stranger's timestamp. A dropped segment logs
   * `Failed to upload segment 42 …`, which contains the same two words as a success in the same
   * order, and a discontinuity line names an index too.
   */
  it('ignores the failure lines that also name a segment', () => {
    const withFailures = [
      '[2026-08-02T19:38:00.000Z] [ERROR] - Failed to upload segment 41 for stream s within the retry window; marking a discontinuity',
      '[2026-08-02T19:38:01.000Z] [ERROR] - 3 segments from index 42 for stream s never reached the uploader, marking a discontinuity',
      '[2026-08-02T19:38:02.000Z] [LOG] - Segment 45 uploaded: cc9911',
    ].join('\n');

    const timeline = uploadTimeline(withFailures);

    assert.deepEqual(
      timeline.segments.map((s) => s.index),
      [45],
    );
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
