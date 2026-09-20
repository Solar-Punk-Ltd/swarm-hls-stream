import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AbrLadder } from '../src/libs/AbrLadder.js';
import {
  AdminApiClient,
  UploaderCapabilities,
  UploaderCapabilityReceipt,
} from '../src/libs/AdminApiClient.js';
import { buildUploaderCapabilities } from '../src/libs/UploaderCapabilities.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeTestOrchestrator } from './helpers/fakes.js';

const UPLOADER_ID = 'srs-157-90-34-105';
const RECEIPT: UploaderCapabilityReceipt = {
  lifecycleVersion: 1,
  uploaderId: UPLOADER_ID,
  receivedAt: '2026-09-20T10:10:00.000Z',
  freshUntil: '2026-09-20T10:10:30.000Z',
  profileDigests: [
    { mediaType: 'video', digest: 'a'.repeat(64) },
    { mediaType: 'audio', digest: 'b'.repeat(64) },
  ],
};

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('managed uploader capability heartbeat', () => {
  it('builds one stable profile per supported media type from the effective ladder', () => {
    assert.deepEqual(
      buildUploaderCapabilities(AbrLadder.parse('720p:1280:720:2800 360p:640:360:700')),
      {
        lifecycleVersion: 1,
        capabilities: { durableCheckpointStore: 1, legacyRecordingAdoption: 1 },
        profiles: [
          {
            mediaType: 'video',
            renditions: [
              { name: '360p', width: 640, height: 360, bandwidth: 700_000, avgBandwidth: 700_000 },
              { name: '720p', width: 1280, height: 720, bandwidth: 2_800_000, avgBandwidth: 2_800_000 },
            ],
          },
          { mediaType: 'audio', renditions: [] },
        ],
      },
    );
    assert.deepEqual(buildUploaderCapabilities(), {
      lifecycleVersion: 1,
      capabilities: { durableCheckpointStore: 1, legacyRecordingAdoption: 1 },
      profiles: [
        { mediaType: 'video', renditions: [] },
        { mediaType: 'audio', renditions: [] },
      ],
    });
  });

  it('reports immediately and every ten seconds without overlapping an outstanding report', async () => {
    const clock = new FakeClock();
    const capability = buildUploaderCapabilities();
    const calls: Array<{ uploaderId: string; capability: UploaderCapabilities }> = [];
    let releaseFirst: ((receipt: UploaderCapabilityReceipt) => void) | undefined;
    const first = new Promise<UploaderCapabilityReceipt>((resolve) => {
      releaseFirst = resolve;
    });
    const admin = {
      reportUploaderCapabilities: async (uploaderId: string, body: UploaderCapabilities) => {
        calls.push({ uploaderId, capability: body });
        return calls.length === 1 ? first : RECEIPT;
      },
    } as AdminApiClient;
    const orchestrator = makeTestOrchestrator({ clock, adminApi: admin });

    orchestrator.startManagedCapabilityHeartbeat(UPLOADER_ID, capability);
    await tick();
    assert.deepEqual(calls, [{ uploaderId: UPLOADER_ID, capability }]);

    await clock.advance(30_000);
    assert.equal(calls.length, 1, 'an outstanding report was overlapped');
    releaseFirst?.(RECEIPT);
    await tick();

    await clock.advance(9_999);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { uploaderId: UPLOADER_ID, capability });

    await orchestrator.cleanup();
    await clock.advance(20_000);
    assert.equal(calls.length, 2, 'cleanup left the capability heartbeat armed');
  });

  it('keeps refreshing after a failed receipt', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const admin = {
      reportUploaderCapabilities: async () => {
        calls += 1;
        if (calls === 1) {throw new Error('admin unavailable');}
        return RECEIPT;
      },
    } as AdminApiClient;
    const orchestrator = makeTestOrchestrator({ clock, adminApi: admin });

    orchestrator.startManagedCapabilityHeartbeat(UPLOADER_ID, buildUploaderCapabilities());
    await tick();
    assert.equal(calls, 1);

    await clock.advance(10_000);
    assert.equal(calls, 2);
    await orchestrator.cleanup();
  });
});
