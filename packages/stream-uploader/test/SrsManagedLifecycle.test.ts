import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSrsEngine } from '../src/engines/srs.js';
import { AbrLadder } from '../src/libs/AbrLadder.js';
import { AdminApiClient, ManagedClaimRequest } from '../src/libs/AdminApiClient.js';
import { ManagedClaimAttempt, ManagedClaimCompletion } from '../src/libs/ManagedRunStore.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { SourceConnectionIdentity } from '../src/types.js';

import { listenOnLoopback } from './helpers/loopbackServer.js';

const TOKEN = 'srs-webhook-token-0123456789abcdef';
const STREAM_ID = 'video/11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const UPLOADER_ID = 'srs-157-90-34-105';
const CLAIM_ID = '44444444-4444-4444-8444-444444444444';

interface Calls {
  attempts: ManagedClaimAttempt[];
  requests: ManagedClaimRequest[];
  completed: ManagedClaimCompletion[];
  provisioned: SourceConnectionIdentity[];
  unpublished: SourceConnectionIdentity[];
  managedRenditions: string[];
  legacyStarts: string[];
  stops: string[];
  disconnect?: (identity: SourceConnectionIdentity) => void;
  deletes: string[];
}

async function withManagedSrs(
  provision: (identity: SourceConnectionIdentity) => boolean,
  drive: (post: (body: Record<string, unknown>) => Promise<number>, calls: Calls) => Promise<void>,
  options: { abr?: boolean } = {},
): Promise<void> {
  const calls: Calls = {
    attempts: [],
    requests: [],
    completed: [],
    provisioned: [],
    unpublished: [],
    managedRenditions: [],
    legacyStarts: [],
    stops: [],
    deletes: [],
  };
  const admin = {
    describe: () => 'http://admin.test',
    lookupByIngestId: async () => ({
      id: ADMIN_ID,
      topic: 'a'.repeat(64),
      owner: '0xowner',
      mediaType: 'video',
      title: 'managed',
      status: 'published',
      publishKey: 'secret',
      lifecycleVersion: 1,
      mode: 'managed',
      lifecycle: {
        revision: 7,
        runNumber: 2,
        state: 'ready',
        permission: 'open',
        uploaderId: UPLOADER_ID,
      },
    }),
    claimManagedRun: async (_id: string, _run: number, request: ManagedClaimRequest) => {
      calls.requests.push(request);
      return {
        lifecycleVersion: 1 as const,
        streamId: ADMIN_ID,
        revision: 8,
        runNumber: 2,
        uploaderId: UPLOADER_ID,
        claimId: CLAIM_ID,
        state: 'claimed' as const,
        permission: 'claimed' as const,
      };
    },
  } as AdminApiClient;
  const orchestrator = {
    beginManagedClaimAttempt: (attempt: ManagedClaimAttempt) => {
      calls.attempts.push(attempt);
      return {
        requestId: '33333333-3333-4333-8333-333333333333',
        expectedRevision: attempt.revision,
        needsClaim: calls.attempts.length === 1,
      };
    },
    completeManagedClaim: (_streamId: string, claim: ManagedClaimCompletion) => {
      calls.completed.push(claim);
      return true;
    },
    provisionManagedSource: (
      _streamId: string,
      _mediaType: string,
      identity: SourceConnectionIdentity,
    ) => {
      calls.provisioned.push(identity);
      return provision(identity);
    },
    markManagedSourceUnpublished: (_streamId: string, identity: SourceConnectionIdentity) => {
      calls.unpublished.push(identity);
      return true;
    },
    startStream: (streamId: string) => {
      calls.legacyStarts.push(streamId);
      return true;
    },
    provisionManagedRendition: (streamId: string) => {
      calls.managedRenditions.push(streamId);
      return true;
    },
    stopStream: async (streamId: string) => {
      calls.stops.push(streamId);
    },
    recordAuthRejection: () => undefined,
    registerManagedSourceDisconnector: (disconnect: (identity: SourceConnectionIdentity) => void) => {
      calls.disconnect = disconnect;
    },
  } as unknown as StreamOrchestrator;
  const engine = createSrsEngine('/srv/media', {
    webhookToken: TOKEN,
    adminApi: admin,
    managedLifecycle: { uploaderId: UPLOADER_ID },
    abr: options.abr ? { vhost: 'abr', ladder: AbrLadder.parse('360p:640:360:700') } : undefined,
    apiUrl: 'http://srs.test:1985',
    fetcher: async (input, init) => {
      calls.deletes.push(`${init?.method} ${String(input)}`);
      return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const app = express();
  app.use(express.json());
  app.use(engine.prefix, engine.createRouter(orchestrator));
  const { server, baseUrl } = await listenOnLoopback(app);
  try {
    const post = async (body: Record<string, unknown>): Promise<number> => {
      const response = await fetch(`${baseUrl}${engine.prefix}/streams?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<number>;
    };
    await drive(post, calls);
  } finally {
    server.close();
  }
}

function callback(clientId: string, action = 'on_publish'): Record<string, unknown> {
  return {
    action,
    app: 'video',
    stream: '11111111-1111-4111-8111-111111111111',
    vhost: '__defaultVhost__',
    param: '?key=secret',
    ip: '198.51.100.7',
    server_id: 'server-a',
    service_id: 'service-a',
    client_id: clientId,
  };
}

function rungCallback(action = 'on_publish'): Record<string, unknown> {
  return {
    ...callback('rung-client', action),
    stream: '11111111-1111-4111-8111-111111111111_360p',
    vhost: 'abr',
    ip: '127.0.0.1',
  };
}

describe('SRS managed lifecycle callbacks', () => {
  it('claims durably and provisions the callback as a provisional source', async () => {
    await withManagedSrs(() => true, async (post, calls) => {
      assert.equal(await post(callback('client-a')), 0);
      assert.equal(calls.legacyStarts.length, 0);
      assert.equal(calls.attempts[0].streamId, STREAM_ID);
      assert.equal(calls.requests[0].requestId, '33333333-3333-4333-8333-333333333333');
      assert.equal(calls.completed[0].claimId, CLAIM_ID);
      assert.deepEqual(calls.provisioned[0], {
        serverId: 'server-a',
        serviceId: 'service-a',
        clientId: 'client-a',
        generation: 1,
      });
    });
  });

  it('ignores the unpublish of a busy-refused provisional source', async () => {
    await withManagedSrs((identity) => identity.clientId === 'client-a', async (post, calls) => {
      assert.equal(await post(callback('client-a')), 0);
      assert.equal(await post(callback('client-b')), 1);
      assert.equal(await post(callback('client-b', 'on_unpublish')), 0);
      assert.deepEqual(calls.unpublished, []);
      assert.equal(calls.requests.length, 1);

      assert.equal(await post(callback('client-a', 'on_unpublish')), 0);
      assert.deepEqual(calls.unpublished.map((identity) => identity.clientId), ['client-a']);
    });
  });

  it('refuses managed callbacks that omit SRS connection identity', async () => {
    await withManagedSrs(() => true, async (post, calls) => {
      const body = callback('client-a');
      delete body.client_id;
      assert.equal(await post(body), 1);
      assert.equal(calls.provisioned.length, 0);
    });
  });

  it('deletes the attached SRS client selected by the cutoff', async () => {
    await withManagedSrs(() => true, async (_post, calls) => {
      calls.disconnect?.({ serverId: 'server-a', serviceId: 'service-a', clientId: 'client-a', generation: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls.deletes, ['DELETE http://srs.test:1985/api/v1/clients/client-a']);
    });
  });

  it('keeps managed ABR rungs alive when their source enters reconnect grace', async () => {
    await withManagedSrs(
      () => true,
      async (post, calls) => {
        assert.equal(await post(callback('client-a')), 0);
        assert.equal(await post(rungCallback()), 0);
        assert.deepEqual(calls.managedRenditions, [`${STREAM_ID}_360p`]);

        assert.equal(await post(callback('client-a', 'on_unpublish')), 0);
        assert.equal(await post(rungCallback('on_unpublish')), 0);
        assert.deepEqual(calls.stops, []);
      },
      { abr: true },
    );
  });
});
