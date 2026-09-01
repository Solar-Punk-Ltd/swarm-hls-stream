import { Bee, BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { CatalogIndexStore } from '../src/libs/CatalogIndexStore.js';
import { Logger } from '../src/libs/Logger.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
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

type CatalogEntry = ReturnType<typeof liveEntry>;

interface CapturedWrite {
  index: FeedIndex;
  deferred?: boolean;
  payload: string;
}

const beeStatusError = (status: number, message: string) =>
  new BeeResponseError('GET', '/feeds', message, undefined, status, message);

/** What a boot lookup throws when the feed topic has never been written to. */
const FEED_NOT_FOUND = beeStatusError(404, 'Not Found.');

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
  /** Thrown by the boot head lookup instead of answering with a head. */
  lookupThrows?: Error;
  /** What the feed already holds, as `fetchCurrentState` reads it back. */
  published?: CatalogEntry[];
  /** Awaited inside the feed write, so a test can hold one write open while it queues the next. */
  holdWrite?: () => Promise<void>;
  /** Called before each feed write. Returning an error throws it instead of recording the write. */
  writeFails?: () => Error | null;
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
          return { payload: { toJSON: () => opts.published ?? opts.stateEntries ?? [] } };
        }
        if (opts.lookupThrows) {
          throw opts.lookupThrows;
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
      uploadPayload: async (_stamp: string, payload: unknown, writeOpts: Omit<CapturedWrite, 'payload'>) => {
        const err = opts.writeFails?.();
        if (err) {
          throw err;
        }
        await opts.holdWrite?.();
        writes.push({ ...writeOpts, payload: String(payload) });
        return { reference: { toHex: () => 'ref' } };
      },
    }),
  } as unknown as Bee;
}

/** The catalog as a reader will parse it back out of the feed. */
function publishedBy(write: CapturedWrite): CatalogEntry[] {
  return JSON.parse(write.payload) as CatalogEntry[];
}

/** The log lines written while `run` is in flight, with the previous sink restored afterwards. */
async function logLinesDuring(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({ sink: (_level, line) => lines.push(line) });
  try {
    await run();
  } finally {
    logger.configure(previous);
  }
  return lines;
}

/**
/** The catalog reaches its node through the pool's coordinator, so that is all a double needs. */
/**
 * A catalog feed that reads back whatever was last written to it.
 *
 * `makeCatalogBee` serves a fixed payload, which is right for testing one write but cannot express
 * the read-merge-write four rungs of a ladder perform against each other.
 */
function feedbackBee(writes: CapturedWrite[]): Bee {
  const latest = () => (writes.length === 0 ? [] : JSON.parse(writes[writes.length - 1].payload));
  return {
    makeFeedReader: () => ({
      downloadPayload: async (dlOpts?: { index?: FeedIndex }) =>
        dlOpts?.index
          ? { payload: { toJSON: latest } }
          : { feedIndex: FeedIndex.fromBigInt(BigInt(writes.length)), payload: { toJSON: latest } },
    }),
    isConnected: async () => true,
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, payload: unknown, writeOpts: Omit<CapturedWrite, 'payload'>) => {
        writes.push({ ...writeOpts, payload: String(payload) });
        return { reference: { toHex: () => 'ref' } };
      },
    }),
  } as unknown as Bee;
}

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

function fakeIndexStore(
  initial: bigint | null,
  msSinceSaveFailed: number | null = null,
): { store: CatalogIndexStore; saved: SavedIndex[] } {
  const saved: SavedIndex[] = [];
  const store = {
    load: () => (initial === null ? null : FeedIndex.fromBigInt(initial)),
    save: (owner: string, topicHex: string, index: FeedIndex) => {
      saved.push({ owner, topicHex, index });
    },
    getMsSinceSaveFailed: () => msSinceSaveFailed,
  } as unknown as CatalogIndexStore;
  return { store, saved };
}

describe('StreamCatalog Swarm write options', () => {
  it('requests a deferred upload for the catalog feed write', async () => {
    const writes: CapturedWrite[] = [];
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await catalog.addStream(liveEntry());

    assert.equal(writes.length, 1);
    assert.equal(writes[0].deferred, true);
  });
});

/**
 * The catalog announce is the write that decides whether a broadcast is discoverable at all, and it
 * is the one write here with no fallback: a segment that never lands is one missing segment, a
 * catalog entry that never lands is a stream nobody can find. Its retry was covered only by
 * `common.test.ts` testing the helper in isolation. See TEST-1.
 */
describe('StreamCatalog survives a transient Bee failure (TEST-1)', () => {
  it('retries a feed write that fails with a retryable status', async () => {
    const writes: CapturedWrite[] = [];
    let attempts = 0;
    const catalog = new StreamCatalog(
      makePublishers(
        makeCatalogBee(writes, {
          lookupThrows: FEED_NOT_FOUND,
          writeFails: () => (attempts++ === 0 ? Object.assign(new Error('503 unavailable'), { status: 503 }) : null),
        }),
      ),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await catalog.addStream(liveEntry());

    assert.equal(attempts, 2, 'a 503 from a busy node has to be attempted again');
    assert.equal(writes.length, 1, 'and the entry reaches the feed, so the stream is discoverable');
  });

  it('gives up on a feed write that fails with a permanent status, rather than burning the window', async () => {
    const writes: CapturedWrite[] = [];
    let attempts = 0;
    const catalog = new StreamCatalog(
      makePublishers(
        makeCatalogBee(writes, {
          lookupThrows: FEED_NOT_FOUND,
          writeFails: () => {
            attempts++;
            return Object.assign(new Error('402 payment required'), { status: 402 });
          },
        }),
      ),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await assert.rejects(catalog.addStream(liveEntry()), /402/);
    assert.equal(attempts, 1, 'an exhausted stamp does not become usable by asking again');
    assert.equal(writes.length, 0);
  });
});

describe('StreamCatalog boot-index hardening', () => {
  it('resumes from the persisted index when the boot lookup returns a stale head', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupIndex: 17n })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes.length, 1);
    assert.equal(
      writes[0].index.toBigInt(),
      126n,
      'the write must continue after the persisted head, not fork the stale one',
    );
  });

  it('resumes from the persisted index when the boot lookup finds no feed (404)', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 126n, 'a not-yet-synced node must not reset the feed to index 0');
  });

  it('keeps the lookup head when it is ahead of the persisted index', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(10n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupIndex: 125n })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 126n);
  });

  it('persists the feed index after every successful write', async () => {
    const writes: CapturedWrite[] = [];
    const { store, saved } = fakeIndexStore(null);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(saved.length, 1);
    assert.equal(saved[0].index.toBigInt(), 0n);
    assert.equal(saved[0].owner, new PrivateKey(TEST_STREAM_KEY).publicKey().address().toString());
    assert.equal(saved[0].topicHex, Topic.fromString(TEST_TOPIC).toString());
  });

  it('adopts the lookup head when nothing is persisted', async () => {
    const writes: CapturedWrite[] = [];
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupIndex: 5n })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 6n, 'an uploader with no persisted floor still has to follow the head');
  });

  /**
   * The floor and the head agreeing is the ordinary case, and announcing it as a stale head sends an
   * operator looking for a fork that is not happening.
   */
  it('does not call a head that matches the persisted index stale', async () => {
    const writes: CapturedWrite[] = [];
    const { store } = fakeIndexStore(125n);
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupIndex: 125n })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
      store,
    );

    const lines = await logLinesDuring(() => catalog.init());

    assert.ok(
      lines.some((line) => line.includes('Loaded feed at index')),
      'the boot has to report something for the absence below to mean anything',
    );
    assert.deepEqual(
      lines.filter((line) => line.includes('stale index')),
      [],
      'a head that agrees with the persisted floor is not a stale head',
    );
  });

  it('rethrows a boot lookup that failed for a reason other than a missing feed', async () => {
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee([], { lookupThrows: beeStatusError(500, 'Internal Server Error.') })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await logLinesDuring(async () => {
      await assert.rejects(
        catalog.init(),
        /Internal Server Error/,
        'a broken node must not read as an empty feed, which would restart the index at 0',
      );
    });
  });

  it('starts fresh when the node reports the feed exists but holds no entries yet (503)', async () => {
    const writes: CapturedWrite[] = [];
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: beeStatusError(503, 'Service Unavailable.') })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.equal(writes[0].index.toBigInt(), 0n, 'an empty feed is where a first broadcast belongs, not an error');
  });
});

describe('StreamCatalog index-save health', () => {
  it('reports how long the persisted index has been failing to save', () => {
    const { store } = fakeIndexStore(null, 4200);
    const catalog = new StreamCatalog(makePublishers(makeCatalogBee([])), TEST_STREAM_KEY, TEST_TOPIC, store);

    assert.equal(catalog.getMsSinceIndexSaveFailed(), 4200);
  });

  it('reports nothing when no index is persisted at all', () => {
    const catalog = new StreamCatalog(makePublishers(makeCatalogBee([])), TEST_STREAM_KEY, TEST_TOPIC);

    assert.equal(catalog.getMsSinceIndexSaveFailed(), null);
  });
});

/**
 * Every write republishes the whole catalog, so what the payload holds is the whole directory a
 * viewer browses. Dropping somebody else's live stream from it takes that broadcast off the air for
 * every viewer who has not already joined, and the uploader that did it sees a successful write.
 */
describe('StreamCatalog publishes the whole catalog', () => {
  it('publishes exactly the announced stream on a first write', async () => {
    const writes: CapturedWrite[] = [];
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await catalog.init();
    await catalog.addStream(liveEntry());

    assert.deepEqual(publishedBy(writes[0]), [liveEntry()]);
  });

  it('keeps every other stream and replaces only its own entry', async () => {
    const writes: CapturedWrite[] = [];
    const supersededByThisWrite = { ...liveEntry(), title: 'the title before this announce' };
    const sameOwnerOtherTopic = { ...liveEntry(), topic: 'another-topic-uuid' };
    const otherOwnerSameTopic = { ...liveEntry(), owner: 'another-owner' };
    const unrelated = { ...liveEntry(), owner: 'another-owner', topic: 'another-topic-uuid' };
    const catalog = new StreamCatalog(
      makePublishers(
        makeCatalogBee(writes, {
          lookupIndex: 4n,
          published: [supersededByThisWrite, sameOwnerOtherTopic, otherOwnerSameTopic, unrelated],
        }),
      ),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );
    const announced = { ...liveEntry(), title: 'the title this announce carries' };

    await catalog.init();
    await catalog.addStream(announced);

    assert.deepEqual(
      publishedBy(writes[0]),
      [sameOwnerOtherTopic, otherOwnerSameTopic, unrelated, announced],
      'only the entry for this owner and topic is replaced, and the rest keep their order',
    );
  });
});

/**
 * Two announces racing produce two writes at the same index, and the second silently replaces the
 * first: the feed forks at that index and every reader following the original chain loses whichever
 * entry lost the race.
 */
describe('StreamCatalog serialises its feed writes', () => {
  it('gives every queued announce its own feed index', async () => {
    const writes: CapturedWrite[] = [];
    let releaseWrite!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND, holdWrite: () => held })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );

    await catalog.init();
    const first = catalog.addStream(liveEntry());
    const second = catalog.addStream({ ...liveEntry(), topic: 'another-topic-uuid' });
    releaseWrite();
    await Promise.all([first, second]);

    assert.deepEqual(
      writes.map((write) => write.index.toBigInt()),
      [0n, 1n],
      'a second announce arriving mid-write must queue behind it, not fork the feed at the same index',
    );
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

    assert.equal(
      writes[0].index.toBigInt(),
      126n,
      'an expired batch behind the head must not take the uploader off the air',
    );
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
    assert.equal(
      JSON.parse(writes[0].payload ?? '[]').length,
      1,
      'the write carries the new entry over an empty previous state',
    );

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
    assert.equal(
      writes[0].index.toBigInt(),
      126n,
      'a floor ahead of a readable head is still a state this uploader never read',
    );
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

describe('StreamCatalog ladder write path', () => {
  const identity = { title: 'title', owner: 'owner', group: 'group-1', mediatype: MEDIA_TYPE_VIDEO };
  const rung = {
    name: '360p',
    width: 640,
    height: 360,
    topic: 'rung-topic',
    bandwidth: 800_000,
    avgBandwidth: 700_000,
  };

  it('publishes the master before the catalog entry that points at it, and repoints the entry at the master', async () => {
    // The catalog entry carries the master's location, so the master has to exist first. Record the
    // order the two writes land in and assert the master precedes the catalog entry.
    const events: string[] = [];
    const writes: CapturedWrite[] = [];
    const publishedGroups: string[] = [];

    const bee = makeCatalogBee(writes, {
      lookupThrows: FEED_NOT_FOUND,
      holdWrite: () => {
        events.push('catalog');
        return Promise.resolve();
      },
    });

    const masterWriter = {
      publish: async (group: string) => {
        events.push('master');
        publishedGroups.push(group);
        return { topic: 'master-topic', index: 4 };
      },
    } as unknown as MasterFeedWriter;

    const catalog = new StreamCatalog(makePublishers(bee), TEST_STREAM_KEY, TEST_TOPIC, undefined, masterWriter);
    await catalog.init();

    await catalog.upsertRendition(identity, rung);

    assert.deepEqual(
      events,
      ['master', 'catalog'],
      'the master must be published before the catalog entry that names it',
    );
    assert.deepEqual(publishedGroups, ['group-1']);

    const written = JSON.parse(writes[0].payload) as Array<{ topic: string; group: string; renditions: unknown[] }>;
    assert.equal(written.length, 1);
    assert.equal(written[0].group, 'group-1');
    assert.equal(written[0].topic, 'master-topic', 'the catalog entry must point at the master, not the lowest rung');
    assert.equal(written[0].renditions.length, 1, 'the rung it still carries for a client without master support');
  });

  /**
   * Scenario H's open red, asked of the code rather than of a broadcast.
   *
   * `finalize-crash` kills the uploader the instant the ladder flips to VOD, reboots it, and asserts
   * the catalog was finalized once. On 2026-08-31 it counted two, and the count is of the
   * `Ladder <group> finalized to VOD` line, whose guard is "the entry the feed currently holds is
   * not already VOD". So the question these two cases settle is which of the two things a second
   * line means: a genuine second finalize, or a first finalize the guard could not see.
   */
  const finishedRung = { ...rung, index: 7, duration: 12 };

  /** A ladder entry as the feed holds it. `CatalogEntry` is the single-rendition shape. */
  const ladderEntries = (write: CapturedWrite) =>
    JSON.parse(write.payload) as Array<{ state: string; renditions?: unknown[] }>;
  const lastLadderEntry = (writes: CapturedWrite[]) => ladderEntries(writes[writes.length - 1])[0];

  it('logs the ladder finalize once when the same finished rung is re-announced after a crash', async () => {
    const writes: CapturedWrite[] = [];
    const bee = makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND });
    const catalog = new StreamCatalog(makePublishers(bee), TEST_STREAM_KEY, TEST_TOPIC);
    await catalog.init();

    const first = await logLinesDuring(() => catalog.upsertRendition(identity, finishedRung));
    // What the feed now holds is what a reboot would read back before re-finalizing.
    const afterFirst = publishedBy(writes[writes.length - 1]);
    const rebooted = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupIndex: 1n, published: afterFirst })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );
    await rebooted.init();
    const second = await logLinesDuring(() => rebooted.upsertRendition(identity, finishedRung));

    assert.equal(first.filter((l) => l.includes('finalized to VOD')).length, 1, 'the first finalize must say so');
    assert.equal(
      second.filter((l) => l.includes('finalized to VOD')).length,
      0,
      're-announcing a rung of an already finalized ladder is not a second finalize',
    );
  });

  /**
   * ⛔ The mechanism that would make H red without anything being finalized twice. The guard reads
   * the feed, so a reboot that comes back to an empty or unreadable catalog sees no previous entry,
   * concludes this is the live-to-VOD moment, and says so a second time. The line would then be
   * counting what the reader could see rather than what the uploader did.
   */
  it('says finalized a second time when the reboot reads a catalog that has lost the entry', async () => {
    const writes: CapturedWrite[] = [];
    const catalog = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );
    await catalog.init();
    await logLinesDuring(() => catalog.upsertRendition(identity, finishedRung));

    // A reboot whose catalog read yields nothing, which is what an empty or stale head looks like.
    const blind = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );
    await blind.init();
    const second = await logLinesDuring(() => blind.upsertRendition(identity, finishedRung));

    assert.equal(
      second.filter((l) => l.includes('finalized to VOD')).length,
      1,
      'a blind read makes the guard call it the first finalize, which is what H would count twice',
    );
  });

  /**
   * ⛔⛔ What a blind read would cost beyond the log line. `buildLadderEntry` merges the incoming
   * rung into whatever the previous entry held, so a read that yields nothing rebuilds the ladder
   * from the one rung in hand and would write THAT over a finished four rung recording.
   *
   * ⚠️ Booted **without** a `CatalogIndexStore`, which is the case this pins and is NOT how the
   * deployment runs. The realistic reboot is the case below, which has the persisted index the
   * store saves on every write. Both are kept because the difference between them is the whole of
   * the protection, and a change that quietly stopped passing the store would otherwise look fine.
   */
  it('rebuilds a four rung recording as a one rung recording when it reboots with no persisted index', async () => {
    const writes: CapturedWrite[] = [];
    const ladder = ['360p', '480p', '720p', '1080p'].map((name, i) => ({
      ...rung,
      name,
      topic: `rung-${name}`,
      index: 7 + i,
      duration: 12,
    }));

    // A feed that hands back what was last written to it, which is what four rungs merging needs.
    const live = new StreamCatalog(makePublishers(feedbackBee(writes)), TEST_STREAM_KEY, TEST_TOPIC);
    await live.init();
    for (const r of ladder) {
      await live.upsertRendition(identity, r);
    }
    assert.equal(lastLadderEntry(writes).renditions?.length, 4, 'all four rungs were recorded');

    const blind = new StreamCatalog(
      makePublishers(makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND })),
      TEST_STREAM_KEY,
      TEST_TOPIC,
    );
    await blind.init();
    await blind.upsertRendition(identity, ladder[0]);

    assert.equal(
      lastLadderEntry(writes).renditions?.length,
      1,
      'with no floor to resume above, the rebuilt entry is the one rung it holds',
    );
  });

  /** The reboot the deployment actually performs: the store saved an index on every write. */
  it('keeps all four rungs when the reboot resumes from its persisted index', async () => {
    const writes: CapturedWrite[] = [];
    const ladder = ['360p', '480p', '720p', '1080p'].map((name, i) => ({
      ...rung,
      name,
      topic: `rung-${name}`,
      index: 7 + i,
      duration: 12,
    }));

    const live = new StreamCatalog(makePublishers(feedbackBee(writes)), TEST_STREAM_KEY, TEST_TOPIC);
    await live.init();
    for (const r of ladder) {
      await live.upsertRendition(identity, r);
    }
    assert.equal(lastLadderEntry(writes).renditions?.length, 4);

    const { store } = fakeIndexStore(BigInt(writes.length));
    const rebooted = new StreamCatalog(makePublishers(feedbackBee(writes)), TEST_STREAM_KEY, TEST_TOPIC, store);
    await rebooted.init();
    const before = writes.length;
    await rebooted.upsertRendition(identity, ladder[0]);

    const entry = lastLadderEntry(writes);
    assert.equal(entry.renditions?.length, 4, 'the reboot must read the finished ladder back, not replace it');
    assert.equal(entry.state, 'vod', 'and it must still be a finished recording');
    assert.ok(writes.length > before, 'the re-announce still wrote, so this is not passing by doing nothing');
  });

  it('falls back to pointing the entry at the lowest rung when no master writer is configured', async () => {
    const writes: CapturedWrite[] = [];
    const bee = makeCatalogBee(writes, { lookupThrows: FEED_NOT_FOUND });

    const catalog = new StreamCatalog(makePublishers(bee), TEST_STREAM_KEY, TEST_TOPIC);
    await catalog.init();

    await catalog.upsertRendition(identity, rung);

    const written = JSON.parse(writes[0].payload) as Array<{ topic: string }>;
    assert.equal(
      written[0].topic,
      'rung-topic',
      'without a master the entry points at the rung a bare client can play',
    );
  });
});
