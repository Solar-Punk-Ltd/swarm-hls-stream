import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  type CandidateVerifier,
  cleanupFixture,
  createFixturePlan,
  FIXTURE_LABEL,
  type FixtureDocker,
  type FixtureHttp,
  type FixturePlan,
  type InspectedResource,
  MediaFixtureRunner,
  type PortProbe,
  type ReadinessEvidence,
  resolveCreationIntents,
  ResourceJournal,
  validateFixturePlan,
} from '../src/continuation/fixture.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const COMMIT = 'a'.repeat(40);
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;

function plan(root = mkdtempSync(join(tmpdir(), 'continuation-fixture-'))): FixturePlan {
  return createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: join(root, FIXTURE_ID),
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
}

class FakeCandidates implements CandidateVerifier {
  readonly dirty = new Set<string>();

  constructor(private readonly commits = new Map<string, string>()) {}

  async inspect(root: string): Promise<{ commit: string; clean: boolean }> {
    return {
      commit: this.commits.get(root) ?? COMMIT,
      clean: !this.dirty.has(root),
    };
  }
}

class FakePorts implements PortProbe {
  readonly occupied = new Set<number>();

  async isAvailable(port: number): Promise<boolean> {
    return !this.occupied.has(port);
  }
}

class FakeHttp implements FixtureHttp {
  evidence: ReadinessEvidence = {
    chainId: 1337,
    chainOwner: FIXTURE_ID,
    components: {
      blockchain: true,
      bee: true,
      srs: true,
      uploader: true,
      admin: true,
      viewer: true,
    },
    storage: {
      stamp: {
        batchIdHash: `sha256:${'d'.repeat(64)}`,
        usable: true,
        capacityBytes: 2_000_000,
        ttlSeconds: 1_800,
      },
      controlRoundTrip: true,
    },
    callbacksReachUploader: true,
    openingFormatVerified: true,
    browserDecodedMedia: true,
    falseCodecControlRefused: true,
    capacityAvailable: true,
  };

  async inspectReadiness(): Promise<ReadinessEvidence> {
    return structuredClone(this.evidence);
  }
}

class FakeDocker implements FixtureDocker {
  readonly resources = new Map<string, InspectedResource>();
  readonly created: string[] = [];
  readonly started: string[] = [];
  readonly removed: string[] = [];
  readonly loseCreateReplyFor = new Set<string>();
  containerImageId = IMAGE_ID;
  private nextId = 1;

  async findExact(_kind: InspectedResource['kind'], name: string): Promise<InspectedResource | null> {
    return [...this.resources.values()].find((resource) => resource.name === name) ?? null;
  }

  async create(
    kind: InspectedResource['kind'],
    name: string,
    labels: Readonly<Record<string, string>>,
    plan?: FixturePlan['resources'][number],
  ): Promise<InspectedResource> {
    const id = kind === 'volume' ? name : `${kind}-${this.nextId++}`;
    const resource = {
      kind,
      id,
      name,
      labels: { ...labels },
      ...(plan?.kind === 'network' ? { internal: plan.internal } : {}),
      ...(plan?.kind === 'container' ? { imageId: this.containerImageId, limits: { ...plan.limits } } : {}),
    };
    this.resources.set(id, resource);
    this.created.push(name);
    if (this.loseCreateReplyFor.has(name)) {
      throw new Error('synthetic lost Docker create reply');
    }
    return resource;
  }

  async startContainer(id: string): Promise<void> {
    this.started.push(id);
  }

  async inspect(kind: InspectedResource['kind'], id: string): Promise<InspectedResource | null> {
    const resource = this.resources.get(id);
    return resource?.kind === kind ? resource : null;
  }

  async remove(kind: InspectedResource['kind'], id: string): Promise<void> {
    assert.equal(this.resources.get(id)?.kind, kind);
    this.resources.delete(id);
    this.removed.push(id);
  }
}

function runner(fixturePlan: FixturePlan, docker = new FakeDocker(), http = new FakeHttp()) {
  return {
    docker,
    http,
    runner: new MediaFixtureRunner({
      plan: fixturePlan,
      docker,
      candidates: new FakeCandidates(),
      ports: new FakePorts(),
      http,
      journal: new ResourceJournal(fixturePlan.outputRoot),
    }),
  };
}

describe('the isolated continuation fixture plan', () => {
  it('binds every object to one identity, immutable images, and loopback-only published ports', () => {
    const fixturePlan = plan();
    const fixture = runner(fixturePlan);

    assert.equal(fixturePlan.network.internal, true);
    assert.deepEqual(
      fixture.runner.plannedStages().map((stage) => stage.status),
      ['planned', 'planned', 'planned', 'planned', 'planned'],
    );
    for (const resource of fixturePlan.resources) {
      assert.match(resource.name, new RegExp(`^${FIXTURE_ID}-`));
      assert.equal(resource.labels[FIXTURE_LABEL], FIXTURE_ID);
      if (resource.kind === 'container') {
        assert.match(resource.image, /@sha256:|^sha256:/);
        assert.ok(resource.limits.cpus > 0);
        assert.ok(resource.limits.memoryBytes >= 64 * 1024 * 1024);
        assert.ok(resource.limits.pidsLimit >= 32);
      }
    }
    for (const binding of fixturePlan.publishedPorts) {
      assert.equal(binding.host, '127.0.0.1');
    }
  });

  it('uses the admin API contract and preserves the pinned Bee image state', () => {
    const fixturePlan = plan();
    const adminBinding = fixturePlan.publishedPorts.find((binding) => binding.role === 'admin');
    const volumeRoles = fixturePlan.resources
      .filter((resource) => resource.kind === 'volume')
      .map((resource) => resource.role);

    assert.equal(adminBinding?.containerPort, 9_877);
    assert.equal(fixturePlan.internalEndpoints.admin, `http://${FIXTURE_ID}-admin-api:9877`);
    assert.ok(volumeRoles.includes('srs-media'));
    assert.ok(volumeRoles.includes('uploader-data'));
    assert.equal(
      volumeRoles.some((role) => role.startsWith('bee-')),
      false,
    );
  });

  it('refuses a colliding resource before creating any object or journal', async () => {
    const fixturePlan = plan();
    const docker = new FakeDocker();
    const collision = fixturePlan.resources[2];
    await docker.create(collision.kind, collision.name, { foreign: 'true' });
    docker.created.length = 0;
    const fixture = runner(fixturePlan, docker);

    await assert.rejects(fixture.runner.up(), /already exists/);

    assert.deepEqual(docker.created, []);
    assert.throws(() => readFileSync(join(fixturePlan.outputRoot, 'resources.json')));
  });

  it('refuses candidate drift before Docker mutation', async () => {
    const fixturePlan = plan();
    const docker = new FakeDocker();
    const candidates = new FakeCandidates(new Map([['/candidates/admin', 'c'.repeat(40)]]));
    const subject = new MediaFixtureRunner({
      plan: fixturePlan,
      docker,
      candidates,
      ports: new FakePorts(),
      http: new FakeHttp(),
      journal: new ResourceJournal(fixturePlan.outputRoot),
    });

    await assert.rejects(subject.up(), /candidate admin.*changed/i);
    assert.deepEqual(docker.created, []);
  });

  it('refuses a dirty candidate before Docker mutation', async () => {
    const fixturePlan = plan();
    const docker = new FakeDocker();
    const candidates = new FakeCandidates();
    candidates.dirty.add('/candidates/stack');
    const subject = new MediaFixtureRunner({
      plan: fixturePlan,
      docker,
      candidates,
      ports: new FakePorts(),
      http: new FakeHttp(),
      journal: new ResourceJournal(fixturePlan.outputRoot),
    });

    await assert.rejects(subject.up(), /candidate stack.*uncommitted/i);
    assert.deepEqual(docker.created, []);
  });

  it('refuses an occupied loopback port before Docker mutation', async () => {
    const fixturePlan = plan();
    const docker = new FakeDocker();
    const ports = new FakePorts();
    ports.occupied.add(fixturePlan.publishedPorts[0].hostPort);
    const subject = new MediaFixtureRunner({
      plan: fixturePlan,
      docker,
      candidates: new FakeCandidates(),
      ports,
      http: new FakeHttp(),
      journal: new ResourceJournal(fixturePlan.outputRoot),
    });

    await assert.rejects(subject.up(), /port 18545.*occupied/i);
    assert.deepEqual(docker.created, []);
  });

  it('refuses a different runtime image before starting any container', async () => {
    const fixturePlan = structuredClone(plan());
    for (const resource of fixturePlan.resources) {
      if (resource.kind === 'container') {
        resource.image = IMAGE_ID;
      }
    }
    const docker = new FakeDocker();
    docker.containerImageId = `sha256:${'c'.repeat(64)}`;
    const fixture = runner(fixturePlan, docker);

    await assert.rejects(fixture.runner.up(), /planned image/i);

    assert.deepEqual(docker.started, []);
  });

  it('refuses an internal endpoint outside the fixture network', () => {
    const fixturePlan = structuredClone(plan());
    (fixturePlan.internalEndpoints as Record<string, string>).rpc = 'https://rpc.gnosischain.com';

    assert.throws(() => validateFixturePlan(fixturePlan), /endpoint.*not owned/i);
  });

  it('keeps the sender stopped when the chain or endpoint belongs to another fixture', async () => {
    const fixturePlan = plan();
    const http = new FakeHttp();
    http.evidence.chainId = 100;
    http.evidence.chainOwner = 'live-chain';
    const fixture = runner(fixturePlan, new FakeDocker(), http);

    await assert.rejects(fixture.runner.up(), /private chain.*identity/i);

    const sender = new ResourceJournal(fixturePlan.outputRoot)
      .read()
      .resources.find((resource) => resource.name.endsWith('-media-sender'));
    assert.ok(sender);
    assert.equal(fixture.docker.started.includes(sender.id), false);
  });

  it('keeps the sender stopped when readiness or storage capacity is insufficient', async () => {
    const fixturePlan = plan();
    const http = new FakeHttp();
    http.evidence.storage.stamp.capacityBytes = 999_999;
    http.evidence.browserDecodedMedia = false;
    const fixture = runner(fixturePlan, new FakeDocker(), http);

    await assert.rejects(fixture.runner.up(), /storage capacity/i);

    const journal = JSON.parse(readFileSync(join(fixturePlan.outputRoot, 'resources.json'), 'utf8')) as {
      readiness: ReadinessEvidence;
      stages: Array<{ name: string; status: string; stdout: string; stderr: string }>;
    };
    assert.equal(journal.readiness.storage.stamp.batchIdHash, `sha256:${'d'.repeat(64)}`);
    assert.deepEqual(
      journal.stages.map((stage) => [stage.name, stage.status]),
      [
        ['candidate-preflight', 'passed'],
        ['collision-preflight', 'passed'],
        ['create-infrastructure', 'passed'],
        ['readiness-preflight', 'failed'],
        ['start-media-sender', 'skipped'],
      ],
    );
    assert.ok(journal.stages.every((stage) => 'stdout' in stage && 'stderr' in stage));
  });

  it('refuses malformed numeric and component readiness evidence', async () => {
    const fixturePlan = plan();
    const http = new FakeHttp();
    http.evidence.storage.stamp.capacityBytes = Number.NaN;
    delete (http.evidence.components as Partial<ReadinessEvidence['components']>).viewer;
    const fixture = runner(fixturePlan, new FakeDocker(), http);

    await assert.rejects(fixture.runner.up(), /readiness evidence is malformed/i);

    const sender = new ResourceJournal(fixturePlan.outputRoot)
      .read()
      .resources.find((resource) => resource.name.endsWith('-media-sender'));
    assert.ok(sender);
    assert.equal(fixture.docker.started.includes(sender.id), false);
  });

  it('removes only journaled IDs after every surviving object proves its label', async () => {
    const fixturePlan = plan();
    const fixture = runner(fixturePlan);
    await fixture.runner.up();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    const recorded = journal.read().resources;
    assert.equal(recorded.find((resource) => resource.kind === 'network')?.internal, true);
    for (const resource of recorded.filter((entry) => entry.kind === 'container')) {
      assert.match(resource.imageId ?? '', /^sha256:[0-9a-f]{64}$/);
      assert.ok(resource.limits);
    }

    await cleanupFixture(journal, fixture.docker);

    assert.deepEqual(fixture.docker.removed, recorded.map((resource) => resource.id).reverse());
  });

  it('preserves a write-ahead intent when Docker creates an object but loses its reply', async () => {
    const fixturePlan = plan();
    const docker = new FakeDocker();
    const first = fixturePlan.resources[0];
    docker.loseCreateReplyFor.add(first.name);
    const fixture = runner(fixturePlan, docker);

    await assert.rejects(fixture.runner.up(), /outcome.*unresolved.*exact-name/i);

    const journal = new ResourceJournal(fixturePlan.outputRoot);
    assert.deepEqual(journal.read().resources, []);
    assert.deepEqual(journal.read().intents, [
      {
        kind: first.kind,
        name: first.name,
        labels: first.labels,
        status: 'planned',
      },
    ]);
    await assert.rejects(cleanupFixture(journal, docker), /unresolved creation intent/i);
    assert.deepEqual(docker.removed, []);

    await resolveCreationIntents(journal, docker);
    await cleanupFixture(journal, docker);
    assert.equal(docker.removed.length, 1);
  });

  it('refuses all cleanup when one recorded ID has the wrong fixture label', async () => {
    const fixturePlan = plan();
    const fixture = runner(fixturePlan);
    await fixture.runner.up();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    const recorded = journal.read().resources;
    const changed = fixture.docker.resources.get(recorded[0].id);
    assert.ok(changed);
    changed.labels[FIXTURE_LABEL] = 'some-other-fixture';

    await assert.rejects(cleanupFixture(journal, fixture.docker), /label.*does not match/i);

    assert.deepEqual(fixture.docker.removed, []);
  });

  it('refuses cleanup while manager profile creation or guarded start is unresolved', async () => {
    for (const state of ['creating', 'created'] as const) {
      const fixturePlan = plan();
      const fixture = runner(fixturePlan);
      await fixture.runner.up();
      const journal = new ResourceJournal(fixturePlan.outputRoot);
      journal.beginManagerProfile('srs-a1b2c3d4-uploader', 1);
      if (state === 'created') {
        journal.completeManagerProfile(
          'srs-a1b2c3d4-uploader',
          1,
          '11111111-1111-4111-8111-111111111111',
        );
      }

      await assert.rejects(cleanupFixture(journal, fixture.docker), /provisioning is unresolved/i);
      assert.deepEqual(fixture.docker.removed, []);
    }
  });
});
