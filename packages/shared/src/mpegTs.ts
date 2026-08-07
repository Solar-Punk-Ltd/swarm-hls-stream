/**
 * Reading a segment's video presentation timestamps out of its own bytes.
 *
 * The bench answers this with ffprobe, which is the right tool where a tool is affordable. The
 * uploader cannot: it holds every segment in memory on the ingest path and has no ffmpeg in its
 * image, so the choice there is between this and trusting whatever the engine declared. On the
 * deployment this was written for, what SRS declares averaged **0.32s against 0.267s of media**, and
 * a viewer met that as a recording whose length shrank by a fifth once it finished buffering.
 *
 * This reads only what is needed to find timestamps and deliberately does not parse the program map:
 * a PES header names its own elementary stream, and the video stream ids are a fixed range, so the
 * video packets can be picked out without first learning which PID carries them. Nothing here
 * validates the stream beyond what it must to avoid reading a timestamp that is not one.
 */

/** Every transport packet is this long, which is what makes the format scannable without parsing it. */
export const TS_PACKET_BYTES = 188;

/** Timestamps count at this rate in every MPEG-TS stream, by the standard rather than by convention. */
export const TS_TIMESCALE_HZ = 90_000;

const SYNC_BYTE = 0x47;

/**
 * ISO 13818-1 assigns `0xE0` to `0xEF` to video elementary streams and `0xC0` to `0xDF` to audio.
 * Audio carries its own timestamps, and mixing the two would interleave two frame rates into one
 * list and make the median gap meaningless.
 */
const VIDEO_STREAM_ID_FIRST = 0xe0;
const VIDEO_STREAM_ID_LAST = 0xef;

/** How many bits a timestamp occupies, which is more than a bitwise operator in this language has. */
const PTS_BITS = 33n;

/**
 * Assembled with BigInt because a PTS is 33 bits.
 *
 * JavaScript's bitwise operators work on 32, so the obvious `<<` version drops the top bit and keeps
 * returning a plausible timestamp roughly 26.5 hours into a stream, which is exactly where nobody
 * looks. Converted back to a number at the end, since 2^33 is far inside the safe integer range.
 */
function readPts(bytes: Uint8Array, at: number): number {
  const value =
    (BigInt(bytes[at] & 0x0e) << 29n) |
    (BigInt(bytes[at + 1]) << 22n) |
    (BigInt(bytes[at + 2] & 0xfe) << 14n) |
    (BigInt(bytes[at + 3]) << 7n) |
    (BigInt(bytes[at + 4]) >> 1n);

  return Number(BigInt.asUintN(Number(PTS_BITS), value));
}

/**
 * Every video presentation timestamp in one MPEG-TS segment, in the order its packets carried them.
 *
 * **Not sorted**, and that is load-bearing rather than incidental. Packets are in decode order, so
 * with B-frames the newest frame is not the last one listed, and `measureSpanTicks` sorts for itself
 * precisely so that a caller cannot quietly hand it a list already flattened the wrong way.
 *
 * Returns an empty list rather than throwing when the bytes are not a transport stream at all. What
 * to do about a segment that says nothing is the caller's decision, and it is a different decision
 * from what to do about one that says too little, which `measureSpanTicks` refuses on its own.
 */
export function readVideoPts(segment: Uint8Array): number[] {
  const timestamps: number[] = [];

  for (let start = 0; start + TS_PACKET_BYTES <= segment.length; start += TS_PACKET_BYTES) {
    if (segment[start] !== SYNC_BYTE) {
      continue;
    }

    // Only the first packet of a PES packet carries its header, and only that header carries a
    // timestamp. Everything else on the same stream is payload that happens to start with anything.
    const payloadUnitStart = (segment[start + 1] & 0x40) !== 0;
    const adaptationControl = (segment[start + 3] & 0x30) >> 4;
    const hasPayload = adaptationControl === 1 || adaptationControl === 3;
    if (!payloadUnitStart || !hasPayload) {
      continue;
    }

    let at = start + 4;
    if (adaptationControl === 3) {
      // The adaptation field states its own length, not counting the byte that states it.
      at += 1 + segment[at];
    }
    // A PES packet opens on this three byte start code. Anything else here is a section of some
    // other table, which carries no presentation timestamp and must not be read as one.
    if (
      at + 14 > start + TS_PACKET_BYTES ||
      segment[at] !== 0x00 ||
      segment[at + 1] !== 0x00 ||
      segment[at + 2] !== 0x01
    ) {
      continue;
    }

    const streamId = segment[at + 3];
    if (streamId < VIDEO_STREAM_ID_FIRST || streamId > VIDEO_STREAM_ID_LAST) {
      continue;
    }
    // The top two bits of this byte say which of PTS and DTS follow. A PES header is allowed to
    // carry neither, and the bytes sitting where a timestamp would be are then something else.
    const carriesPts = (segment[at + 7] & 0x80) !== 0;
    if (!carriesPts) {
      continue;
    }

    timestamps.push(readPts(segment, at + 9));
  }

  return timestamps;
}
