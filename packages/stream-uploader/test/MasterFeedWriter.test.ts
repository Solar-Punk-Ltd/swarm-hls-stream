import { BeeResponseError, FeedIndex, PrivateKey } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool } from '../src/libs/BeePublisherPool.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
import { Rendition } from '../src/types.js';

const TEST_KEY = '0'.repeat(63) + '1';

const rung = (name: string): Rendition => ({
  name,
  width: 640,
  height: 360,
  topic: `topic-${name}`,
  bandwidth: 800_000,
  avgBandwidth: 700_000,
});

interface WriterOptions {
  /** The group's master feed already holds a head at this index, as a restart mid-ladder leaves it. */
  headIndex?: bigint;
  /** The feed reader answers 404, the shape of a group whose master was never written. */
  headMissing?: boolean;
}

function makeWriter(writes: bigint[], opts: WriterOptions = {}): MasterFeedWriter {
  const bee = {
    makeFeedReader: () => ({
      downloadPayload: async () => {
        if (opts.headMissing) {
          throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
        }
        return { feedIndex: FeedIndex.fromBigInt(opts.headIndex ?? 0n) };
      },
    }),
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, _payload: unknown, writeOpts: { index: FeedIndex }) => {
        writes.push(writeOpts.index.toBigInt());
        return { reference: { toHex: () => 'ref' } };
      },
    }),
  };
  const publisher = { rung: 'coordinator', url: '', stamp: 'stamp', bee };
  const publishers = { coordinator: () => publisher } as unknown as BeePublisherPool;
  return new MasterFeedWriter(publishers, new PrivateKey(TEST_KEY));
}

describe('MasterFeedWriter next index', () => {
  it('probes the feed on the first write, so a recovering ladder does not rewind its master', async () => {
    // The group id is the feed topic and it survives a restart. An uploader that recovers a ladder
    // mid-stream must continue past the master a viewer is already reading, not overwrite it at 0.
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headIndex: 5n });

    const published = await writer.publish('group-1', [rung('360p')]);

    assert.equal(published?.index, 6, 'a probed head at 5 must write the next master at 6, not 0');
    assert.deepEqual(writes, [6n]);
  });

  it('starts at 0 when the group has never had a master', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headMissing: true });

    const published = await writer.publish('group-1', [rung('360p')]);

    assert.equal(published?.index, 0);
    assert.deepEqual(writes, [0n]);
  });

  it('continues from its cached index without probing again after the first write', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes, { headIndex: 5n });

    await writer.publish('group-1', [rung('360p')]);
    await writer.publish('group-1', [rung('360p'), rung('720p')]);

    assert.deepEqual(writes, [6n, 7n], 'the second write continues from the cached index rather than re-probing');
  });

  it('publishes nothing for an empty rung list', async () => {
    const writes: bigint[] = [];
    const writer = makeWriter(writes);

    const published = await writer.publish('group-1', []);

    assert.equal(published, null);
    assert.deepEqual(writes, []);
  });
});
