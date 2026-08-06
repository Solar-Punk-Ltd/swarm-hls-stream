import { TS_PACKET_BYTES, TS_TIMESCALE_HZ } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { measureSegmentDuration } from '../src/utils/segmentDuration.js';

/** 90kHz, so 3000 ticks is one frame at 30fps. */
const FRAME_TICKS = 3_000;
const VIDEO_PID = 0x100;
const VIDEO_STREAM_ID = 0xe0;

/**
 * What SRS declared for the segments this was written against: 20% longer than the media in them.
 *
 * A real number rather than a round one, because the point of every test below is that the two are
 * different and that the measured one wins.
 */
const SRS_CLAIMED_SECONDS = 0.32;

function videoPacket(pts: number): Uint8Array {
  const bytes = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
  bytes[0] = 0x47;
  bytes[1] = 0x40 | ((VIDEO_PID >> 8) & 0x1f);
  bytes[2] = VIDEO_PID & 0xff;
  bytes[3] = 0x10;
  bytes[4] = 0x00;
  bytes[5] = 0x00;
  bytes[6] = 0x01;
  bytes[7] = VIDEO_STREAM_ID;
  bytes[8] = 0x00;
  bytes[9] = 0x00;
  bytes[10] = 0x80;
  bytes[11] = 0x80;
  bytes[12] = 0x05;

  const value = BigInt(pts);
  bytes[13] = 0x21 | (Number((value >> 30n) & 0x07n) << 1);
  bytes[14] = Number((value >> 22n) & 0xffn);
  bytes[15] = 0x01 | (Number((value >> 15n) & 0x7fn) << 1);
  bytes[16] = Number((value >> 7n) & 0xffn);
  bytes[17] = 0x01 | (Number(value & 0x7fn) << 1);
  return bytes;
}

function tsSegment(...pts: number[]): Buffer {
  const bytes = Buffer.alloc(pts.length * TS_PACKET_BYTES);
  pts.forEach((tick, index) => Buffer.from(videoPacket(tick)).copy(bytes, index * TS_PACKET_BYTES));
  return bytes;
}

describe('how long a segment is, according to the segment', () => {
  it('reports the media in the bytes rather than what the engine claimed about them', () => {
    // Eight frames at 30fps, which is what a 0.25s fragment setting actually cuts, against the 0.32s
    // SRS declares for the same segment. See docs/bench/a-recording-played-back-2026-08-06.md.
    const eightFrames = tsSegment(...Array.from({ length: 8 }, (_, frame) => frame * FRAME_TICKS));

    const reading = measureSegmentDuration(eightFrames, SRS_CLAIMED_SECONDS);

    assert.equal(reading.fellBackBecause, null);
    assert.ok(
      Math.abs(reading.seconds - (8 * FRAME_TICKS) / TS_TIMESCALE_HZ) < 1e-9,
      `expected 8 frames of media, got ${reading.seconds}s`,
    );
  });

  it('credits the final frame, since a timestamp says when a frame began and not how long it lasted', () => {
    const twoFrames = tsSegment(0, FRAME_TICKS);

    const reading = measureSegmentDuration(twoFrames, SRS_CLAIMED_SECONDS);

    // Two frames, so two frame durations. Spanning only the timestamps would give one.
    assert.ok(Math.abs(reading.seconds - (2 * FRAME_TICKS) / TS_TIMESCALE_HZ) < 1e-9, `got ${reading.seconds}s`);
  });

  it('is unmoved by decode order, where the newest frame is not the last one listed', () => {
    const inOrder = measureSegmentDuration(tsSegment(0, FRAME_TICKS, 2 * FRAME_TICKS, 3 * FRAME_TICKS), 1);
    const reordered = measureSegmentDuration(tsSegment(0, 3 * FRAME_TICKS, FRAME_TICKS, 2 * FRAME_TICKS), 1);

    assert.equal(reordered.seconds, inOrder.seconds);
    assert.equal(reordered.fellBackBecause, null);
  });

  it('falls back to the engine when the segment is not a transport stream, and says so', () => {
    // No shipped engine should produce this: SRS writes MPEG-TS, and the OME puller asks for
    // `ts:playlist.m3u8` rather than the fMP4 playlist. What matters is the shape of the degradation,
    // since answering zero would publish a playlist of zero-length segments no player can follow.
    const notTransportStream = Buffer.alloc(4096, 0x00);

    const reading = measureSegmentDuration(notTransportStream, SRS_CLAIMED_SECONDS);

    assert.equal(reading.seconds, SRS_CLAIMED_SECONDS);
    assert.ok(reading.fellBackBecause, 'a fallback must carry its reason, or nothing can report it');
  });

  it('falls back on a segment holding one frame, which fixes no duration at all', () => {
    const reading = measureSegmentDuration(tsSegment(0), SRS_CLAIMED_SECONDS);

    assert.equal(reading.seconds, SRS_CLAIMED_SECONDS);
    assert.match(String(reading.fellBackBecause), /one video packet/);
  });

  it('falls back rather than publishing an hour of media when the timestamps wrap', () => {
    // Timestamps are 33 bits and wrap about every 26.5 hours. A segment straddling that reads as
    // nearly the whole range, which is a number no `#EXTINF` should ever carry.
    const nearTheTop = 8_589_930_000;
    const straddling = tsSegment(nearTheTop, nearTheTop + FRAME_TICKS, 0, FRAME_TICKS);

    const reading = measureSegmentDuration(straddling, SRS_CLAIMED_SECONDS);

    assert.equal(reading.seconds, SRS_CLAIMED_SECONDS);
    assert.ok(reading.fellBackBecause, 'a fallback must carry its reason');
  });
});
