import { BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import { feedSlotReference } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { BeePublisherPool } from '../src/libs/BeePublisherPool.js';
import {
  ManagedMasterBinding,
  ManagedMasterIntent,
  ManagedMasterPersistence,
  ManagedMasterStore,
} from '../src/libs/ManagedMasterStore.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
import { Rendition } from '../src/types.js';

const TEST_KEY = '0'.repeat(63) + '1';
const BINDING: ManagedMasterBinding = {
  streamId: '11111111-1111-4111-8111-111111111111',
  runNumber: 2,
  uploaderId: 'srs-uploader-a',
  claimId: '22222222-2222-4222-8222-222222222222',
  group: '33333333-3333-4333-8333-333333333333',
};
const RENDITIONS: Rendition[] = [
  {
    name: '360p',
    topic: '44444444-4444-4444-8444-444444444444',
    width: 640,
    height: 360,
    bandwidth: 800_000,
    avgBandwidth: 700_000,
  },
];

class CommitCrashStore implements ManagedMasterPersistence {
  constructor(private readonly delegate: ManagedMasterStore) {}
  read(binding: ManagedMasterBinding) {
    return this.delegate.read(binding);
  }
  latestCommittedIndex(group: string) {
    return this.delegate.latestCommittedIndex(group);
  }
  seedCommitted(intent: Omit<ManagedMasterIntent, 'lifecycleVersion' | 'status'> & { readonly reference: string }) {
    return this.delegate.seedCommitted(intent);
  }
  prepare(intent: Omit<ManagedMasterIntent, 'lifecycleVersion' | 'status' | 'reference'>) {
    return this.delegate.prepare(intent);
  }
  commit(_intent: ManagedMasterIntent, _reference: string): ManagedMasterIntent {
    throw new Error('process crashed after Bee acknowledgement');
  }
}

describe('managed master publication recovery', () => {
  it('reconciles the exact fixed index after Bee acknowledged before the local commit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-master-writer-'));
    let payload: string | undefined;
    let uploads = 0;
    const signer = new PrivateKey(TEST_KEY);
    const reference = feedSlotReference(
      signer.publicKey().address().toHex(),
      Topic.fromString(BINDING.group),
      FeedIndex.fromBigInt(0n),
    ).toHex();
    const bee = {
      makeFeedReader: () => ({
        downloadPayload: async () => {
          if (payload === undefined) {
            throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
          }
          return { payload: { toUtf8: () => payload } };
        },
      }),
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, next: unknown) => {
          uploads += 1;
          payload = String(next);
          return { reference: { toHex: () => reference } };
        },
      }),
    };
    const publishers = {
      coordinator: () => ({ rung: 'coordinator', stamp: 'stamp', bee }),
    } as unknown as BeePublisherPool;

    try {
      const store = new ManagedMasterStore(root);
      const first = new MasterFeedWriter(publishers, signer);
      await assert.rejects(
        () => first.publishManaged(BINDING.group, RENDITIONS, 'rendition:4', BINDING, new CommitCrashStore(store)),
        /crashed after Bee acknowledgement/,
      );
      assert.equal(uploads, 1);

      const restarted = new MasterFeedWriter(publishers, signer);
      assert.deepEqual(
        await restarted.publishManaged(BINDING.group, RENDITIONS, 'rendition:4', BINDING, new ManagedMasterStore(root)),
        { topic: BINDING.group, index: 0, reference },
      );
      assert.equal(uploads, 1, 'restart must reconcile the acknowledged index instead of publishing above it');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a successor above the durable predecessor when the feed head looks empty', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-master-floor-'));
    const store = new ManagedMasterStore(root);
    store.seedCommitted({
      ...BINDING,
      eventId: 'legacy-adoption:candidate-a',
      index: 12,
      playlist: '#EXTM3U\nA',
      reference: 'a'.repeat(64),
    });
    const successor = { ...BINDING, runNumber: 3, claimId: '55555555-5555-4555-8555-555555555555' };
    const written: bigint[] = [];
    const bee = {
      makeFeedReader: () => ({
        downloadPayload: async () => {
          throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
        },
      }),
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, _payload: unknown, options: { index: { toBigInt(): bigint } }) => {
          written.push(options.index.toBigInt());
          return { reference: { toHex: () => 'b'.repeat(64) } };
        },
      }),
    };
    const publishers = {
      coordinator: () => ({ rung: 'coordinator', stamp: 'stamp', bee }),
    } as unknown as BeePublisherPool;

    try {
      await new MasterFeedWriter(publishers, new PrivateKey(TEST_KEY)).publishManaged(
        BINDING.group,
        RENDITIONS,
        'rendition:1',
        successor,
        store,
      );
      assert.deepEqual(written, [13n]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
