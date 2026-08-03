/**
 * That each engine actually hands the orchestrator the publisher's address. See SEC-26.
 *
 * `StreamTakeover.test.ts` drives `startStream` directly, so it pins what the guard does with the
 * evidence and nothing about whether the guard ever receives any. Those are separate failures and
 * the second one is silent: the guard fails open on a null address, so an engine that stops passing
 * one turns SEC-26 off with a green suite and `takeovers_refused_total` reading zero, which is
 * indistinguishable from nobody having tried.
 *
 * The gate's correctness lens established that both call sites were in exactly that state: replacing
 * either engine's argument with `{ address: null }` left all 577 tests passing.
 */

import express from 'express';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { createOmeEngine } from '../src/engines/ome.js';
import { createSrsEngine } from '../src/engines/srs.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import { startTestApi } from './helpers/apiTestServer.js';
import { makeFakeRecoveryStore, makeRecoveredState, makeTestOrchestrator, toRecoveryFileId } from './helpers/fakes.js';
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

/**
 * A live stream fed by one segment, which is what makes the id worth defending: the guard only ever
 * refuses over a stream something is still publishing into.
 */
async function liveStreamFedOnce(orchestrator: StreamOrchestrator): Promise<void> {
  await waitFor(() => orchestrator.getActiveStreamCount() === 1, SETTLE_CEILING_MS);
  orchestrator.handleSegment(STREAM_ID, 0, 2, Buffer.from('seg'));
}

/** `mount` wires one engine's router, `announce` sends one opening from an address and returns the reply. */
async function withEngine<T>(
  mount: (app: express.Express, orchestrator: StreamOrchestrator) => string,
  drive: (announce: (address: string) => Promise<T>, orchestrator: StreamOrchestrator) => Promise<void>,
  announceAt: (baseUrl: string, prefix: string, address: string) => Promise<T>,
): Promise<void> {
  const orchestrator = makeTestOrchestrator();
  const app = express();
  const prefix = mount(app, orchestrator);
  const { server, baseUrl } = await listenOnLoopback(app);
  try {
    await drive((address) => announceAt(baseUrl, prefix, address), orchestrator);
  } finally {
    server.close();
    await orchestrator.cleanup();
  }
}

describe('the address each engine hands to the takeover guard', () => {
  it('OME refuses a second admission from a different client address', async () => {
    await withEngine(
      (app, orchestrator) => {
        const engine = createOmeEngine('http://ome:8081', 50, { admissionSecret: OME_SECRET });
        app.use(
          express.json({
            // Mirrors api/server.ts, which is what the admission signature is computed over.
            verify: (req, _res, buf) => {
              (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
            },
          }),
        );
        app.use(engine.prefix, engine.createRouter(orchestrator));
        return engine.prefix;
      },
      async (announce, orchestrator) => {
        assert.deepEqual(await announce(BROADCASTER), { allowed: true, lifetime: 0, reason: 'ok' });
        await liveStreamFedOnce(orchestrator);

        assert.deepEqual(
          await announce(STRANGER),
          { allowed: false, reason: 'orchestrator rejected' },
          'the admission must carry the publisher address through to the guard',
        );
        assert.equal(orchestrator.getMetricsSnapshot().takeoversRefusedTotal, 1);
      },
      async (baseUrl, prefix, address) => {
        const body = JSON.stringify({
          client: { address, port: 44546 },
          request: {
            direction: 'incoming',
            status: 'opening',
            url: `srt://ingest.example:9999/${APP}/${STREAM}`,
            time: new Date(0).toISOString(),
          },
        });
        const signature = createHmac('sha1', OME_SECRET).update(body).digest('base64url');
        const response = await fetch(`${baseUrl}${prefix}/admission`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ome-signature': signature },
          body,
        });
        return response.json();
      },
    );
  });

  /**
   * SRS names the field `ip` and this deployment's build has not been observed sending it, unlike
   * OME's `client.address` which was captured live. That is exactly why it needs a test: a wrong
   * field name lands on the null path, and the null path is the one that says nothing.
   */
  it('SRS refuses a second on_publish from a different ip', async () => {
    await withEngine(
      (app, orchestrator) => {
        const engine = createSrsEngine('/srv/media', { webhookToken: SRS_TOKEN });
        app.use(express.json());
        app.use(engine.prefix, engine.createRouter(orchestrator));
        return engine.prefix;
      },
      async (announce, orchestrator) => {
        assert.equal(await announce(BROADCASTER), 0, 'SRS accepts with a zero code');
        await liveStreamFedOnce(orchestrator);

        assert.equal(await announce(STRANGER), 1, 'the webhook must carry `ip` through to the guard');
        assert.equal(orchestrator.getMetricsSnapshot().takeoversRefusedTotal, 1);
      },
      async (baseUrl, prefix, ip) => {
        const response = await fetch(`${baseUrl}${prefix}/streams?token=${SRS_TOKEN}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'on_publish', app: APP, stream: STREAM, ip }),
        });
        return response.json();
      },
    );
  });

  /**
   * The control route is the third caller and it must keep working. It holds the service token, so it
   * is inside the trust boundary and names nobody deliberately, which the guard reads as no evidence
   * rather than as a stranger.
   *
   * Driven over the real app rather than by calling `startStream` directly. The direct call leans on
   * the default parameter and leaves the route's own argument list unobserved, so a route that began
   * passing `req.ip` would go unnoticed and would refuse the operator over their own proxy's address.
   */
  it('the control route still starts a stream over a live one, naming nobody', async () => {
    const orchestrator = makeTestOrchestrator();
    const api = await startTestApi(orchestrator);
    try {
      assert.equal(orchestrator.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
      await liveStreamFedOnce(orchestrator);

      const response = await api.request('/stream/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamId: STREAM_ID, mediatype: MEDIA_TYPE_VIDEO }),
      });

      assert.equal(response.status, 200);
      assert.equal(orchestrator.getMetricsSnapshot().takeoversRefusedTotal, 0);
    } finally {
      await api.close();
      await orchestrator.cleanup();
    }
  });

  /**
   * And when it *is* refused, it must say so. `startStream` returned `true` on every path until this
   * guard landed, so the route discarding its answer was correct by accident and stopped being so
   * without changing. An operator was told `200 {ok:true}` while nothing had started, which is the
   * worst shape a refusal can take: the caller holds the service token and is the one person who
   * could have acted on it.
   *
   * A recovered stream is what makes the refusal reachable from this route at all. Its owner is
   * unknown rather than absent, so even an announce naming nobody is judged against the stall window,
   * and this route names nobody by design. That is the same shape the gate's lens demonstrated.
   */
  it('the control route reports a refusal instead of answering ok', async () => {
    const orchestrator = makeTestOrchestrator(
      { recoveryTimeout: 60_000 },
      {},
      makeFakeRecoveryStore({
        listActive: () => [toRecoveryFileId(STREAM_ID)],
        load: () => makeRecoveredState(STREAM_ID),
      }),
    );
    const api = await startTestApi(orchestrator);
    try {
      await orchestrator.recoverStreams();
      // Segments, not an announce, which is how both engines resume a recovered stream and what
      // leaves its owner unknown.
      await liveStreamFedOnce(orchestrator);

      const response = await api.request('/stream/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamId: STREAM_ID, mediatype: MEDIA_TYPE_VIDEO }),
      });

      assert.equal(response.status, 409, 'a refused start must not be answered ok');
      assert.equal(orchestrator.getMetricsSnapshot().takeoversRefusedTotal, 1);
    } finally {
      await api.close();
      await orchestrator.cleanup();
    }
  });
});
