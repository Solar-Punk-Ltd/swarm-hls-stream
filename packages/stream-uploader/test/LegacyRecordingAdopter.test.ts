import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { LegacyAdoptionOperation } from '../src/libs/AdminApiClient.js';
import { LegacyAdoptionMediaReader, LegacyRecordingAdopter } from '../src/libs/LegacyRecordingAdopter.js';
import { ManifestManager } from '../src/libs/ManifestManager.js';
import { buildMasterPlaylist } from '../src/libs/MasterPlaylist.js';
import { MediaFormatFingerprint, MediaFormatInspector } from '../src/libs/MediaFormatProbe.js';
import { rungTopicFor } from '../src/utils/rungTopic.js';

const STREAM_ID = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222';
const SEGMENT = 'a'.repeat(64);
const MANIFEST_REFERENCE = 'b'.repeat(64);
const VIDEO_FORMAT: MediaFormatFingerprint = {
  version: 1,
  container: 'mpegts',
  tracks: [
    {
      kind: 'video',
      codec: 'h264',
      profile: 'High',
      level: 40,
      width: 1280,
      height: 720,
      pixelFormat: 'yuv420p',
      chromaLocation: 'left',
      bitsPerRawSample: 8,
    },
  ],
};

function operation(): LegacyAdoptionOperation {
  return {
    lifecycleVersion: 1,
    kind: 'legacy-adoption',
    operationId: '33333333-3333-4333-8333-333333333333',
    requestId: '44444444-4444-4444-8444-444444444444',
    streamId: STREAM_ID,
    topic: TOPIC,
    mediaType: 'video',
    uploaderId: 'srs-uploader-a',
    candidateDigest: 'c'.repeat(64),
    revision: 4,
    status: 'pending',
    candidate: {
      streamId: STREAM_ID,
      topic: TOPIC,
      mediaType: 'video',
      master: { topic: TOPIC, index: 12, duration: 2 },
      renditions: [],
    },
  };
}

describe('LegacyRecordingAdopter', () => {
  it('reads every immutable segment and builds an exact single-track adoption proof', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-MEDIA-SEQUENCE:7',
      '#EXTINF:2,',
      SEGMENT,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const readSegment = mock.fn(async () => Buffer.from('opening mpeg-ts'));
    const reader: LegacyAdoptionMediaReader = {
      owner: '0'.repeat(40),
      readFeed: async () => ({ playlist, reference: MANIFEST_REFERENCE }),
      readSegment,
    };
    const inspect = mock.fn(async () => ({ kind: 'valid' as const, fingerprint: VIDEO_FORMAT }));
    const adopter = new LegacyRecordingAdopter(reader, { inspect } as MediaFormatInspector, () => 1234);

    const result = await adopter.inspect(operation(), []);

    assert.equal(readSegment.mock.callCount(), 1);
    assert.equal(inspect.mock.callCount(), 1);
    assert.deepEqual(result.validation, {
      version: 1,
      mediaReadable: true,
      pendingWrites: 0,
      tracks: [{ topic: TOPIC, formatFingerprint: VIDEO_FORMAT }],
    });
    assert.deepEqual(result.checkpoint.master, {
      topic: TOPIC,
      index: 12,
      reference: MANIFEST_REFERENCE,
      duration: 2,
    });
    assert.deepEqual(result.checkpoint.tracks[0].state.segments, [
      {
        index: 7,
        sequence: 7,
        duration: 2,
        ref: SEGMENT,
      },
    ]);
    assert.equal(result.checkpoint.tracks[0].state.updatedAt, 1234);
  });

  it('refuses a recording with pending local writes before reading media', async () => {
    const readFeed = mock.fn(async () => ({ playlist: '', reference: MANIFEST_REFERENCE }));
    const adopter = new LegacyRecordingAdopter(
      { owner: '0'.repeat(40), readFeed, readSegment: async () => Buffer.alloc(0) },
      { inspect: async () => ({ kind: 'valid', fingerprint: VIDEO_FORMAT }) },
    );

    await assert.rejects(() => adopter.inspect(operation(), [TOPIC]), /pending writes/i);
    assert.equal(readFeed.mock.callCount(), 0);
  });

  it('refuses incomplete media metadata without sealing a fingerprint', async () => {
    const playlist = `#EXTM3U\n#EXTINF:2,\n${SEGMENT}\n#EXT-X-ENDLIST\n`;
    const adopter = new LegacyRecordingAdopter(
      {
        owner: '0'.repeat(40),
        readFeed: async () => ({ playlist, reference: MANIFEST_REFERENCE }),
        readSegment: async () => Buffer.from('truncated'),
      },
      { inspect: async () => ({ kind: 'incomplete' }) },
    );

    await assert.rejects(() => adopter.inspect(operation(), []), /format metadata/i);
  });

  it('keeps measured legacy rendition metadata separate from configured managed targets', async () => {
    const owner = '0'.repeat(40);
    const group = TOPIC;
    const topic360 = rungTopicFor(group, '360p');
    const topic720 = rungTopicFor(group, '720p');
    const candidateRenditions = [
      {
        name: '360p',
        topic: topic360,
        index: 8,
        duration: 2,
        width: 640,
        height: 360,
        bandwidth: 810_000,
        avgBandwidth: 710_000,
      },
      {
        name: '720p',
        topic: topic720,
        index: 9,
        duration: 2,
        width: 1280,
        height: 720,
        bandwidth: 2_910_000,
        avgBandwidth: 2_610_000,
      },
    ];
    const assigned: LegacyAdoptionOperation = {
      ...operation(),
      candidate: {
        ...operation().candidate,
        master: { topic: group, index: 12, duration: 2 },
        renditions: candidateRenditions,
      },
    };
    const expected = candidateRenditions.map((rendition) => ({
      ...rendition,
      bandwidth: rendition.name === '360p' ? 700_000 : 2_800_000,
      avgBandwidth: rendition.name === '360p' ? 700_000 : 2_800_000,
    }));
    const mediaPlaylist = (reference: string) => `#EXTM3U\n#EXTINF:2,\n${reference}\n#EXT-X-ENDLIST\n`;
    const adopter = new LegacyRecordingAdopter(
      {
        owner,
        readFeed: async (topic, _index, rendition) =>
          rendition === null
            ? { playlist: buildMasterPlaylist(owner, candidateRenditions), reference: 'b'.repeat(64) }
            : {
                playlist: mediaPlaylist(rendition === '360p' ? 'c'.repeat(64) : 'd'.repeat(64)),
                reference: 'e'.repeat(64),
              },
        readSegment: async (_reference, rendition) => Buffer.from(rendition ?? ''),
      },
      {
        inspect: async (data) => ({
          kind: 'valid',
          fingerprint: {
            ...VIDEO_FORMAT,
            tracks: [
              {
                ...VIDEO_FORMAT.tracks[0],
                width: data.toString() === '360p' ? 640 : 1280,
                height: data.toString() === '360p' ? 360 : 720,
              },
            ],
          },
        }),
      },
    );

    const result = await adopter.inspect(assigned, [], expected);

    assert.deepEqual(result.checkpoint.expectedRenditions, expected);
    assert.ok(result.checkpoint.tracks[0].manifest && 'bandwidth' in result.checkpoint.tracks[0].manifest);
    assert.ok(result.checkpoint.tracks[1].manifest && 'bandwidth' in result.checkpoint.tracks[1].manifest);
    assert.equal(result.checkpoint.tracks[0].manifest.bandwidth, 810_000);
    assert.equal(result.checkpoint.tracks[1].manifest.bandwidth, 2_910_000);
    assert.deepEqual(
      result.validation.tracks.map(({ topic }) => topic),
      [topic360, topic720].sort(),
    );
  });

  it('preserves an internal gap duration and following discontinuity in cumulative playback state', async () => {
    const first = 'c'.repeat(64);
    const second = 'd'.repeat(64);
    const base = operation();
    const assigned: LegacyAdoptionOperation = {
      ...base,
      candidate: { ...base.candidate, master: { ...base.candidate.master, duration: 6 } },
    };
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:5',
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-20T10:00:00.000Z',
      '#EXTINF:3,',
      first,
      '#EXT-X-GAP',
      '#EXTINF:2,',
      'gap-6',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-20T10:00:05.000Z',
      '#EXTINF:3,',
      second,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const adopter = new LegacyRecordingAdopter(
      {
        owner: '0'.repeat(40),
        readFeed: async () => ({ playlist, reference: MANIFEST_REFERENCE }),
        readSegment: async () => Buffer.from('mpeg-ts'),
      },
      { inspect: async () => ({ kind: 'valid', fingerprint: VIDEO_FORMAT }) },
    );

    const result = await adopter.inspect(assigned, []);
    const state = result.checkpoint.tracks[0].state;
    assert.equal(state.anchor?.fragmentSeconds, 2);
    assert.equal(state.anchor?.startedAtMs, Date.parse('2026-09-20T09:59:50.000Z'));
    assert.deepEqual(
      state.segments.map(({ sequence, discontinuity }) => ({ sequence, discontinuity })),
      [
        { sequence: 5, discontinuity: undefined },
        { sequence: 7, discontinuity: true },
      ],
    );

    const manifest = new ManifestManager(state.anchor!);
    manifest.restoreState(state.segments, state.hlsHeaders);
    const rebuilt = manifest.buildVODManifest();
    assert.match(rebuilt, /#EXT-X-PROGRAM-DATE-TIME:2026-09-20T10:00:03\.000Z\n#EXTINF:2,\ngap-6/);
    assert.match(rebuilt, /#EXTINF:2,\ngap-6/);
    assert.match(rebuilt, /gap-6\n#EXT-X-DISCONTINUITY\n#EXT-X-PROGRAM-DATE-TIME:2026-09-20T10:00:05\.000Z/);
  });

  it('refuses edge gaps that the current manifest writer cannot reconstruct', async () => {
    const playlist = `#EXTM3U\n#EXT-X-GAP\n#EXTINF:2,\ngap-0\n#EXTINF:2,\n${SEGMENT}\n#EXT-X-ENDLIST\n`;
    const assigned = operation();
    const adopter = new LegacyRecordingAdopter(
      {
        owner: '0'.repeat(40),
        readFeed: async () => ({ playlist, reference: MANIFEST_REFERENCE }),
        readSegment: async () => Buffer.from('mpeg-ts'),
      },
      { inspect: async () => ({ kind: 'valid', fingerprint: VIDEO_FORMAT }) },
    );

    await assert.rejects(() => adopter.inspect(assigned, []), /edge gap/i);
  });
});
