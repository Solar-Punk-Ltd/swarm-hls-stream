/**
 * That each engine actually reads the publish key out of what it was sent, and acts on it. See SEC-28.
 *
 * The same argument as `EngineClaimant.test.ts`, one field along, and the same failure mode it was
 * written for. `StreamTakeover.test.ts` drives `startStream` directly, so it pins what the guard does
 * with a proven claimant and nothing about whether either engine ever produces one. An engine that
 * reads the wrong field lands on the null path, the null path is indistinguishable from a broadcaster
 * who presented nothing, and the whole feature is off with a green suite.
 *
 * That is not hypothetical here: the gate's correctness lens established that both call sites were in
 * exactly that state for SEC-26's address, and this field arrives through the same two webhooks.
 *
 * The bodies below are shaped from captures taken on 2026-08-03 against `airensoft/ovenmediaengine:latest`
 * and `ossrs/srs:6`, the images this deployment pins. `param` really does arrive with its leading `?`.
 */

import express from 'express';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { createOmeEngine, createOmeEngineFromEnv } from '../src/engines/ome.js';
import { createSrsEngine, createSrsEngineFromEnv } from '../src/engines/srs.js';
import { Logger } from '../src/libs/Logger.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { derivePublishKey } from '../src/utils/publishKey.js';
import { redactUrlSecrets } from '../src/utils/urlSecrets.js';

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
const PUBLISH_SECRET = 'publish-key-secret-0123456789abcdef';

const KEY = derivePublishKey(PUBLISH_SECRET, STREAM_ID);
/** Valid, but issued for a stream this announce is not naming. The attack the address test could not see. */
const KEY_FOR_ANOTHER_STREAM = derivePublishKey(PUBLISH_SECRET, `${APP}/somebody-else`);

interface OmeReply {
  allowed: boolean;
  reason?: string;
}

/**
 * How the admission below differs from the ordinary opening. Defaulted so every existing caller keeps
 * sending exactly what it sent before this existed.
 *
 * `port` and `timeMs` are the two session discriminators `reasonToIgnoreClosing` matches a closing on,
 * so a closing meant to be *acted on* has to carry its own opening's port and a time at or after it.
 * Get either wrong and the closing is discarded as `replaced` or `already-closed`, which looks
 * identical from the orchestrator to the refusal these tests are about. See CON-21 and CON-23.
 */
interface AdmissionOptions {
  status?: 'opening' | 'closing';
  timeMs?: number;
  port?: number;
}

/** An OME admission carrying whatever publish url the caller wants, signed the way OME signs it. */
async function postAdmission(
  baseUrl: string,
  prefix: string,
  address: string,
  url: string,
  options: AdmissionOptions = {},
): Promise<OmeReply> {
  const { status = 'opening', timeMs = 0, port = 44546 } = options;
  const body = JSON.stringify({
    client: { address, port },
    request: { direction: 'incoming', status, url, time: new Date(timeMs).toISOString() },
  });
  const signature = createHmac('sha1', OME_SECRET).update(body).digest('base64url');
  const response = await fetch(`${baseUrl}${prefix}/admission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ome-signature': signature },
    body,
  });
  return response.json() as Promise<OmeReply>;
}

/** An OME admission for `STREAM_ID`, with whatever query the caller wants on the publish url. */
async function announceToOme(baseUrl: string, prefix: string, address: string, query: string): Promise<OmeReply> {
  return postAdmission(baseUrl, prefix, address, `srt://ingest.example:9999/${APP}/${STREAM}${query}`);
}

/**
 * An OME `closing` for `STREAM_ID`, carrying the same port its opening carried and a later time, so
 * the session guard reads it as the live session ending rather than as some other session's closing.
 */
async function closeOme(baseUrl: string, prefix: string, address: string, query: string): Promise<OmeReply> {
  return postAdmission(baseUrl, prefix, address, `srt://ingest.example:9999/${APP}/${STREAM}${query}`, {
    status: 'closing',
    timeMs: 60_000,
  });
}

/** One SRS stream webhook. `param` is omitted entirely when the caller passes null. */
async function postSrsWebhook(
  baseUrl: string,
  prefix: string,
  action: string,
  ip: string,
  param: string | null,
): Promise<number> {
  const response = await fetch(`${baseUrl}${prefix}/streams?token=${SRS_TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action,
      app: APP,
      stream: STREAM,
      ip,
      ...(param === null ? {} : { param }),
    }),
  });
  return response.json() as Promise<number>;
}

/** An SRS `on_publish` for `STREAM_ID`. */
async function announceToSrs(baseUrl: string, prefix: string, ip: string, param: string | null): Promise<number> {
  return postSrsWebhook(baseUrl, prefix, 'on_publish', ip, param);
}

/**
 * An SRS `on_unpublish` for `STREAM_ID`. It really does carry `param`, measured on 2026-08-03 against
 * `ossrs/srs:6`: the unpublish for a session repeats the publish's own `param` verbatim, leading `?`
 * and all, which is what lets the close path be screened at all.
 */
async function unpublishFromSrs(baseUrl: string, prefix: string, ip: string, param: string | null): Promise<number> {
  return postSrsWebhook(baseUrl, prefix, 'on_unpublish', ip, param);
}

interface OmeHarness {
  /** An admission for `STREAM_ID`, with `query` appended to its publish url. */
  announce: (address: string, query: string) => Promise<OmeReply>;
  /** An admission for any publish url at all, for the ones that must not parse. */
  announceUrl: (address: string, url: string) => Promise<OmeReply>;
  /** A `closing` for `STREAM_ID`, matching the opening's session. See SEC-29. */
  close: (address: string, query: string) => Promise<OmeReply>;
  orchestrator: StreamOrchestrator;
}

async function withOme(
  publishKeySecret: string | undefined,
  drive: (harness: OmeHarness) => Promise<void>,
): Promise<void> {
  const orchestrator = makeTestOrchestrator();
  const app = express();
  const engine = createOmeEngine('http://ome:8081', 50, { admissionSecret: OME_SECRET, publishKeySecret });
  app.use(
    express.json({
      // Mirrors api/server.ts, which is what the admission signature is computed over.
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(engine.prefix, engine.createRouter(orchestrator));
  const { server, baseUrl } = await listenOnLoopback(app);
  try {
    await drive({
      announce: (address, query) => announceToOme(baseUrl, engine.prefix, address, query),
      announceUrl: (address, url) => postAdmission(baseUrl, engine.prefix, address, url),
      close: (address, query) => closeOme(baseUrl, engine.prefix, address, query),
      orchestrator,
    });
  } finally {
    server.close();
    await orchestrator.cleanup();
  }
}

type SrsDrive = (
  announce: (ip: string, param: string | null) => Promise<number>,
  orchestrator: StreamOrchestrator,
  /** An `on_unpublish` for the same stream. Third rather than second so no existing caller moves. */
  unpublish: (ip: string, param: string | null) => Promise<number>,
) => Promise<void>;

async function withSrs(publishKeySecret: string | undefined, drive: SrsDrive): Promise<void> {
  const orchestrator = makeTestOrchestrator();
  const app = express();
  const engine = createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN, publishKeySecret });
  app.use(express.json());
  app.use(engine.prefix, engine.createRouter(orchestrator));
  const { server, baseUrl } = await listenOnLoopback(app);
  try {
    await drive(
      (ip, param) => announceToSrs(baseUrl, engine.prefix, ip, param),
      orchestrator,
      (ip, param) => unpublishFromSrs(baseUrl, engine.prefix, ip, param),
    );
  } finally {
    server.close();
    await orchestrator.cleanup();
  }
}

async function liveStreamFedOnce(orchestrator: StreamOrchestrator): Promise<void> {
  await waitFor(() => orchestrator.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
  orchestrator.handleSegment(STREAM_ID, 0, 2, Buffer.from('seg'));
}

describe('the publish key OME reads out of an admission', () => {
  /**
   * The end-to-end shape of SEC-28, driven through the real router: an announce from an address the
   * SEC-26 guard would refuse, allowed because it proved the key. If the engine stopped extracting
   * the key this would be a refusal, which is a failure this test can see and the suite otherwise
   * could not.
   */
  it('lets a proven key take a live id from another address', async () => {
    await withOme(PUBLISH_SECRET, async ({ announce, orchestrator }) => {
      assert.equal((await announce(BROADCASTER, `?key=${KEY}`)).allowed, true);
      await liveStreamFedOnce(orchestrator);

      assert.equal(
        (await announce(STRANGER, `?key=${KEY}`)).allowed,
        true,
        'the admission has to carry the key through to the guard',
      );
      assert.equal(orchestrator.getMetricsSnapshot().takeoversRefusedTotal, 0);
    });
  });

  /**
   * The reason is asserted, not only `allowed: false`. `handleAdmission`'s catch-all answers
   * `{ allowed: false, reason: 'handler error' }`, so replacing this whole refusal with a `throw`
   * produced the same observable and left the suite green. That is worse than an untested refusal,
   * because the engine also ships `OME_ADMISSION_FAIL_OPEN`, and with that on the identical crash
   * answers `allowed: true`: the suite was greenest in exactly the configuration where the defect
   * admits the attacker. The SRS half never had this hole, since its catch answers `SRS_ACCEPT` and
   * the same substitution kills all four of its refusals.
   */
  it('refuses an admission carrying no key at all', async () => {
    await withOme(PUBLISH_SECRET, async ({ announce, orchestrator }) => {
      assert.deepEqual(await announce(BROADCASTER, ''), { allowed: false, reason: 'invalid publish key' });
      assert.equal(orchestrator.getActiveStreamCount(), 0, 'nothing may be started for a refused publisher');
    });
  });

  it('refuses an admission carrying a wrong key', async () => {
    await withOme(PUBLISH_SECRET, async ({ announce, orchestrator }) => {
      assert.deepEqual(await announce(BROADCASTER, '?key=not-the-key'), {
        allowed: false,
        reason: 'invalid publish key',
      });
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    });
  });

  /**
   * The direction that actually hurts, pinned separately. With fail-open configured a handler crash
   * answers `allowed: true`, so this is the case where "refused" and "blew up" stop being the same
   * observable at all, and it is the one an operator is most likely to have turned on.
   */
  it('still refuses a keyless admission when the handler is configured to fail open', async () => {
    const orchestrator = makeTestOrchestrator();
    const app = express();
    const engine = createOmeEngine('http://ome:8081', 50, {
      admissionSecret: OME_SECRET,
      publishKeySecret: PUBLISH_SECRET,
      failOpen: true,
    });
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
      assert.deepEqual(await announceToOme(baseUrl, engine.prefix, BROADCASTER, ''), {
        allowed: false,
        reason: 'invalid publish key',
      });
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    } finally {
      server.close();
      await orchestrator.cleanup();
    }
  });

  /**
   * The per-stream half, and the reason the key is keyed by stream id rather than being one shared
   * secret. A broadcaster legitimately holding one stream's key must not be able to publish into
   * another, which is precisely what a single deployment-wide credential would allow.
   */
  it('refuses a key that is valid for a stream this announce is not naming', async () => {
    await withOme(PUBLISH_SECRET, async ({ announce, orchestrator }) => {
      assert.deepEqual(await announce(BROADCASTER, `?key=${KEY_FOR_ANOTHER_STREAM}`), {
        allowed: false,
        reason: 'invalid publish key',
      });
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    });
  });

  /**
   * With no secret configured the feature is off and the deployment behaves exactly as it did before
   * it existed. Asserted rather than assumed, because "off" and "rejecting everything" are the two
   * readings of an empty secret and the SRS webhook token deliberately takes the other one. The
   * difference is that this credential has no issuance path yet in an existing deployment, so
   * defaulting it on would take every broadcaster off the air on upgrade.
   */
  it('admits a keyless publisher when no secret is configured', async () => {
    await withOme(undefined, async ({ announce, orchestrator }) => {
      assert.equal((await announce(BROADCASTER, '')).allowed, true);
      await liveStreamFedOnce(orchestrator);

      assert.equal(
        (await announce(STRANGER, '')).allowed,
        false,
        'and SEC-26 is still the rule that applies when nobody proved anything',
      );
    });
  });
});

/**
 * The credential travels in a URL, which is the one place a secret cannot be kept out of by choosing
 * not to log it: every path that logs a URL logs it too. `parseAppStream` wrote the whole publish URL
 * into three `logger.error` calls and three thrown messages, all reachable by a broadcaster who
 * mistyped their app or stream, and all landing wherever this deployment ships its logs.
 *
 * This is why `redactWebhookToken` was generalised rather than copied. Its own invariant carries over:
 * it must redact at least every URL the check accepts, and being wider than that costs nothing.
 */
describe('keeping the publish key out of the logs', () => {
  /** Every publish url `parseAppStream` refuses, each of which used to be logged whole. */
  const UNPARSEABLE = [
    { name: 'names only an app', url: () => `srt://ingest.example:9999/video?key=${KEY}` },
    { name: 'is not a url at all', url: () => `:::nonsense:::?key=${KEY}` },
    { name: 'names an unusable app and stream', url: () => `srt://ingest.example:9999/video/a\\..\\b?key=${KEY}` },
  ];

  for (const testCase of UNPARSEABLE) {
    it(`redacts the key from the log when the publish url ${testCase.name}`, async () => {
      const lines: string[] = [];
      const logger = Logger.getInstance();
      const previous = logger.configure({ sink: (_level, line) => lines.push(line) });

      try {
        await withOme(PUBLISH_SECRET, async ({ announceUrl }) => {
          lines.length = 0;
          assert.equal((await announceUrl(BROADCASTER, testCase.url())).allowed, false);

          const logged = lines.join('\n');
          assert.ok(logged.length > 0, 'the refusal has to be logged at all for this to mean anything');
          assert.equal(logged.includes(KEY), false, 'the publish key must not reach a log line');
          assert.match(logged, /key=REDACTED/, 'and the parameter has to still be visible as redacted');
        });
      } finally {
        logger.configure(previous);
      }
    });
  }

  /**
   * The redactor is wider than the key, and has to stay that way. It is the same function the HTTP
   * request logger and the auth middleware call, so narrowing it to the publish key would silently
   * un-redact the SRS webhook token on three other paths.
   */
  it('still redacts the webhook token it was originally written for', () => {
    assert.equal(redactUrlSecrets('/engines/srs/hls?token=abc123'), '/engines/srs/hls?token=REDACTED');
    assert.equal(redactUrlSecrets('/x?token=abc&key=def'), '/x?token=REDACTED&key=REDACTED');
  });
});

describe('the publish key SRS reads out of an on_publish', () => {
  it('lets a proven key take a live id from another ip', async () => {
    await withSrs(PUBLISH_SECRET, async (announce, orchestrator) => {
      assert.equal(await announce(BROADCASTER, `?key=${KEY}`), 0);
      await liveStreamFedOnce(orchestrator);

      assert.equal(await announce(STRANGER, `?key=${KEY}`), 0, 'the webhook has to carry `param` through to the guard');
      assert.equal(orchestrator.getMetricsSnapshot().takeoversRefusedTotal, 0);
    });
  });

  /**
   * `param` absent is the shape a build that does not send it produces, and it has to be refused
   * rather than waved through. This is the field whose delivery was measured for exactly this reason.
   */
  it('refuses an on_publish that carried no param', async () => {
    await withSrs(PUBLISH_SECRET, async (announce, orchestrator) => {
      assert.equal(await announce(BROADCASTER, null), 1);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    });
  });

  it('refuses an on_publish whose param carries no key', async () => {
    await withSrs(PUBLISH_SECRET, async (announce, orchestrator) => {
      assert.equal(await announce(BROADCASTER, '?vhost=__defaultVhost__'), 1);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    });
  });

  it('refuses an on_publish carrying a wrong key', async () => {
    await withSrs(PUBLISH_SECRET, async (announce, orchestrator) => {
      assert.equal(await announce(BROADCASTER, '?key=not-the-key'), 1);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    });
  });

  it('refuses a key that is valid for a stream this webhook is not naming', async () => {
    await withSrs(PUBLISH_SECRET, async (announce, orchestrator) => {
      assert.equal(await announce(BROADCASTER, `?key=${KEY_FOR_ANOTHER_STREAM}`), 1);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    });
  });

  it('admits a keyless publisher when no secret is configured', async () => {
    await withSrs(undefined, async (announce, orchestrator) => {
      assert.equal(await announce(BROADCASTER, null), 0);
      await liveStreamFedOnce(orchestrator);

      assert.equal(await announce(STRANGER, null), 1, 'and SEC-26 is still the rule when nobody proved anything');
    });
  });

  /**
   * A publish that threw before it could be screened was never authenticated, and the handler's
   * catch-all answered `SRS_ACCEPT`, which tells SRS to admit the publisher.
   *
   * `publishKeyFromParam` throws for a `param` that is not a string, because `URLSearchParams` rejects
   * anything that is not a string or a list of pairs. A real SRS always sends a string, so this is not
   * reachable through a genuine engine, but the catch is wide enough to swallow anything a later
   * change puts on the credential path, and OME's equivalent already defaults to refusing. This is the
   * asymmetric half.
   */
  it('refuses a publish whose param cannot be parsed at all', async () => {
    const orchestrator = makeTestOrchestrator();
    const app = express();
    const engine = createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN, publishKeySecret: PUBLISH_SECRET });
    app.use(express.json());
    app.use(engine.prefix, engine.createRouter(orchestrator));
    const { server, baseUrl } = await listenOnLoopback(app);

    try {
      const response = await fetch(`${baseUrl}${engine.prefix}/streams?token=${SRS_TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A shape `URLSearchParams` refuses, which is what makes the extractor throw.
        body: JSON.stringify({ action: 'on_publish', app: APP, stream: STREAM, param: [['a', 'b', 'c']] }),
      });

      assert.equal(await response.json(), 1, 'a publish that could not be screened must not be admitted');
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    } finally {
      server.close();
      await orchestrator.cleanup();
    }
  });

  /**
   * A broadcaster who simply disconnects still gets their stream finalized once the close path is
   * screened, driven through a real orchestrator all the way to the stream leaving the active set.
   *
   * **This test used to assert the opposite and its reasoning was wrong.** It was written for SEC-28
   * as "does not require a key on an unpublish", arguing that screening the close path would strand
   * every stream whose broadcaster dropped, since the unpublish would be refused and the stream would
   * sit live until the recovery timeout. That rested on an unpublish carrying no key, and it was
   * driven with no `param` at all as "the strictest form of the claim". SRS sends no such thing. In a
   * capture on 2026-08-03 against `ossrs/srs:6`, killing the publisher produced an unpublish carrying
   * `param` identical to its own publish, key included, so the disconnect case screens clean and the
   * stranding this was written to prevent cannot arise from a real engine. See SEC-29.
   *
   * The SEC-29 block below covers the refusals with a recording orchestrator, which answers whether
   * `stopStream` was called and not whether a stream actually finalizes. This one keeps that half.
   */
  it('finalizes the stream on an unpublish carrying the key its publish carried', async () => {
    const orchestrator = makeTestOrchestrator();
    const app = express();
    const engine = createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN, publishKeySecret: PUBLISH_SECRET });
    app.use(express.json());
    app.use(engine.prefix, engine.createRouter(orchestrator));
    const { server, baseUrl } = await listenOnLoopback(app);

    try {
      assert.equal(await announceToSrs(baseUrl, engine.prefix, BROADCASTER, `?key=${KEY}`), 0);
      await liveStreamFedOnce(orchestrator);

      const response = await fetch(`${baseUrl}${engine.prefix}/streams?token=${SRS_TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'on_unpublish',
          app: APP,
          stream: STREAM,
          ip: BROADCASTER,
          param: `?key=${KEY}`,
        }),
      });

      assert.equal(await response.json(), 0, 'an unpublish is acknowledged whatever it carried');
      await waitFor(() => orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);
    } finally {
      server.close();
      await orchestrator.cleanup();
    }
  });
});

/**
 * That the variable is read from the environment at all.
 *
 * This file's header argues that a test constructing the engine directly cannot see an engine that
 * stopped reading its evidence. That argument applies one level further up than the tests above
 * reach: every one of them hands the secret in as an option, so both `*FromEnv` builders could
 * hardcode the empty string and the whole file would stay green while the feature was off in every
 * real deployment. Mutation showed exactly that, on both engines.
 *
 * Both sibling credentials already have this test (`OmeAdmission.test.ts` for the admission secret,
 * `srsWebhookAuth.test.ts` for the webhook token), so the omission was an asymmetry rather than a
 * judgement.
 */
describe('reading PUBLISH_KEY_SECRET out of the environment', () => {
  const savedPublishKey = process.env.PUBLISH_KEY_SECRET;
  const savedOme = process.env.OME_ADMISSION_SECRET;
  const savedSrs = process.env.SRS_WEBHOOK_TOKEN;

  before(() => {
    process.env.PUBLISH_KEY_SECRET = PUBLISH_SECRET;
    process.env.OME_ADMISSION_SECRET = OME_SECRET;
    process.env.SRS_WEBHOOK_TOKEN = SRS_TOKEN;
  });

  after(() => {
    restore('PUBLISH_KEY_SECRET', savedPublishKey);
    restore('OME_ADMISSION_SECRET', savedOme);
    restore('SRS_WEBHOOK_TOKEN', savedSrs);
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  /** Driven through the router, because "the option was set" is not "the announce is screened". */
  async function keylessAnnounceIsRefused(engine: ReturnType<typeof createOmeEngineFromEnv>): Promise<void> {
    const orchestrator = makeTestOrchestrator();
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
      if (engine.name === 'ome') {
        assert.deepEqual(await announceToOme(baseUrl, engine.prefix, BROADCASTER, ''), {
          allowed: false,
          reason: 'invalid publish key',
        });
      } else {
        assert.equal(await announceToSrs(baseUrl, engine.prefix, BROADCASTER, null), 1);
      }
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    } finally {
      server.close();
      await orchestrator.cleanup();
    }
  }

  it('OME screens an announce when the secret came from the environment', async () => {
    await keylessAnnounceIsRefused(createOmeEngineFromEnv());
  });

  it('SRS screens an announce when the secret came from the environment', async () => {
    await keylessAnnounceIsRefused(createSrsEngineFromEnv());
  });

  /**
   * And the length screen is reached through each engine's constructor. Covering the function in
   * isolation left both engines able to accept a four-character master secret with a green suite.
   */
  it('OME refuses to build on a secret the service would reject', () => {
    assert.throws(
      () => createOmeEngine('http://ome:8081', 50, { admissionSecret: OME_SECRET, publishKeySecret: 'short' }),
      /at least/,
    );
  });

  it('SRS refuses to build on a secret the service would reject', () => {
    assert.throws(
      () => createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN, publishKeySecret: 'short' }),
      /at least/,
    );
  });
});

/**
 * The warnings are the only thing that tells an operator publisher authentication is off, and both
 * engines' source comments argue they are load-bearing for exactly that reason. Neither was asserted,
 * so either text could be replaced wholesale with the suite green.
 */
describe('saying out loud when publisher authentication is off', () => {
  function warningsWhileBuilding(build: () => void): string {
    const lines: string[] = [];
    const logger = Logger.getInstance();
    const previous = logger.configure({ sink: (_level, line) => lines.push(line) });
    try {
      build();
    } finally {
      logger.configure(previous);
    }
    return lines.join('\n');
  }

  it('OME warns when no secret is configured', () => {
    const logged = warningsWhileBuilding(() => {
      const engine = createOmeEngine('http://ome:8081', 50, { admissionSecret: OME_SECRET });
      engine.createRouter(makeTestOrchestrator());
    });

    assert.match(logged, /No PUBLISH_KEY_SECRET configured/);
    assert.match(logged, /SEC-28/);
  });

  it('SRS warns when no secret is configured', () => {
    const logged = warningsWhileBuilding(() => createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN }));

    assert.match(logged, /No PUBLISH_KEY_SECRET configured/);
    assert.match(logged, /SEC-28/);
  });

  it('says nothing of the sort once a secret is configured', () => {
    const logged = warningsWhileBuilding(() =>
      createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN, publishKeySecret: PUBLISH_SECRET }),
    );

    assert.doesNotMatch(logged, /No PUBLISH_KEY_SECRET configured/);
  });
});

/**
 * That the publish key gates stopping a stream, not only starting one. See SEC-29.
 *
 * **What this is not.** It is not an unauthenticated takedown. Measured on 2026-08-03 against
 * `ossrs/srs:6`: a publish the hook rejects produces no `on_unpublish` at all, so a stranger cannot
 * end a broadcast by connecting to its name and being refused. The one unpublish in that capture
 * carried the accepted session's own `client_id` and `param`. Both close paths also sit behind an
 * engine credential already, the webhook token here and the admission signature on the OME side.
 *
 * **What it is.** After SEC-28, starting a stream needs two credentials and stopping one needed only
 * the engine's, so anything that could replay or forge an engine webhook could end a broadcast that
 * it could not have started. Both engines carry the key on the close webhook, so closing the gap
 * costs one comparison on a path that already had the value in hand.
 *
 * The orchestrator is a recorder rather than a real one on purpose. What is under test is whether the
 * engine *calls* `stopStream`, and reading that off a drain means waiting out a window and asserting
 * a stream is still live, which is a race that reports the machine's load. `stops` answers the actual
 * question with no clock in it.
 */
describe('the publish key on the path that stops a stream (SEC-29)', () => {
  /** Answers every playlist poll with a 404 so the puller an accepted announce starts stays quiet. */
  const silentFetcher = async (): Promise<Response> => new Response('', { status: 404 });

  interface StopHarness {
    /** Stream ids the engine asked the orchestrator to stop, in order. */
    stops: string[];
    announce: (query: string) => Promise<OmeReply>;
    close: (query: string) => Promise<OmeReply>;
  }

  async function withOmeStops(
    publishKeySecret: string | undefined,
    drive: (harness: StopHarness) => Promise<void>,
  ): Promise<void> {
    const stops: string[] = [];
    const orchestrator = makeFakeOrchestrator({
      stopStream: async (streamId: string) => {
        stops.push(streamId);
      },
    });
    const app = express();
    const engine = createOmeEngine('http://ome.invalid:8081', 60_000, {
      admissionSecret: OME_SECRET,
      publishKeySecret,
      fetcher: silentFetcher,
    });
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
      await drive({
        stops,
        announce: (query) => announceToOme(baseUrl, engine.prefix, BROADCASTER, query),
        close: (query) => closeOme(baseUrl, engine.prefix, BROADCASTER, query),
      });
    } finally {
      server.close();
    }
  }

  interface SrsStopHarness {
    stops: string[];
    announce: (param: string | null) => Promise<number>;
    unpublish: (param: string | null) => Promise<number>;
  }

  async function withSrsStops(
    publishKeySecret: string | undefined,
    drive: (harness: SrsStopHarness) => Promise<void>,
  ): Promise<void> {
    const stops: string[] = [];
    const orchestrator = makeFakeOrchestrator({
      stopStream: async (streamId: string) => {
        stops.push(streamId);
      },
    });
    const app = express();
    const engine = createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN, publishKeySecret });
    app.use(express.json());
    app.use(engine.prefix, engine.createRouter(orchestrator));
    const { server, baseUrl } = await listenOnLoopback(app);
    try {
      await drive({
        stops,
        announce: (param) => announceToSrs(baseUrl, engine.prefix, BROADCASTER, param),
        unpublish: (param) => unpublishFromSrs(baseUrl, engine.prefix, BROADCASTER, param),
      });
    } finally {
      server.close();
    }
  }

  describe('OME', () => {
    /**
     * The degenerate case, asserted first and deliberately. Every test below it asserts that a stop
     * did *not* happen, and an empty `stops` proves nothing unless a closing that should stop the
     * stream does reach it through the same harness. Without this one, deleting the whole closing
     * branch would leave the rest of this block green.
     */
    it('stops the stream for a closing that carries the key', async () => {
      await withOmeStops(PUBLISH_SECRET, async ({ announce, close, stops }) => {
        assert.equal((await announce(`?key=${KEY}`)).allowed, true);

        assert.equal((await close(`?key=${KEY}`)).allowed, true);
        assert.deepEqual(stops, [STREAM_ID]);
      });
    });

    it('does not stop the stream for a closing that carries no key', async () => {
      await withOmeStops(PUBLISH_SECRET, async ({ announce, close, stops }) => {
        assert.equal((await announce(`?key=${KEY}`)).allowed, true);

        await close('');
        assert.deepEqual(stops, [], 'a keyless closing must not end a proven broadcast');
      });
    });

    it('does not stop the stream for a closing carrying a key issued for another stream', async () => {
      await withOmeStops(PUBLISH_SECRET, async ({ announce, close, stops }) => {
        assert.equal((await announce(`?key=${KEY}`)).allowed, true);

        await close(`?key=${KEY_FOR_ANOTHER_STREAM}`);
        assert.deepEqual(stops, []);
      });
    });

    /**
     * OME wants an acknowledgement and nothing else from a closing, and it is entitled to one whoever
     * sent it. Answering `allowed: false` would be a protocol answer to an authorization question, so
     * the refusal is expressed by not acting rather than by refusing the reply.
     */
    it('still acknowledges the closing it refuses to act on', async () => {
      await withOmeStops(PUBLISH_SECRET, async ({ announce, close }) => {
        await announce(`?key=${KEY}`);

        assert.equal((await close('')).allowed, true);
      });
    });

    it('stops the stream for a keyless closing when no secret is configured', async () => {
      await withOmeStops(undefined, async ({ announce, close, stops }) => {
        assert.equal((await announce('')).allowed, true);

        await close('');
        assert.deepEqual(stops, [STREAM_ID], 'SEC-29 must not change a deployment that never opted in');
      });
    });
  });

  describe('SRS', () => {
    it('stops the stream for an unpublish that carries the key', async () => {
      await withSrsStops(PUBLISH_SECRET, async ({ announce, unpublish, stops }) => {
        assert.equal(await announce(`?key=${KEY}`), 0);

        assert.equal(await unpublish(`?key=${KEY}`), 0);
        assert.deepEqual(stops, [STREAM_ID]);
      });
    });

    it('does not stop the stream for an unpublish that carries no key', async () => {
      await withSrsStops(PUBLISH_SECRET, async ({ announce, unpublish, stops }) => {
        assert.equal(await announce(`?key=${KEY}`), 0);

        await unpublish(null);
        assert.deepEqual(stops, [], 'a keyless unpublish must not end a proven broadcast');
      });
    });

    it('does not stop the stream for an unpublish carrying a key issued for another stream', async () => {
      await withSrsStops(PUBLISH_SECRET, async ({ announce, unpublish, stops }) => {
        assert.equal(await announce(`?key=${KEY}`), 0);

        await unpublish(`?key=${KEY_FOR_ANOTHER_STREAM}`);
        assert.deepEqual(stops, []);
      });
    });

    /**
     * SRS reads any non-zero answer as a failure worth logging and retrying, and an unpublish is not
     * a request it can usefully be refused: the session it names is already gone from SRS's side. So
     * the refusal is silent to SRS and visible only in the log and in `stops`.
     */
    it('still answers SRS_ACCEPT to the unpublish it refuses to act on', async () => {
      await withSrsStops(PUBLISH_SECRET, async ({ announce, unpublish }) => {
        await announce(`?key=${KEY}`);

        assert.equal(await unpublish(null), 0);
      });
    });

    it('stops the stream for a keyless unpublish when no secret is configured', async () => {
      await withSrsStops(undefined, async ({ announce, unpublish, stops }) => {
        assert.equal(await announce(null), 0);

        await unpublish(null);
        assert.deepEqual(stops, [STREAM_ID], 'SEC-29 must not change a deployment that never opted in');
      });
    });
  });
});
