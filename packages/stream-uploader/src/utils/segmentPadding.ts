import { Logger } from '../libs/Logger.js';

const logger = Logger.getInstance();

/** Swarm chunk payload size in bytes. */
export const SWARM_CHUNK_SIZE = 4096;

/** MPEG-TS packet size in bytes. */
export const TS_PACKET_SIZE = 188;

/**
 * Data chunks carried by one full Packed Address Chunk (PAC) under MEDIUM
 * erasure coding (redundancyLevel 1, unencrypted): 119 data + 9 parity = 128.
 *
 * A segment that fits within one PAC gets the lowest parity overhead (7.6%)
 * and keeps the undiluted six-nines (10^-6) retrieval guarantee — which is a
 * per-PAC budget, so a segment spanning s PACs degrades to ~s * 10^-6. Keeping
 * one segment == one PAC is therefore both the cheapest and the most reliable
 * unit. See docs/segment-sizing.md. This is coupled to the redundancyLevel: 1
 * used in StreamUploader.uploadDataToBee — change both together.
 */
export const PAC_DATA_CHUNKS = 119;

/** Usable data bytes in one full PAC: 119 * 4096 = 487424 (476 KiB). */
export const PAC_DATA_SIZE = PAC_DATA_CHUNKS * SWARM_CHUNK_SIZE;

/**
 * Largest whole number of TS packets that still fits within one PAC.
 *
 * PAC_DATA_SIZE (487424) is not a multiple of 188, and a valid MPEG-TS stream
 * must be a whole number of 188-byte packets — so we pad up to 2592 packets
 * (487296 bytes), which still occupies exactly 119 chunks (one full PAC).
 */
export const PAC_TS_TARGET_SIZE = Math.floor(PAC_DATA_SIZE / TS_PACKET_SIZE) * TS_PACKET_SIZE;

const TS_SYNC_BYTE = 0x47;

/**
 * A single MPEG-TS null packet (PID 0x1FFF). Null packets exist for exactly
 * this purpose — constant-bitrate stuffing — and every compliant demuxer
 * discards them, so players ignore the padding while Swarm sees a full PAC.
 */
function buildNullPacket(): Buffer {
  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff); // payload conventionally 0xFF stuffing
  packet[0] = TS_SYNC_BYTE; // sync byte 0x47
  packet[1] = 0x1f; // TEI=0, PUSI=0, priority=0, PID high bits
  packet[2] = 0xff; // PID low bits -> PID 0x1FFF (null packet)
  packet[3] = 0x10; // scrambling=0, adaptation_field_control=01 (payload only), CC=0
  return packet;
}

const NULL_PACKET = buildNullPacket();

/**
 * Pad an MPEG-TS HLS segment up to one full PAC with null packets so it aligns
 * to a single Swarm erasure-coding group. Returns the buffer unchanged (and
 * logs) when padding can't or shouldn't be applied:
 *  - not a whole number of TS packets (not clean MPEG-TS) -> skip;
 *  - already larger than one PAC -> skip and warn (it will span >1 group, so
 *    the encoder bitrate/duration must be lowered to fit);
 *  - already at/above the target -> nothing to add.
 */
export function padTsSegmentToPac(data: Buffer, segmentIndex: number): Buffer {
  if (data.length % TS_PACKET_SIZE !== 0) {
    logger.warn(
      `[segmentPadding] Segment ${segmentIndex} length ${data.length} is not a multiple of ` +
        `${TS_PACKET_SIZE}; skipping PAC padding`,
    );
    return data;
  }

  if (data.length > PAC_DATA_SIZE) {
    logger.warn(
      `[segmentPadding] Segment ${segmentIndex} is ${data.length} bytes, exceeding one PAC ` +
        `(${PAC_DATA_SIZE}); it will span multiple erasure groups and lose the single-PAC ` +
        `reliability guarantee — lower the encoder bitrate or segment duration`,
    );
    return data;
  }

  if (data.length >= PAC_TS_TARGET_SIZE) {
    return data;
  }

  const padBytes = PAC_TS_TARGET_SIZE - data.length;
  const padding = Buffer.alloc(padBytes);
  for (let offset = 0; offset < padBytes; offset += TS_PACKET_SIZE) {
    NULL_PACKET.copy(padding, offset);
  }

  return Buffer.concat([data, padding], PAC_TS_TARGET_SIZE);
}
