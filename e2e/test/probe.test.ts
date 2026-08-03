import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseProbedSegment, probeArgs } from '../src/bench/probe.js';
import { MPEGTS_WRAP_TICKS } from '../src/bench/wallclock.js';

import {
  NO_VIDEO_SEGMENT,
  OPEN_GOP_TS_SEGMENT,
  REORDERED_FMP4_SEGMENT,
  REORDERED_TS_SEGMENT,
  SINGLE_PACKET_SEGMENT,
  TRUNCATED_SEGMENT,
} from './helpers/probeFixtures.js';

describe('parsing ffprobe output into a timestamped segment', () => {
  it('reads the tick rate of an MPEG-TS segment and the span it holds', () => {
    const segment = parseProbedSegment(REORDERED_TS_SEGMENT, 'seg1.ts');

    assert.equal(segment.firstFrame.timescale, 90_000);
    assert.equal(segment.firstFrame.wrapTicks, MPEGTS_WRAP_TICKS);
    assert.equal(segment.mediaSpanS, 0.5, 'which is the 0.500000 its manifest declared');
    assert.equal(segment.videoPacketCount, 15);
  });

  it('reads a fragmented MP4 at its own tick rate, not at 90kHz', () => {
    const segment = parseProbedSegment(REORDERED_FMP4_SEGMENT, 'seg1.m4s');

    assert.equal(segment.firstFrame.timescale, 15_360);
    // The same half second, and it only comes out that way if the span is divided by the rate the
    // container declared. Read as 90kHz it would be 0.083s, which is a plausible-looking number.
    assert.equal(segment.mediaSpanS, 0.5);
  });

  /**
   * Applying the MPEG-TS wrap to a container that does not truncate would fold a legitimate timestamp
   * from beyond 26.5 hours back into range, turning a stream that should be rejected into a plausible
   * latency. The wrap has to follow the container, and `format_name` is the only thing that says so.
   */
  it('applies the 33-bit wrap only to the container that truncates', () => {
    assert.equal(parseProbedSegment(REORDERED_TS_SEGMENT, 'seg1.ts').firstFrame.wrapTicks, MPEGTS_WRAP_TICKS);
    assert.equal(parseProbedSegment(REORDERED_FMP4_SEGMENT, 'seg1.m4s').firstFrame.wrapTicks, null);
  });

  /**
   * The capture instant is recovered from this one timestamp, so which packet it comes from decides
   * every latency figure a run reports.
   *
   * The open-GOP fixture is the whole test. The other two open on the keyframe that starts their
   * group, so their first listed packet is also their smallest, and against those alone taking
   * `timestamps[0]` passes. This one begins with frames that reference the previous group, so the two
   * differ by three frames, and an anchor read off the list head lands 100ms late on every segment.
   */
  it('anchors on the earliest frame rather than the first one listed', () => {
    const openGop = parseProbedSegment(OPEN_GOP_TS_SEGMENT, 'seg1.ts');

    assert.equal(openGop.firstFrame.pts, 168_000, 'the earliest frame');
    assert.notEqual(openGop.firstFrame.pts, 177_000, 'which is not the first packet listed');
  });
});

describe('refusing output that only looks like a measurement', () => {
  /**
   * The probe asked for one packet until LAT-9, so this is the shape every segment used to come back
   * as. It reads cleanly and holds no span, which is why it is refused rather than defaulted.
   */
  it('refuses a segment holding one video packet, which fixes no duration', () => {
    assert.throws(() => parseProbedSegment(SINGLE_PACKET_SEGMENT, 'ref abc123'), /one video packet/);
  });

  it('refuses a segment with no video, which ffprobe reports at exit 0', () => {
    assert.throws(
      () => parseProbedSegment(NO_VIDEO_SEGMENT, 'ref abc123'),
      (error: Error) => {
        assert.match(error.message, /ref abc123/);
        assert.match(error.message, /no video packets/);
        return true;
      },
    );
  });

  it('refuses the empty object a truncated segment leaves on stdout', () => {
    assert.throws(() => parseProbedSegment(TRUNCATED_SEGMENT, 'ref abc123'), /no video packets/);
  });

  it('refuses output that is not JSON at all', () => {
    assert.throws(() => parseProbedSegment('seg1.ts: Invalid data found', 'ref abc123'), /not JSON/);
  });

  it('refuses empty output, naming it as empty rather than as malformed', () => {
    assert.throws(() => parseProbedSegment('', 'ref abc123'), /wrote nothing/);
  });

  /**
   * Checked on every packet rather than the first. ffprobe writes `"N/A"` per packet, so a segment
   * whose timestamps go missing partway through still reads as a good one at the front, and the span
   * is measured across all of them.
   */
  it('refuses a packet whose timestamp ffprobe could not determine, wherever it sits', () => {
    const firstUnreadable = REORDERED_TS_SEGMENT.replace('"pts": 177000', '"pts": "N/A"');
    const lastUnreadable = REORDERED_TS_SEGMENT.replace('"pts": 216000', '"pts": "N/A"');

    assert.throws(() => parseProbedSegment(firstUnreadable, 'ref abc123'), /no usable timestamp/);
    assert.throws(() => parseProbedSegment(lastUnreadable, 'ref abc123'), /no usable timestamp/);
  });

  it('refuses a stream with no time_base, rather than assuming one', () => {
    const noTimeBase = REORDERED_TS_SEGMENT.split('"time_base": "1/90000"').join('"codec_type": "video"');

    assert.throws(() => parseProbedSegment(noTimeBase, 'ref abc123'), /no time_base/);
  });

  it('refuses a time_base that is not a rational', () => {
    const odd = REORDERED_TS_SEGMENT.split('"time_base": "1/90000"').join('"time_base": "1:90000"');

    assert.throws(() => parseProbedSegment(odd, 'ref abc123'), /not a rational/);
  });

  /**
   * Each of these passes the rational shape and none yields a rate a timestamp can be divided by:
   * `1/0` gives zero ticks per second, `0/90000` gives infinity, `0/0` gives `NaN`. A pts divided by
   * any of them reaches `wallclock.ts` as a non-finite number, where the physical bounds cannot
   * reject it, because every comparison against `NaN` is false. So it has to be refused here, while
   * it is still a string the error can name.
   */
  it('refuses a time_base that parses but yields no usable tick rate', () => {
    for (const timeBase of ['1/0', '0/90000', '0/0']) {
      const noRate = REORDERED_TS_SEGMENT.split('"time_base": "1/90000"').join(`"time_base": "${timeBase}"`);

      assert.throws(() => parseProbedSegment(noRate, 'ref abc123'), /no usable tick rate/, `time_base "${timeBase}"`);
    }
  });

  /**
   * Without `format_name` there is no way to know whether the timestamps wrap, and guessing either
   * way is a silent factor error rather than a visible failure.
   */
  it('refuses output with no format_name, rather than guessing whether it wraps', () => {
    const noFormat = REORDERED_TS_SEGMENT.replace('"format_name": "mpegts"', '"nb_streams": 1');

    assert.throws(() => parseProbedSegment(noFormat, 'ref abc123'), /no format_name/);
  });
});

describe('the invocation the parser is written against', () => {
  /**
   * The parser reads three `-show_entries` sections, and ffprobe omits a section that was not asked
   * for rather than erroring. Dropping one from the argument list would therefore turn every probe
   * into a refusal with a message blaming the segment, so the arguments are pinned next to the parser
   * that depends on them.
   */
  it('asks for every section the parser reads', () => {
    const args = probeArgs('/tmp/seg.ts');

    assert.ok(args.includes('packet=pts'));
    assert.ok(args.includes('stream=time_base'));
    assert.ok(args.includes('format=format_name'));
    assert.deepEqual(args.slice(-3), ['-of', 'json', '/tmp/seg.ts']);
  });

  /**
   * This used to carry `-read_intervals %+#1`, which stops ffprobe after one packet. That is all the
   * capture instant needs and is why the span had to be taken from the manifest. Restoring it would
   * not break the parse, it would make every segment fail as a one-packet segment, so the absence is
   * asserted rather than left as something a later change could quietly restore for the decode cost.
   */
  it('reads the whole segment rather than stopping at the first packet', () => {
    assert.ok(!probeArgs('/tmp/seg.ts').includes('-read_intervals'));
  });
});
