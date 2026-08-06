import { TS_PACKET_BYTES } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import { makeTestOrchestrator } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

/**
 * What a viewer is told a segment lasts, end to end.
 *
 * The unit tests beside this pin the measurement. This one pins that the measurement is what reaches
 * the playlist, because between the two sits the whole reason the defect existed: the number was
 * taken from the engine's webhook and carried all the way to `#EXTINF` without anything looking at
 * the segment. See `docs/bench/a-recording-played-back-2026-08-06.md`.
 */

const STREAM_ID = 'live/one';
const SETTLE_CEILING_MS = 4_000;

/** 90kHz, so 3000 ticks is one frame at 30fps. */
const FRAME_TICKS = 3_000;
const FRAMES_PER_SEGMENT = 8;

/** What SRS declares for a segment of that shape, measured on 2026-08-06. It is 20% too long. */
const SRS_CLAIMED_SECONDS = 0.32;
/** What eight frames at 30fps actually last, as `buildExtinf` writes it. */
const MEASURED_EXTINF = '#EXTINF:0.266667,';

const VIDEO_PID = 0x100;
const VIDEO_STREAM_ID = 0xe0;

function videoPacket(pts: number): Uint8Array {
  const bytes = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
  bytes.set([0x47, 0x40 | ((VIDEO_PID >> 8) & 0x1f), VIDEO_PID & 0xff, 0x10], 0);
  bytes.set([0x00, 0x00, 0x01, VIDEO_STREAM_ID, 0x00, 0x00, 0x80, 0x80, 0x05], 4);

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

/** A transport stream segment holding `FRAMES_PER_SEGMENT` frames at 30fps, starting at `firstPts`. */
function transportSegment(firstPts: number): Buffer {
  const bytes = Buffer.alloc(FRAMES_PER_SEGMENT * TS_PACKET_BYTES);
  for (let frame = 0; frame < FRAMES_PER_SEGMENT; frame++) {
    Buffer.from(videoPacket(firstPts + frame * FRAME_TICKS)).copy(bytes, frame * TS_PACKET_BYTES);
  }
  return bytes;
}

describe('what a playlist tells a viewer a segment lasts', () => {
  it('publishes the media in the segment, not the duration the engine claimed for it', async () => {
    const published: string[] = [];
    const orch = makeTestOrchestrator(
      {},
      {
        uploadPayload: async (index, payload) => {
          published.push(String(payload));
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
    );
    await orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);

    orch.handleSegment(STREAM_ID, 0, SRS_CLAIMED_SECONDS, transportSegment(0));

    await waitFor(() => published.length > 0, SETTLE_CEILING_MS);
    const manifest = published[published.length - 1];

    assert.ok(manifest.includes(MEASURED_EXTINF), `expected the measured duration, got:\n${manifest}`);
    assert.ok(!manifest.includes('0.32'), `the engine's claim must not reach a viewer, got:\n${manifest}`);

    await orch.stopStream(STREAM_ID);
  });

  it('keeps publishing the engine claim for a segment it cannot read, rather than a zero', async () => {
    const published: string[] = [];
    const orch = makeTestOrchestrator(
      {},
      {
        uploadPayload: async (index, payload) => {
          published.push(String(payload));
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
    );
    await orch.startStream(STREAM_ID, MEDIA_TYPE_VIDEO);

    // Not a transport stream, which no shipped engine should produce: SRS writes MPEG-TS and the OME
    // puller asks for `ts:playlist.m3u8` rather than the fMP4 playlist. So this is the path for a
    // segment that is genuinely unreadable, and what matters is that it degrades to the engine's
    // claim instead of to a zero, since a playlist of zero-length segments is one no player can
    // follow. The counter asserted below is what makes the degradation visible rather than silent.
    orch.handleSegment(STREAM_ID, 0, SRS_CLAIMED_SECONDS, Buffer.alloc(4096));

    await waitFor(() => published.length > 0, SETTLE_CEILING_MS);
    const manifest = published[published.length - 1];

    assert.ok(manifest.includes('#EXTINF:0.32,'), `expected the engine's claim to survive, got:\n${manifest}`);
    assert.equal(
      orch.getMetricsSnapshot().segmentDurationsUnreadTotal,
      1,
      'a fallback that nothing counts is a fallback nobody can see',
    );

    await orch.stopStream(STREAM_ID);
  });
});
