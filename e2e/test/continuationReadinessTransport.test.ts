import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createFixturePlan,
  FIXTURE_LABEL,
  type FixturePlan,
  FixtureRefusal,
  MANAGED_LABEL,
} from '../src/continuation/fixture.js';
import {
  type BoundedHttpRequest,
  type BoundedHttpResponse,
  type CapabilityReadObservation,
  type ContainerReadinessObservation,
  type GuardedReleaseObservation,
  ObservedReadinessTransport,
  type ReadinessObservationSource,
} from '../src/continuation/readinessTransport.js';
import {
  type ContinuationTopology,
  createContinuationTopology,
  inspectContinuationReadiness,
  type ReadinessProbeId,
  type ReleaseGuardRole,
  type TopologyServiceRole,
} from '../src/continuation/topology.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const STACK_COMMIT = 'a'.repeat(40);
const ADMIN_COMMIT = 'b'.repeat(40);
const MANAGER_COMMIT = 'c'.repeat(40);
const IMAGE_ID = `sha256:${'d'.repeat(64)}`;
const BATCH_HASH = `sha256:${'e'.repeat(64)}`;
const STATE_DIGEST = 'f'.repeat(64);
const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const UPLOADER_ID = '22222222-2222-4222-8222-222222222222';
const encoder = new TextEncoder();

function fixturePlan(): FixturePlan {
  return createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: `/tmp/${FIXTURE_ID}`,
    candidates: [
      { role: 'stack', root: '/candidates/stack', commit: STACK_COMMIT },
      { role: 'admin', root: '/candidates/admin', commit: ADMIN_COMMIT },
      { role: 'manager', root: '/candidates/manager', commit: MANAGER_COMMIT },
    ],
    candidateImages: {
      postgres: IMAGE_ID,
      srs: IMAGE_ID,
      uploader: IMAGE_ID,
      adminApi: IMAGE_ID,
      adminWeb: IMAGE_ID,
      viewer: IMAGE_ID,
      mediaSender: IMAGE_ID,
      browser: IMAGE_ID,
    },
    loopbackPorts: { rpc: 18_545, admin: 18_080, viewer: 18_081 },
    minimumStorageBytes: 1_000_000,
    minimumStorageTtlSeconds: 900,
    expectedChainId: 1337,
  });
}

function json(body: unknown, status = 200): BoundedHttpResponse {
  return { status, body: encoder.encode(JSON.stringify(body)) };
}

function guard(
  role: 'admin' | 'uploader' | 'viewer',
  serviceImages: Array<{ service: string; imageId: string }>,
): GuardedReleaseObservation {
  const candidateRole = role === 'admin' ? 'admin' : 'stack';
  const candidateCommit = role === 'admin' ? ADMIN_COMMIT : STACK_COMMIT;
  const treeDigest = role === 'admin' ? '1'.repeat(64) : '2'.repeat(64);
  return {
    slot: { role, id: role === 'uploader' ? UPLOADER_ID : 'default' },
    installationId: INSTALLATION_ID,
    generation: 1,
    stateDigest: STATE_DIGEST,
    artifact: { treeDigest, images: serviceImages },
    candidate: {
      role: candidateRole,
      commit: candidateCommit,
      root: `/candidates/${candidateRole}`,
      treeDigest,
    },
  };
}

class FakeObservationSource implements ReadinessObservationSource {
  readonly requests: BoundedHttpRequest[] = [];
  readonly controlRequests: ReadinessProbeId[] = [];
  readonly containers = new Map<TopologyServiceRole, ContainerReadinessObservation>();
  readonly guards = new Map<ReleaseGuardRole, GuardedReleaseObservation>();
  capability: CapabilityReadObservation = {
    uploaderId: UPLOADER_ID,
    lifecycleVersion: 1,
    profileDigests: [{ mediaType: 'video', digest: '3'.repeat(64) }],
    receivedAt: '2026-09-21T00:00:00.000Z',
    freshUntil: '2026-09-21T00:00:30.000Z',
    serverNow: '2026-09-21T00:00:10.000Z',
  };
  readonly controls = new Map<ReadinessProbeId, Uint8Array>([
    [
      'storage',
      encoder.encode(
        JSON.stringify({
          source: 'bee-upload-read-control',
          batchIdHash: BATCH_HASH,
          usable: true,
          capacityBytes: 2_000_000,
          ttlSeconds: 1_800,
          uploadStatus: 201,
          readStatus: 200,
          bytesMatch: true,
        }),
      ),
    ],
    [
      'callbacks',
      encoder.encode(
        JSON.stringify({
          source: 'srs-callback-control',
          callbacksBefore: 4,
          callbacksAfter: 5,
        }),
      ),
    ],
    [
      'openingFormat',
      encoder.encode(
        JSON.stringify({
          source: 'ffprobe',
          exitCode: 0,
          formatName: 'mpegts',
        }),
      ),
    ],
    [
      'browserDecode',
      encoder.encode(
        JSON.stringify({
          source: 'browser-media-control',
          playEvent: true,
          decodedFramesBefore: 1,
          decodedFramesAfter: 9,
          currentTimeBefore: 0,
          currentTimeAfter: 2.5,
          codecs: ['avc1', 'mp4a'],
        }),
      ),
    ],
    [
      'falseCodec',
      encoder.encode(
        JSON.stringify({
          source: 'browser-false-codec-control',
          attemptedCodec: 'video/not-real',
          supported: false,
          loadedMetadata: false,
        }),
      ),
    ],
  ]);

  constructor(
    readonly plan: FixturePlan,
    readonly topology: ContinuationTopology,
  ) {
    this.controls.set(
      'capacity',
      encoder.encode(
        JSON.stringify({
          source: 'fixture-capacity-control',
          availableDiskBytes: 4_000_000_000,
          requiredDiskBytes: 1_000_000_000,
          timeoutsWithinBounds: true,
          services: topology.services.map(({ role, container }) => ({
            role,
            memoryCurrentBytes: 100_000_000,
            memoryLimitBytes: container.limits.memoryBytes,
            pidsCurrent: 20,
            pidsLimit: container.limits.pidsLimit,
            cpuLimit: container.limits.cpus,
            cpuThrottledDelta: 0,
          })),
        }),
      ),
    );
    const labels = { [FIXTURE_LABEL]: FIXTURE_ID, [MANAGED_LABEL]: 'true' };
    for (const role of ['blockchain', 'bee-queen', 'srs', 'uploader', 'admin-api', 'viewer'] as const) {
      const service = topology.services.find((entry) => entry.role === role);
      assert.ok(service);
      this.containers.set(role, {
        role,
        name: service.container.name,
        expectedName: service.container.name,
        configuredImage: service.container.image,
        imageId: IMAGE_ID,
        state: 'running',
        health: 'healthy',
        labels,
      });
    }
    this.guards.set(
      'admin',
      guard('admin', [
        { service: 'admin-api', imageId: IMAGE_ID },
        { service: 'admin-web', imageId: `sha256:${'a'.repeat(64)}` },
      ]),
    );
    this.guards.set(
      'uploader',
      guard('uploader', [
        { service: 'srs', imageId: IMAGE_ID },
        { service: 'stream-uploader', imageId: IMAGE_ID },
      ]),
    );
    this.guards.set('viewer', guard('viewer', [{ service: 'client', imageId: IMAGE_ID }]));
    const admin = this.containers.get('admin-api');
    assert.ok(admin);
    admin.activeArtifact = {
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      generation: 1,
      slot: { role: 'admin', id: 'default' },
      artifact: structuredClone(this.guards.get('admin')!.artifact),
    };
  }

  async request(request: BoundedHttpRequest): Promise<BoundedHttpResponse> {
    this.requests.push(structuredClone(request));
    const method = request.body === undefined
      ? null
      : (JSON.parse(new TextDecoder().decode(request.body)) as { method?: string }).method;
    if (method === 'eth_chainId') {return json({ jsonrpc: '2.0', id: 1, result: '0x539' });}
    if (method === 'web3_clientVersion') {return json({ jsonrpc: '2.0', id: 1, result: 'anvil/v1.4.0' });}
    if (request.url.endsWith('/health') && request.url.includes('bee-queen')) {
      return json({ status: 'ok', version: '2.8.2', apiVersion: '7.3.0' });
    }
    if (request.url.endsWith('/api/v1/versions')) {
      return json({ code: 0, data: { version: '6.0.170' } });
    }
    if (request.url.endsWith('/health')) {return json({ status: 'ok', reasons: [] });}
    if (request.url.endsWith('/api/health')) {return json({ status: 'ok' });}
    if (request.url.endsWith('/build-stamp.json')) {
      return json({ head: STACK_COMMIT, dirty: false, clientTree: 'tree', sharedTree: 'shared' });
    }
    throw new Error(`unexpected test request ${request.url}`);
  }

  async inspectContainer(role: TopologyServiceRole): Promise<ContainerReadinessObservation> {
    const observation = this.containers.get(role);
    if (!observation) {throw new Error(`missing test container ${role}`);}
    return structuredClone(observation);
  }

  async inspectGuard(role: ReleaseGuardRole): Promise<GuardedReleaseObservation> {
    const observation = this.guards.get(role);
    if (!observation) {throw new Error(`missing test guard ${role}`);}
    return structuredClone(observation);
  }

  async readUploaderCapability(_uploaderId: string): Promise<CapabilityReadObservation> {
    return structuredClone(this.capability);
  }

  async runControl(probeId: ReadinessProbeId): Promise<Uint8Array> {
    this.controlRequests.push(probeId);
    const observation = this.controls.get(probeId);
    if (!observation) {throw new Error(`missing test control ${probeId}`);}
    return observation.slice();
  }
}

describe('observed continuation readiness transport', () => {
  it('normalizes bounded service, guard, capability and control observations', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const source = new FakeObservationSource(plan, topology);
    const transport = new ObservedReadinessTransport(plan, topology, source);

    const evidence = await inspectContinuationReadiness(plan, topology, transport);

    assert.deepEqual(evidence, {
      chainId: 1337,
      chainOwner: FIXTURE_ID,
      components: { blockchain: true, bee: true, srs: true, uploader: true, admin: true, viewer: true },
      storage: {
        stamp: { batchIdHash: BATCH_HASH, usable: true, capacityBytes: 2_000_000, ttlSeconds: 1_800 },
        controlRoundTrip: true,
      },
      callbacksReachUploader: true,
      openingFormatVerified: true,
      browserDecodedMedia: true,
      falseCodecControlRefused: true,
      capacityAvailable: true,
    });
    assert.deepEqual(source.controlRequests, [
      'storage',
      'callbacks',
      'openingFormat',
      'browserDecode',
      'falseCodec',
      'capacity',
    ]);
    assert.ok(source.requests.every((request) => request.maxResponseBytes <= 64 * 1024));
    const rpcMethods = source.requests
      .filter((request) => request.body !== undefined)
      .map((request) => (JSON.parse(new TextDecoder().decode(request.body)) as { method: string }).method);
    assert.deepEqual(rpcMethods, ['eth_chainId', 'web3_clientVersion']);
  });

  it('refuses a response beyond its byte bound without exposing its body', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const source = new FakeObservationSource(plan, topology);
    const original = source.request.bind(source);
    source.request = async (request) =>
      request.url.includes('bee-queen')
        ? { status: 200, body: encoder.encode('SENTINEL'.repeat(10_000)) }
        : original(request);

    await assert.rejects(
      inspectContinuationReadiness(
        plan,
        topology,
        new ObservedReadinessTransport(plan, topology, source),
      ),
      (error: unknown) => {
        assert.ok(error instanceof FixtureRefusal);
        assert.match(error.message, /bee.*bound/i);
        assert.doesNotMatch(error.message, /SENTINEL/);
        return true;
      },
    );
  });

  it('refuses a running image that is absent from its persisted guard artifact', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const source = new FakeObservationSource(plan, topology);
    source.containers.get('uploader')!.imageId = `sha256:${'9'.repeat(64)}`;

    await assert.rejects(
      inspectContinuationReadiness(
        plan,
        topology,
        new ObservedReadinessTransport(plan, topology, source),
      ),
      /uploader.*image/i,
    );
  });

  it('refuses admin health when the mounted active artifact differs from the receipt', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const source = new FakeObservationSource(plan, topology);
    source.containers.get('admin-api')!.activeArtifact!.generation = 2;

    await assert.rejects(
      inspectContinuationReadiness(
        plan,
        topology,
        new ObservedReadinessTransport(plan, topology, source),
      ),
      /admin.*active artifact/i,
    );
  });

  it('refuses an uploader capability after the admin server freshness window', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const source = new FakeObservationSource(plan, topology);
    source.capability = { ...source.capability, serverNow: source.capability.freshUntil };

    await assert.rejects(
      inspectContinuationReadiness(
        plan,
        topology,
        new ObservedReadinessTransport(plan, topology, source),
      ),
      /capability.*fresh/i,
    );
  });

  it('does not retain a fresh capability across a later inspection', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const source = new FakeObservationSource(plan, topology);
    const transport = new ObservedReadinessTransport(plan, topology, source);

    await inspectContinuationReadiness(plan, topology, transport);
    source.capability = { ...source.capability, serverNow: source.capability.freshUntil };

    await assert.rejects(
      inspectContinuationReadiness(plan, topology, transport),
      /capability.*fresh/i,
    );
  });

  it('refuses capacity evidence that omits a required Bee service', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const source = new FakeObservationSource(plan, topology);
    const encoded = source.controls.get('capacity');
    assert.ok(encoded);
    const capacity = JSON.parse(new TextDecoder().decode(encoded)) as {
      services: Array<{ role: string }>;
    };
    capacity.services = capacity.services.filter(({ role }) => role !== 'bee-worker-1');
    source.controls.set('capacity', encoder.encode(JSON.stringify(capacity)));

    await assert.rejects(
      inspectContinuationReadiness(plan, topology, new ObservedReadinessTransport(plan, topology, source)),
      /capacity.*service/i,
    );
  });
});
