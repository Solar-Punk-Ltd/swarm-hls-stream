/**
 * The ladder sink admin mode uses: the admin holds the merge state, this writes the master.
 *
 * ## What each group of cases is for
 *
 * 1. **The report and the master are one act.** A rung's record goes to the admin, and the master is
 *    written from the ladder that comes back — not from anything this process assembled, because a
 *    rung can only ever see itself. Either half failing is a failed announce, which the uploader
 *    re-attempts on the catalog announce cadence.
 * 2. **The catalog is never touched.** The one rule admin mode has never been allowed to break. Here
 *    it is structural: the only feed this class can address at all is the master's.
 * 3. **A rung that stops is dropped from the master without asking the admin.** A rung dying is not an
 *    announce, so the announce path never hears about it — the whole of the ⛔⛔⛔ note on
 *    `StreamCatalog.republishIfLadderShapeChanged`, which this shares the schedule of.
 *
 * Every case drives a fake fetch and a fake bee, so what is asserted is this deployment's own decision
 * rather than a fixture's. `AdminApiClient.test.ts` is where the wire itself is driven.
 */

import { BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminApiClient, RenditionReportResponse } from '../src/libs/AdminApiClient.js';
import { AdminLadderSink } from '../src/libs/AdminLadderSink.js';
import { BeePublisherPool } from '../src/libs/BeePublisherPool.js';
import { RUNG_DEATH_LAG_SEGMENTS } from '../src/libs/LadderLiveness.js';
import { LadderIdentity } from '../src/libs/LadderSink.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
import { MASTER_REWRITE_RETRY_MS } from '../src/libs/MasterRewriteSchedule.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

import { waitAndConfirmNothingHappened, waitFor } from './helpers/waiting.js';

/**
 * How long a case that expects NOTHING to happen watches for it. A master rewrite is fire and forget:
 * it is queued from a synchronous delivery and settles a few turns later, so a case asserting that one
 * did not land has to outlast those turns rather than read the counter straight away.
 */
const NOTHING_HAPPENS_WINDOW_MS = 100;

const TEST_KEY = '0'.repeat(63) + '1';
const ADMIN_URL = 'http://admin.test:9877';
const ADMIN_TOKEN = 'admin-api-token-0123456789abcdef';
const ADMIN_STREAM_ID = 'str_01HZY';
const DECLARED_TOPIC = 'declared-topic-0001';
const SETTLE_CEILING_MS = 4_000;

const IDENTITY: LadderIdentity = {
  title: 'A declared broadcast',
  owner: '0xowner',
  group: DECLARED_TOPIC,
  mediatype: MEDIA_TYPE_VIDEO,
  adminStreamId: ADMIN_STREAM_ID,
};

const rung = (name: string, height: number, final?: { index: number; duration: number }): Rendition => ({
  name,
  width: (height * 16) / 9,
  height,
  topic: `topic-${name}`,
  bandwidth: 800_000,
  avgBandwidth: 700_000,
  ...(final ?? {}),
});

/** The merged ladder the admin answers with, what it says the ladder became, and the status it holds. */
function merged(
  renditions: Rendition[],
  ladder: Partial<RenditionReportResponse['ladder']> = {},
  status: string = 'live',
): string {
  return JSON.stringify({
    stream: { id: ADMIN_STREAM_ID, status },
    renditions,
    ladder: { finished: false, flippedToFinished: false, duration: null, ...ladder },
    feed: { owner: '0xowner', topic: DECLARED_TOPIC, topicHex: '00', index: 3, entryCount: 1 },
  });
}

/** One master playlist this sink wrote, and where it landed. */
interface MasterWrite {
  /** The feed topic it was written to, as bee sees it, so the declared topic can be checked in hex. */
  topicHex: string;
  index: bigint;
  playlist: string;
}

interface Harness {
  sink: AdminLadderSink;
  /** Every master write, in order. */
  masters: MasterWrite[];
  /** Every url the admin client called, in order. */
  posted: string[];
  /** Step the monotonic clock the rewrite hold-off is measured on. */
  advance: (ms: number) => void;
}

interface HarnessOptions {
  /** What the admin answers for each report in turn. Defaults to a ladder holding just what was sent. */
  answer?: (rendition: Rendition, attempt: number) => Response;
  /**
   * Whether the next master write fails, standing in for a node that will not take one.
   *
   * A function rather than a flag, because a case has to flip it after the fixture is built and a
   * fixture that spreads its options would copy a flag's value once and never see the flip.
   */
  masterWritesFail?: () => boolean;
}

function makeSink(options: HarnessOptions = {}): Harness {
  const masters: MasterWrite[] = [];
  const posted: string[] = [];
  let attempts = 0;
  let now = 0;

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    posted.push(String(input));
    const rendition = JSON.parse(String(init?.body)) as Rendition;
    attempts += 1;
    return options.answer?.(rendition, attempts) ?? new Response(merged([rendition]), { status: 200 });
  }) as typeof globalThis.fetch;

  const bee = {
    makeFeedReader: () => ({
      // A group whose master has never been written, which is every broadcast's first report.
      downloadPayload: async () => {
        throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
      },
    }),
    makeFeedWriter: (topic: Topic) => ({
      uploadPayload: async (_stamp: string, payload: unknown, opts: { index: FeedIndex }) => {
        if (options.masterWritesFail?.()) {
          // A status outside the retryable set, so the master writer's own ten second window rethrows
          // on the first attempt rather than spending itself proving what the first attempt said.
          throw Object.assign(new Error('the node refused the master write'), { status: 400 });
        }
        masters.push({ topicHex: topic.toString(), index: opts.index.toBigInt(), playlist: String(payload) });
        return { reference: { toHex: () => 'ref' } };
      },
    }),
  };
  const publisher = { rung: 'coordinator', url: '', stamp: 'stamp', bee };
  const publishers = { coordinator: () => publisher } as unknown as BeePublisherPool;

  return {
    sink: new AdminLadderSink({
      client: new AdminApiClient({
        baseUrl: ADMIN_URL,
        token: ADMIN_TOKEN,
        fetcher,
        // So a case about a refused report does not spend the retry ladder's four seconds of wall clock.
        sleep: async () => {},
      }),
      masterWriter: new MasterFeedWriter(publishers, new PrivateKey(TEST_KEY)),
      now: () => now,
    }),
    masters,
    posted,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('what a rendition announce does in admin mode', () => {
  it('reports the rung to the admin′s rendition route for the declared stream', async () => {
    const harness = makeSink();

    await harness.sink.upsertRendition(IDENTITY, rung('360p', 360));

    assert.deepEqual(harness.posted, [`${ADMIN_URL}/api/internal/streams/${ADMIN_STREAM_ID}/renditions`]);
  });

  /**
   * ⛔ The master names every rung the ADMIN holds, not the one this process announced. Four rungs
   * report concurrently and each is answered with the whole ladder, so a master built from anything
   * else would offer a viewer only the rungs that happen to share one uploader process.
   */
  it('writes the master from the ladder the admin folded, not from the rung it was handed', async () => {
    const ladder = [rung('360p', 360), rung('720p', 720)];
    const harness = makeSink({ answer: () => new Response(merged(ladder), { status: 200 }) });

    const announced = await harness.sink.upsertRendition(IDENTITY, rung('360p', 360));

    assert.equal(harness.masters.length, 1);
    assert.match(harness.masters[0].playlist, /topic-360p/);
    assert.match(harness.masters[0].playlist, /topic-720p/, 'the sibling rung is only knowable from the fold');
    assert.equal(announced.masterIndex, 0, 'the index a vod report would name');
  });

  /**
   * ⛔ The declared topic, because that is where the admin's own catalog entry already points a viewer.
   * A master written anywhere else is a ladder nobody can open.
   */
  it('writes the master to the declared topic, which is the ladder group', async () => {
    const harness = makeSink();

    await harness.sink.upsertRendition(IDENTITY, rung('360p', 360));

    assert.equal(harness.masters[0]?.topicHex, Topic.fromString(DECLARED_TOPIC).toString());
  });

  it('hands back the flip and the ladder′s duration exactly as the admin reported them', async () => {
    const finished = [rung('360p', 360, { index: 9, duration: 12 })];
    const harness = makeSink({
      answer: () =>
        new Response(merged(finished, { finished: true, flippedToFinished: true, duration: 12 }), { status: 200 }),
    });

    const announced = await harness.sink.upsertRendition(IDENTITY, finished[0]);

    assert.deepEqual(announced, { masterIndex: 0, flippedToFinished: true, duration: 12 });
  });

  /**
   * The admin flips once, on the report that completed the fold. If the master write behind that
   * report failed, the sink threw and the flip is gone: the retry is answered with a finished ladder
   * and `flippedToFinished: false`. Read literally, that is a recording the admin lists as live for
   * good, so a finished ladder the admin still holds as anything but `vod` is a flip to report.
   */
  it('reports a finished ladder as flipped while the admin still holds the stream as live', async () => {
    const finished = [rung('360p', 360, { index: 9, duration: 12 })];
    const harness = makeSink({
      answer: () =>
        new Response(merged(finished, { finished: true, flippedToFinished: false, duration: 12 }, 'live'), {
          status: 200,
        }),
    });

    const announced = await harness.sink.upsertRendition(IDENTITY, finished[0]);

    assert.deepEqual(announced, { masterIndex: 0, flippedToFinished: true, duration: 12 });
  });

  it('does not report a finished ladder again once the admin holds the stream as vod', async () => {
    const finished = [rung('360p', 360, { index: 9, duration: 12 })];
    const harness = makeSink({
      answer: () =>
        new Response(merged(finished, { finished: true, flippedToFinished: false, duration: 12 }, 'vod'), {
          status: 200,
        }),
    });

    const announced = await harness.sink.upsertRendition(IDENTITY, finished[0]);

    assert.equal(
      announced.flippedToFinished,
      false,
      'a recovered rung re-announcing on a listed recording is not a second ending',
    );
  });

  /**
   * ⛔ A failed report has to cost what a failed catalog write costs, or the two deployments behave
   * differently at the one moment that decides whether a broadcast is findable at all. The uploader's
   * `announceToCatalog` catches this, records the age `/health` reports, and re-attempts on its own
   * cadence; `completeFinalize` lets it propagate and leaves the recovery entry on disk.
   */
  it('throws when the admin refuses the report, and writes no master over a ladder it does not know', async () => {
    const harness = makeSink({ answer: () => new Response('{"error":"invalid_state"}', { status: 409 }) });

    await assert.rejects(() => harness.sink.upsertRendition(IDENTITY, rung('360p', 360)), /admin API/);
    assert.deepEqual(harness.masters, []);
  });

  it('throws when the admin answers 200 with a body that is not a ladder', async () => {
    const harness = makeSink({ answer: () => new Response('{"renditions":[{"name":"360p"}]}', { status: 200 }) });

    await assert.rejects(() => harness.sink.upsertRendition(IDENTITY, rung('360p', 360)), /admin API/);
    assert.deepEqual(harness.masters, [], 'a master built from a body nobody screened is an unplayable stream');
  });

  it('throws when the master could not be written, even though the admin took the report', async () => {
    const harness = makeSink({ masterWritesFail: () => true });

    await assert.rejects(() => harness.sink.upsertRendition(IDENTITY, rung('360p', 360)), /master/i);
  });

  /**
   * ⛔ Unreachable from the live path — the engine resolves the declaration before anything starts and
   * the orchestrator refuses an announce without one — but said out loud rather than assumed, because
   * the alternative is a report addressed to `undefined` and a 404 that reads like a deleted stream.
   */
  it('refuses to report a ladder that carries no admin stream id', async () => {
    const harness = makeSink();
    const { adminStreamId: _dropped, ...withoutId } = IDENTITY;

    await assert.rejects(() => harness.sink.upsertRendition(withoutId, rung('360p', 360)), /admin stream id/);
    assert.deepEqual(harness.posted, []);
  });
});

/**
 * A two rung ladder mid-broadcast, announced and fed, with nothing in flight.
 *
 * ⚠️ Fed BEFORE it is announced, which is the opposite of the order a broadcast takes and is what makes
 * the fixture deterministic. The same arrangement `StreamCatalog.test.ts` uses, for the same reason: a
 * rung reaching the liveness tracker changes the ladder's shape, so warming up after the announce
 * leaves fire-and-forget rewrites racing whatever the case does next. Before it, every delivery returns
 * at the sink's own "nothing has announced this ladder yet" guard, writing nothing, and the announce
 * then leaves the advertised shape agreeing with the tracker.
 */
async function announcedLadder(options: HarnessOptions = {}): Promise<Harness & { deliver: Deliver }> {
  const ladder = [rung('360p', 360), rung('720p', 720)];
  const harness = makeSink({ answer: () => new Response(merged(ladder), { status: 200 }), ...options });

  const deliver: Deliver = (rungs, rounds = 1) => {
    for (let round = 0; round < rounds; round++) {
      for (const name of rungs) {
        harness.sink.recordRungDelivered(DECLARED_TOPIC, name);
      }
    }
  };

  deliver(BOTH_RUNGS, WARMUP_ROUNDS);
  await harness.sink.upsertRendition(IDENTITY, ladder[0]);
  assert.equal(harness.masters.length, 1, 'the fixture is only settled if nothing is still being rewritten');

  return { ...harness, deliver };
}

/** One segment on each of these rungs, in the order given. */
type Deliver = (rungs: readonly string[], rounds?: number) => void;

const BOTH_RUNGS = ['360p', '720p'] as const;
/** What is left once `720p` stops, which is what a corrected master has to name. */
const HEALTHY = ['360p'] as const;
/** Enough rounds on the survivors for the ladder to run {@link RUNG_DEATH_LAG_SEGMENTS} past the dead rung. */
const ROUNDS_TO_KILL_A_RUNG = RUNG_DEATH_LAG_SEGMENTS + 1;
/** Deliveries per rung before the announce, so every rung is on record as having produced something. */
const WARMUP_ROUNDS = 2;

describe('what a delivery does in admin mode', () => {
  /**
   * The master goes on naming a rung nothing is producing until something notices, and the only thing
   * that can notice is a delivery. See `LadderLiveness`.
   */
  it('rewrites the master, without asking the admin, once a rung has stopped', async () => {
    const harness = await announcedLadder();
    const postsAfterAnnounce = harness.posted.length;

    harness.deliver(HEALTHY, ROUNDS_TO_KILL_A_RUNG);

    await waitFor(() => harness.masters.length > 1, SETTLE_CEILING_MS);

    const rewritten = harness.masters.at(-1)!.playlist;
    assert.match(rewritten, /topic-360p/, 'the last rung standing is still what a viewer gets');
    assert.doesNotMatch(rewritten, /topic-720p/, 'a viewer joining is still offered the rung that stopped producing');
    assert.equal(harness.posted.length, postsAfterAnnounce, 'a rung dying is nothing the admin has to be asked about');
  });

  /** Nothing has been folded yet, so there is no ladder to write a master from and nothing to correct. */
  it('writes nothing before the ladder has ever announced', async () => {
    const harness = makeSink();

    for (let round = 0; round < ROUNDS_TO_KILL_A_RUNG; round++) {
      for (const name of BOTH_RUNGS) {
        harness.sink.recordRungDelivered(DECLARED_TOPIC, name);
      }
    }
    harness.sink.recordRungDelivered(DECLARED_TOPIC, '360p');

    await waitAndConfirmNothingHappened(() => harness.masters.length === 0, NOTHING_HAPPENS_WINDOW_MS);
    assert.equal(harness.posted.length, 0, 'and nothing asked the admin about a ladder it has never been told of');
  });

  /**
   * ⛔ A steady ladder produces no further transition, so a rewrite that failed and was never retried
   * left a viewer offered a dead rung for the rest of the broadcast. It is held off rather than
   * abandoned, and rather than re-attempted on every delivery against a node that has just refused one.
   */
  it('holds a failed rewrite off, then writes it on the first delivery after the period', async () => {
    let masterWritesFail = false;
    const harness = await announcedLadder({ masterWritesFail: () => masterWritesFail });
    const landed = harness.masters.length;

    masterWritesFail = true;
    harness.deliver(HEALTHY, ROUNDS_TO_KILL_A_RUNG);
    await waitAndConfirmNothingHappened(() => harness.masters.length === landed, NOTHING_HAPPENS_WINDOW_MS);

    masterWritesFail = false;
    harness.deliver(HEALTHY);
    await waitAndConfirmNothingHappened(() => harness.masters.length === landed, NOTHING_HAPPENS_WINDOW_MS);

    harness.advance(MASTER_REWRITE_RETRY_MS + 1);
    harness.deliver(HEALTHY);

    await waitFor(() => harness.masters.length > landed, SETTLE_CEILING_MS);
    assert.doesNotMatch(harness.masters.at(-1)!.playlist, /topic-720p/, 'the retry writes the shape the ladder is in');
  });
});
