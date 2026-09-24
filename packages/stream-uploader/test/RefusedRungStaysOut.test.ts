/**
 * A rung whose uploads are being refused stays out of the master until it works again.
 *
 * ⛔⛔⛔ **Measured live 2026-09-23.** The 1080p rung's postage batch filled at 15:15 UTC. An immutable
 * batch refuses only the chunks that land in a full bucket, so most 1080p uploads were refused with
 * 402 and an occasional one still landed: 5,285 segments were lost between 15:00 and 20:15. Between
 * 16:17 and 20:14 the master was rewritten 793 times, flipping every 18 seconds or so between
 * `now produces 3 rung(s)` and `now produces 4 rung(s)`, and every flip was a catalog write too. The
 * rule dropped the rung once the ladder had delivered four segments it had not, and took it back on
 * the next one of its segments that landed, so every stray success offered viewers the rung again.
 *
 * Owner ruling: a quality whose uploads are failing stays out of the master until it works again,
 * instead of flipping in and out.
 *
 * Driven through a real uploader whose uploads a script refuses, because the uploader is the one place
 * a refused segment is known. The three healthy rungs are fed straight into the catalog, which is the
 * one call their own uploaders would make for each segment that lands.
 */

import { Bee, FeedIndex, PrivateKey } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { RUNG_DEATH_LAG_SEGMENTS, RUNG_READMIT_AFTER_SEGMENTS } from '../src/libs/LadderLiveness.js';
import { LadderIdentity } from '../src/libs/LadderRegistry.js';
import { Logger } from '../src/libs/Logger.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

import { makeFakeBee, makeFakeRecoveryStore, TEST_ANCHOR, testPublisher } from './helpers/fakes.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const GROUP = 'group-1';

/** The uploader announces as the address of the key it signs with, so the ladder has to be keyed the same way. */
const OWNER = new PrivateKey(TEST_STREAM_KEY).publicKey().address().toHex();
const IDENTITY: LadderIdentity = { title: 'title', owner: OWNER, group: GROUP, mediatype: MEDIA_TYPE_VIDEO };

const REFUSED_RUNG = { name: '1080p', width: 1920, height: 1080, configuredKbps: 5000 };
const REFUSED_RUNG_TOPIC = 'topic-1080p';

const LADDER: Rendition[] = [
  { name: '360p', width: 640, height: 360, topic: 'topic-360p', bandwidth: 800_000, avgBandwidth: 700_000 },
  { name: '480p', width: 854, height: 480, topic: 'topic-480p', bandwidth: 1_400_000, avgBandwidth: 1_200_000 },
  { name: '720p', width: 1280, height: 720, topic: 'topic-720p', bandwidth: 2_800_000, avgBandwidth: 2_500_000 },
  {
    name: REFUSED_RUNG.name,
    width: REFUSED_RUNG.width,
    height: REFUSED_RUNG.height,
    topic: REFUSED_RUNG_TOPIC,
    bandwidth: 5_000_000,
    avgBandwidth: 4_500_000,
  },
];
const SIBLINGS = LADDER.slice(0, 3).map((rendition) => rendition.name);

/** Deliveries per rung before the ladder announces, so every rung is on record as having produced something. */
const WARMUP_ROUNDS = 2;

/**
 * How often one of 1080p's uploads lands while its batch is full. Further apart than the ladder takes
 * to leave a rung behind, which is what makes the old rule drop it between two landings and take it
 * back at each of them.
 */
const LANDS_ONE_IN = RUNG_DEATH_LAG_SEGMENTS + 2;

/** Long enough for the flapping to repeat several times over, as it did for four hours on the stage. */
const REFUSING_ROUNDS = 8 * LANDS_ONE_IN;

/** A status bee answers a batch it will not stamp against, and one no retry window spends itself on. */
const PAYMENT_REQUIRED = 402;

/** A catalog feed that hands back whatever was last written to it, which is what four rungs merging need. */
function catalogFeed(payloads: string[]): Bee {
  const latest = () => (payloads.length === 0 ? [] : JSON.parse(payloads[payloads.length - 1]));
  return {
    makeFeedReader: () => ({
      downloadPayload: async (options?: { index?: FeedIndex }) =>
        options?.index
          ? { payload: { toJSON: latest } }
          : { feedIndex: FeedIndex.fromBigInt(BigInt(payloads.length)), payload: { toJSON: latest } },
    }),
    isConnected: async () => true,
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, payload: unknown) => {
        payloads.push(String(payload));
        return { reference: { toHex: () => 'ref' } };
      },
    }),
  } as unknown as Bee;
}

/** The private queues a round waits out, because every master rewrite is fire and forget. */
interface Queued {
  queue: { onIdle(): Promise<void> };
}
interface UploaderQueues {
  manifestQueue: { onIdle(): Promise<void> };
}

interface Ladder {
  catalog: StreamCatalog;
  uploader: StreamUploader;
  /** Whether each master written since the ladder settled offered the refused rung. */
  offeredSince: () => boolean[];
  /** One segment on every healthy rung, then 1080p's segment for the same moment, landing or refused. */
  round: (lands: boolean) => Promise<void>;
}

/** A four rung ladder mid-broadcast, every rung announced and delivering, with 1080p behind a real uploader. */
async function announcedLadder(): Promise<Ladder> {
  const payloads: string[] = [];
  const masters: boolean[] = [];
  const masterWriter = {
    publish: async (group: string, renditions: Rendition[]) => {
      masters.push(renditions.some((rendition) => rendition.name === REFUSED_RUNG.name));
      return { topic: group, index: masters.length - 1 };
    },
  } as unknown as MasterFeedWriter;

  const publisher = { rung: SINGLE_PUBLISHER, url: 'http://fake-bee:1633', stamp: 'stamp', bee: catalogFeed(payloads) };
  const publishers = { coordinator: () => publisher, forRung: () => publisher } as unknown as BeePublisherPool;
  const catalog = new StreamCatalog(publishers, TEST_STREAM_KEY, 'catalog-topic', undefined, masterWriter);
  await catalog.init();

  let landsNext = true;
  let references = 0;
  const bee = makeFakeBee({
    uploadData: async () =>
      landsNext
        ? { reference: { toHex: () => `ref${references++}` } }
        : Promise.reject({ status: PAYMENT_REQUIRED, message: 'batch is overissued' }),
    feedHead: () => null,
  });
  const uploader = new StreamUploader({
    anchor: TEST_ANCHOR,
    publisher: testPublisher(bee),
    streamCatalog: catalog,
    recoveryStore: makeFakeRecoveryStore(),
    streamKey: TEST_STREAM_KEY,
    redundancyLevel: 0,
    streamId: `live/stream_${REFUSED_RUNG.name}`,
    streamTopic: REFUSED_RUNG_TOPIC,
    mediatype: MEDIA_TYPE_VIDEO,
    ladder: { group: GROUP, rung: REFUSED_RUNG },
  });

  const settle = async (): Promise<void> => {
    await uploader.segmentQueue.onIdle();
    await (uploader as unknown as UploaderQueues).manifestQueue.onIdle();
    await (catalog as unknown as Queued).queue.onIdle();
    await new Promise((resolve) => setImmediate(resolve));
  };

  // ⚠️ Fed before it is announced, for the reason `StreamCatalog.test.ts` gives: a rung reaching the
  // liveness tracker changes the ladder's shape, and before any announce a shape change writes nothing.
  for (let warmup = 0; warmup < WARMUP_ROUNDS; warmup++) {
    for (const rendition of LADDER) {
      catalog.recordRungDelivered(GROUP, rendition.name);
    }
  }
  for (const rendition of LADDER) {
    await catalog.upsertRendition(IDENTITY, rendition);
  }
  const settledAt = masters.length;

  let segmentIndex = 0;
  return {
    catalog,
    uploader,
    offeredSince: () => masters.slice(settledAt),
    round: async (lands) => {
      for (const sibling of SIBLINGS) {
        catalog.recordRungDelivered(GROUP, sibling);
      }
      await settle();
      landsNext = lands;
      uploader.handleSegment(segmentIndex++, 1, Buffer.from(`1080p-segment-${segmentIndex}`));
      await settle();
    },
  };
}

/** One in every {@link LANDS_ONE_IN} of 1080p's uploads lands, the first included, and the rest are refused. */
const landsWhileTheBatchIsFull = (round: number): boolean => round % LANDS_ONE_IN === 0;

/** How many times a master put the refused rung back after one had taken it out. */
function readmissions(offered: readonly boolean[]): number {
  return offered.filter((isOffered, at) => at > 0 && isOffered && !offered[at - 1]).length;
}

/** How many times a master took the refused rung out after one had offered it. */
function drops(offered: readonly boolean[]): number {
  return offered.filter((isOffered, at) => at > 0 && !isOffered && offered[at - 1]).length;
}

/** Runs `run` with the log silenced, so an error line per refused segment does not flood the test output. */
async function quietly(run: () => Promise<void>): Promise<void> {
  const logger = Logger.getInstance();
  const previous = logger.configure({ sink: () => {} });
  try {
    await run();
  } finally {
    logger.configure(previous);
  }
}

describe('a rung whose uploads are being refused', () => {
  it('stays out of the master, however often one of its segments still lands', async () => {
    await quietly(async () => {
      const ladder = await announcedLadder();

      for (let round = 0; round < REFUSING_ROUNDS; round++) {
        await ladder.round(landsWhileTheBatchIsFull(round));
      }

      const offered = ladder.offeredSince();
      assert.ok(drops(offered) > 0, 'the refused rung was never dropped at all, so nothing here is tested');
      assert.equal(
        readmissions(offered),
        0,
        `the master put 1080p back ${readmissions(offered)} times over ${REFUSING_ROUNDS} segments, each time ` +
          'one of its uploads happened to land, which is the flapping of 2026-09-23',
      );
      assert.equal(drops(offered), 1, 'and it was taken out once, rather than once per stray segment');
    });
  });

  it('is not put back by the first segment that lands once the refusals stop', async () => {
    await quietly(async () => {
      const ladder = await announcedLadder();
      for (let round = 0; round < REFUSING_ROUNDS; round++) {
        await ladder.round(landsWhileTheBatchIsFull(round));
      }
      assert.equal(ladder.offeredSince().at(-1), false, 'the refused rung was supposed to be out by now');

      await ladder.round(true);

      assert.equal(
        ladder.offeredSince().at(-1),
        false,
        'one segment landing is not the rung working again, and the master offered it to viewers anyway',
      );
    });
  });

  it(`is put back once it has landed ${RUNG_READMIT_AFTER_SEGMENTS} segments in a row, which is it working again`, async () => {
    await quietly(async () => {
      const ladder = await announcedLadder();
      for (let round = 0; round < REFUSING_ROUNDS; round++) {
        await ladder.round(landsWhileTheBatchIsFull(round));
      }

      for (let landed = 1; landed < RUNG_READMIT_AFTER_SEGMENTS; landed++) {
        await ladder.round(true);
        assert.equal(ladder.offeredSince().at(-1), false, `offered again after only ${landed} segments in a row`);
      }
      await ladder.round(true);

      assert.equal(ladder.offeredSince().at(-1), true, 'a rung whose uploads work again was kept from viewers');
    });
  });
});
