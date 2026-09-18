/**
 * What admin mode changes about a broadcast once the gate has admitted it: whose topic it publishes
 * on, where in that topic's feed it starts writing, and who is told that it went live and became a
 * recording.
 *
 * ## The three properties, and why each one is here
 *
 * 1. **The topic belongs to the declaration.** A standalone single-rendition session mints a fresh
 *    `crypto.randomUUID()` topic, so an empty feed and index 0 cannot collide with anything. A
 *    declared stream keeps one topic for its whole life, which is what makes it reachable before it
 *    has ever published — and what makes a second session on it dangerous.
 * 2. **So the feed index resumes from the feed head.** Without it the second broadcast on a declared
 *    stream starts at index 0 and writes over the first, including whatever the previous recording's
 *    opening was. The feed is the only thing that knows: this process may never have seen the earlier
 *    session, and its recovery entry was deleted when it finalized.
 * 3. **Nothing is written to the stream catalog, and the admin is told instead.** The admin owns the
 *    list of streams here, so a second writer would publish entries nothing reconciles. The two
 *    reports land at exactly the two moments the catalog's own entries would have, carrying exactly
 *    what those entries would have carried.
 * 4. **And a replacement session waits for the one it replaced.** (2) reads the head once and latches
 *    it, which is sound only once the head has stopped moving — and a re-announce leaves the retired
 *    session writing its own closing and VOD playlists to this same topic. Without the wait the two
 *    claim the same indexes and the old recording ends up above the live broadcast.
 */

import { Bee } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_STATE_LIVE,
  ADMIN_STATE_VOD,
  AdminApiClient,
  AdminStateReport,
  STATE_REPORT_ACCEPTED,
  STATE_REPORT_FAILED,
  StateReportOutcome,
} from '../src/libs/AdminApiClient.js';
import { LadderRegistry, RenditionAnnouncement } from '../src/libs/LadderRegistry.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO, Rendition, StreamState } from '../src/types.js';

import {
  FakeFeedHead,
  makeFakeBee,
  makeFakeCatalog,
  makeFakeRecoveryStore,
  makeTestOrchestrator,
  TEST_ANCHOR,
  testPublisher,
} from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

const TEST_STREAM_KEY = '0'.repeat(63) + '1';
const STREAM_ID = 'video/demo';
const DECLARED_TOPIC = 'declared-topic-0001';
const ADMIN_STREAM_ID = 'str_01HZY';
const SETTLE_CEILING_MS = 4_000;

/** A playlist the head read can hand back. Its content decides nothing on the resume path. */
const SOME_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n';

/**
 * A read failure that is not a 404 and not worth retrying, so the head read fails on its first
 * attempt instead of spending its fifteen second window proving it.
 */
const headReadRefused = () => Object.assign(new Error('bee refused the read'), { status: 400 });

/**
 * How many `downloadPayload` calls one head read makes, which is two and not one.
 *
 * `readManifestFeedHead` asks without an index for the head's position and then again **at** that
 * index for the payload, because bee-js only rejoins a payload larger than one chunk on the indexed
 * path. The fake answers both out of the same fixture, so a counter on it counts downloads rather
 * than head reads, and the ratio has to be stated rather than assumed.
 */
const DOWNLOADS_PER_HEAD_READ = 2;

/** One SOC write the uploader made to its manifest feed. */
interface ManifestWrite {
  index: number;
  playlist: string;
}

interface Session {
  uploader: StreamUploader;
  /** Every manifest this session published, in order. Its first index is the whole of property 2. */
  published: ManifestWrite[];
  /** Every catalog entry written. In admin mode this must stay empty. */
  catalogEntries: unknown[];
  /** Every state report delivered to the admin, in order. */
  reports: AdminStateReport[];
  /** Every state the recovery entry was saved in. */
  saved: StreamState[];
}

interface SessionOptions {
  /** What the manifest feed head answers. Absent throws a 404, which is a topic nothing ever wrote. */
  feedHead?: () => FakeFeedHead | null;
  /** Answer for each report in turn, so a failure can be driven. Defaults to accepting every one. */
  reportOutcome?: (report: AdminStateReport) => StateReportOutcome;
  /** Built without `admin`, which is the standalone deployment this service has always been. */
  standalone?: boolean;
  /** The finalize of the session this one replaced, when this session is a re-announce's replacement. */
  predecessorDrained?: Promise<void>;
}

/**
 * A fresh session on a declared topic.
 *
 * The admin client is a stand-in rather than a real one over an injected fetch, because what these
 * cases are about is which reports the uploader decides to make and in what order.
 * `AdminApiClient.test.ts` is where the call itself is driven.
 */
function newSession(options: SessionOptions = {}): Session {
  const published: ManifestWrite[] = [];
  const catalogEntries: unknown[] = [];
  const reports: AdminStateReport[] = [];
  const saved: StreamState[] = [];

  const bee = makeFakeBee({
    uploadPayload: async (index, payload) => {
      published.push({ index, playlist: String(payload) });
      return { reference: { toHex: () => `soc${index}` } };
    },
    feedHead: options.feedHead ?? (() => null),
  });

  const client = {
    describe: () => 'http://admin.test:9877',
    reportState: async (_id: string, report: AdminStateReport) => {
      reports.push(report);
      return options.reportOutcome?.(report) ?? STATE_REPORT_ACCEPTED;
    },
  } as unknown as AdminApiClient;

  const uploader = new StreamUploader({
    anchor: TEST_ANCHOR,
    publisher: testPublisher(bee as Bee),
    streamCatalog: makeFakeCatalog({
      addStream: async (entry: unknown) => {
        catalogEntries.push(entry);
        return true;
      },
    }),
    recoveryStore: makeFakeRecoveryStore({
      save: (_id: string, state: StreamState) => {
        saved.push(state);
      },
    }),
    streamKey: TEST_STREAM_KEY,
    redundancyLevel: 0,
    streamId: STREAM_ID,
    streamTopic: DECLARED_TOPIC,
    mediatype: MEDIA_TYPE_VIDEO,
    admin: options.standalone ? undefined : { client, id: ADMIN_STREAM_ID },
    predecessorDrained: options.predecessorDrained,
  });

  return { uploader, published, catalogEntries, reports, saved };
}

async function drain(uploader: StreamUploader): Promise<void> {
  await uploader.segmentQueue.onIdle();
  await (uploader as unknown as { manifestQueue: { onIdle(): Promise<void> } }).manifestQueue.onIdle();
}

async function feedOneSegment(uploader: StreamUploader, index: number): Promise<void> {
  uploader.handleSegment(index, 2, Buffer.from(`seg${index}`));
  await drain(uploader);
}

describe('the feed index a declared topic resumes from', () => {
  /**
   * ⛔⛔ The case the whole mechanism exists for. The declaration's topic already holds a previous
   * broadcast, and a session that started at 0 would publish over it — over the recording's own
   * opening playlist first of all.
   */
  it('continues above the head the topic already holds', async () => {
    const session = newSession({ feedHead: () => ({ index: 7, manifest: SOME_PLAYLIST }) });
    await feedOneSegment(session.uploader, 0);

    assert.equal(session.published[0]?.index, 8, 'the first write of this session must sit above the feed head');
  });

  it('starts at zero when nothing has ever been written on the topic', async () => {
    const session = newSession();
    await feedOneSegment(session.uploader, 0);

    assert.equal(session.published[0]?.index, 0, 'a 404 is an answer: the feed is empty, so 0 is right');
  });

  it('asks the feed once and then publishes straight through', async () => {
    let downloads = 0;
    const session = newSession({
      feedHead: () => {
        downloads++;
        return { index: 3, manifest: SOME_PLAYLIST };
      },
    });

    await feedOneSegment(session.uploader, 0);
    await feedOneSegment(session.uploader, 1);
    await feedOneSegment(session.uploader, 2);

    assert.equal(
      downloads,
      DOWNLOADS_PER_HEAD_READ,
      'the head is established once per session, not once per manifest: a retrieval per segment is what ' +
        'the latch exists to avoid',
    );
    assert.deepEqual(
      session.published.map((write) => write.index),
      [4, 5, 6],
      'and the indexes step from the head rather than restarting at it, which is the same fact read off the feed',
    );
  });

  /**
   * ⛔ Refused rather than guessed. Taking a failed read for an empty feed is what overwrites the
   * previous recording, and the cost of refusing is a stale live playlist for one segment interval.
   * The session is not latched by the failure: the next segment asks again.
   */
  it('refuses to publish while it cannot tell where the topic has got to, and retries at the next segment', async () => {
    let attempts = 0;
    const session = newSession({
      feedHead: () => {
        if (++attempts === 1) {
          throw headReadRefused();
        }
        return { index: 5, manifest: SOME_PLAYLIST };
      },
    });

    await feedOneSegment(session.uploader, 0);
    // A length rather than `deepEqual` against `[]`: node's assertion signature narrows the array to
    // `never[]` for the rest of the block, and the next assertion is about what ends up in it.
    assert.equal(session.published.length, 0, 'nothing may be written on a topic whose head is unknown');

    await feedOneSegment(session.uploader, 1);
    assert.equal(session.published[0]?.index, 6, 'the retried read settles the index and publishing resumes above it');
  });

  /**
   * A standalone single-rendition stream is untouched, and it is the only session left that is. Its
   * topic is a fresh uuid, so there is nothing to resume from and asking would spend a retrieval per
   * session to be told so. A standalone RUNG is not this case: its topic is derived from its ladder
   * and outlives it, so it reads the head like any declared stream — see `LadderIdentity.test.ts`.
   */
  it('is not run at all for a standalone single-rendition stream', async () => {
    let reads = 0;
    const session = newSession({
      standalone: true,
      feedHead: () => {
        reads++;
        return { index: 7, manifest: SOME_PLAYLIST };
      },
    });

    await feedOneSegment(session.uploader, 0);

    assert.equal(reads, 0);
    assert.equal(session.published[0]?.index, 0, 'a session that mints its own topic starts at zero');
  });
});

describe('what a declared broadcast reports, and what it no longer writes', () => {
  /**
   * ⛔ Not one entry, at either moment. The admin owns the list of streams in admin mode, and a
   * second writer would publish entries nothing reconciles — and pay postage for them.
   */
  it('writes nothing to the stream catalog, live or on the flip to vod', async () => {
    const session = newSession();

    await feedOneSegment(session.uploader, 0);
    await session.uploader.notifyStop();

    assert.deepEqual(session.catalogEntries, []);
  });

  it('reports live on its first published manifest and vod once the recording is in the feed', async () => {
    const session = newSession();

    await feedOneSegment(session.uploader, 0);
    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE],
      'the live report lands where the catalog announce would have, on the first manifest',
    );

    await session.uploader.notifyStop();

    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE, ADMIN_STATE_VOD],
      'and in that order: a vod the admin never saw go live is a broadcast it cannot show correctly',
    );
  });

  /**
   * The two values the catalog's own VOD entry would have carried, because they answer the same
   * question: where the recording sits in this stream's feed, and how long it plays. The index is
   * read off what was actually published rather than written out here, so a change in how many
   * playlists a finalize publishes cannot leave this asserting a number nothing points at.
   */
  it('reports the recording at the index it was published to, with its playing time', async () => {
    const session = newSession();

    await feedOneSegment(session.uploader, 0);
    await feedOneSegment(session.uploader, 1);
    await session.uploader.notifyStop();

    const vod = session.reports.at(-1);
    assert.equal(vod?.state, ADMIN_STATE_VOD);
    assert.equal(
      vod?.state === ADMIN_STATE_VOD ? vod.index : null,
      session.published.at(-1)?.index,
      'the report has to name the SOC the recording was actually written to',
    );
    assert.equal(vod?.state === ADMIN_STATE_VOD ? vod.duration : null, 4, 'two segments of two seconds each');
  });

  /**
   * ⛔ A finalize that could not tell the admin is a finalize that is not finished. The report is the
   * only thing that says the broadcast became a recording, exactly as the catalog write is outside
   * admin mode, so it has to cost the same: the failure propagates and the recovery entry stays on
   * disk for the next boot to retry.
   */
  it('leaves the broadcast unfinalized when the vod report could not be delivered', async () => {
    const removed: string[] = [];
    const session = newSession({
      reportOutcome: (report) => (report.state === ADMIN_STATE_VOD ? STATE_REPORT_FAILED : STATE_REPORT_ACCEPTED),
    });
    (session.uploader as unknown as { recoveryStore: { remove: (id: string) => void } }).recoveryStore.remove = (
      id: string,
    ) => {
      removed.push(id);
    };

    await feedOneSegment(session.uploader, 0);
    await assert.rejects(() => session.uploader.notifyStop(), /admin API/);

    assert.deepEqual(removed, [], 'the recovery entry is the only record the broadcast was live');
  });

  /** Without an admin nothing moves: the catalog is still this service's own to write. */
  it('still writes the catalog in the standalone deployment', async () => {
    const session = newSession({ standalone: true });

    await feedOneSegment(session.uploader, 0);
    await session.uploader.notifyStop();

    assert.equal(session.reports.length, 0);
    assert.equal(session.catalogEntries.length, 2, 'the live announce and the flip to vod');
  });
});

describe('the orchestrator in admin mode', () => {
  /** An admin client that accepts every report, for the sessions these cases actually start. */
  const acceptingAdmin = (): AdminApiClient =>
    new AdminApiClient({
      baseUrl: 'http://admin.test:9877',
      token: 'admin-api-token-0123456789abcdef',
      fetcher: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
    });

  /**
   * ⛔ The generic `POST /stream/start` has no declaration to pass and no way to get one. Admitted,
   * it would mint a random topic and publish a broadcast the admin never learns about and — because
   * nothing writes a catalog entry in admin mode — that no viewer could find either.
   */
  it('refuses an announce that carries no declaration', async () => {
    const orchestrator = makeTestOrchestrator({ adminApi: acceptingAdmin() });
    try {
      assert.equal(orchestrator.startStream(STREAM_ID, MEDIA_TYPE_VIDEO), false);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    } finally {
      await orchestrator.cleanup();
    }
  });

  /**
   * The topic comes off the declaration rather than `crypto.randomUUID()`, and the admin's own id for
   * the stream is persisted beside it. Both are read back off the recovery entry, which is the only
   * thing a rebuilt session has: nothing re-announces a recovered stream, so an entry without the id
   * is a broadcast that finalizes into its feed and stays `live` in the admin's list for ever.
   */
  it('publishes a declared stream on the declaration topic, and writes its admin id down', async () => {
    const saved: StreamState[] = [];
    const orchestrator = makeTestOrchestrator(
      { adminApi: acceptingAdmin() },
      {},
      makeFakeRecoveryStore({
        save: (_id: string, state: StreamState) => {
          saved.push(state);
        },
      }),
    );

    try {
      assert.equal(
        orchestrator.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, undefined, {
          id: ADMIN_STREAM_ID,
          topic: DECLARED_TOPIC,
        }),
        true,
      );

      orchestrator.handleSegment(STREAM_ID, 0, 2, Buffer.from('seg'));
      await waitFor(() => saved.length > 0, SETTLE_CEILING_MS);

      assert.equal(saved[0].streamRawTopic, DECLARED_TOPIC, 'a declared stream must not mint a topic of its own');
      assert.equal(saved[0].adminStreamId, ADMIN_STREAM_ID);
    } finally {
      await orchestrator.cleanup();
    }
  });
});

/**
 * Takeover ordering: the fourth property, and the one the other three quietly assumed.
 *
 * A re-announce retires the live session and starts its replacement in the same synchronous turn,
 * then drains the retired one in the background. Outside admin mode that is safe because each session
 * mints its own topic and the retired one writes only to its own. Under a declaration both sessions
 * hold the same topic, and `retire()` does not stop SOC writes — it gives up the recovery entry, the
 * admin report and the catalog entry, and nothing else. Its doc used to close with the premise admin
 * mode had already removed, "the published media is unaffected, since each uploader owns its own feed
 * topic", which is why this went unnoticed; it now says what it does not cover.
 *
 * So the retired session's closing and VOD manifests are writes onto the feed the replacement is
 * about to publish into. Ungated, the replacement reads a head the retired session is still moving:
 * both then compute the same next index and write over one another, and the retired session's VOD
 * lands above the replacement's live playlist — leaving the feed head announcing that a broadcast
 * still running has finished.
 */
describe('a replacement session on a declared topic waits for the session it replaced', () => {
  /** Runs after the microtask queue, so the constructor's own settle callback on the drain has run. */
  const afterMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('publishes nothing, and does not even read the head, while the retired session is finalizing', async () => {
    let releaseDrain = (): void => {};
    const drained = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });

    // Where the retired session has got to, and where it ends up: a closing manifest at 8 and its VOD
    // at 9, which is exactly what it writes during the window this test holds open.
    let head = 7;
    let downloads = 0;
    const session = newSession({
      predecessorDrained: drained,
      feedHead: () => {
        downloads++;
        return { index: head, manifest: SOME_PLAYLIST };
      },
    });

    await feedOneSegment(session.uploader, 0);

    assert.equal(
      session.published.length,
      0,
      'a write here would land on an index the retired session is about to claim for its closing manifest',
    );
    assert.equal(
      downloads,
      0,
      'and the head must not even be read yet: it is still moving, and the read is latched for the ' +
        'life of the session, so a reading taken now would be wrong for every publish that follows',
    );

    head = 9;
    releaseDrain();
    await drained;
    await afterMicrotasks();

    await feedOneSegment(session.uploader, 1);

    assert.deepEqual(
      session.published.map((write) => write.index),
      [10],
      'once the retired session is done the replacement resumes above its VOD, so no index is written ' +
        'twice and the newest thing on the feed is this session live rather than the old recording',
    );
  });

  /**
   * The latch is on the drain settling, not on the first refusal. A session that refused once has to
   * publish on its own next segment rather than waiting for a further event, or a broadcast would be
   * held for its whole life by one early reconnect.
   */
  it('is not latched by having refused once', async () => {
    let releaseDrain = (): void => {};
    const drained = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const session = newSession({
      predecessorDrained: drained,
      feedHead: () => ({ index: 2, manifest: SOME_PLAYLIST }),
    });

    await feedOneSegment(session.uploader, 0);
    assert.equal(session.published.length, 0);

    releaseDrain();
    await drained;
    await afterMicrotasks();

    await feedOneSegment(session.uploader, 1);
    await feedOneSegment(session.uploader, 2);

    assert.deepEqual(
      session.published.map((write) => write.index),
      [3, 4],
      'the session publishes normally from here',
    );
  });

  /**
   * ⛔ The gate is admin-only, and this is the half that says so. A standalone session owns a topic
   * nothing else will ever write, so holding its playlist for a drain would buy nothing and cost every
   * viewer the wait. `StreamOrchestrator` is what passes the promise, and it passes it only when the
   * announce carried an admin session.
   */
  it('does not wait when it was handed no predecessor, which is every session outside a re-announce', async () => {
    const session = newSession({ feedHead: () => ({ index: 4, manifest: SOME_PLAYLIST }) });

    await feedOneSegment(session.uploader, 0);

    assert.deepEqual(
      session.published.map((write) => write.index),
      [5],
      'nothing to wait for, so nothing waits',
    );
  });
});

/**
 * A rung of an ABR ladder under a declaration, which is the other shape admin mode now takes.
 *
 * ## What is the same, and what is not
 *
 * The three properties above hold, with one substitution each. The declared topic still belongs to the
 * declaration — but it is the **ladder's master feed**, not this rung's, so this session publishes its
 * own manifests on a topic derived from the ladder group and its rung name. That topic outlives the
 * session exactly as a declared one does, so the head resume and the predecessor gate are both owed
 * here too. Nothing is written to the stream catalog, and the admin is told instead — but the two
 * reports are now statements about the LADDER: `live` once a master a viewer can open has landed, and
 * `vod` once every rung of the ladder has finalized, carrying the master's index rather than this
 * rung's own.
 *
 * ⛔ The rung registers its own record through the ladder registry, which is the only thing that can
 * see the other three rungs. That is why the flip is read off an answer rather than off this session's
 * intent: a rung draining while its siblings are live has ended its own recording and nothing else.
 */
describe('a rung of a declared ladder', () => {
  /**
   * This rung's own manifest feed, which the orchestrator derives from the ladder group and the rung
   * name. Spelled out rather than computed with `rungTopicFor`, because what these cases turn on is
   * that it is NOT the declared topic and that it outlives the session, not what the derivation
   * produces — `rungTopic.test.ts` pins that.
   */
  const RUNG_TOPIC = 'rung-topic-0001';
  const RUNG = { name: '720p', width: 1280, height: 720, configuredKbps: 2800 };

  /** One rendition report registered with the registry. */
  interface Upsert {
    adminStreamId?: string;
    group: string;
    rendition: Rendition;
  }

  interface LadderSession {
    uploader: StreamUploader;
    published: ManifestWrite[];
    catalogEntries: unknown[];
    reports: AdminStateReport[];
    upserts: Upsert[];
    delivered: string[];
  }

  interface LadderSessionOptions {
    /**
     * What the registry answers for each announce in turn. Defaults to a master at 0 that flipped
     * nothing.
     */
    announce?: (upsert: Upsert, attempt: number) => RenditionAnnouncement;
    /** How long a failed announce waits before the next manifest publish re-attempts it. */
    catalogAnnounceRetryMs?: number;
    feedHead?: () => FakeFeedHead | null;
  }

  function newLadderSession(options: LadderSessionOptions = {}): LadderSession {
    const published: ManifestWrite[] = [];
    const catalogEntries: unknown[] = [];
    const reports: AdminStateReport[] = [];
    const upserts: Upsert[] = [];
    const delivered: string[] = [];

    const bee = makeFakeBee({
      uploadPayload: async (index, payload) => {
        published.push({ index, playlist: String(payload) });
        return { reference: { toHex: () => `soc${index}` } };
      },
      feedHead: options.feedHead ?? (() => null),
    });

    const client = {
      describe: () => 'http://admin.test:9877',
      reportState: async (_id: string, report: AdminStateReport) => {
        reports.push(report);
        return STATE_REPORT_ACCEPTED;
      },
    } as unknown as AdminApiClient;

    const ladderRegistry: LadderRegistry = {
      upsertRendition: async (identity, rendition) => {
        const upsert = { adminStreamId: identity.adminStreamId, group: identity.group, rendition };
        upserts.push(upsert);
        return (
          options.announce?.(upsert, upserts.length) ?? {
            masterIndex: 0,
            flippedToFinished: false,
            duration: null,
          }
        );
      },
      recordRungDelivered: (_group, rung) => {
        delivered.push(rung);
      },
    };

    const uploader = new StreamUploader({
      anchor: TEST_ANCHOR,
      publisher: testPublisher(bee as Bee),
      streamCatalog: makeFakeCatalog({
        addStream: async (entry: unknown) => {
          catalogEntries.push(entry);
          return true;
        },
      }),
      ladderRegistry,
      recoveryStore: makeFakeRecoveryStore(),
      streamKey: TEST_STREAM_KEY,
      redundancyLevel: 0,
      streamId: `${STREAM_ID}_720p`,
      // The rung's own derived topic, never the declaration's. The declaration's topic is the group
      // below, which is the ladder's master feed.
      streamTopic: RUNG_TOPIC,
      mediatype: MEDIA_TYPE_VIDEO,
      ladder: { group: DECLARED_TOPIC, rung: RUNG },
      admin: { client, id: ADMIN_STREAM_ID },
      catalogAnnounceRetryMs: options.catalogAnnounceRetryMs,
    });

    return { uploader, published, catalogEntries, reports, upserts, delivered };
  }

  /**
   * ⛔⛔ **A rung reads the head of its OWN feed, and it is the only feed it ever reads.** Its topic is
   * derived from the ladder group and the rung name, so it outlives the session: a rung that restarts
   * mid-broadcast comes back onto the feed it was already writing, and starting at index 0 there would
   * write over its own last session's playlists. Reading the DECLARED topic would be the opposite
   * mistake and is what the session is built to make impossible — that feed is the ladder's master,
   * whose writer establishes its own index, and this session never names it.
   */
  it('continues above the head its own derived topic already holds', async () => {
    const session = newLadderSession({ feedHead: () => ({ index: 7, manifest: SOME_PLAYLIST }) });

    await feedOneSegment(session.uploader, 0);

    assert.equal(session.published[0]?.index, 8, 'a rung that restarts must not write over the feed it left');
  });

  it('starts at zero when its own topic has never been written, which is a new ladder', async () => {
    const session = newLadderSession();

    await feedOneSegment(session.uploader, 0);

    assert.equal(session.published[0]?.index, 0, 'a 404 is an answer: the feed is empty, so 0 is right');
  });

  /**
   * ⛔ The numbering continues too, not just the index. A viewer following this rung's feed head is
   * handed the new session's first playlist as the next update of the one they are playing, and
   * hls.js reads a media sequence that moved backwards as a parsing error rather than as a new
   * broadcast. `ManifestManager.test.ts` drives the seam itself; this pins that the head read is
   * where the number comes from.
   */
  it('numbers its playlist on from what the head it read was numbered to', async () => {
    const previous = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:12', '', '#EXTINF:2,', 'ref-a', ''].join(
      '\n',
    );
    const session = newLadderSession({ feedHead: () => ({ index: 4, manifest: previous }) });

    await feedOneSegment(session.uploader, 0);

    assert.match(
      session.published[0]?.playlist ?? '',
      /#EXT-X-MEDIA-SEQUENCE:13/,
      'the new session restarted the numbering over a feed a viewer is already following',
    );
    assert.match(session.published[0]?.playlist ?? '', /#EXT-X-DISCONTINUITY/, 'the seam must be marked');
  });

  it('writes nothing to the stream catalog, and registers its rung with the ladder registry instead', async () => {
    const session = newLadderSession();

    await feedOneSegment(session.uploader, 0);

    assert.deepEqual(session.catalogEntries, []);
    assert.deepEqual(
      session.upserts.map((upsert) => [
        upsert.group,
        upsert.adminStreamId,
        upsert.rendition.name,
        upsert.rendition.topic,
      ]),
      [[DECLARED_TOPIC, ADMIN_STREAM_ID, '720p', RUNG_TOPIC]],
      'the record names the rung′s own feed, under the declared ladder, addressed to the declared stream',
    );
  });

  /**
   * `live` is a statement about the ladder, so it waits for a master a viewer can actually open. A
   * rung that published a manifest into a ladder with no master yet is a quality nothing points at.
   */
  it('reports live once the ladder′s first master has landed', async () => {
    const session = newLadderSession();

    await feedOneSegment(session.uploader, 0);

    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE],
    );
  });

  it('reports nothing while no master has landed', async () => {
    const session = newLadderSession({
      announce: () => ({ masterIndex: null, flippedToFinished: false, duration: null }),
    });

    await feedOneSegment(session.uploader, 0);

    assert.deepEqual(session.reports, [], 'there is nothing for a viewer to open yet, so the broadcast is not live');
  });

  /**
   * ⛔ The index is the FINAL MASTER's, in the declared topic's feed, and never this rung's own VOD
   * index. A viewer in admin mode is handed the declared topic; for a ladder that feed holds the
   * master, so a rung's index would name a position in a feed nobody opens.
   */
  it('reports vod at the master′s index with the ladder′s duration, once the ladder flipped', async () => {
    const session = newLadderSession({
      announce: (upsert) =>
        upsert.rendition.index === undefined
          ? { masterIndex: 0, flippedToFinished: false, duration: null }
          : { masterIndex: 4, flippedToFinished: true, duration: 12 },
    });

    await feedOneSegment(session.uploader, 0);
    await session.uploader.notifyStop();

    const vod = session.reports.at(-1);
    assert.equal(vod?.state, ADMIN_STATE_VOD);
    assert.equal(vod?.state === ADMIN_STATE_VOD ? vod.index : null, 4, 'the master′s index, not the rung′s');
    assert.equal(vod?.state === ADMIN_STATE_VOD ? vod.duration : null, 12, 'the ladder′s playing time, not the rung′s');
    assert.notEqual(
      session.published.at(-1)?.index,
      4,
      'and the rung really did publish its own recording somewhere else, or this asserts nothing',
    );
  });

  /**
   * ⛔ A rung draining while its siblings are still live has ended its own recording and nothing more.
   * The broadcast is over when the LAST of them finalizes, which is the only report the admin answers
   * with a flip, so a rung announcing the end off its own drain would take three live rungs off the
   * air in the admin′s list.
   */
  it('reports no vod when its own finalize did not finish the ladder', async () => {
    const session = newLadderSession({
      announce: () => ({ masterIndex: 0, flippedToFinished: false, duration: null }),
    });

    await feedOneSegment(session.uploader, 0);
    await session.uploader.notifyStop();

    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE],
      'the broadcast went live and stays that way: three of its rungs are still publishing',
    );
    assert.equal(session.upserts.length, 2, 'the rung still announced itself finished, which is what flips the ladder');
    assert.equal(session.upserts[1].rendition.index, session.published.at(-1)?.index);
  });

  /**
   * A rendition report that did not land is a rung missing from the master every viewer resolves, so it
   * costs exactly what a failed catalog announce costs: the age `/health` reports as an unlisted
   * stream, and a re-attempt on the announce cadence rather than on the segment cadence.
   */
  it('re-attempts a failed announce on the announce cadence, and says so on /health meanwhile', async () => {
    const session = newLadderSession({
      catalogAnnounceRetryMs: 0,
      announce: (_upsert, attempt) => {
        if (attempt === 1) {
          throw new Error('the admin refused the rendition report');
        }
        return { masterIndex: 1, flippedToFinished: false, duration: null };
      },
    });

    await feedOneSegment(session.uploader, 0);
    assert.equal(session.upserts.length, 1);
    // A length rather than `deepEqual` against `[]`: node's assertion signature narrows the array to
    // `never[]` for the rest of the block, and the assertions below are about what ends up in it.
    assert.equal(session.reports.length, 0, 'nothing is live until a master exists');
    assert.notEqual(
      session.uploader.getMsSinceCatalogAnnounceFailed(),
      null,
      'a ladder the admin does not hold is a broadcast no viewer can find, which is what this signal is',
    );

    await feedOneSegment(session.uploader, 1);

    assert.equal(session.upserts.length, 2, 'the next manifest publish re-attempts it');
    assert.deepEqual(
      session.reports.map((report) => report.state),
      [ADMIN_STATE_LIVE],
    );
    assert.equal(session.uploader.getMsSinceCatalogAnnounceFailed(), null, 'and the signal clears once it lands');
  });

  it('counts each delivery against the ladder, so the master can drop a rung that stops', async () => {
    const session = newLadderSession();

    await feedOneSegment(session.uploader, 0);
    await feedOneSegment(session.uploader, 1);

    assert.deepEqual(session.delivered, ['720p', '720p']);
  });
});
