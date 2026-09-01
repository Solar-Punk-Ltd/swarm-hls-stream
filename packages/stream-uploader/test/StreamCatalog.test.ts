import { Bee, BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { CatalogIndexStore } from '../src/libs/CatalogIndexStore.js';
import { StreamCatalog, TREAT_STATE_AS_LOST_AFTER } from '../src/libs/StreamCatalog.js';
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
  /** The catalog JSON the write carried, so a test can see which entries survived the read. */
  payload?: string;
}

/**
 * The shapes bee-js actually throws, confirmed against a live node and against a server that drops
 * a response body mid-transfer: every failure arrives as a BeeResponseError, `status` is unset when
 * no response completed, and axios's code comes through as `statusText`.
 */
const droppedBody = () =>
  new BeeResponseError('GET', '/feeds', 'response stream aborted', undefined, undefined, 'ECONNABORTED');
const connectionRefused = () =>
  new BeeResponseError('GET', '/feeds', 'connect ECONNREFUSED 127.0.0.1:1', undefined, undefined, 'ECONNREFUSED');
const chunkNotFound = () => new BeeResponseError('GET', '/chunks', 'Not Found.', undefined, 404, 'Not Found');

interface CatalogBeeOptions {
  lookupIndex?: bigint;
  lookupFails404?: boolean;
  /** The head lookup answers with headers and then drops the body. */
  lookupDropsBody?: boolean;
  /** The head lookup never reaches the node at all — a wrong url or a node that is down. */
  lookupRefused?: boolean;
  /** Whether the node answers a liveness check. Live unless a test says otherwise. */
  nodeLive?: boolean;
  /** The update at an explicit index is not in the network: its chunk is simply not found. */
  stateReadFails?: boolean;
  /** Entries a successful read of the current state returns. */
  stateEntries?: unknown[];
}

function makeCatalogBee(writes: CapturedWrite[], opts: CatalogBeeOptions = {}): Bee {
  return {
    makeFeedReader: () => ({
      downloadPayload: async (dlOpts?: { index?: FeedIndex }) => {
        // With an index this is fetchCurrentState; without, it is the init head lookup.
        if (dlOpts?.index) {
          if (opts.stateReadFails) {
            throw chunkNotFound();
          }
          return { payload: { toJSON: () => opts.stateEntries ?? [] } };
        }
        if (opts.lookupFails404) {
          throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
        }
        if (opts.lookupDropsBody) {
          throw droppedBody();
        }
        if (opts.lookupRefused) {
          throw connectionRefused();
        }
        return { feedIndex: FeedIndex.fromBigInt(opts.lookupIndex ?? 0n), payload: { toJSON: () => [] } };
      },
    }),
    isConnected: async () => opts.nodeLive ?? true,
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, data: unknown, writeOpts: CapturedWrite) => {
        writes.push({ ...writeOpts, payload: String(data) });
        return { reference: { toHex: () => 'ref' } };
      },
    }),
  } as unknown as Bee;
}

/** The catalog reaches its node through the pool's coordinator, so that is all a double needs. */
function makePublishers(bee: Bee): BeePublisherPool {
  const publisher = { rung: SINGLE_PUBLISHER, url: '', stamp: 'stamp', bee };
  return {
    coordinator: () => publisher,
    forRung: () => publisher,
  } as unknown as BeePublisherPool;
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
    const catalog = new StreamCatalog(makePublishers(makeCatalogBee(writes, { lookupFails404: true })), TEST_STREAM_KEY, TEST_TOPIC);

    await catalog.addStream(liveEntry());

    assert.equal(writes.length, 1);
    assert.equal(writes[0].deferred, true);
  });
});

describe('StreamCatalog boot-index hardening', () => {
  it('resumes from the persisted index when the boot lookup returns a stale head', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(makePublishers(makeCatalogBee(writes, { lookupIndex: 17n })), TEST_STREAM_KEY, TEST_TOPIC, store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes.length, 1);
    assert.equal(writes[0].index.toBigInt(), 126n, 'the write must continue after the persisted head, not fork the stale one');
  });

  it('resumes from the persisted index when the boot lookup finds no feed (404)', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(makePublishers(makeCatalogBee(writes, { lookupFails404: true })), TEST_STREAM_KEY, TEST_TOPIC, store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 126n, 'a not-yet-synced node must not reset the feed to index 0');
  });

  it('keeps the lookup head when it is ahead of the persisted index', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(10n);
    const catalog = new StreamCatalog(makePublishers(makeCatalogBee(writes, { lookupIndex: 125n })), TEST_STREAM_KEY, TEST_TOPIC, store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 126n);
  });

  it('persists the feed index after every successful write', async () => {
    const writes: CapturedWrite[] = [];
    const { store, saved } = fakeIndexStore(null);
    const catalog = new StreamCatalog(makePublishers(makeCatalogBee(writes, { lookupFails404: true })), TEST_STREAM_KEY, TEST_TOPIC, store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(saved.length, 1);
    assert.equal(saved[0].index.toBigInt(), 0n);
    assert.equal(saved[0].owner, new PrivateKey(TEST_STREAM_KEY).publicKey().address().toString());
    assert.equal(saved[0].topicHex, Topic.fromString(TEST_TOPIC).toString());
  });
});

describe('StreamCatalog unreadable-head hardening', () => {
  it('resumes from the persisted index when the head lookup drops the body on a live node', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupDropsBody: true })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 126n, 'an expired batch behind the head must not take the uploader off the air');
  });

  it('keeps the boot fatal when the lookup never reached the node', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupRefused: true })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await assert.rejects(
      () => catalog.init(),
      /ECONNREFUSED/,
      'a wrong url or a node that is down must refuse the boot, not start an uploader that cannot publish',
    );
  });

  it('keeps the boot fatal when the node does not answer a liveness check', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupDropsBody: true, nodeLive: false })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await assert.rejects(
      () => catalog.init(),
      /aborted/,
      'the same error code covers a timeout, so an unresponsive node stays a boot failure',
    );
  });

  it('refuses to start when the head is unreadable and no index was persisted', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(null);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupDropsBody: true })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await assert.rejects(
      () => catalog.init(),
      /aborted/,
      'without a floor to resume above, starting at 0 would fork the feed for every reader',
    );
  });

  it('fails the write while the resumed state is unreadable, and gives up only after three tries', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupDropsBody: true, stateReadFails: true })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await catalog.init();

    // Retrievability flaps, so the first attempts cost the update rather than the catalog.
    await assert.rejects(() => catalog.addStream(liveEntry()), /Not Found/);
    await assert.rejects(() => catalog.addStream(liveEntry()), /Not Found/);
    assert.equal(writes.length, 0, 'nothing may be written while the previous entries might still come back');

    await catalog.addStream(liveEntry());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].index.toBigInt(), 126n);
    assert.equal(JSON.parse(writes[0].payload ?? '[]').length, 1, 'the write carries the new entry over an empty previous state');

    // The window closes with the write that landed: index 126 is what this uploader just wrote, so
    // failing to read it again is a real failure from the first attempt.
    await assert.rejects(() => catalog.addStream(liveEntry()), /Not Found/);
    assert.equal(writes.length, 1);
  });

  it('opens the same window when the head is readable but below the persisted floor', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupIndex: 70n, stateReadFails: true })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await catalog.init();

    await assert.rejects(() => catalog.addStream(liveEntry()), /Not Found/);
    await assert.rejects(() => catalog.addStream(liveEntry()), /Not Found/);
    await catalog.addStream(liveEntry());

    assert.equal(writes.length, 1);
    assert.equal(writes[0].index.toBigInt(), 126n, 'a floor ahead of a readable head is still a state this uploader never read');
  });

  it('keeps an unreadable state fatal when the head read fine', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(null);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupIndex: 12n, stateReadFails: true })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await catalog.init();

    for (let attempt = 0; attempt < TREAT_STATE_AS_LOST_AFTER + 1; attempt++) {
      await assert.rejects(
        () => catalog.addStream(liveEntry()),
        /Not Found/,
        'a read that fails outside the boot window must not silently drop every other entry',
      );
    }
    assert.equal(writes.length, 0);
  });

  it('appends to the entries a successful state read returns', async () => {
    const writes: CapturedWrite[] = [];
    const existing = [{ ...liveEntry(), topic: 'other-uuid' }];
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupIndex: 3n, stateEntries: existing })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(JSON.parse(writes[0].payload ?? '[]').length, 2);
  });

  it('closes the window as soon as the state reads, so a later failure is fatal', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const reads = { fails: false };
    const bee = {
      makeFeedReader: () => ({
        downloadPayload: async (dlOpts?: { index?: FeedIndex }) => {
          if (!dlOpts?.index) {
            throw droppedBody();
          }
          if (reads.fails) {
            throw chunkNotFound();
          }
          return { payload: { toJSON: () => [] } };
        },
      }),
      isConnected: async () => true,
      makeFeedWriter: () => ({
        uploadPayload: async (_stamp: string, data: unknown, writeOpts: CapturedWrite) => {
          writes.push({ ...writeOpts, payload: String(data) });
          return { reference: { toHex: () => 'ref' } };
        },
      }),
    } as unknown as Bee;
    const catalog = new StreamCatalog(makePublishers(bee), TEST_STREAM_KEY, TEST_TOPIC, store);

    await catalog.init();
    await catalog.addStream(liveEntry());

    reads.fails = true;
    await assert.rejects(() => catalog.addStream(liveEntry()), /Not Found/);
  });
});
