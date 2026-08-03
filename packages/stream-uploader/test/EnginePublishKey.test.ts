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
import { describe, it } from 'node:test';

import { createOmeEngine } from '../src/engines/ome.js';
import { createSrsEngine } from '../src/engines/srs.js';
import { Logger } from '../src/libs/Logger.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { derivePublishKey } from '../src/utils/publishKey.js';
import { redactUrlSecrets } from '../src/utils/urlSecrets.js';

import { makeTestOrchestrator } from './helpers/fakes.js';
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

/** An OME admission carrying whatever publish url the caller wants, signed the way OME signs it. */
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

/** An OME admission for `STREAM_ID`, with whatever query the caller wants on the publish url. */
async function announceToOme(baseUrl: string, prefix: string, address: string, query: string): Promise<OmeReply> {
  return postAdmission(baseUrl, prefix, address, `srt://ingest.example:9999/${APP}/${STREAM}${query}`);
}

/** An SRS `on_publish` for `STREAM_ID`. `param` is omitted entirely when the caller passes null. */
async function announceToSrs(baseUrl: string, prefix: string, ip: string, param: string | null): Promise<number> {
  const response = await fetch(`${baseUrl}${prefix}/streams?token=${SRS_TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'on_publish',
      app: APP,
      stream: STREAM,
      ip,
      ...(param === null ? {} : { param }),
    }),
  });
  return response.json() as Promise<number>;
}

interface OmeHarness {
  /** An admission for `STREAM_ID`, with `query` appended to its publish url. */
  announce: (address: string, query: string) => Promise<OmeReply>;
  /** An admission for any publish url at all, for the ones that must not parse. */
  announceUrl: (address: string, url: string) => Promise<OmeReply>;
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
) => Promise<void>;

async function withSrs(publishKeySecret: string | undefined, drive: SrsDrive): Promise<void> {
  const orchestrator = makeTestOrchestrator();
  const app = express();
  const engine = createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN, publishKeySecret });
  app.use(express.json());
  app.use(engine.prefix, engine.createRouter(orchestrator));
  const { server, baseUrl } = await listenOnLoopback(app);
  try {
    await drive((ip, param) => announceToSrs(baseUrl, engine.prefix, ip, param), orchestrator);
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

  it('refuses an admission carrying no key at all', async () => {
    await withOme(PUBLISH_SECRET, async ({ announce, orchestrator }) => {
      assert.equal((await announce(BROADCASTER, '')).allowed, false);
      assert.equal(orchestrator.getActiveStreamCount(), 0, 'nothing may be started for a refused publisher');
    });
  });

  it('refuses an admission carrying a wrong key', async () => {
    await withOme(PUBLISH_SECRET, async ({ announce, orchestrator }) => {
      assert.equal((await announce(BROADCASTER, '?key=not-the-key')).allowed, false);
      assert.equal(orchestrator.getActiveStreamCount(), 0);
    });
  });

  /**
   * The per-stream half, and the reason the key is keyed by stream id rather than being one shared
   * secret. A broadcaster legitimately holding one stream's key must not be able to publish into
   * another, which is precisely what a single deployment-wide credential would allow.
   */
  it('refuses a key that is valid for a stream this announce is not naming', async () => {
    await withOme(PUBLISH_SECRET, async ({ announce, orchestrator }) => {
      assert.equal((await announce(BROADCASTER, `?key=${KEY_FOR_ANOTHER_STREAM}`)).allowed, false);
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
   * An unpublish is not a publish and must not be screened as one. SRS sends it for a session it
   * already accepted, and the webhook itself is authenticated by the token, so requiring a key here
   * would only strand the streams whose broadcaster disconnected: the unpublish would be refused, the
   * stream would never be finalized, and it would sit live until the recovery timeout took it.
   *
   * Driven with no `param` at all, which is the strictest form of the claim.
   */
  it('does not require a key on an unpublish', async () => {
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
        body: JSON.stringify({ action: 'on_unpublish', app: APP, stream: STREAM, ip: BROADCASTER }),
      });

      assert.equal(await response.json(), 0, 'an unpublish carrying no key must still be accepted');
      await waitFor(() => orchestrator.getActiveStreamCount() === 0, SETTLE_CEILING_MS);
    } finally {
      server.close();
      await orchestrator.cleanup();
    }
  });
});
