import express from 'express';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createSrsEngine } from '../src/engines/srs.js';
import { AbrLadder } from '../src/libs/AbrLadder.js';
import {
  AdminApiClient,
  LegacyAdoptionOperation,
  ManagedClaimRequest,
} from '../src/libs/AdminApiClient.js';
import {
  LegacyAdoptionPendingError,
  LegacyRecordingAdopter,
} from '../src/libs/LegacyRecordingAdopter.js';
import { ManagedCheckpointStore } from '../src/libs/ManagedCheckpointStore.js';
import { ManagedMasterStore } from '../src/libs/ManagedMasterStore.js';
import { ManagedMediaStore } from '../src/libs/ManagedMediaStore.js';
import { ManagedClaimAttempt, ManagedClaimCompletion, ManagedRunStore } from '../src/libs/ManagedRunStore.js';
import { buildMasterPlaylist } from '../src/libs/MasterPlaylist.js';
import { MediaFormatFingerprint } from '../src/libs/MediaFormatProbe.js';
import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { SourceConnectionIdentity } from '../src/types.js';
import { rungTopicFor } from '../src/utils/rungTopic.js';

import { FakeClock } from './helpers/fakeClock.js';
import { makeTestOrchestrator } from './helpers/fakes.js';
import { listenOnLoopback } from './helpers/loopbackServer.js';
import { FRAME_TICKS, videoSegment } from './helpers/transportStream.js';

const TOKEN = 'srs-webhook-token-0123456789abcdef';
const STREAM_ID = 'video/11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const UPLOADER_ID = 'srs-157-90-34-105';
const CLAIM_ID = '44444444-4444-4444-8444-444444444444';
const ADOPTION_TOPIC = 'a'.repeat(64);
const ADOPTION_RUNG_TOPIC = rungTopicFor(ADOPTION_TOPIC, '360p');
const ADOPTION_SEGMENT = 'b'.repeat(64);
const ADOPTION_FORMAT: MediaFormatFingerprint = {
  version: 1,
  container: 'mpegts',
  tracks: [{
    kind: 'video',
    codec: 'h264',
    profile: 'High',
    level: 40,
    width: 640,
    height: 360,
    pixelFormat: 'yuv420p',
    chromaLocation: 'left',
    bitsPerRawSample: 8,
  }],
};

function adoptionOperation(): LegacyAdoptionOperation {
  return {
    lifecycleVersion: 1,
    kind: 'legacy-adoption',
    operationId: '55555555-5555-4555-8555-555555555555',
    requestId: '66666666-6666-4666-8666-666666666666',
    streamId: ADMIN_ID,
    topic: ADOPTION_TOPIC,
    mediaType: 'video',
    uploaderId: UPLOADER_ID,
    candidateDigest: 'c'.repeat(64),
    revision: 9,
    status: 'pending',
    candidate: {
      streamId: ADMIN_ID,
      topic: ADOPTION_TOPIC,
      mediaType: 'video',
      master: { topic: ADOPTION_TOPIC, index: 12, duration: 2 },
      renditions: [{
        name: '360p',
        topic: ADOPTION_RUNG_TOPIC,
        width: 640,
        height: 360,
        bandwidth: 700_000,
        avgBandwidth: 700_000,
        index: 4,
        duration: 2,
      }],
    },
  };
}

interface Calls {
  attempts: ManagedClaimAttempt[];
  requests: ManagedClaimRequest[];
  completed: ManagedClaimCompletion[];
  provisioned: SourceConnectionIdentity[];
  unpublished: SourceConnectionIdentity[];
  managedRenditions: string[];
  managedRenditionSegments: Array<{ streamId: string; sourceClientId: string; segmentIndex: number }>;
  managedSourceSegments: Array<{ streamId: string; sourceClientId: string; segmentIndex: number }>;
  failedManagedSources: SourceConnectionIdentity[];
  legacySegments: Array<{ streamId: string; segmentIndex: number }>;
  legacyStarts: string[];
  stops: string[];
  disconnect?: (identity: SourceConnectionIdentity) => void;
  deletes: string[];
}

async function withManagedSrs(
  provision: (identity: SourceConnectionIdentity) => boolean,
  drive: (
    post: (body: Record<string, unknown>, route?: 'streams' | 'hls') => Promise<number>,
    calls: Calls,
  ) => Promise<void>,
  options: {
    abr?: boolean;
    mediaRoot?: string;
    mode?: 'legacy' | 'managed';
    managedSegmentAccepted?: boolean;
  } = {},
): Promise<void> {
  const calls: Calls = {
    attempts: [],
    requests: [],
    completed: [],
    provisioned: [],
    unpublished: [],
    managedRenditions: [],
    managedRenditionSegments: [],
    managedSourceSegments: [],
    failedManagedSources: [],
    legacySegments: [],
    legacyStarts: [],
    stops: [],
    deletes: [],
  };
  const admin = {
    describe: () => 'http://admin.test',
    lookupByIngestId: async () => {
      const draft = {
        id: ADMIN_ID,
        topic: 'a'.repeat(64),
        owner: '0xowner',
        mediaType: 'video',
        title: 'managed',
        status: 'published',
        publishKey: 'secret',
        lifecycleVersion: 1 as const,
      };
      return options.mode === 'legacy'
        ? { ...draft, mode: 'legacy' as const }
        : {
            ...draft,
            mode: 'managed' as const,
            expectedRenditions: [],
            lifecycle: {
              revision: 7,
              runNumber: 2,
              state: 'ready' as const,
              permission: 'open' as const,
              uploaderId: UPLOADER_ID,
            },
          };
    },
    claimManagedRun: async (_id: string, _run: number, request: ManagedClaimRequest) => {
      calls.requests.push(request);
      return {
        lifecycleVersion: 1 as const,
        streamId: ADMIN_ID,
        revision: 8,
        runNumber: 2,
        uploaderId: UPLOADER_ID,
        claimId: CLAIM_ID,
        expectedRenditions: [],
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
    recoverManagedSourceConnection: () => null,
    startStream: (streamId: string) => {
      calls.legacyStarts.push(streamId);
      return true;
    },
    captureLegacyAdmissionGeneration: () => 0,
    isLegacyAdmissionGenerationCurrent: () => true,
    captureLegacyStreamAdmissionGeneration: () => 0,
    isLegacyStreamAdmissionGenerationCurrent: () => true,
    provisionManagedRendition: (streamId: string) => {
      calls.managedRenditions.push(streamId);
      return true;
    },
    bindManagedRenditionConnection: () => true,
    recoverManagedRenditionConnection: () => null,
    handleManagedRenditionSegment: (
      streamId: string,
      _baseStreamId: string,
      source: SourceConnectionIdentity,
      segmentIndex: number,
    ) => {
      calls.managedRenditionSegments.push({ streamId, sourceClientId: source.clientId, segmentIndex });
      return { accepted: true };
    },
    handleManagedSegment: (
      streamId: string,
      source: SourceConnectionIdentity,
      segmentIndex: number,
    ) => {
      calls.managedSourceSegments.push({ streamId, sourceClientId: source.clientId, segmentIndex });
      return options.managedSegmentAccepted === false
        ? { accepted: false, reason: 'durability_failed' }
        : { accepted: true };
    },
    failManagedSource: (_streamId: string, source: SourceConnectionIdentity) => {
      calls.failedManagedSources.push(source);
      return true;
    },
    handleSegment: (streamId: string, segmentIndex: number) => {
      calls.legacySegments.push({ streamId, segmentIndex });
      return { accepted: true };
    },
    handleSegmentLoss: () => true,
    stopStream: async (streamId: string) => {
      calls.stops.push(streamId);
    },
    recordAuthRejection: () => undefined,
    registerManagedSourceDisconnector: (disconnect: (identity: SourceConnectionIdentity) => void) => {
      calls.disconnect = disconnect;
    },
  } as unknown as StreamOrchestrator;
  const engine = createSrsEngine(options.mediaRoot ?? '/srv/media', {
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
    const post = async (body: Record<string, unknown>, route: 'streams' | 'hls' = 'streams'): Promise<number> => {
      const response = await fetch(`${baseUrl}${engine.prefix}/${route}?token=${TOKEN}`, {
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

function rungCallback(action = 'on_publish', clientId = 'rung-client', rung = '360p'): Record<string, unknown> {
  return {
    ...callback(clientId, action),
    stream: `11111111-1111-4111-8111-111111111111_${rung}`,
    vhost: 'abr',
    ip: '127.0.0.1',
  };
}

async function openManagedSrsRouter(
  orchestrator: StreamOrchestrator,
  adminApi: AdminApiClient,
  ladder: AbrLadder,
): Promise<{
  post: (body: Record<string, unknown>) => Promise<number>;
  close: () => void;
}> {
  const engine = createSrsEngine('/srv/media', {
    webhookToken: TOKEN,
    adminApi,
    managedLifecycle: { uploaderId: UPLOADER_ID },
    abr: { vhost: 'abr', ladder },
    apiUrl: 'http://srs.test:1985',
  });
  const app = express();
  app.use(express.json());
  app.use(engine.prefix, engine.createRouter(orchestrator));
  const { server, baseUrl } = await listenOnLoopback(app);
  return {
    post: async (body) => {
      const response = await fetch(`${baseUrl}${engine.prefix}/streams?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<number>;
    },
    close: () => server.close(),
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

  it('rejects a managed callback whose durable acceptance failed and retains its file', async () => {
    const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-managed-durability-'));
    fs.mkdirSync(path.join(mediaRoot, 'video'), { recursive: true });
    const segmentPath = path.join(mediaRoot, 'video', 'segment.ts');
    fs.writeFileSync(segmentPath, 'managed-segment');

    try {
      await withManagedSrs(
        () => true,
        async (post, calls) => {
          assert.equal(await post(callback('source-a')), 0);
          assert.equal(
            await post(
              {
                ...callback('source-a', 'on_hls'),
                file: './objs/nginx/html/video/segment.ts',
                seq_no: 5,
                duration: 4,
              },
              'hls',
            ),
            1,
          );
          assert.equal(fs.existsSync(segmentPath), true);
          assert.deepEqual(calls.failedManagedSources.map((source) => source.clientId), ['source-a']);
        },
        { mediaRoot, managedSegmentAccepted: false },
      );
    } finally {
      fs.rmSync(mediaRoot, { recursive: true, force: true });
    }
  });

  it('rebinds only the persisted acquired source after a fresh router starts without on_publish', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-managed-router-recovery-'));
    const mediaRoot = path.join(root, 'media');
    fs.mkdirSync(path.join(mediaRoot, 'video'), { recursive: true });
    const runStore = new ManagedRunStore(path.join(root, 'runs'));
    const checkpointStore = new ManagedCheckpointStore(path.join(root, 'checkpoints'));
    const mediaStore = new ManagedMediaStore(path.join(root, 'managed-media'));
    const ladder = AbrLadder.parse('360p:640:360:700 720p:1280:720:2800');
    const wallStart = 1_000_000;
    const firstClock = new FakeClock();
    let reference = 0;
    const uploads = {
      uploadData: async () => ({ reference: { toHex: () => String(++reference).padStart(64, '0') } }),
    };
    const source: SourceConnectionIdentity = {
      serverId: 'server-a',
      serviceId: 'service-a',
      clientId: 'source-a',
      generation: 1,
    };
    const first = makeTestOrchestrator(
      {
        clock: firstClock,
        wallClock: () => wallStart + firstClock.now(),
        managedSourceReconnectMs: 60_000,
        managedRunStore: runStore,
        managedMediaStore: mediaStore,
        managedCheckpointStore: checkpointStore,
        ladder,
      },
      uploads,
      new RecoveryStore(path.join(root, 'recovery')),
    );
    assert.equal(
      first.prepareManagedRun({
        lifecycleVersion: 1,
        streamId: STREAM_ID,
        adminStreamId: ADMIN_ID,
        topic: 'a'.repeat(64),
        mediaType: 'video',
        revision: 8,
        runNumber: 2,
        uploaderId: UPLOADER_ID,
        claimId: CLAIM_ID,
        eventSequence: 1,
        expectedRenditions: [
          {
            name: '360p',
            topic: rungTopicFor('a'.repeat(64), '360p'),
            width: 640,
            height: 360,
            bandwidth: 700_000,
            avgBandwidth: 700_000,
          },
          {
            name: '720p',
            topic: rungTopicFor('a'.repeat(64), '720p'),
            width: 1280,
            height: 720,
            bandwidth: 2_800_000,
            avgBandwidth: 2_800_000,
          },
        ],
      }),
      true,
    );
    assert.equal(
      first.provisionManagedSource(
        STREAM_ID,
        'video',
        source,
        { address: '198.51.100.7', isAuthenticated: true },
        { id: ADMIN_ID, topic: 'a'.repeat(64) },
      ),
      true,
    );
    assert.deepEqual(first.handleManagedSourceProgress(STREAM_ID, source, 0.1, videoSegment(4, 0)), {
      accepted: true,
    });
    assert.equal(
      first.provisionManagedRendition(
        `${STREAM_ID}_360p`,
        STREAM_ID,
        source,
        'video',
        { address: '127.0.0.1', isAuthenticated: true },
        { id: ADMIN_ID, topic: 'a'.repeat(64) },
      ),
      true,
    );
    assert.equal(
      first.bindManagedRenditionConnection(`${STREAM_ID}_360p`, STREAM_ID, source, {
        serverId: 'server-a',
        serviceId: 'service-a',
        clientId: 'rung-a',
      }),
      true,
    );
    assert.equal(
      first.provisionManagedRendition(
        `${STREAM_ID}_720p`,
        STREAM_ID,
        source,
        'video',
        { address: '127.0.0.1', isAuthenticated: true },
        { id: ADMIN_ID, topic: 'a'.repeat(64) },
      ),
      true,
    );
    assert.equal(
      first.bindManagedRenditionConnection(`${STREAM_ID}_720p`, STREAM_ID, source, {
        serverId: 'server-a',
        serviceId: 'service-a',
        clientId: 'rung-720-a',
      }),
      true,
    );
    assert.deepEqual(
      first.handleManagedRenditionSegment(
        `${STREAM_ID}_360p`,
        STREAM_ID,
        source,
        0,
        0.1,
        videoSegment(4, 0),
      ),
      { accepted: true },
    );
    const firstRungUploader = (
      first as unknown as { activeStreams: Map<string, { segmentQueue: { onIdle(): Promise<void> } }> }
    ).activeStreams.get(`${STREAM_ID}_360p`);
    assert.ok(firstRungUploader);
    await firstRungUploader.segmentQueue.onIdle();

    const secondClock = new FakeClock();
    const second = makeTestOrchestrator(
      {
        clock: secondClock,
        wallClock: () => wallStart + 1_000 + secondClock.now(),
        managedSourceReconnectMs: 60_000,
        managedRunStore: new ManagedRunStore(path.join(root, 'runs')),
        managedMediaStore: new ManagedMediaStore(path.join(root, 'managed-media')),
        managedCheckpointStore: new ManagedCheckpointStore(path.join(root, 'checkpoints')),
        ladder,
      },
      uploads,
      new RecoveryStore(path.join(root, 'recovery')),
    );
    second.restoreManagedRuns();
    assert.deepEqual(second.recoverManagedMedia(), [`${STREAM_ID}_360p`, `${STREAM_ID}_720p`]);
    assert.deepEqual(await second.recoverStreams(), [`${STREAM_ID}_360p`]);
    const engine = createSrsEngine(mediaRoot, {
      webhookToken: TOKEN,
      adminApi: { describe: () => 'http://admin.test' } as AdminApiClient,
      managedLifecycle: { uploaderId: UPLOADER_ID },
      abr: { vhost: 'abr', ladder },
      apiUrl: 'http://srs.test:1985',
      fetcher: async () =>
        new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const app = express();
    app.use(express.json());
    app.use(engine.prefix, engine.createRouter(second));
    const { server, baseUrl } = await listenOnLoopback(app);
    const postHls = async (clientId: string, file: string, sequence: number): Promise<number> => {
      const response = await fetch(`${baseUrl}${engine.prefix}/hls?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...callback(clientId, 'on_hls'),
          file: `./objs/nginx/html/video/${file}`,
          seq_no: sequence,
          duration: 0.1,
        }),
      });
      return response.json() as Promise<number>;
    };

    try {
      const forgedPath = path.join(mediaRoot, 'video', 'forged.ts');
      fs.writeFileSync(forgedPath, videoSegment(4, 4 * FRAME_TICKS));
      assert.equal(await postHls('source-forged', 'forged.ts', 1), 0);
      assert.equal(fs.existsSync(forgedPath), true);

      const resumedPath = path.join(mediaRoot, 'video', 'resumed.ts');
      fs.writeFileSync(resumedPath, videoSegment(4, 4 * FRAME_TICKS));
      assert.equal(await postHls('source-a', 'resumed.ts', 1), 0);
      assert.equal(fs.existsSync(resumedPath), false);

      const forgedRungPath = path.join(mediaRoot, 'video', 'forged-rung.ts');
      fs.writeFileSync(forgedRungPath, videoSegment(4, 4 * FRAME_TICKS));
      const forgedRungResponse = await fetch(`${baseUrl}${engine.prefix}/hls?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...rungCallback('on_hls', 'rung-forged'),
          file: './objs/nginx/html/video/forged-rung.ts',
          seq_no: 1,
          duration: 0.1,
        }),
      });
      assert.equal(await forgedRungResponse.json(), 0);
      assert.equal(fs.existsSync(forgedRungPath), true);

      const resumedRungPath = path.join(mediaRoot, 'video', 'resumed-rung.ts');
      fs.writeFileSync(resumedRungPath, videoSegment(4, 4 * FRAME_TICKS));
      const response = await fetch(`${baseUrl}${engine.prefix}/hls?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...rungCallback('on_hls', 'rung-a'),
          file: './objs/nginx/html/video/resumed-rung.ts',
          seq_no: 1,
          duration: 0.1,
        }),
      });
      assert.equal(await response.json(), 0);
      assert.equal(fs.existsSync(resumedRungPath), false);

      const first720pPath = path.join(mediaRoot, 'video', 'first-720p.ts');
      fs.writeFileSync(first720pPath, videoSegment(4, 4 * FRAME_TICKS));
      const first720pResponse = await fetch(`${baseUrl}${engine.prefix}/hls?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...rungCallback('on_hls', 'rung-720-a', '720p'),
          file: './objs/nginx/html/video/first-720p.ts',
          seq_no: 0,
          duration: 0.1,
        }),
      });
      assert.equal(await first720pResponse.json(), 0);
      assert.equal(fs.existsSync(first720pPath), false);

      await secondClock.advance(60_000);
      const expiredPath = path.join(mediaRoot, 'video', 'expired.ts');
      fs.writeFileSync(expiredPath, videoSegment(4, 8 * FRAME_TICKS));
      assert.equal(await postHls('source-a', 'expired.ts', 2), 0);
      assert.equal(fs.existsSync(expiredPath), true);
    } finally {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it('does not relabel a delayed old-rung segment as the reconnected source', async () => {
    const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-managed-rung-'));
    fs.mkdirSync(path.join(mediaRoot, 'video'), { recursive: true });
    const oldPath = path.join(mediaRoot, 'video', 'old.ts');
    const currentPath = path.join(mediaRoot, 'video', 'current.ts');
    fs.writeFileSync(oldPath, 'old-rung');
    fs.writeFileSync(currentPath, 'current-rung');

    try {
      await withManagedSrs(
        () => true,
        async (post, calls) => {
          assert.equal(await post(callback('source-a')), 0);
          assert.equal(await post(rungCallback('on_publish', 'rung-a')), 0);
          assert.equal(await post(callback('source-a', 'on_unpublish')), 0);
          assert.equal(await post(callback('source-b')), 0);
          assert.equal(await post(rungCallback('on_publish', 'rung-b')), 0);

          assert.equal(
            await post(
              {
                ...rungCallback('on_hls', 'rung-a'),
                file: './objs/nginx/html/video/old.ts',
                seq_no: 7,
                duration: 4,
              },
              'hls',
            ),
            0,
          );
          assert.deepEqual(calls.managedRenditionSegments, []);
          assert.equal(await post(rungCallback('on_unpublish', 'rung-a')), 0);

          assert.equal(
            await post(
              {
                ...rungCallback('on_hls', 'rung-b'),
                file: './objs/nginx/html/video/current.ts',
                seq_no: 8,
                duration: 4,
              },
              'hls',
            ),
            0,
          );
          assert.deepEqual(calls.managedRenditionSegments, [
            { streamId: `${STREAM_ID}_360p`, sourceClientId: 'source-b', segmentIndex: 8 },
          ]);
        },
        { abr: true, mediaRoot },
      );
    } finally {
      fs.rmSync(mediaRoot, { recursive: true, force: true });
    }
  });

  it('invalidates an authenticated legacy source when adoption completes before its first rung', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-adoption-source-race-'));
    const ladder = AbrLadder.parse('360p:640:360:700');
    const operation = adoptionOperation();
    const owner = '0'.repeat(40);
    let assigned: readonly LegacyAdoptionOperation[] = [operation];
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {signalRead = resolve;});
    const readReleased = new Promise<void>((resolve) => {releaseRead = resolve;});
    const adminApi = {
      describe: () => 'http://admin.test',
      lookupByIngestId: async () => ({
        id: ADMIN_ID,
        topic: ADOPTION_TOPIC,
        owner: '0xowner',
        mediaType: 'video' as const,
        title: 'legacy',
        status: 'published',
        publishKey: 'secret',
        lifecycleVersion: 1 as const,
        mode: 'legacy' as const,
      }),
      listManagedContinuations: async () => [],
      listLegacyAdoptions: async () => assigned,
      reportLegacyAdoptionPreparation: async () => undefined,
    } as unknown as AdminApiClient;
    const recoveryStore = new RecoveryStore(path.join(root, 'recovery'));
    const target = makeTestOrchestrator({
      adminApi,
      ladder,
      managedCheckpointStore: new ManagedCheckpointStore(path.join(root, 'checkpoints')),
      managedMasterStore: new ManagedMasterStore(path.join(root, 'masters')),
      legacyRecordingAdopter: new LegacyRecordingAdopter(
        {
          owner,
          readFeed: async (_topic, _index, rendition) => {
            signalRead();
            await readReleased;
            return rendition === null
              ? {
                  playlist: buildMasterPlaylist(owner, operation.candidate.renditions),
                  reference: 'd'.repeat(64),
                }
              : {
                  playlist: `#EXTM3U\n#EXTINF:2,\n${ADOPTION_SEGMENT}\n#EXT-X-ENDLIST\n`,
                  reference: 'e'.repeat(64),
                };
          },
          readSegment: async () => Buffer.from('mpeg-ts'),
        },
        { inspect: async () => ({ kind: 'valid', fingerprint: ADOPTION_FORMAT }) },
      ),
    }, {}, recoveryStore);
    const router = await openManagedSrsRouter(target, adminApi, ladder);

    try {
      assert.equal(await router.post(callback('legacy-source-a')), 0);
      const polling = target.pollManagedContinuations(UPLOADER_ID);
      await readStarted;
      releaseRead();
      await polling;
      assigned = [];
      await target.pollManagedContinuations(UPLOADER_ID);

      assert.equal(await router.post(rungCallback('on_publish', 'delayed-rung-a')), 1);
      assert.deepEqual(recoveryStore.listActive(), []);
    } finally {
      releaseRead();
      router.close();
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a legacy lookup resolved across adoption while allowing a fresh lookup after cancellation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-adoption-lookup-race-'));
    const ladder = AbrLadder.parse('360p:640:360:700');
    const operation = adoptionOperation();
    let assigned: readonly LegacyAdoptionOperation[] = [];
    let signalLookup!: () => void;
    let releaseLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {signalLookup = resolve;});
    const lookupReleased = new Promise<void>((resolve) => {releaseLookup = resolve;});
    let lookupCount = 0;
    const draft = {
      id: ADMIN_ID,
      topic: ADOPTION_TOPIC,
      owner: '0xowner',
      mediaType: 'video' as const,
      title: 'legacy',
      status: 'published',
      publishKey: 'secret',
      lifecycleVersion: 1 as const,
      mode: 'legacy' as const,
    };
    const adminApi = {
      describe: () => 'http://admin.test',
      lookupByIngestId: async () => {
        lookupCount += 1;
        if (lookupCount === 1) {
          signalLookup();
          await lookupReleased;
        }
        return draft;
      },
      listManagedContinuations: async () => [],
      listLegacyAdoptions: async () => assigned,
      reportLegacyAdoptionPreparation: async () => undefined,
    } as unknown as AdminApiClient;
    const target = makeTestOrchestrator({
      adminApi,
      ladder,
      managedCheckpointStore: new ManagedCheckpointStore(path.join(root, 'checkpoints')),
      managedMasterStore: new ManagedMasterStore(path.join(root, 'masters')),
      legacyRecordingAdopter: new LegacyRecordingAdopter(
        {
          owner: '0'.repeat(40),
          readFeed: async () => {
            throw new LegacyAdoptionPendingError('inspection deliberately held');
          },
          readSegment: async () => Buffer.from('mpeg-ts'),
        },
        { inspect: async () => ({ kind: 'valid', fingerprint: ADOPTION_FORMAT }) },
      ),
    });
    const router = await openManagedSrsRouter(target, adminApi, ladder);

    try {
      const stalePublish = router.post(callback('legacy-source-stale'));
      await lookupStarted;
      assigned = [operation];
      await target.pollManagedContinuations(UPLOADER_ID);
      assigned = [];
      await target.pollManagedContinuations(UPLOADER_ID);
      releaseLookup();

      assert.equal(await stalePublish, 1);
      assert.equal(await router.post(callback('legacy-source-fresh')), 0);
    } finally {
      releaseLookup();
      router.close();
      await target.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an explicitly negotiated legacy rung on its connection-bound path', async () => {
    const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-legacy-rung-'));
    fs.mkdirSync(path.join(mediaRoot, 'video'), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, 'video', 'legacy.ts'), 'legacy-rung');

    try {
      await withManagedSrs(
        () => true,
        async (post, calls) => {
          assert.equal(await post(callback('source-legacy')), 0);
          assert.equal(await post(rungCallback('on_publish', 'rung-legacy')), 0);
          assert.equal(
            await post(
              {
                ...rungCallback('on_hls', 'rung-legacy'),
                file: './objs/nginx/html/video/legacy.ts',
                seq_no: 9,
                duration: 4,
              },
              'hls',
            ),
            0,
          );
          assert.deepEqual(calls.legacySegments, [{ streamId: `${STREAM_ID}_360p`, segmentIndex: 9 }]);
          assert.deepEqual(calls.managedRenditionSegments, []);
        },
        { abr: true, mediaRoot, mode: 'legacy' },
      );
    } finally {
      fs.rmSync(mediaRoot, { recursive: true, force: true });
    }
  });
});
