import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';

import type { CompletedRecording } from '@/types/stream';

import {
  ManifestFetcher,
  ManifestStateManager,
  recordingSourceUrl,
} from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { buildSwarmUri } from '../src/components/SwarmHlsPlayer/playlist';

const BEE_URL = 'http://bee.test';
const recording: CompletedRecording = {
  runNumber: 4,
  master: { topic: 'old-master', index: 18, reference: 'old-master-reference', duration: 95 },
  expectedRenditions: ['720p'],
  renditions: [
    {
      name: '720p',
      topic: 'old-rung',
      index: 7,
      reference: 'old-rung-reference',
      duration: 95,
      width: 1280,
      height: 720,
      bandwidth: 2_000_000,
      avgBandwidth: 1_800_000,
    },
  ],
};

const capturedMaster = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
  'swarm://current-owner/old-rung',
].join('\n');

const capturedRung = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:2',
  '#EXTINF:2,',
  'captured-segment-reference',
  '#EXT-X-ENDLIST',
].join('\n');

describe('completed recording playback', () => {
  const manager = ManifestStateManager.getInstance();
  const realFetch = globalThis.fetch;
  let fetcher: ManifestFetcher;
  let requested: string[];

  beforeEach(() => {
    manager.clear();
    fetcher = new ManifestFetcher(manager);
    fetcher.beeUrl = BEE_URL;
    requested = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === `${BEE_URL}/bytes/old-master-reference`) {
        return new Response(capturedMaster);
      }
      if (url === `${BEE_URL}/bytes/old-rung-reference`) {
        return new Response(capturedRung);
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    fetcher.unregisterRecording(recordingSourceUrl(recording.master));
    globalThis.fetch = realFetch;
  });

  it('uses captured byte references for the master and every rung without following current feeds', async () => {
    const source = recordingSourceUrl(recording.master);
    fetcher.registerRecording(source, recording);

    const master = await fetcher.fetchSource(source);
    const rung = await fetcher.fetch(recordingSourceUrl(recording.renditions[0]));

    assert.match(master, new RegExp(recordingSourceUrl(recording.renditions[0])));
    assert.match(rung, new RegExp(`${BEE_URL}/bytes/captured-segment-reference`));
    assert.deepEqual(requested, [`${BEE_URL}/bytes/old-master-reference`, `${BEE_URL}/bytes/old-rung-reference`]);
  });

  it('maps each captured master rung by its stable topic when snapshot rows are in another order', async () => {
    const twoRungs: CompletedRecording = {
      ...recording,
      expectedRenditions: ['360p', '720p'],
      renditions: [
        { ...recording.renditions[0], name: '720p', topic: 'old-720', reference: 'old-720-reference', index: 8 },
        { ...recording.renditions[0], name: '360p', topic: 'old-360', reference: 'old-360-reference', index: 7 },
      ],
    };
    const twoRungMaster = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360',
      'swarm://current-owner/old-360',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      'swarm://current-owner/old-720',
    ].join('\n');
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return url === `${BEE_URL}/bytes/old-master-reference`
        ? new Response(twoRungMaster)
        : new Response('not found', { status: 404 });
    }) as typeof fetch;
    const source = recordingSourceUrl(twoRungs.master);
    fetcher.registerRecording(source, twoRungs);

    const master = await fetcher.fetchSource(source);

    assert.match(master, new RegExp(`BANDWIDTH=700000,RESOLUTION=640x360\\nswarm-replay://old-360-reference/7`));
    assert.match(master, new RegExp(`BANDWIDTH=2000000,RESOLUTION=1280x720\\nswarm-replay://old-720-reference/8`));
  });

  it('pins a mounted live run to its captured rung bytes after its stable feed starts another run', async () => {
    const source = buildSwarmUri('current-owner', 'stable-master-topic');
    fetcher.pinRecording(source, 'current-owner', recording);

    const master = await fetcher.fetchSource(source);
    const rungUri = master.split('\n').at(-1);
    assert.ok(rungUri, 'the pinned master has to name its captured rung');
    const rung = await fetcher.fetch(rungUri);

    assert.match(rung, new RegExp(`${BEE_URL}/bytes/captured-segment-reference`));
    assert.deepEqual(requested, [`${BEE_URL}/bytes/old-master-reference`, `${BEE_URL}/bytes/old-rung-reference`]);
    fetcher.unpinRecording(source, 'current-owner', recording);
  });
});
