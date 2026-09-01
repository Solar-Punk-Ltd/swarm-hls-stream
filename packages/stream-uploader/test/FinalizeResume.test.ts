import { Bee, BeeResponseError, FeedIndex, PrivateKey } from '@ethersphere/bee-js';
import { finalizeResumed, ladderFinalized } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool, SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { Logger } from '../src/libs/Logger.js';
import { ManifestManager } from '../src/libs/ManifestManager.js';
import { StreamCatalog } from '../src/libs/StreamCatalog.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { LadderMembership, MEDIA_TYPE_VIDEO, SegmentEntry, StreamStatus } from '../src/types.js';

import { FakeFeedHead, makeFakeBee, makeFakeCatalog, makeFakeRecoveryStore } from './helpers/fakes.js';

/**
 * ## Scenario H, as a unit: a finalize that comes back after a crash must not buy the recording twice
 *
 * `StreamUploader.finalize` publishes the closing playlist, then the VOD manifest, then writes the
 * catalog, and deletes the recovery entry last of all. A kill anywhere after the VOD manifest lands
 * therefore leaves a **paid-for recording in the feed** under an entry that still says the broadcast
 * is recoverable. Measured live on 2026-09-01: the reboot recovered the surviving rung, the recovery
 * timer fired, finalize ran again in full, and a second recording went into the feed at a higher
 * index with the first left bought and unreachable.
 *
 * So a recovered finalize asks the feed where the dead process got to before it publishes anything.
 * The recovery entry cannot answer that, and not because it is written badly: it is saved before the
 * writes it describes complete, and the crash is exactly what stopped it saying more. The feed head
 * is a retrieval, so the answer costs no postage where the guess costs a recording.
 *
 * ⛔ The discriminator is `#EXT-X-PLAYLIST-TYPE:VOD`, never `#EXT-X-ENDLIST` on its own. The closing
 * live playlist carries ENDLIST too and is published one SOC index EARLIER, so a crash between the
 * two leaves it at the head with the recording still unwritten. Both cases are driven below.
 */

const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const RUNG_TOPIC = 'rung-topic-1080p';
const LADDER_GROUP = 'group-h';

const SEGMENTS: SegmentEntry[] = [
  { index: 40, duration: 1, ref: 'ref40', discontinuity: false },
  { index: 41, duration: 1, ref: 'ref41', discontinuity: false },
];

/** The playlists the real producer writes, so the discriminator is read off `ManifestManager`. */
function manifests(segments: SegmentEntry[]): { vod: string; closingLive: string } {
  const manager = new ManifestManager();
  manager.restoreState(segments, ['#EXTM3U', '#EXT-X-VERSION:3']);
  return { vod: manager.buildVODManifest(), closingLive: manager.buildClosingLiveManifest() };
}

const PLAYLISTS = manifests(SEGMENTS);

/** One SOC write the uploader made to its own manifest feed. */
interface ManifestWrite {
  index: number;
  playlist: string;
}

interface RecoveredUploader {
  uploader: StreamUploader;
  /** Every manifest this finalize published, which on the resume path must be none. */
  published: ManifestWrite[];
  /** Stream ids whose recovery entry was deleted. */
  removed: string[];
  /** How many times the feed head was asked, so a session that must not ask can be shown not to. */
  headReads: () => number;
}

interface RecoveredOptions {
  /** What the manifest feed answers. `undefined` throws a 404, which is a feed nothing ever wrote. */
  feedHead?: () => FakeFeedHead | null;
  catalog?: StreamCatalog;
  ladder?: LadderMembership;
  socIndex?: number | null;
  /** Built without `restoreState`, which is an ordinary session rather than a recovered one. */
  fresh?: boolean;
}

const STREAM_ID = 'live/stream_1080p';

function makeRecovered(options: RecoveredOptions = {}): RecoveredUploader {
  const published: ManifestWrite[] = [];
  const removed: string[] = [];
  let reads = 0;

  const bee = makeFakeBee({
    uploadPayload: async (index, payload) => {
      published.push({ index, playlist: String(payload) });
      return { reference: { toHex: () => `soc${index}` } };
    },
    feedHead: () => {
      reads++;
      return options.feedHead ? options.feedHead() : null;
    },
  });

  const recoveryStore = makeFakeRecoveryStore({
    remove: (streamId: string) => {
      removed.push(streamId);
    },
  });

  const restoreState = {
    streamRawTopic: RUNG_TOPIC,
    socIndex: options.socIndex === undefined ? 9 : options.socIndex,
    segments: SEGMENTS,
    hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
    isFirstSegmentReady: true,
    isFirstManifestReady: true,
  };

  const uploader = new StreamUploader({
    bee,
    streamCatalog: options.catalog ?? makeFakeCatalog(),
    recoveryStore,
    streamKey: TEST_STREAM_KEY,
    stamp: 'stamp',
    redundancyLevel: 0,
    streamId: STREAM_ID,
    streamTopic: RUNG_TOPIC,
    mediatype: MEDIA_TYPE_VIDEO,
    ladder: options.ladder,
    restoreState: (options.fresh ? undefined : restoreState) as never,
  });

  return { uploader, published, removed, headReads: () => reads };
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

const linesHolding = (lines: string[], message: string): number => lines.filter((l) => l.includes(message)).length;

describe('a single-rendition finalize that comes back after a crash', () => {
  it('publishes nothing when its recording is already at the head of its own feed', async () => {
    const entries: Array<{ index?: number; state: string }> = [];
    const catalog = makeFakeCatalog({
      addStream: async (entry: { index?: number; state: string }) => {
        entries.push(entry);
      },
    });
    const { uploader, published, removed } = makeRecovered({
      catalog,
      feedHead: () => ({ index: 9, manifest: PLAYLISTS.vod }),
    });

    const lines = await logLinesDuring(() => uploader.notifyStop());

    assert.deepEqual(published, [], 'the recording was published a second time, which is what H measured');
    assert.equal(linesHolding(lines, finalizeResumed(STREAM_ID, 9)), 1, 'the resume must say so, once');
    assert.equal(entries.length, 1, 'the catalog write is the step the crash cut short and still has to run');
    assert.equal(entries[0].state, 'vod');
    assert.equal(entries[0].index, 9, 'the entry must point at the recording that is already in the feed');
    assert.deepEqual(removed, [STREAM_ID], 'a finished broadcast must leave no recovery entry');
  });

  /**
   * ⛔ The half a plain ENDLIST check would get wrong. The closing live playlist carries ENDLIST and
   * sits one index below the recording, so a resume that stopped here would skip the publish that
   * still had to happen and point the catalog at a live window.
   */
  it('runs the full publish when the crash landed before the recording went out', async () => {
    const entries: Array<{ index?: number }> = [];
    const catalog = makeFakeCatalog({
      addStream: async (entry: { index?: number }) => {
        entries.push(entry);
      },
    });
    const { uploader, published, removed } = makeRecovered({
      catalog,
      feedHead: () => ({ index: 9, manifest: PLAYLISTS.closingLive }),
    });

    const lines = await logLinesDuring(() => uploader.notifyStop());

    assert.equal(published.length, 2, 'the closing playlist and the recording both still had to be written');
    assert.equal(linesHolding(lines, 'Resuming the finalize of'), 0, 'nothing was resumed, so nothing may say so');
    assert.ok(published[1].playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD'), 'the second write is the recording');
    assert.deepEqual(
      entries.map((e) => e.index),
      [11],
      'the catalog must name the recording this finalize wrote, above the restored index',
    );
    assert.deepEqual(removed, [STREAM_ID]);
  });

  it('runs the full publish when the feed holds nothing at all', async () => {
    const { uploader, published } = makeRecovered({ socIndex: null });

    await uploader.notifyStop();

    assert.equal(published.length, 2, 'a crash before the first manifest leaves an empty feed and a full path');
  });

  /**
   * ⛔⛔⛔ The index has to come from the feed, never from the recovery entry. `commitManifest` sets
   * `socIndex` and persists it AFTER the SOC write it describes, so a crash in that gap leaves the
   * entry naming an index the feed has already moved past. Reading there returns the live playlist
   * from before the finalize, the guard concludes nothing was published, and the double publish is
   * back for exactly the crash it is supposed to answer.
   */
  it('finds the recording at the index the feed is really at, not the one the entry saved', async () => {
    const entries: Array<{ index?: number }> = [];
    const catalog = makeFakeCatalog({
      addStream: async (entry: { index?: number }) => {
        entries.push(entry);
      },
    });
    const { uploader, published } = makeRecovered({
      catalog,
      socIndex: 7,
      feedHead: () => ({ index: 9, manifest: PLAYLISTS.vod }),
    });

    const lines = await logLinesDuring(() => uploader.notifyStop());

    assert.deepEqual(published, [], 'a stale saved index must not read as a recording that was never published');
    assert.equal(linesHolding(lines, finalizeResumed(STREAM_ID, 9)), 1, 'the resume names where the feed really is');
    assert.deepEqual(
      entries.map((e) => e.index),
      [9],
    );
  });

  /**
   * ⛔⛔ The read failing is not the feed being empty, and treating it as one reinstates the double
   * publish on exactly the node that was already struggling. The finalize is deferred instead, which
   * costs an unfinalized interval and nothing that cannot be undone: the drain retires the uploader,
   * the recovery entry stays on disk, and the next boot asks again.
   */
  it('refuses to publish when it cannot read the head, and leaves the recovery entry behind', async () => {
    const { uploader, published, removed } = makeRecovered({
      feedHead: () => {
        throw new BeeResponseError('GET', '/feeds', 'Internal Server Error', undefined, 500, 'Internal Server Error');
      },
    });

    await assert.rejects(() => uploader.notifyStop(), /did not read within/);

    assert.deepEqual(published, [], 'a read it could not complete must never become a second recording');
    assert.deepEqual(removed, [], 'the entry is the only record the broadcast was live, so a deferral keeps it');
  });

  /**
   * ⛔⛔⛔ The hazard that would have made this whole guard dead code on the stage, and it would have
   * looked like the guard simply never firing. bee-js rejoins a payload over one 4096 byte chunk
   * only on the indexed read, and a VOD manifest naming every segment of a broadcast is always over
   * it. Read without an index, a real recording comes back as its wrapping chunk, `isFinishedRecording`
   * says no, and the second recording is published exactly as before, silently.
   *
   * `makeFakeBee` answers the two calls the way bee-js answers them, so a reader that stopped asking
   * at an index fails here rather than on a paid broadcast.
   */
  it('reads the playlist at its index, which is the only shape a real recording comes back on', async () => {
    const { uploader, published, headReads } = makeRecovered({
      feedHead: () => ({ index: 9, manifest: PLAYLISTS.vod }),
    });

    await uploader.notifyStop();

    assert.deepEqual(published, [], 'the recording at the head was not recognised, so it was bought again');
    assert.equal(headReads(), 2, 'the index and the playlist are two reads, and both are retrievals');
  });

  it('never asks the feed at all when the session was not recovered from a crash', async () => {
    const { uploader, published, headReads } = makeRecovered({ fresh: true });

    uploader.handleSegment(0, 1, Buffer.from('seg0'));
    await uploader.segmentQueue.onIdle();
    await uploader.notifyStop();

    assert.equal(headReads(), 0, 'a session that published every index it holds has nothing to ask');
    assert.ok(published.length >= 2, 'and it finalizes exactly as it always did');
  });
});

/** One write the catalog feed took, as a reader would parse it back. */
interface CatalogWrite {
  index: FeedIndex;
  payload: string;
}

/** A catalog feed that hands back whatever was last written to it, which is what a reboot reads. */
function catalogFeedBee(writes: CatalogWrite[]): Bee {
  const latest = () => (writes.length === 0 ? [] : JSON.parse(writes[writes.length - 1].payload));
  return {
    makeFeedReader: () => ({
      downloadPayload: async (opts?: { index?: FeedIndex }) =>
        opts?.index
          ? { payload: { toJSON: latest } }
          : { feedIndex: FeedIndex.fromBigInt(BigInt(writes.length)), payload: { toJSON: latest } },
    }),
    isConnected: async () => true,
    makeFeedWriter: () => ({
      uploadPayload: async (_stamp: string, payload: unknown, opts: { index: FeedIndex }) => {
        writes.push({ index: opts.index, payload: String(payload) });
        return { reference: { toHex: () => 'ref' } };
      },
    }),
  } as unknown as Bee;
}

function makeCatalog(bee: Bee): StreamCatalog {
  const publisher = { rung: SINGLE_PUBLISHER, url: 'http://fake-bee:1633', stamp: 'stamp', bee };
  const publishers = { coordinator: () => publisher, forRung: () => publisher } as unknown as BeePublisherPool;
  return new StreamCatalog(publishers, TEST_STREAM_KEY, 'catalog-topic');
}

const heldEntry = (writes: CatalogWrite[]) =>
  (JSON.parse(writes[writes.length - 1].payload) as Array<{ state: StreamStatus; renditions?: unknown[] }>)[0];

const LADDER: LadderMembership = {
  group: LADDER_GROUP,
  rung: { name: '1080p', width: 1920, height: 1080, configuredKbps: 5000 },
};

/**
 * ⚠️ The owner the recovered uploader will announce as, derived from the same key. Written out as a
 * literal instead, the pre-crash entries belong to a different owner, `buildLadderEntry` finds no
 * previous entry and every announce reads as the first flip. That is the fixture failing, not the
 * guard, and it looks identical to the defect.
 */
const LADDER_OWNER = new PrivateKey(TEST_STREAM_KEY).publicKey().address().toHex();

const LADDER_IDENTITY = { title: 'title', owner: LADDER_OWNER, group: LADDER_GROUP, mediatype: MEDIA_TYPE_VIDEO };

const rungOf360p = { name: '360p', width: 640, height: 360, topic: 'rung-topic-360p' };
const rungOf1080p = { name: '1080p', width: 1920, height: 1080, topic: RUNG_TOPIC };

const live360p = { ...rungOf360p, bandwidth: 800_000, avgBandwidth: 700_000 };
const live1080p = { ...rungOf1080p, bandwidth: 5_000_000, avgBandwidth: 4_500_000 };

/**
 * The catalog feed as the crash left it, walked through the sequence a real broadcast takes: every
 * rung announces itself live at session start, and each contributes an index when it finalizes.
 *
 * ⚠️ The order is load-bearing rather than decorative. Announcing a finished rung first would flip
 * the whole entry to VOD on that one announce, because a ladder is finished when every rung it has
 * announced carries an index, and one rung is every rung. The fixture would then be a ladder that
 * finalized before the broadcast started, which is not the case under test.
 *
 * The measured shape had four rungs and exactly one surviving entry. Two hold the property here,
 * which is that a ladder flips when the LAST of its rungs finalizes.
 *
 * @param finished whether 1080p already contributed its index before the crash, which is the whole
 * difference between a feed left saying `vod` and one left honestly saying `live`.
 */
async function ladderInTheFeed(catalog: StreamCatalog, finished: boolean): Promise<void> {
  await catalog.upsertRendition(LADDER_IDENTITY, live360p);
  await catalog.upsertRendition(LADDER_IDENTITY, live1080p);
  await catalog.upsertRendition(LADDER_IDENTITY, { ...live360p, index: 5, duration: 2 });
  if (finished) {
    await catalog.upsertRendition(LADDER_IDENTITY, { ...live1080p, index: 9, duration: 2 });
  }
}

describe('a recovered ladder rung whose entry outlived the recording', () => {
  /**
   * ⛔⛔⛔ The measured case, end to end. Ladder flipped, uploader killed, one rung's entry survived,
   * reboot recovered it and the recovery timer finalized it again. The flip must still be announced
   * exactly once for the broadcast, and nothing may be published a second time.
   */
  it('republishes nothing and does not announce a second flip', async () => {
    const writes: CatalogWrite[] = [];
    const bee = catalogFeedBee(writes);
    const live = makeCatalog(bee);
    await live.init();

    const before = await logLinesDuring(() => ladderInTheFeed(live, true));
    assert.equal(linesHolding(before, ladderFinalized(LADDER_GROUP)), 1, 'the broadcast flipped once before the kill');
    assert.equal(heldEntry(writes).state, 'vod');

    // The reboot: a fresh catalog over the same feed, and the surviving rung rebuilt from its entry.
    const rebooted = makeCatalog(bee);
    await rebooted.init();
    const { uploader, published, removed } = makeRecovered({
      catalog: rebooted,
      ladder: LADDER,
      feedHead: () => ({ index: 9, manifest: PLAYLISTS.vod }),
    });

    const after = await logLinesDuring(() => uploader.notifyStop());

    assert.deepEqual(published, [], 'the surviving rung bought its recording a second time');
    assert.equal(linesHolding(after, finalizeResumed(STREAM_ID, 9)), 1);
    assert.equal(
      linesHolding(after, ladderFinalized(LADDER_GROUP)),
      0,
      'a rung re-finalizing over a catalog that already says vod is not a second flip',
    );
    const finished = heldEntry(writes);
    assert.equal(finished.state, 'vod');
    assert.equal(finished.renditions?.length, 2, 'the recording must keep every rung it announced');
    assert.deepEqual(removed, [STREAM_ID]);
  });

  /**
   * The other side of the same window: the kill landed after the recording went into the feed and
   * **before** the catalog write, so the entry the reboot reads honestly still says live. The resume
   * still owes that write, so this is where the one flip of the broadcast is announced.
   */
  it('announces the flip once when the crash beat the catalog write', async () => {
    const writes: CatalogWrite[] = [];
    const bee = catalogFeedBee(writes);
    const live = makeCatalog(bee);
    await live.init();

    const before = await logLinesDuring(() => ladderInTheFeed(live, false));
    assert.equal(linesHolding(before, ladderFinalized(LADDER_GROUP)), 0, 'a rung still live is not a finished ladder');
    assert.equal(heldEntry(writes).state, 'live', 'the catalog write the crash cut short never landed');

    const rebooted = makeCatalog(bee);
    await rebooted.init();
    const { uploader, published } = makeRecovered({
      catalog: rebooted,
      ladder: LADDER,
      feedHead: () => ({ index: 9, manifest: PLAYLISTS.vod }),
    });

    const after = await logLinesDuring(() => uploader.notifyStop());

    assert.deepEqual(published, [], 'the recording was already in the feed, whatever the catalog had missed');
    assert.equal(linesHolding(after, ladderFinalized(LADDER_GROUP)), 1, 'the flip the crash cut short still happens');
    assert.equal(heldEntry(writes).state, 'vod');
  });
});
