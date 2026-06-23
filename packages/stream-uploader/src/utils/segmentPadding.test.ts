import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PAC_DATA_SIZE,
  PAC_TS_TARGET_SIZE,
  padTsSegmentToPac,
  SWARM_CHUNK_SIZE,
  TS_PACKET_SIZE,
} from './segmentPadding.js';

/** Build a buffer of `count` valid-looking TS packets (sync byte + filler). */
function tsPackets(count: number): Buffer {
  const buf = Buffer.alloc(count * TS_PACKET_SIZE, 0x00);
  for (let i = 0; i < count; i++) {
    buf[i * TS_PACKET_SIZE] = 0x47; // sync byte
  }
  return buf;
}

describe('PAC constants', () => {
  it('one PAC at MEDIUM is 119 chunks = 476 KiB', () => {
    assert.equal(PAC_DATA_SIZE, 119 * SWARM_CHUNK_SIZE);
    assert.equal(PAC_DATA_SIZE, 487424);
  });

  it('target is the largest whole TS-packet size that still fits one PAC', () => {
    assert.equal(PAC_TS_TARGET_SIZE % TS_PACKET_SIZE, 0);
    assert.ok(PAC_TS_TARGET_SIZE <= PAC_DATA_SIZE);
    assert.ok(PAC_TS_TARGET_SIZE + TS_PACKET_SIZE > PAC_DATA_SIZE);
    assert.equal(PAC_TS_TARGET_SIZE, 487296);
  });

  it('the padded target still occupies exactly 119 chunks', () => {
    assert.equal(Math.ceil(PAC_TS_TARGET_SIZE / SWARM_CHUNK_SIZE), 119);
  });
});

describe('padTsSegmentToPac', () => {
  it('pads a small segment up to exactly one PAC', () => {
    const input = tsPackets(100); // 18800 bytes
    const out = padTsSegmentToPac(input, 0);
    assert.equal(out.length, PAC_TS_TARGET_SIZE);
    // original bytes are preserved at the front
    assert.ok(out.subarray(0, input.length).equals(input));
  });

  it('appends valid null packets (sync byte + PID 0x1FFF)', () => {
    const input = tsPackets(1);
    const out = padTsSegmentToPac(input, 0);
    // first padding packet starts right after the input
    const pad = out.subarray(input.length, input.length + TS_PACKET_SIZE);
    assert.equal(pad[0], 0x47);
    assert.equal(pad[1], 0x1f);
    assert.equal(pad[2], 0xff);
    assert.equal(pad[3], 0x10);
    // remains a whole number of TS packets
    assert.equal(out.length % TS_PACKET_SIZE, 0);
  });

  it('leaves a segment already at the target untouched', () => {
    const input = tsPackets(PAC_TS_TARGET_SIZE / TS_PACKET_SIZE);
    const out = padTsSegmentToPac(input, 0);
    assert.equal(out.length, input.length);
    assert.equal(out, input);
  });

  it('does not pad — and does not truncate — a segment larger than one PAC', () => {
    const input = tsPackets(PAC_DATA_CHUNKS_PACKETS() + 50);
    const out = padTsSegmentToPac(input, 0);
    assert.equal(out, input); // returned as-is; caller is warned via logs
  });

  it('skips padding when the input is not a whole number of TS packets', () => {
    const input = Buffer.alloc(500, 0x47); // 500 is not a multiple of 188
    const out = padTsSegmentToPac(input, 0);
    assert.equal(out, input);
  });
});

/** Packets needed to exceed one PAC. */
function PAC_DATA_CHUNKS_PACKETS(): number {
  return Math.ceil(PAC_DATA_SIZE / TS_PACKET_SIZE);
}
