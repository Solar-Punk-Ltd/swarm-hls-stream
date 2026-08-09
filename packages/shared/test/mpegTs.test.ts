import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countPesPackets, readVideoPts, TS_PACKET_BYTES } from '../src/mpegTs.js';

/** 90kHz, so 3000 ticks is one frame at 30fps. */
const FRAME_TICKS = 3_000;

const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;
const VIDEO_STREAM_ID = 0xe0;
const AUDIO_STREAM_ID = 0xc0;

interface PacketOptions {
  pid: number;
  streamId?: number;
  pts?: number;
  /** Bytes of adaptation field to insert before the payload, as a real segment's first packet has. */
  adaptationBytes?: number;
  payloadUnitStart?: boolean;
}

/**
 * One 188-byte transport packet, optionally carrying the start of a PES packet with a timestamp.
 *
 * Built by hand rather than captured, so each test can isolate the one property it is about. The
 * shapes that matter are the ones a real muxer emits: an adaptation field before the payload, packets
 * with no timestamp at all, and packets on a second elementary stream.
 */
function packet({ pid, streamId, pts, adaptationBytes = 0, payloadUnitStart = true }: PacketOptions): Uint8Array {
  const bytes = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
  bytes[0] = 0x47;
  bytes[1] = (payloadUnitStart ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  bytes[2] = pid & 0xff;
  bytes[3] = adaptationBytes > 0 ? 0x30 : 0x10;

  let at = 4;
  if (adaptationBytes > 0) {
    bytes[at] = adaptationBytes - 1;
    at += adaptationBytes;
  }
  if (streamId === undefined) {
    return bytes;
  }

  bytes[at] = 0x00;
  bytes[at + 1] = 0x00;
  bytes[at + 2] = 0x01;
  bytes[at + 3] = streamId;
  bytes[at + 4] = 0x00;
  bytes[at + 5] = 0x00;
  bytes[at + 6] = 0x80;
  bytes[at + 7] = pts === undefined ? 0x00 : 0x80;
  bytes[at + 8] = pts === undefined ? 0x00 : 0x05;

  if (pts !== undefined) {
    const value = BigInt(pts);
    const p = at + 9;
    bytes[p] = 0x21 | (Number((value >> 30n) & 0x07n) << 1);
    bytes[p + 1] = Number((value >> 22n) & 0xffn);
    bytes[p + 2] = 0x01 | (Number((value >> 15n) & 0x7fn) << 1);
    bytes[p + 3] = Number((value >> 7n) & 0xffn);
    bytes[p + 4] = 0x01 | (Number(value & 0x7fn) << 1);
  }

  return bytes;
}

function segment(...packets: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(packets.length * TS_PACKET_BYTES);
  packets.forEach((one, index) => bytes.set(one, index * TS_PACKET_BYTES));
  return bytes;
}

describe('reading a segment video timestamps out of its own bytes', () => {
  it('reads every video timestamp, in the order the packets carried them', () => {
    const bytes = segment(
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: 0 }),
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: FRAME_TICKS }),
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: 2 * FRAME_TICKS }),
    );

    assert.deepEqual(readVideoPts(bytes), [0, FRAME_TICKS, 2 * FRAME_TICKS]);
  });

  it('keeps decode order rather than sorting, since the span arithmetic depends on seeing it', () => {
    const bytes = segment(
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: 3 * FRAME_TICKS }),
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: FRAME_TICKS }),
    );

    assert.deepEqual(readVideoPts(bytes), [3 * FRAME_TICKS, FRAME_TICKS]);
  });

  it('ignores audio, which carries its own timestamps on its own stream id', () => {
    const bytes = segment(
      packet({ pid: AUDIO_PID, streamId: AUDIO_STREAM_ID, pts: 7 }),
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: FRAME_TICKS }),
      packet({ pid: AUDIO_PID, streamId: AUDIO_STREAM_ID, pts: 9 }),
    );

    assert.deepEqual(readVideoPts(bytes), [FRAME_TICKS]);
  });

  it('reads past an adaptation field, which the first packet of a segment always has', () => {
    const bytes = segment(packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: FRAME_TICKS, adaptationBytes: 8 }));

    assert.deepEqual(readVideoPts(bytes), [FRAME_TICKS]);
  });

  it('skips a PES header that carries no timestamp rather than reading the bytes after it', () => {
    const bytes = segment(
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID }),
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: FRAME_TICKS }),
    );

    assert.deepEqual(readVideoPts(bytes), [FRAME_TICKS]);
  });

  it('skips a continuation packet, whose payload is not a PES header at all', () => {
    const bytes = segment(
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: FRAME_TICKS }),
      packet({ pid: VIDEO_PID, payloadUnitStart: false }),
    );

    assert.deepEqual(readVideoPts(bytes), [FRAME_TICKS]);
  });

  it('reads a timestamp at the top of the 33 bit range without losing its high bits', () => {
    // 2^33 - 1. Anything that assembles this with 32 bit bitwise operators silently truncates it,
    // and the result stays a plausible timestamp.
    const atTheTop = 8_589_934_591;
    const bytes = segment(packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: atTheTop }));

    assert.deepEqual(readVideoPts(bytes), [atTheTop]);
  });

  it('finds nothing in bytes that are not transport packets, rather than inventing a timestamp', () => {
    assert.deepEqual(readVideoPts(new Uint8Array(400).fill(0x00)), []);
  });

  it('finds nothing in an empty segment', () => {
    assert.deepEqual(readVideoPts(new Uint8Array(0)), []);
  });

  /**
   * The tail has to be a packet that would otherwise be read, or this asserts nothing.
   *
   * It first appended forty bytes holding a lone sync byte and zeros. That is rejected by the
   * payload-unit-start check long before the loop bound matters, so relaxing the bound to
   * `start < segment.length` left this test green. A truncated segment is what an interrupted write
   * leaves behind, and this repository already injects crashes and outages that produce them.
   *
   * The tail below is the first forty bytes of a real video PES packet, which is enough to carry a
   * complete timestamp: the PES header starts at offset 4 and its five PTS bytes end at offset 18.
   * So the only thing standing between the parser and a timestamp from a packet that does not exist
   * is the bound itself.
   */
  it('stops at a trailing partial packet instead of reading past the end', () => {
    const whole = segment(packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: FRAME_TICKS }));
    const PARTIAL_BYTES = 40;
    const cutOffPts = 900_000;
    const truncated = new Uint8Array(whole.length + PARTIAL_BYTES);
    truncated.set(whole);
    truncated.set(
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: cutOffPts }).subarray(0, PARTIAL_BYTES),
      whole.length,
    );

    // Reading the tail would put the span at 897000 ticks, just under ten seconds, which
    // `isUsableDuration` accepts and publishes as `#EXTINF` for a segment holding one frame.
    assert.deepEqual(readVideoPts(truncated), [FRAME_TICKS]);
  });
});

/**
 * What kinds of media a segment carries, which is the question `readVideoPts` cannot answer on its
 * own: an empty timestamp list is what a segment full of audio and a segment of some other format
 * entirely both look like, and only one of those is a broadcast about to publish without a picture.
 */
describe('counting what kinds of packet a segment carries', () => {
  it('separates video from audio', () => {
    const bytes = segment(
      packet({ pid: VIDEO_PID, streamId: VIDEO_STREAM_ID, pts: 0 }),
      packet({ pid: AUDIO_PID, streamId: AUDIO_STREAM_ID, pts: 0 }),
      packet({ pid: AUDIO_PID, streamId: AUDIO_STREAM_ID, pts: FRAME_TICKS }),
    );

    assert.deepEqual(countPesPackets(bytes), { video: 1, audio: 2 });
  });

  /** The shape a real recording opened with: a video PID declared, and no video packet in it. */
  it('reports audio without video for a segment that carries only sound', () => {
    const bytes = segment(packet({ pid: AUDIO_PID, streamId: AUDIO_STREAM_ID, pts: 0 }));

    assert.deepEqual(countPesPackets(bytes), { video: 0, audio: 1 });
  });

  /**
   * ⛔ The distinction the withhold guard rests on. Bytes of any other container read as zero and
   * zero, and a caller that treated that as "no video" would hold back every segment an engine it
   * cannot parse produces, rather than the one segment that genuinely has no picture in it.
   */
  it('reports neither for bytes that are not a transport stream', () => {
    assert.deepEqual(countPesPackets(new Uint8Array(4096)), { video: 0, audio: 0 });
  });

  /** A PES header with no timestamp still names its elementary stream, and still is media. */
  it('counts a packet carrying no timestamp, which readVideoPts must skip', () => {
    const bytes = segment(packet({ pid: AUDIO_PID, streamId: AUDIO_STREAM_ID }));

    assert.deepEqual(readVideoPts(bytes), []);
    assert.deepEqual(countPesPackets(bytes), { video: 0, audio: 1 });
  });
});
