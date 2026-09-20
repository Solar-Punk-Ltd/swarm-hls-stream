import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createFixturePlan,
  FIXTURE_LABEL,
  type FixturePlan,
  FixtureRefusal,
  type VolumePlan,
} from '../src/continuation/fixture.js';
import {
  createContinuationTopology,
  inspectContinuationReadiness,
  type ReadinessProbe,
  type ReadinessProbeTransport,
} from '../src/continuation/topology.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const COMMIT = 'a'.repeat(40);
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const BATCH_HASH = `sha256:${'c'.repeat(64)}`;

function correctedPlan(): FixturePlan {
  const plan = createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: `/tmp/${FIXTURE_ID}`,
    candidates: [
      { role: 'stack', root: '/candidates/stack', commit: COMMIT },
      { role: 'admin', root: '/candidates/admin', commit: COMMIT },
      { role: 'manager', root: '/candidates/manager', commit: COMMIT },
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
  const labels = { [FIXTURE_LABEL]: FIXTURE_ID, 'org.solarpunk.srs-continuation.managed': 'true' };
  const media: VolumePlan = {
    kind: 'volume',
    role: 'srs-media',
    name: `${FIXTURE_ID}-srs-media`,
    labels,
  };
  return {
    ...plan,
    resources: [...plan.resources, media],
    publishedPorts: plan.publishedPorts.map((port) =>
      port.role === 'admin' ? { ...port, containerPort: 9877 } : port,
    ),
    internalEndpoints: {
      ...plan.internalEndpoints,
      admin: `http://${FIXTURE_ID}-admin-api:9877`,
    },
  };
}

function service(plan: FixturePlan, role: string) {
  const topology = createContinuationTopology(plan);
  const found = topology.services.find((candidate) => candidate.role === role);
  assert.ok(found, `missing ${role}`);
  return found;
}

class FakeProbeTransport implements ReadinessProbeTransport {
  readonly requested: ReadinessProbe[] = [];

  constructor(private readonly answers: Readonly<Record<string, unknown>>) {}

  async probe(probe: ReadinessProbe): Promise<unknown> {
    this.requested.push(probe);
    return structuredClone(this.answers[probe.id]);
  }
}

function readyAnswers(): Record<string, unknown> {
  return {
    chain: { chainId: 1337, owner: FIXTURE_ID },
    blockchain: { ready: true, identity: 'anvil', version: '1.4.0' },
    bee: { ready: true, identity: 'bee', version: '2.8.2', warmingUp: false },
    srs: { ready: true, identity: 'srs', version: '6.0.170' },
    uploader: {
      ready: true,
      identity: 'stream-uploader',
      version: COMMIT,
      lifecycleVersion: 1,
      uploaderId: 'fixture-srs-uploader',
    },
    admin: {
      ready: true,
      identity: 'web2-admin',
      version: COMMIT,
      lifecycleVersion: 1,
      uploaderId: 'fixture-srs-uploader',
    },
    viewer: { ready: true, identity: 'viewer', version: COMMIT },
    storage: {
      batchIdHash: BATCH_HASH,
      usable: true,
      capacityBytes: 2_000_000,
      ttlSeconds: 1_800,
      controlRoundTrip: true,
    },
    callbacks: { reachedUploader: true },
    openingFormat: { verified: true, tool: 'ffprobe', container: 'mpegts' },
    browserDecode: { decodedMedia: true, codecs: ['avc1', 'mp4a'] },
    falseCodec: { refused: true },
    capacity: { available: true },
  };
}

describe('continuation fixture topology', () => {
  it('wires exact aliases, internal ports, mounts, and symbolic secret inputs', () => {
    const plan = correctedPlan();
    const topology = createContinuationTopology(plan);

    assert.equal(topology.network, plan.network.name);
    assert.equal(topology.services.length, 14);
    assert.equal(new Set(topology.services.map((entry) => entry.role)).size, topology.services.length);
    assert.deepEqual(
      topology.publishedPorts.map(({ role, host, containerPort }) => ({ role, host, containerPort })),
      [
        { role: 'blockchain', host: '127.0.0.1', containerPort: 8545 },
        { role: 'admin', host: '127.0.0.1', containerPort: 9877 },
        { role: 'viewer', host: '127.0.0.1', containerPort: 80 },
      ],
    );
    assert.deepEqual(service(plan, 'admin-api').aliases, ['admin-api', 'api']);
    assert.deepEqual(
      service(plan, 'srs').ports.map((port) => port.containerPort),
      [1935, 1985, 8080, 10080],
    );
    assert.deepEqual(
      service(plan, 'uploader').mounts.map((mount) => [mount.target, mount.source.kind, mount.source.role]),
      [
        ['/app/state', 'volume', 'uploader-data'],
        ['/media', 'volume', 'srs-media'],
      ],
    );
    assert.deepEqual(
      service(plan, 'srs').mounts.map((mount) => [mount.target, mount.source.kind, mount.source.role]),
      [
        ['/usr/local/srs/conf/entrypoint.sh', 'candidate', 'stack'],
        ['/usr/local/srs/conf/healthcheck.sh', 'candidate', 'stack'],
        ['/usr/local/srs/conf/srs.conf.template', 'candidate', 'stack'],
        ['/usr/local/srs/objs/nginx/html', 'volume', 'srs-media'],
      ],
    );
    assert.ok(
      service(plan, 'uploader').environment.some(
        (entry) => entry.name === 'ADMIN_API_TOKEN' && entry.value.kind === 'input',
      ),
    );
    const sensitiveNames = new Set([
      'ADMIN_API_TOKEN',
      'API_AUTH_TOKEN',
      'FEED_PRIVATE_KEY',
      'INGEST_SRT_PASSPHRASE',
      'POSTGRES_PASSWORD',
      'PUBLISH_KEY_SECRET',
      'SRS_WEBHOOK_TOKEN',
      'SRT_PASSPHRASE',
      'STREAM_KEY',
    ]);
    for (const entry of topology.services.flatMap((candidate) => candidate.environment)) {
      if (sensitiveNames.has(entry.name)) {
        assert.notEqual(entry.value.kind, 'literal');
      }
    }
  });

  it('uses the pinned Bee Factory entrypoint contract without hiding baked state', () => {
    const plan = correctedPlan();
    const queen = service(plan, 'bee-queen');
    const worker = service(plan, 'bee-worker-1');
    const blockchain = service(plan, 'blockchain');

    assert.deepEqual(blockchain.entrypointAssumption, ['/bin/sh', '-c']);
    assert.deepEqual(blockchain.command, [
      { kind: 'literal', value: 'anvil --host 0.0.0.0 --chain-id 1337 --accounts 20 --balance 10000 --block-time 1' },
    ]);
    assert.deepEqual(queen.entrypointAssumption, ['bee']);
    assert.equal(queen.entrypointAssumptionStatus, 'source-verified');
    assert.equal(queen.mounts.length, 0);
    assert.equal(worker.mounts.length, 0);
    assert.ok(queen.command.some((part) => part.kind === 'bootstrap' && part.output === 'chain.postageStampAddress'));
    assert.ok(worker.command.some((part) => part.kind === 'bootstrap' && part.output === 'bee.queenBootnode'));
    assert.deepEqual(
      createContinuationTopology(plan)
        .services.filter((entry) => entry.entrypointAssumptionStatus === 'runtime-unverified')
        .map((entry) => entry.role),
      ['postgres', 'media-sender'],
    );
  });

  it('orders chain restore, Bee bootstrapping, storage, and application startup', () => {
    const plan = correctedPlan();
    const topology = createContinuationTopology(plan);

    assert.deepEqual(
      topology.bootstrap.map((step) => [step.id, step.kind]),
      [
        ['start-blockchain', 'start-services'],
        ['load-chain-state', 'load-anvil-state'],
        ['start-queen', 'start-services'],
        ['discover-queen', 'discover-bee-bootnode'],
        ['start-workers', 'start-services'],
        ['form-peer-mesh', 'form-bee-peer-mesh'],
        ['advance-private-chain', 'advance-anvil-chain'],
        ['provision-postage', 'provision-postage'],
        ['activate-admin', 'activate-guarded-release'],
        ['activate-manager', 'activate-guarded-release'],
        ['activate-viewer', 'activate-guarded-release'],
        ['activate-uploader', 'activate-guarded-release'],
        ['submit-release-guard-receipts', 'submit-release-guard-receipts'],
        ['start-test-controls', 'start-services'],
      ],
    );
    const directStarts = topology.bootstrap
      .filter((step) => step.kind === 'start-services')
      .flatMap((step) => step.services);
    assert.deepEqual(directStarts, [
      'blockchain',
      'bee-queen',
      'bee-worker-1',
      'bee-worker-2',
      'bee-worker-3',
      'bee-worker-4',
      'browser',
    ]);
    assert.deepEqual(topology.guardedActivations, [
      {
        role: 'admin',
        slot: { role: 'admin', id: 'default' },
        candidateRole: 'admin',
        services: ['admin-api', 'admin-web'],
        serviceBindings: [
          { adapterService: 'postgres', topologyRole: 'postgres' },
          { adapterService: 'api', topologyRole: 'admin-api' },
          { adapterService: 'web', topologyRole: 'admin-web' },
        ],
        fixtureNetwork: { name: plan.network.name, fixtureId: FIXTURE_ID },
        startsEnrollmentDisabled: true,
      },
      {
        role: 'manager',
        slot: { role: 'manager', id: 'default' },
        candidateRole: 'manager',
        services: ['api', 'web'],
        serviceBindings: [],
      },
      {
        role: 'viewer',
        slot: { role: 'viewer', id: 'default' },
        candidateRole: 'stack',
        services: ['client'],
        serviceBindings: [{ adapterService: 'client', topologyRole: 'viewer' }],
        fixtureNetwork: { name: plan.network.name, fixtureId: FIXTURE_ID },
      },
      {
        role: 'uploader',
        slot: { role: 'uploader', id: 'fixture-srs-uploader' },
        candidateRole: 'stack',
        services: ['srs', 'stream-uploader'],
        serviceBindings: [
          { adapterService: 'srs', topologyRole: 'srs' },
          { adapterService: 'stream-uploader', topologyRole: 'uploader' },
        ],
        fixtureNetwork: { name: plan.network.name, fixtureId: FIXTURE_ID },
      },
    ]);
    assert.deepEqual(
      topology.bootstrap
        .filter((step) => step.kind === 'activate-guarded-release')
        .map((step) => [step.id, step.after]),
      [
        ['activate-admin', ['provision-postage']],
        ['activate-manager', ['activate-admin']],
        ['activate-viewer', ['activate-manager']],
        ['activate-uploader', ['activate-viewer']],
      ],
    );
    const receiptSubmission = topology.bootstrap.find((step) => step.kind === 'submit-release-guard-receipts');
    assert.equal(receiptSubmission?.source, 'guard-persisted-receipts');
    assert.equal(receiptSubmission?.mode, 'retry-and-verify');
    assert.equal(service(correctedPlan(), 'media-sender').startAfterReadiness, true);
  });

  it('refuses the stale admin port and missing shared media volume', () => {
    const stale = createFixturePlan({
      fixtureId: FIXTURE_ID,
      outputRoot: `/tmp/${FIXTURE_ID}`,
      candidates: [
        { role: 'stack', root: '/candidates/stack', commit: COMMIT },
        { role: 'admin', root: '/candidates/admin', commit: COMMIT },
        { role: 'manager', root: '/candidates/manager', commit: COMMIT },
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

    assert.throws(() => createContinuationTopology(stale), /admin.*9877/i);
    const fixedPort = {
      ...stale,
      internalEndpoints: { ...stale.internalEndpoints, admin: `http://${FIXTURE_ID}-admin-api:9877` },
      publishedPorts: stale.publishedPorts.map((port) =>
        port.role === 'admin' ? { ...port, containerPort: 9877 } : port,
      ),
    };
    assert.throws(() => createContinuationTopology(fixedPort), /srs-media/i);
  });
});

describe('continuation readiness inspection', () => {
  it('runs the bounded internal probe set and produces existing readiness evidence', async () => {
    const plan = correctedPlan();
    const topology = createContinuationTopology(plan);
    const transport = new FakeProbeTransport(readyAnswers());

    const evidence = await inspectContinuationReadiness(plan, topology, transport);

    assert.deepEqual(
      transport.requested.map((probe) => probe.id),
      [
        'chain',
        'blockchain',
        'bee',
        'srs',
        'uploader',
        'admin',
        'viewer',
        'storage',
        'callbacks',
        'openingFormat',
        'browserDecode',
        'falseCodec',
        'capacity',
      ],
    );
    assert.ok(transport.requested.every((probe) => probe.maxResponseBytes <= 64 * 1024));
    assert.ok(
      transport.requested.every((probe) => {
        const hostname = new URL(probe.url).hostname;
        return topology.services.some((entry) => entry.container.name === hostname || entry.aliases.includes(hostname));
      }),
    );
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
  });

  it('refuses malformed component identity without including the raw response', async () => {
    const plan = correctedPlan();
    const topology = createContinuationTopology(plan);
    const answers = readyAnswers();
    answers.uploader = { ready: true, identity: 'foreign', raw: 'SENTINEL-MUST-NOT-LEAK' };

    await assert.rejects(
      inspectContinuationReadiness(plan, topology, new FakeProbeTransport(answers)),
      (error: unknown) => {
        assert.ok(error instanceof FixtureRefusal);
        assert.match(error.message, /uploader.*identity/i);
        assert.doesNotMatch(error.message, /SENTINEL/);
        return true;
      },
    );
  });

  it('refuses an uploader that cannot prove lifecycle version and assignment', async () => {
    const plan = correctedPlan();
    const topology = createContinuationTopology(plan);
    const answers = readyAnswers();
    answers.uploader = {
      ready: true,
      identity: 'stream-uploader',
      version: COMMIT,
      lifecycleVersion: 1,
      uploaderId: 'other-uploader',
    };

    await assert.rejects(
      inspectContinuationReadiness(plan, topology, new FakeProbeTransport(answers)),
      /uploader.*assignment/i,
    );
  });

  it('refuses an external probe endpoint before transport is called', async () => {
    const plan = correctedPlan();
    const topology = createContinuationTopology(plan);
    const transport = new FakeProbeTransport(readyAnswers());
    const external = {
      ...topology,
      readiness: topology.readiness.map((probe) =>
        probe.id === 'bee' ? { ...probe, url: 'https://api.gateway.example/health' } : probe,
      ),
    };

    await assert.rejects(inspectContinuationReadiness(plan, external, transport), /outside.*fixture network/i);
    assert.deepEqual(transport.requested, []);
  });
});
