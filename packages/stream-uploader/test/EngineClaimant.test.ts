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
   */
  it('the control route still starts a stream over a live one, naming nobody', async () => {
    const orchestrator = makeTestOrchestrator();
    try {
      assert.equal(orchestrator.startStream(STREAM_ID, MEDIA_TYPE_VIDEO, { address: BROADCASTER }), true);
      await liveStreamFedOnce(orchestrator);

      assert.equal(orchestrator.startStream(STREAM_ID, MEDIA_TYPE_VIDEO), true);
      assert.equal(orchestrator.getMetricsSnapshot().takeoversRefusedTotal, 0);
    } finally {
      await orchestrator.cleanup();
    }
  });
});
