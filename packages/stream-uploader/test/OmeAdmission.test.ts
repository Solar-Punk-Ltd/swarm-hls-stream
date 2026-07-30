import express, { Request } from 'express';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createOmeEngine, createOmeEngineFromEnv } from '../src/engines/ome.js';
import { verifyAdmissionSignature } from '../src/engines/ome/http.js';
import { OmeAdmissionReply } from '../src/engines/ome/interfaces.js';
import { EnginePlugin, RawBodyRequest } from '../src/engines/types.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';

const SECRET = 'admission-secret';
const HLS_BASE = 'http://ome:8081';

// Long enough that a puller started by an admitted request polls once and then idles far outside
// the test window.
const POLL_INTERVAL_MS = 60_000;

const ADMISSION_BODY = JSON.stringify({
  request: { direction: 'incoming', status: 'opening', url: 'srt://ome:10080/video/demo' },
});

function signatureFor(secret: string, body: string): string {
  return createHmac('sha1', secret).update(Buffer.from(body)).digest('base64url');
}

function fakeRequest(signature: string | undefined, rawBody: Buffer | undefined): Request {
  return {
    get: (name: string) => (name.toLowerCase() === 'x-ome-signature' ? signature : undefined),
    rawBody,
  } as unknown as Request;
}

describe('verifyAdmissionSignature (SEC-3)', () => {
  // The empty secret is not a secret. Anyone who can reach the webhook can compute this signature
  // themselves, so an empty secret has to reject rather than wave the request through.
  it('rejects an empty secret even when the request carries a signature made with the empty key', () => {
    const forged = signatureFor('', ADMISSION_BODY);
    assert.equal(verifyAdmissionSignature(fakeRequest(forged, Buffer.from(ADMISSION_BODY)), ''), false);
  });

  it('rejects an empty secret when the request carries no signature at all', () => {
    assert.equal(verifyAdmissionSignature(fakeRequest(undefined, Buffer.from(ADMISSION_BODY)), ''), false);
  });

  it('accepts a correctly signed request', () => {
    const signature = signatureFor(SECRET, ADMISSION_BODY);
    assert.equal(verifyAdmissionSignature(fakeRequest(signature, Buffer.from(ADMISSION_BODY)), SECRET), true);
  });

  it('rejects a signature computed with a different secret', () => {
    const signature = signatureFor('some-other-secret', ADMISSION_BODY);
    assert.equal(verifyAdmissionSignature(fakeRequest(signature, Buffer.from(ADMISSION_BODY)), SECRET), false);
  });

  it('rejects a request with no signature header', () => {
    assert.equal(verifyAdmissionSignature(fakeRequest(undefined, Buffer.from(ADMISSION_BODY)), SECRET), false);
  });

  it('rejects a request whose raw body was never captured', () => {
    const signature = signatureFor(SECRET, ADMISSION_BODY);
    assert.equal(verifyAdmissionSignature(fakeRequest(signature, undefined), SECRET), false);
  });
});

describe('createOmeEngineFromEnv requires an admission secret (SEC-3)', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.OME_ADMISSION_SECRET;
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OME_ADMISSION_SECRET;
    } else {
      process.env.OME_ADMISSION_SECRET = saved;
    }
  });

  it('throws naming the variable when it is unset', () => {
    delete process.env.OME_ADMISSION_SECRET;
    assert.throws(() => createOmeEngineFromEnv(), /Missing required env var: OME_ADMISSION_SECRET/);
  });

  // The deploy compose passes `${OME_ADMISSION_SECRET:-}`, so an operator who never set it gets the
  // empty string rather than an absent variable. Both have to fail, and the messages have to differ,
  // or the log tells the operator to add a key that is already in their .env.
  it('throws when it is set to the empty string, and says empty rather than missing', () => {
    process.env.OME_ADMISSION_SECRET = '';
    assert.throws(() => createOmeEngineFromEnv(), /set but empty: OME_ADMISSION_SECRET/);
  });

  it('constructs the engine once the secret is set', () => {
    process.env.OME_ADMISSION_SECRET = SECRET;
    assert.equal(createOmeEngineFromEnv().name, 'ome');
  });
});

function fakeOrchestrator(startedStreamIds: string[]): StreamOrchestrator {
  return {
    startStream: (streamId: string) => {
      startedStreamIds.push(streamId);
      return true;
    },
    stopStream: async () => {},
    handleSegment: () => ({ accepted: true }),
  } as unknown as StreamOrchestrator;
}

interface AdmissionResponse {
  status: number;
  body: OmeAdmissionReply;
}

async function postAdmission(
  engine: EnginePlugin,
  orchestrator: StreamOrchestrator,
  signature?: string,
): Promise<AdmissionResponse> {
  const app = express();
  // Mirrors the raw-body capture in api/server.ts, which is what the signature is computed over.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );
  app.use(engine.prefix, engine.createRouter(orchestrator));

  const server = app.listen(0);
  try {
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature) {
      headers['x-ome-signature'] = signature;
    }
    const response = await fetch(`http://127.0.0.1:${port}${engine.prefix}/admission`, {
      method: 'POST',
      headers,
      body: ADMISSION_BODY,
    });
    return { status: response.status, body: (await response.json()) as OmeAdmissionReply };
  } finally {
    server.close();
  }
}

describe('OME admission route with no secret configured (SEC-3)', () => {
  let originalFetch: typeof globalThis.fetch;

  // An admitted request starts an HLS puller against HLS_BASE, which does not resolve. Only that
  // host is stubbed, because postAdmission itself reaches the test server over fetch.
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith('http://127.0.0.1:')) {
        return originalFetch(input, init);
      }
      return Promise.resolve({ ok: false, status: 404, text: async () => '' } as Response);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects an unsigned request instead of admitting it', async () => {
    const started: string[] = [];
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS);

    const { status, body } = await postAdmission(engine, fakeOrchestrator(started));

    assert.equal(status, 401);
    assert.equal(body.allowed, false);
    assert.deepEqual(started, [], 'an unauthenticated admission must not start a stream, which spends stamp funds');
  });

  it('rejects a request signed with the empty key', async () => {
    const started: string[] = [];
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS);
    const forged = signatureFor('', ADMISSION_BODY);

    const { status, body } = await postAdmission(engine, fakeOrchestrator(started), forged);

    assert.equal(status, 401);
    assert.equal(body.allowed, false);
    assert.deepEqual(started, []);
  });

  it('admits and starts the stream once a secret is configured and the signature matches', async () => {
    const started: string[] = [];
    const engine = createOmeEngine(HLS_BASE, POLL_INTERVAL_MS, { admissionSecret: SECRET });
    const signature = signatureFor(SECRET, ADMISSION_BODY);

    const { status, body } = await postAdmission(engine, fakeOrchestrator(started), signature);

    assert.equal(status, 200);
    assert.equal(body.allowed, true);
    assert.deepEqual(started, ['video/demo']);
  });
});
