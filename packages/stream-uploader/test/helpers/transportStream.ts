import { TS_PACKET_BYTES } from '@swarm-hls-stream/shared';

/**
 * Transport stream segments built by hand, so a test can hold everything constant but the one
 * property it is about.
 *
 * The property that matters most here is whether a segment carries video at all. A real broadcast
 * produced segments that declare a video stream in the PMT and hold nothing but audio, and a player
 * that parses one of those first builds an audio-only codec set it never revises. See
 * `docs/bench/a-recording-that-opens-without-video-2026-08-09.md`.
 */

/** 90kHz, so 3000 ticks is one frame at 30fps. */
export const FRAME_TICKS = 3_000;

const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;
const VIDEO_STREAM_ID = 0xe0;
const AUDIO_STREAM_ID = 0xc0;

/** One 188-byte packet opening a PES packet that carries a presentation timestamp. */
function pesPacket(pid: number, streamId: number, pts: number): Uint8Array {
  const bytes = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
  bytes.set([0x47, 0x40 | ((pid >> 8) & 0x1f), pid & 0xff, 0x10], 0);
  bytes.set([0x00, 0x00, 0x01, streamId, 0x00, 0x00, 0x80, 0x80, 0x05], 4);

  const value = BigInt(pts);
  bytes.set(
    [
      0x21 | (Number((value >> 30n) & 0x07n) << 1),
      Number((value >> 22n) & 0xffn),
      0x01 | (Number((value >> 15n) & 0x7fn) << 1),
      Number((value >> 7n) & 0xffn),
      0x01 | (Number(value & 0x7fn) << 1),
    ],
    13,
  );
  return bytes;
}

function segmentOf(pid: number, streamId: number, frames: number, firstPts: number): Buffer {
  const bytes = Buffer.alloc(frames * TS_PACKET_BYTES);
  for (let frame = 0; frame < frames; frame++) {
    Buffer.from(pesPacket(pid, streamId, firstPts + frame * FRAME_TICKS)).copy(bytes, frame * TS_PACKET_BYTES);
  }
  return bytes;
}

/** A segment holding `frames` video frames at 30fps, which `readVideoPts` can measure. */
export function videoSegment(frames: number, firstPts = 0): Buffer {
  return segmentOf(VIDEO_PID, VIDEO_STREAM_ID, frames, firstPts);
}

/**
 * A segment holding audio and no video, which is what the failing recording's first four segments
 * were. Every byte of it is a valid transport packet, so nothing but the elementary stream id
 * separates it from the segment above.
 */
export function audioOnlySegment(frames: number, firstPts = 0): Buffer {
  return segmentOf(AUDIO_PID, AUDIO_STREAM_ID, frames, firstPts);
}
