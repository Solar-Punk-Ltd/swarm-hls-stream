import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  cleanupFixture,
  createFixturePlan,
  FIXTURE_LABEL,
  type FixtureDocker,
  type FixturePlan,
  type FixtureResourcePlan,
  type InspectedResource,
  MANAGED_LABEL,
  resolveCreationIntents,
  ResourceJournal,
  type ResourceKind,
} from '../src/continuation/fixture.js';
import {
  GuardedResourceInventory,
  type GuardedResourceStage,
} from '../src/continuation/guardedResources.js';
import type { ReleaseFixtureTargets } from '../src/continuation/provisioner.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

function plan(): FixturePlan {
  const parent = mkdtempSync(join(tmpdir(), 'continuation-guarded-resources-'));
  return createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: join(parent, FIXTURE_ID),
    candidates: [
      { role: 'stack', root: '/candidates/stack', commit: 'a'.repeat(40) },
      { role: 'admin', root: '/candidates/admin', commit: 'b'.repeat(40) },
      { role: 'manager', root: '/candidates/manager', commit: 'c'.repeat(40) },
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
    expectedChainId: 1_337,
  });
}

function targets(): ReleaseFixtureTargets {
  return {
    manager: {
      projectName: 'srs-a1b2c3d4-manager',
      postgresVolumeName: 'srs-a1b2c3d4-manager-pg',
      postgresPort: 25_432,
      webPort: 18_082,
    },
    admin: {
      projectName: 'srs-a1b2c3d4-admin',
      postgresVolumeName: 'srs-a1b2c3d4-admin-pg',
      webPort: 18_080,
    },
    uploader: {
      profile: 'srs-a1b2c3d4-uploader',
      portSlot: 1,
      services: ['srs', 'stream-uploader'],
    },
    viewer: { profile: 'srs-a1b2c3d4-viewer', portSlot: 1, services: ['client'] },
  };
}

class InventoryDocker implements FixtureDocker {
  readonly resources = new Map<string, InspectedResource>();
  readonly removed: string[] = [];
  failInspectionFor: string | null = null;
  private nextId = 1;

  createExpected(kind: ResourceKind, name: string, labels: Record<string, string>): InspectedResource {
    const id = kind === 'volume' ? name : `${kind}-${this.nextId++}`;
    const resource: InspectedResource = {
      kind,
      id,
      name,
      labels: { ...labels },
      ...(kind === 'container'
        ? { imageId: IMAGE_ID, limits: { cpus: 1, memoryBytes: 1_073_741_824, pidsLimit: 256 } }
        : {}),
      ...(kind === 'network' ? { internal: true } : {}),
    };
    this.resources.set(id, resource);
    return resource;
  }

  replaceExpected(kind: ResourceKind, name: string, labels: Record<string, string>): InspectedResource {
    for (const [id, resource] of this.resources) {
      if (resource.kind === kind && resource.name === name) {
        this.resources.delete(id);
      }
    }
    return this.createExpected(kind, name, labels);
  }

  async findExact(kind: ResourceKind, name: string): Promise<InspectedResource | null> {
    return [...this.resources.values()].find((resource) => resource.kind === kind && resource.name === name) ?? null;
  }

  async create(
    kind: ResourceKind,
    name: string,
    labels: Readonly<Record<string, string>>,
    _plan?: FixtureResourcePlan,
  ): Promise<InspectedResource> {
    return this.createExpected(kind, name, { ...labels });
  }

  async startContainer(): Promise<void> {}

  async inspect(kind: ResourceKind, id: string): Promise<InspectedResource | null> {
    if (this.failInspectionFor === id) {
      throw new Error('synthetic daemon inspection failure');
    }
    const resource = this.resources.get(id);
    return resource?.kind === kind ? resource : null;
  }

  async remove(kind: ResourceKind, id: string): Promise<void> {
    assert.equal(this.resources.get(id)?.kind, kind);
    this.resources.delete(id);
    this.removed.push(id);
  }
}

function labels(project: string, service?: string, volumeOrNetwork?: string): Record<string, string> {
  return {
    [FIXTURE_LABEL]: FIXTURE_ID,
    [MANAGED_LABEL]: 'true',
    'com.docker.compose.project': project,
    ...(service ? { 'com.docker.compose.service': service } : {}),
    ...(volumeOrNetwork?.startsWith('volume:')
      ? { 'com.docker.compose.volume': volumeOrNetwork.slice('volume:'.length) }
      : {}),
    ...(volumeOrNetwork?.startsWith('network:')
      ? { 'com.docker.compose.network': volumeOrNetwork.slice('network:'.length) }
      : {}),
  };
}

function createStageResources(docker: InventoryDocker, stage: GuardedResourceStage): void {
  const target = targets();
  const create = (kind: ResourceKind, name: string, resourceLabels: Record<string, string>) =>
    docker.createExpected(kind, name, resourceLabels);
  if (stage === 'admin-bootstrap') {
    for (const service of ['postgres', 'api', 'web']) {
      create('container', `${target.admin.projectName}-${service}-1`, labels(target.admin.projectName, service));
    }
    create('network', `${target.admin.projectName}-fixture-db`, labels(target.admin.projectName, undefined, 'network:admin-db'));
    create('volume', target.admin.postgresVolumeName, labels(target.admin.projectName, undefined, 'volume:web2admin-pg'));
  } else if (stage === 'manager') {
    for (const service of ['postgres', 'api', 'web']) {
      create('container', `${target.manager.projectName}-${service}-1`, labels(target.manager.projectName, service));
    }
    create('network', `${target.manager.projectName}-fixture-manager`, labels(target.manager.projectName, undefined, 'network:default'));
    create('volume', target.manager.postgresVolumeName, labels(target.manager.projectName, undefined, 'volume:manager-pg'));
  } else if (stage === 'uploader-preparation') {
    create('container', `${target.uploader.profile}-srs-1`, labels(target.uploader.profile, 'srs'));
    create('volume', `${target.uploader.profile}_srs-media`, labels(target.uploader.profile, undefined, 'volume:srs-media'));
  } else if (stage === 'admin-managed') {
    docker.replaceExpected('container', `${target.admin.projectName}-api-1`, labels(target.admin.projectName, 'api'));
  } else if (stage === 'viewer') {
    create('container', `${target.viewer.profile}-client-1`, labels(target.viewer.profile, 'client'));
  } else {
    create(
      'container',
      `${target.uploader.profile}-stream-uploader-1`,
      labels(target.uploader.profile, 'stream-uploader'),
    );
    create(
      'volume',
      `${target.uploader.profile}_uploader-state`,
      labels(target.uploader.profile, undefined, 'volume:uploader-state'),
    );
  }
}

describe('guarded resource inventory', () => {
  it('journals every guarded resource generation and removes only surviving exact IDs', async () => {
    const fixturePlan = plan();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    const docker = new InventoryDocker();
    journal.initialize(fixturePlan, []);
    const inventory = new GuardedResourceInventory(FIXTURE_ID, targets(), journal, docker);
    const stages: GuardedResourceStage[] = [
      'admin-bootstrap',
      'manager',
      'uploader-preparation',
      'admin-managed',
      'viewer',
      'uploader',
    ];

    for (const stage of stages) {
      await inventory.run(stage, async () => createStageResources(docker, stage));
    }

    const document = journal.read();
    const managerResources = document.resources.filter((resource) =>
      resource.labels['com.docker.compose.project'] === targets().manager.projectName,
    );
    assert.deepEqual(
      managerResources.map(({ kind, name }) => [kind, name]).sort(),
      [
        ['container', 'srs-a1b2c3d4-manager-api-1'],
        ['container', 'srs-a1b2c3d4-manager-postgres-1'],
        ['container', 'srs-a1b2c3d4-manager-web-1'],
        ['network', 'srs-a1b2c3d4-manager-fixture-manager'],
        ['volume', 'srs-a1b2c3d4-manager-pg'],
      ],
    );
    const adminApiGenerations = document.resources.filter(
      ({ name }) => name === 'srs-a1b2c3d4-admin-api-1',
    );
    assert.equal(adminApiGenerations.length, 2);
    assert.notEqual(adminApiGenerations[0]?.id, adminApiGenerations[1]?.id);
    assert.equal(
      document.intents.find(
        (intent) => intent.name === 'srs-a1b2c3d4-admin-web-1' && intent.status === 'unchanged',
      )?.id,
      document.resources.find(({ name }) => name === 'srs-a1b2c3d4-admin-web-1')?.id,
    );

    const survivingIds = [...docker.resources.keys()];
    await cleanupFixture(journal, docker);

    assert.deepEqual(docker.removed, survivingIds.reverse());
  });

  it('leaves write-ahead intents unresolved when a guarded mutation outcome is ambiguous', async () => {
    const fixturePlan = plan();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    const docker = new InventoryDocker();
    journal.initialize(fixturePlan, []);
    const inventory = new GuardedResourceInventory(FIXTURE_ID, targets(), journal, docker);

    await assert.rejects(
      inventory.run('manager', async () => {
        docker.createExpected(
          'container',
          `${targets().manager.projectName}-api-1`,
          labels(targets().manager.projectName, 'api'),
        );
        throw new Error('synthetic lost guarded response');
      }),
      /synthetic lost guarded response/,
    );

    assert.equal(journal.read().intents.filter(({ status }) => status === 'planned').length, 5);
    await assert.rejects(cleanupFixture(journal, docker), /unresolved creation intent/i);
    assert.deepEqual(docker.removed, []);
  });

  it('never adopts an exact-name resource whose full Compose identity differs', async () => {
    const fixturePlan = plan();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    const docker = new InventoryDocker();
    journal.initialize(fixturePlan, []);
    const inventory = new GuardedResourceInventory(FIXTURE_ID, targets(), journal, docker);

    await assert.rejects(
      inventory.run('viewer', async () => {
        docker.createExpected(
          'container',
          `${targets().viewer.profile}-client-1`,
          labels(targets().viewer.profile, 'srs'),
        );
      }),
      /identity does not match/i,
    );
    await assert.rejects(resolveCreationIntents(journal, docker), /full fixture identity/i);
    assert.equal(journal.read().resources.length, 0);
  });

  it('treats a verified absent predecessor as gone but never swallows an inspection failure', async () => {
    const fixturePlan = plan();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    const docker = new InventoryDocker();
    journal.initialize(fixturePlan, []);
    const inventory = new GuardedResourceInventory(FIXTURE_ID, targets(), journal, docker);
    await inventory.run('admin-bootstrap', async () => createStageResources(docker, 'admin-bootstrap'));
    const predecessor = journal.read().resources.find(({ name }) => name.endsWith('-admin-api-1'));
    assert.ok(predecessor);
    await inventory.run('admin-managed', async () => createStageResources(docker, 'admin-managed'));

    docker.failInspectionFor = predecessor.id;
    await assert.rejects(cleanupFixture(journal, docker), /synthetic daemon inspection failure/);
    assert.deepEqual(docker.removed, []);
    docker.failInspectionFor = null;
    await cleanupFixture(journal, docker);
    assert.ok(docker.removed.length > 0);
  });
});
