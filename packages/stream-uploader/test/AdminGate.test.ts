/**
 * The publish gate admin mode runs, driven through both engines' real routers. See
 * `src/engines/adminGate.ts`.
 *
 * ⛔ Through the routers rather than against `resolveAdminPublish` directly, and for the reason
 * `EnginePublishKey.test.ts` states one file along: a gate that is never reached is indistinguishable
 * from a gate that admits everyone, and both engines have already shipped in exactly that state once
 * (SEC-26's publisher address, wrong at both call sites for the whole life of the feature). The unit
 * is one function on purpose; what these cases pin is that each engine actually calls it, with the
 * key it was sent and the media type its own `app` implies, and acts on the answer.
 *
 * Every case answers the admin from an injected `fetch`, so what is asserted is the deployment's own
 * decision and not a fixture's. `AdminApiClient.test.ts` is where the wire itself is driven.
 */

import express from 'express';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { createOmeEngine } from '../src/engines/ome.js';
import { createSrsEngine } from '../src/engines/srs.js';
import { AbrLadder } from '../src/libs/AbrLadder.js';
import { AdminApiClient, AdminStreamDraft } from '../src/libs/AdminApiClient.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { AdminSession, MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO } from '../src/types.js';
import { derivePublishKey } from '../src/utils/publishKey.js';

import { makeFakeOrchestrator, makeTestOrchestrator } from './helpers/fakes.js';
import { listenOnLoopback } from './helpers/loopbackServer.js';
import { waitFor } from './helpers/waiting.js';

const APP = 'video';
const STREAM = 'demo';
const STREAM_ID = `${APP}/${STREAM}`;
const BROADCASTER = '203.0.113.10';
const STRANGER = '198.51.100.7';

const SETTLE_CEILING_MS = 4_000;
const OME_SECRET = 'ome-admission-secret-0123456789ab';
const SRS_TOKEN = 'srs-webhook-token-0123456789abcdef';
const ADMIN_TOKEN = 'admin-api-token-0123456789abcdef';
const ADMIN_URL = 'http://admin.test:9877';

/** A secret a deployment might still have set. In admin mode it must decide nothing. */
const LEGACY_PUBLISH_SECRET = 'publish-key-secret-0123456789abcdef';
const LEGACY_KEY = derivePublishKey(LEGACY_PUBLISH_SECRET, STREAM_ID);

/** The key the admin minted for this declaration. The only one that admits anybody in admin mode. */
const DECLARED_KEY = 'declared-publish-key-0123456789';

const DRAFT: AdminStreamDraft = {
  id: 'str_01HZY',
  topic: 'declared-topic-0001',
  owner: '0xowner',
  mediaType: MEDIA_TYPE_VIDEO,
  title: 'A declared broadcast',
  status: 'draft',
  publishKey: DECLARED_KEY,
};

/** What the fake admin does with the lookup. Its POSTs are always accepted: state reports are not what is under test. */
type LookupAnswer = () => Response | Promise<Response>;

const answersDraft =
  (draft: Partial<AdminStreamDraft> = {}): LookupAnswer =>
  () =>
    new Response(JSON.stringify({ ...DRAFT, ...draft }), { status: 200 });

const answersNotFound: LookupAnswer = () =>
  new Response(JSON.stringify({ error: 'stream_not_found' }), { status: 404 });

const answersServerError: LookupAnswer = () => new Response('', { status: 503 });

const refusesTheConnection: LookupAnswer = () => Promise.reject(new Error('ECONNREFUSED'));

/**
 * An admin client whose lookups answer `lookup` and whose state reports always succeed.
 *
 * The POST half matters even though nothing here asserts on it: a gate case that admits a publisher
 * starts a real uploader, and an uploader in admin mode reports `live` on its first manifest. Left
 * unanswered, that would spend the retry ladder in the background of an unrelated assertion.
 */
function adminAnswering(lookup: LookupAnswer): AdminApiClient {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      return new Response('{}', { status: 200 });
    }
    return lookup();
  }) as typeof globalThis.fetch;

  return new AdminApiClient({ baseUrl: ADMIN_URL, token: ADMIN_TOKEN, fetcher });
}

interface OmeReply {
  allowed: boolean;
  reason?: string;
}

/** An OME admission for `app/stream`, signed the way OME signs it, with `query` on the publish url. */
async function postAdmission(baseUrl: string, prefix: string, address: string, url: string): Promise<OmeReply> {
  const body = JSON.stringify({
    client: { address, port: 44546 },
    request: { direction: 'incoming', status: 'opening', url, time: new Date(0).toISOString() },
  });
  const signature = createHmac('sha1', OME_SECRET).update(body).digest('base64url');
  const response = await fetch(`${baseUrl}${prefix}/admission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ome-signature': signature },
    body,
  });
  return response.json() as Promise<OmeReply>;
}

interface EngineHarness {
  /** One opening for `STREAM_ID` with `query` on its publish url. Answers the engine's own verdict. */
  announce: (address: string, query: string) => Promise<boolean>;
  /** One opening for an `app` other than the default, so a media-type disagreement can be sent. */
  announceApp: (app: string, query: string) => Promise<boolean>;
  orchestrator: StreamOrchestrator;
}

type Drive = (harness: EngineHarness) => Promise<void>;

/** Mounts one engine in admin mode and hands back an announce that answers `true` when it was admitted. */
async function withEngine(
  mount: (adminApi: AdminApiClient) => {
    engine: ReturnType<typeof createSrsEngine>;
    announce: (baseUrl: string, prefix: string, app: string, address: string, query: string) => Promise<boolean>;
  },
  lookup: LookupAnswer,
  drive: Drive,
): Promise<void> {
  const adminApi = adminAnswering(lookup);
  const orchestrator = makeTestOrchestrator({ adminApi });
  const { engine, announce } = mount(adminApi);

  const app = express();
  app.use(
    express.json({
      // Mirrors api/server.ts, which is what OME's admission signature is computed over.
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(engine.prefix, engine.createRouter(orchestrator));
  const { server, baseUrl } = await listenOnLoopback(app);

  try {
    await drive({
      announce: (address, query) => announce(baseUrl, engine.prefix, APP, address, query),
      announceApp: (ingestApp, query) => announce(baseUrl, engine.prefix, ingestApp, BROADCASTER, query),
      orchestrator,
    });
  } finally {
    server.close();
    // ⛔ Before the orchestrator, and not optional. An admitted OME publish arms a pull loop whose
    // timer lives in a map closed over inside the engine, and nothing else can reach it: a file that
    // leaves one armed holds its own child process open for the retry window. That is the leak
    // `scripts/assert-test-floor.mjs` exists because of. See `EnginePlugin.stopIngest`.
    engine.stopIngest?.();
    await orchestrator.cleanup();
  }
}

function withSrs(lookup: LookupAnswer, drive: Drive): Promise<void> {
  return withEngine(
    (adminApi) => ({
      engine: createSrsEngine('/srv/media', {
        webhookToken: SRS_TOKEN,
        // Set on purpose in every case: admin mode has to ignore it, and a suite that never
        // configured it could not tell "ignored" from "absent".
        publishKeySecret: LEGACY_PUBLISH_SECRET,
        adminApi,
      }),
      announce: async (baseUrl, prefix, ingestApp, address, query) => {
        const response = await fetch(`${baseUrl}${prefix}/streams?token=${SRS_TOKEN}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'on_publish',
            app: ingestApp,
            stream: STREAM,
            ip: address,
            ...(query === '' ? {} : { param: query }),
          }),
        });
        return (await response.json()) === 0;
      },
    }),
    lookup,
    drive,
  );
}

function withOme(lookup: LookupAnswer, drive: Drive): Promise<void> {
  return withEngine(
    (adminApi) => ({
      engine: createOmeEngine('http://ome.test:8081', 50, {
        admissionSecret: OME_SECRET,
        publishKeySecret: LEGACY_PUBLISH_SECRET,
        adminApi,
      }),
      announce: async (baseUrl, prefix, ingestApp, address, query) => {
        const reply = await postAdmission(
          baseUrl,
          prefix,
          address,
          `srt://ingest.example:9999/${ingestApp}/${STREAM}${query}`,
        );
        return reply.allowed;
      },
    }),
    lookup,
    drive,
  );
}

const ENGINES: [string, (lookup: LookupAnswer, drive: Drive) => Promise<void>][] = [
  ['SRS', withSrs],
  ['OME', withOme],
];

for (const [name, withThisEngine] of ENGINES) {
  describe(`the admin publish gate as ${name} runs it`, () => {
    it('admits a publisher presenting the key the declaration carries', async () => {
      await withThisEngine(answersDraft(), async ({ announce, orchestrator }) => {
        assert.equal(await announce(BROADCASTER, `?key=${DECLARED_KEY}`), true);
        await waitFor(() => orchestrator.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
        assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 0);
      });
    });

    /**
     * ⛔ There is no such thing as a stream nobody declared here. The topic and the key are both
     * minted by the declaration, so an unannounced ingest id has nothing to publish into and nothing
     * to check against, and admitting it would spend postage on a broadcast the admin never learns
     * about and no viewer could find.
     */
    it('refuses an ingest id the admin has never heard of', async () => {
      await withThisEngine(answersNotFound, async ({ announce, orchestrator }) => {
        assert.equal(await announce(BROADCASTER, `?key=${DECLARED_KEY}`), false);
        assert.equal(orchestrator.getActiveStreamCount(), 0);
        assert.equal(
          orchestrator.getMetricsSnapshot().authRejectionsTotal,
          1,
          'a publisher naming an id nobody declared failed to prove something, so /health has to see it',
        );
      });
    });

    /**
     * ⛔⛔ Refused, never admitted. Failing open would let a publisher through with no key check at
     * all, onto a topic this service would have to mint itself, and a broadcast published where the
     * admin is not looking is worse than one that never started: it is paid for and it reaches
     * nobody.
     */
    it('refuses every publish while the admin is unreachable', async () => {
      await withThisEngine(refusesTheConnection, async ({ announce, orchestrator }) => {
        assert.equal(await announce(BROADCASTER, `?key=${DECLARED_KEY}`), false);
        assert.equal(orchestrator.getActiveStreamCount(), 0);
        assert.equal(
          orchestrator.getMetricsSnapshot().authRejectionsTotal,
          0,
          'this deployment failed, not the caller, and counting it would make an outage read as an attack',
        );
      });
    });

    it('refuses a publish while the admin is answering 5xx', async () => {
      await withThisEngine(answersServerError, async ({ announce, orchestrator }) => {
        assert.equal(await announce(BROADCASTER, `?key=${DECLARED_KEY}`), false);
        assert.equal(orchestrator.getActiveStreamCount(), 0);
        assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 0);
      });
    });

    it('refuses a publish carrying no key at all', async () => {
      await withThisEngine(answersDraft(), async ({ announce, orchestrator }) => {
        assert.equal(await announce(BROADCASTER, ''), false);
        assert.equal(orchestrator.getActiveStreamCount(), 0);
        assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 1);
      });
    });

    it('refuses a publish carrying a wrong key', async () => {
      await withThisEngine(answersDraft(), async ({ announce, orchestrator }) => {
        assert.equal(await announce(BROADCASTER, '?key=not-the-declared-key'), false);
        assert.equal(orchestrator.getActiveStreamCount(), 0);
        assert.equal(orchestrator.getMetricsSnapshot().authRejectionsTotal, 1);
      });
    });

    /**
     * ⛔ `PUBLISH_KEY_SECRET` decides nothing here, and this is the case that says so. Both modes
     * answer the same question — is this publisher the owner of this stream — from two different
     * sources of truth, and a deployment where they disagree has no right answer, so the engine
     * blanks the secret outright rather than consulting both.
     */
    it('refuses a key derived from PUBLISH_KEY_SECRET, which admin mode ignores', async () => {
      await withThisEngine(answersDraft(), async ({ announce, orchestrator }) => {
        assert.equal(await announce(BROADCASTER, `?key=${LEGACY_KEY}`), false);
        assert.equal(orchestrator.getActiveStreamCount(), 0);
      });
    });

    /**
     * The ingest `app` decides which media this service publishes and the declaration decides what
     * the admin will show. A stream that is audio to one and video to the other is a player building
     * the wrong codec set off the first fragment, so it is refused rather than reconciled.
     */
    it('refuses a publish whose ingest app disagrees with the declared media type', async () => {
      await withThisEngine(answersDraft({ mediaType: MEDIA_TYPE_VIDEO }), async ({ announceApp, orchestrator }) => {
        assert.equal(await announceApp('audio', `?key=${DECLARED_KEY}`), false);
        assert.equal(orchestrator.getActiveStreamCount(), 0);
        assert.equal(
          orchestrator.getMetricsSnapshot().authRejectionsTotal,
          0,
          'the caller proved the key for the stream it named, so this is a misconfigured publisher and not an unauthorised one',
        );
      });
    });

    it('admits an audio publish against an audio declaration', async () => {
      await withThisEngine(answersDraft({ mediaType: MEDIA_TYPE_AUDIO }), async ({ announceApp, orchestrator }) => {
        assert.equal(await announceApp('audio', `?key=${DECLARED_KEY}`), true);
        await waitFor(() => orchestrator.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
      });
    });

    /**
     * ⛔ The end-to-end shape of "an accepted publish is an authenticated claimant". A takeover from
     * another address is refused by SEC-26 unless the announce proved a key, so this is only green
     * while the gate marks admitted publishers `isAuthenticated: true` — which is the field nothing
     * else in the suite would notice going missing.
     */
    it('marks an admitted publisher authenticated, so a proven key takes its id back from any address', async () => {
      await withThisEngine(answersDraft(), async ({ announce, orchestrator }) => {
        assert.equal(await announce(BROADCASTER, `?key=${DECLARED_KEY}`), true);
        await waitFor(() => orchestrator.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
        orchestrator.handleSegment(STREAM_ID, 0, 2, Buffer.from('seg'));

        assert.equal(await announce(STRANGER, `?key=${DECLARED_KEY}`), true);
        assert.equal(orchestrator.getMetricsSnapshot().takeoversRefusedTotal, 0);
      });
    });
  });
}

/**
 * The half of `OME_ADMISSION_FAIL_OPEN` that admin mode has to override, and the counterpart to
 * `EnginePublishKey.test.ts`'s "still refuses a keyless admission when the handler is configured to
 * fail open", which pins only the standalone side.
 *
 * Nothing unauthorised was ever getting in: every step that decides the verdict either cannot throw
 * or catches its own errors, so this catch is reachable only once the gate has already admitted the
 * publisher. What it was answering `allowed: true` to is the narrower failure — `startStream`
 * returning false is a refusal the handler honours, and `startStream` *throwing* was being answered
 * as an admission.
 *
 * ⛔ The bargain `failOpen` offers an operator — a broadcast admitted while this handler is broken
 * beats a broadcast lost to it — has nothing to buy in admin mode, because there is no broadcast left
 * to save. The topic and the catalog entry both live in the declaration, so a stream admitted without
 * a session publishes to nothing and no viewer can find it. `srs.ts` already makes this call in its
 * own catch and says so; without this, the two engines disagreed about the same deployment the moment
 * an operator set the knob.
 */
describe('fail-open in admin mode', () => {
  it('refuses an admission the handler threw on, even with OME_ADMISSION_FAIL_OPEN set', async () => {
    const adminApi = adminAnswering(answersDraft());
    const orchestrator = makeFakeOrchestrator({
      startStream: () => {
        throw new Error('orchestrator exploded');
      },
    });
    const engine = createOmeEngine('http://ome.test:8081', 50, {
      admissionSecret: OME_SECRET,
      publishKeySecret: LEGACY_PUBLISH_SECRET,
      adminApi,
      failOpen: true,
    });

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use(engine.prefix, engine.createRouter(orchestrator));
    const { server, baseUrl } = await listenOnLoopback(app);

    try {
      const reply = await postAdmission(
        baseUrl,
        engine.prefix,
        BROADCASTER,
        `srt://ingest.example:9999/${APP}/${STREAM}?key=${DECLARED_KEY}`,
      );

      assert.deepEqual(
        reply,
        { allowed: false, reason: 'handler error' },
        'admin mode is fail-closed whatever the operator chose, because an admitted stream with no session publishes nowhere',
      );
    } finally {
      server.close();
      engine.stopIngest?.();
    }
  });
});

/**
 * The publish gate with BOTH the ladder and admin mode on, which is a deployment neither half used to
 * allow. See the "Admin mode" section of the package README.
 *
 * ## What the combination has to get right
 *
 * A ladder publish arrives twice over: once as the untranscoded **source** a real broadcaster sends to
 * the ingest vhost, carrying the declaration's key, and then four times as **rungs** SRS republishes
 * from loopback onto the ABR vhost carrying nothing at all. Only the source has an ingest id the admin
 * has ever heard of — a rung's is `video/<uuid>_720p`, which nothing declared and nothing ever will —
 * so the session the source resolves is the only thing that can tell a rung which broadcast it belongs
 * to. Losing it would start four rungs with no declaration, on topics of their own, publishing a ladder
 * the admin never learns about and no viewer could find.
 *
 * SEC-28's rule is unchanged underneath: a rung is admitted only because its base authenticated, and
 * only from the transcode loopback.
 */
describe('the admin publish gate with the ABR ladder on', () => {
  const LADDER_SPEC = '720p:1280:720:2800 360p:640:360:700';
  const ABR_VHOST = 'abr';
  const INGEST_VHOST = '__defaultVhost__';
  const LOOPBACK = '127.0.0.1';
  const RUNG = `${STREAM}_720p`;
  const RUNG_ID = `${STREAM_ID}_720p`;

  /** One `startStream` the engine asked for, with the declaration it passed alongside it. */
  interface Start {
    streamId: string;
    admin?: AdminSession;
  }

  interface LadderCalls {
    starts: Start[];
    stops: string[];
    /** How many refusals reached `/health` through `recordAuthRejection`. See OBS-15. */
    authRejections: number;
  }

  interface SrsBody {
    action: 'on_publish' | 'on_unpublish';
    app: string;
    stream: string;
    vhost: string;
    ip?: string;
    param?: string;
  }

  async function withSrsLadder(
    lookup: LookupAnswer,
    drive: (harness: { calls: LadderCalls; post: (body: SrsBody) => Promise<number> }) => Promise<void>,
  ): Promise<void> {
    const calls: LadderCalls = { starts: [], stops: [], authRejections: 0 };
    const orchestrator = makeFakeOrchestrator({
      startStream: (streamId: string, _mediatype: unknown, _claimant: unknown, admin?: AdminSession) => {
        calls.starts.push({ streamId, admin });
        return true;
      },
      stopStream: async (streamId: string) => {
        calls.stops.push(streamId);
      },
      recordAuthRejection: () => {
        calls.authRejections += 1;
      },
    });
    const engine = createSrsEngine('/srv/media', {
      webhookToken: SRS_TOKEN,
      publishKeySecret: LEGACY_PUBLISH_SECRET,
      adminApi: adminAnswering(lookup),
      abr: { vhost: ABR_VHOST, ladder: AbrLadder.parse(LADDER_SPEC) },
    });

    const app = express();
    app.use(express.json());
    app.use(engine.prefix, engine.createRouter(orchestrator));
    const { server, baseUrl } = await listenOnLoopback(app);

    async function post(body: SrsBody): Promise<number> {
      const response = await fetch(`${baseUrl}${engine.prefix}/streams?token=${SRS_TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<number>;
    }

    try {
      await drive({ calls, post });
    } finally {
      server.close();
      engine.stopIngest?.();
    }
  }

  const source = (extra: Partial<SrsBody> = {}): SrsBody => ({
    action: 'on_publish',
    app: APP,
    stream: STREAM,
    vhost: INGEST_VHOST,
    ip: BROADCASTER,
    ...extra,
  });

  const rung = (extra: Partial<SrsBody> = {}): SrsBody => ({
    action: 'on_publish',
    app: APP,
    stream: RUNG,
    vhost: ABR_VHOST,
    ip: LOOPBACK,
    ...extra,
  });

  it('resolves the source against its declaration and admits it without ingesting it', async () => {
    await withSrsLadder(answersDraft(), async ({ calls, post }) => {
      assert.equal(await post(source({ param: `?key=${DECLARED_KEY}` })), 0);
      assert.deepEqual(calls.starts, [], 'the source exists to be transcoded by SRS, not ingested by the uploader');
      assert.equal(calls.authRejections, 0);
    });
  });

  it('refuses a source whose key is not the declaration′s, and records the refusal', async () => {
    await withSrsLadder(answersDraft(), async ({ calls, post }) => {
      assert.equal(await post(source({ param: '?key=not-the-declared-key' })), 1);
      assert.deepEqual(calls.starts, []);
      assert.equal(calls.authRejections, 1, 'a refused credential has to be visible on /health. See OBS-15');
    });
  });

  it('refuses a source the admin has never heard of, so no rung of it can be admitted either', async () => {
    await withSrsLadder(answersNotFound, async ({ calls, post }) => {
      assert.equal(await post(source({ param: `?key=${DECLARED_KEY}` })), 1);

      assert.equal(await post(rung()), 1, 'a rung is admitted only because its base authenticated');
      assert.deepEqual(calls.starts, []);
      assert.equal(calls.authRejections, 2);
    });
  });

  /**
   * ⛔ The whole of the combination, in one assertion. The rung presents nothing and names an ingest id
   * the admin has never heard of, so the declaration its base resolved is the only route by which this
   * broadcast can reach the admin at all.
   */
  it('starts a rung under the declaration its base resolved', async () => {
    await withSrsLadder(answersDraft(), async ({ calls, post }) => {
      await post(source({ param: `?key=${DECLARED_KEY}` }));

      assert.equal(await post(rung()), 0);
      assert.deepEqual(calls.starts, [{ streamId: RUNG_ID, admin: { id: DRAFT.id, topic: DRAFT.topic } }]);
    });
  });

  it('refuses a loopback rung whose base never authenticated', async () => {
    await withSrsLadder(answersDraft(), async ({ calls, post }) => {
      assert.equal(await post(rung({ stream: 'attacker_720p' })), 1);
      assert.deepEqual(calls.starts, []);
      assert.equal(calls.authRejections, 1);
    });
  });

  it('refuses a rung that is not from the transcode loopback, however its base authenticated', async () => {
    await withSrsLadder(answersDraft(), async ({ calls, post }) => {
      await post(source({ param: `?key=${DECLARED_KEY}` }));

      assert.equal(await post(rung({ ip: STRANGER })), 1, 'origin trust must not extend off the host');
      assert.deepEqual(calls.starts, []);
      assert.equal(calls.authRejections, 1);
    });
  });

  /**
   * ⛔ The rungs must not outlive their base. An unpublished source gives up the declaration, so a rung
   * arriving afterwards has nothing to publish under and is refused rather than started without one.
   */
  it('forgets the declaration when the source unpublishes', async () => {
    await withSrsLadder(answersDraft(), async ({ calls, post }) => {
      await post(source({ param: `?key=${DECLARED_KEY}` }));
      assert.equal(await post(source({ action: 'on_unpublish', param: `?key=${DECLARED_KEY}` })), 0);

      assert.equal(await post(rung()), 1);
      assert.deepEqual(calls.starts, []);
    });
  });

  it('still stops a rung on an unpublish from loopback', async () => {
    await withSrsLadder(answersDraft(), async ({ calls, post }) => {
      await post(source({ param: `?key=${DECLARED_KEY}` }));
      await post(rung());

      assert.equal(await post(rung({ action: 'on_unpublish' })), 0);
      assert.deepEqual(calls.stops, [RUNG_ID]);
    });
  });

  /**
   * A name on the ABR vhost that is no configured rung is nothing the uploader can place on a ladder.
   * Accepted so SRS keeps running, ingested never — and, in admin mode, never looked up either: a
   * lookup per stray name would let anyone who can reach the webhook probe the admin's declarations.
   */
  it('ingests nothing for a stray name on the ABR vhost', async () => {
    let lookups = 0;
    await withSrsLadder(
      () => {
        lookups += 1;
        return answersDraft()();
      },
      async ({ calls, post }) => {
        assert.equal(await post(rung({ stream: 'not-a-rung' })), 0);
        assert.deepEqual(calls.starts, []);
        assert.equal(lookups, 0);
      },
    );
  });
});
