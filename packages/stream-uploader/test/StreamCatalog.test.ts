import { Bee, BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CatalogIndexStore } from '../src/libs/CatalogIndexStore.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { MEDIA_TYPE_VIDEO, STREAM_STATUS_LIVE } from '../src/types.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const TEST_TOPIC = 'test-topic';

const liveEntry = () => ({
  title: 'title',
  owner: 'owner',
  topic: 'topic-uuid',
  state: STREAM_STATUS_LIVE,
  mediatype: MEDIA_TYPE_VIDEO,
  timestamp: 0,
});

interface CapturedWrite {
  index: FeedIndex;
  deferred?: boolean;
}

interface CatalogBeeOptions {
  lookupIndex?: bigint;
  lookupFails404?: boolean;
}

function makeCatalogBee(writes: CapturedWrite[], opts: CatalogBeeOptions = {}): Bee {
  return {
    makeFeedReader: () => ({
      downloadPayload: async (dlOpts?: { index?: FeedIndex }) => {
        // With an index this is fetchCurrentState; without, it is the init head lookup.
        if (dlOpts?.index) {
          return { payload: { toJSON: () => [] } };
        }
        if (opts.lookupFails404) {
          throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
        }
        return { feedIndex: FeedIndex.fromBigInt(opts.lookupIndex ?? 0n), payload: { toJSON: () => [] } };
      },
    }),
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, _data: unknown, writeOpts: CapturedWrite) => {
        writes.push(writeOpts);
        return { reference: { toHex: () => 'ref' } };
      },
    }),
  } as unknown as Bee;
}

interface SavedIndex {
  owner: string;
  topicHex: string;
  index: FeedIndex;
}

function fakeIndexStore(initial: bigint | null): { store: CatalogIndexStore; saved: SavedIndex[] } {
  const saved: SavedIndex[] = [];
  const store = {
    load: () => (initial === null ? null : FeedIndex.fromBigInt(initial)),
    save: (owner: string, topicHex: string, index: FeedIndex) => {
      saved.push({ owner, topicHex, index });
    },
  } as unknown as CatalogIndexStore;
  return { store, saved };
}

describe('StreamCatalog Swarm write options', () => {
  it('requests a deferred upload for the catalog feed write', async () => {
    const writes: CapturedWrite[] = [];
    const catalog = new StreamCatalog(makeCatalogBee(writes, { lookupFails404: true }), TEST_STREAM_KEY, TEST_TOPIC, 'stamp');

    await catalog.addStream(liveEntry());

    assert.equal(writes.length, 1);
    assert.equal(writes[0].deferred, true);
  });
});

describe('StreamCatalog boot-index hardening', () => {
  it('resumes from the persisted index when the boot lookup returns a stale head', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(makeCatalogBee(writes, { lookupIndex: 17n }), TEST_STREAM_KEY, TEST_TOPIC, 'stamp', store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes.length, 1);
    assert.equal(writes[0].index.toBigInt(), 126n, 'the write must continue after the persisted head, not fork the stale one');
  });

  it('resumes from the persisted index when the boot lookup finds no feed (404)', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(makeCatalogBee(writes, { lookupFails404: true }), TEST_STREAM_KEY, TEST_TOPIC, 'stamp', store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 126n, 'a not-yet-synced node must not reset the feed to index 0');
  });

  it('keeps the lookup head when it is ahead of the persisted index', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(10n);
    const catalog = new StreamCatalog(makeCatalogBee(writes, { lookupIndex: 125n }), TEST_STREAM_KEY, TEST_TOPIC, 'stamp', store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 126n);
  });

  it('persists the feed index after every successful write', async () => {
    const writes: CapturedWrite[] = [];
    const { store, saved } = fakeIndexStore(null);
    const catalog = new StreamCatalog(makeCatalogBee(writes, { lookupFails404: true }), TEST_STREAM_KEY, TEST_TOPIC, 'stamp', store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(saved.length, 1);
    assert.equal(saved[0].index.toBigInt(), 0n);
    assert.equal(saved[0].owner, new PrivateKey(TEST_STREAM_KEY).publicKey().address().toString());
    assert.equal(saved[0].topicHex, Topic.fromString(TEST_TOPIC).toString());
  });
});
