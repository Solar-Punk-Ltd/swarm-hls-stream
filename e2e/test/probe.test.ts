import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseProbedFrame, probeArgs } from '../src/bench/probe.js';
import { MPEGTS_WRAP_TICKS } from '../src/bench/wallclock.js';

/**
 * Every fixture below is verbatim stdout from `ffprobe 7.1.1 ${probeArgs(file)}`, captured on
 * 2026-08-02 against files that build produced. None of it is written from the documentation, which
 * is the point: the shapes that matter here are the ones the tool actually emits, including the two
 * that look like success.
 */

/** A live MPEG-TS segment, the normal case. */
const TS_SEGMENT = `{
    "packets": [
        {
            "pts": 1932509272,
            "side_data_list": [
                {

                }
            ]
        }
    ],
    "programs": [
        {
            "streams": [
                {
                    "time_base": "1/90000"
                }
            ]
        }
    ],
    "stream_groups": [

    ],
    "streams": [
        {
            "time_base": "1/90000"
        }
    ],
    "format": {
        "format_name": "mpegts"
    }
}`;

/**
 * A fragmented MP4, which OME's low-latency packaging produces. Two things differ and both matter:
 * the timescale is 15360 rather than 90000, so reading 90kHz would be wrong by a factor of six, and
 * `format_name` is the whole comma-separated list of formats the demuxer answers to.
 */
const FMP4_SEGMENT = `{
    "packets": [
        {
            "pts": 0
        }
    ],
    "programs": [

    ],
    "stream_groups": [

    ],
    "streams": [
        {
            "time_base": "1/15360"
        }
    ],
    "format": {
        "format_name": "mov,mp4,m4a,3gp,3g2,mj2"
    }
}`;

/**
 * A segment that carries audio and no video. ffprobe exits **0** and reports empty arrays, so this is
 * the shape a reader mistakes for success: `packets[0].pts` is `undefined`, and every arithmetic step
 * after it yields NaN rather than throwing. A gateway serving the wrong bytes looks exactly like this.
 */
const NO_VIDEO_SEGMENT = `{
    "packets": [

    ],
    "programs": [
        {
            "streams": [

            ]
        }
    ],
    "stream_groups": [

    ],
    "streams": [

    ],
    "format": {
        "format_name": "mpegts"
    }
}`;

/** What a truncated segment produces on stdout. ffprobe exits 1 and puts "End of file" on stderr. */
const TRUNCATED_SEGMENT = `{

}`;

describe('parsing ffprobe output into a timestamped frame', () => {
  it('reads the timestamp and tick rate of an MPEG-TS segment', () => {
    const frame = parseProbedFrame(TS_SEGMENT, 'seg1.ts');

    assert.deepEqual(frame, { pts: 1_932_509_272, timescale: 90_000, wrapTicks: MPEGTS_WRAP_TICKS });
  });

  it('reads a fragmented MP4 at its own tick rate, not at 90kHz', () => {
    const frame = parseProbedFrame(FMP4_SEGMENT, 'seg1.m4s');

    assert.equal(frame.timescale, 15_360);
  });

  /**
   * Applying the MPEG-TS wrap to a container that does not truncate would fold a legitimate timestamp
   * from beyond 26.5 hours back into range, turning a stream that should be rejected into a plausible
   * latency. The wrap has to follow the container, and `format_name` is the only thing that says so.
   */
  it('applies the 33-bit wrap only to the container that truncates', () => {
    assert.equal(parseProbedFrame(TS_SEGMENT, 'seg1.ts').wrapTicks, MPEGTS_WRAP_TICKS);
    assert.equal(parseProbedFrame(FMP4_SEGMENT, 'seg1.m4s').wrapTicks, null);
  });
});

describe('refusing output that only looks like a measurement', () => {
  it('refuses a segment with no video, which ffprobe reports at exit 0', () => {
    assert.throws(
      () => parseProbedFrame(NO_VIDEO_SEGMENT, 'ref abc123'),
      (error: Error) => {
        assert.match(error.message, /ref abc123/);
        assert.match(error.message, /no video packets/);
        return true;
      },
    );
  });

  it('refuses the empty object a truncated segment leaves on stdout', () => {
    assert.throws(() => parseProbedFrame(TRUNCATED_SEGMENT, 'ref abc123'), /no video packets/);
  });

  it('refuses output that is not JSON at all', () => {
    assert.throws(() => parseProbedFrame('seg1.ts: Invalid data found', 'ref abc123'), /not JSON/);
  });

  it('refuses empty output, naming it as empty rather than as malformed', () => {
    assert.throws(() => parseProbedFrame('', 'ref abc123'), /wrote nothing/);
  });

  it('refuses a packet whose timestamp ffprobe could not determine', () => {
    const noPts = TS_SEGMENT.replace('"pts": 1932509272', '"pts": "N/A"');

    assert.throws(() => parseProbedFrame(noPts, 'ref abc123'), /no usable timestamp/);
  });

  it('refuses a stream with no time_base, rather than assuming one', () => {
    const noTimeBase = TS_SEGMENT.split('"time_base": "1/90000"').join('"codec_type": "video"');

    assert.throws(() => parseProbedFrame(noTimeBase, 'ref abc123'), /no time_base/);
  });

  it('refuses a time_base that is not a rational', () => {
    const odd = TS_SEGMENT.split('"time_base": "1/90000"').join('"time_base": "1:90000"');

    assert.throws(() => parseProbedFrame(odd, 'ref abc123'), /not a rational/);
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
      const noRate = TS_SEGMENT.split('"time_base": "1/90000"').join(`"time_base": "${timeBase}"`);

      assert.throws(() => parseProbedFrame(noRate, 'ref abc123'), /no usable tick rate/, `time_base "${timeBase}"`);
    }
  });

  /**
   * Without `format_name` there is no way to know whether the timestamps wrap, and guessing either
   * way is a silent factor error rather than a visible failure.
   */
  it('refuses output with no format_name, rather than guessing whether it wraps', () => {
    const noFormat = TS_SEGMENT.replace('"format_name": "mpegts"', '"nb_streams": 1');

    assert.throws(() => parseProbedFrame(noFormat, 'ref abc123'), /no format_name/);
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

  it('stops decoding after the first packet, so a VOD segment costs the same as a live one', () => {
    assert.ok(probeArgs('/tmp/seg.ts').includes('%+#1'));
  });
});
