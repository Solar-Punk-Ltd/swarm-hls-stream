import {
  FIXTURE_LABEL,
  type FixtureDocker,
  FixtureRefusal,
  MANAGED_LABEL,
  type ResourceJournal,
  type ResourceKind,
} from './fixture.js';
import type { ReleaseFixtureTargets } from './provisioner.js';

const GUARDED_CONTAINER_LIMITS = { cpus: 1, memoryBytes: 1_073_741_824, pidsLimit: 256 } as const;

export type GuardedResourceStage =
  | 'admin-bootstrap'
  | 'manager'
  | 'uploader-preparation'
  | 'admin-managed'
  | 'viewer'
  | 'uploader';

export interface GuardedResourceTracker {
  run<T>(stage: GuardedResourceStage, mutation: () => Promise<T>): Promise<T>;
}

interface GuardedResourceExpectation {
  kind: ResourceKind;
  name: string;
  labels: Record<string, string>;
  internal?: true;
  limits?: typeof GUARDED_CONTAINER_LIMITS;
}

/** Journals exact guard-owned Docker identities around the fixed fixture activation sequence. */
export class GuardedResourceInventory implements GuardedResourceTracker {
  constructor(
    private readonly fixtureId: string,
    private readonly targets: ReleaseFixtureTargets,
    private readonly journal: ResourceJournal,
    private readonly docker: FixtureDocker,
  ) {}

  async run<T>(stage: GuardedResourceStage, mutation: () => Promise<T>): Promise<T> {
    const expectations = this.expectations(stage);
    for (const expectation of expectations) {
      this.journal.planResource(expectation);
    }
    const result = await mutation();
    for (const expectation of expectations) {
      const actual = await this.docker.findExact(expectation.kind, expectation.name);
      if (!actual) {
        throw new FixtureRefusal(`guarded resource ${expectation.name} creation outcome is unresolved`);
      }
      if (!matchesExpectation(actual, expectation)) {
        throw new FixtureRefusal(`guarded resource ${expectation.name} identity does not match`);
      }
      const previous = this.journal
        .read()
        .resources.filter(({ kind, name }) => kind === expectation.kind && name === expectation.name)
        .at(-1);
      if (previous?.id === actual.id) {
        this.journal.recordUnchanged(actual);
      } else {
        this.journal.recordResource(actual);
      }
    }
    return result;
  }

  private expectations(stage: GuardedResourceStage): readonly GuardedResourceExpectation[] {
    const { manager, admin, uploader, viewer } = this.targets;
    switch (stage) {
      case 'admin-bootstrap':
        return [
          ...containers(this.fixtureId, admin.projectName, ['postgres', 'api', 'web']),
          network(this.fixtureId, admin.projectName, `${admin.projectName}-fixture-db`, 'admin-db'),
          volume(this.fixtureId, admin.projectName, admin.postgresVolumeName, 'web2admin-pg'),
        ];
      case 'manager':
        return [
          ...containers(this.fixtureId, manager.projectName, ['postgres', 'api', 'web']),
          network(this.fixtureId, manager.projectName, `${manager.projectName}-fixture-manager`, 'fixture_manager'),
          volume(this.fixtureId, manager.projectName, manager.postgresVolumeName, 'manager-pg'),
        ];
      case 'uploader-preparation':
        return [
          container(this.fixtureId, uploader.profile, 'srs'),
          volume(this.fixtureId, uploader.profile, `${uploader.profile}_srs-media`, 'srs-media'),
        ];
      case 'admin-managed':
        return containers(this.fixtureId, admin.projectName, ['api', 'web']);
      case 'viewer':
        return [container(this.fixtureId, viewer.profile, 'client')];
      case 'uploader':
        return [
          container(this.fixtureId, uploader.profile, 'stream-uploader'),
          volume(this.fixtureId, uploader.profile, `${uploader.profile}_uploader-state`, 'uploader-state'),
        ];
    }
  }
}

function identityLabels(fixtureId: string, project: string): Record<string, string> {
  return {
    [FIXTURE_LABEL]: fixtureId,
    [MANAGED_LABEL]: 'true',
    'com.docker.compose.project': project,
  };
}

function container(fixtureId: string, project: string, service: string): GuardedResourceExpectation {
  return {
    kind: 'container',
    name: `${project}-${service}-1`,
    labels: {
      ...identityLabels(fixtureId, project),
      'com.docker.compose.service': service,
    },
    limits: GUARDED_CONTAINER_LIMITS,
  };
}

function containers(fixtureId: string, project: string, services: readonly string[]): GuardedResourceExpectation[] {
  return services.map((service) => container(fixtureId, project, service));
}

function network(fixtureId: string, project: string, name: string, composeName: string): GuardedResourceExpectation {
  return {
    kind: 'network',
    name,
    labels: {
      ...identityLabels(fixtureId, project),
      'com.docker.compose.network': composeName,
    },
    internal: true,
  };
}

function volume(fixtureId: string, project: string, name: string, composeName: string): GuardedResourceExpectation {
  return {
    kind: 'volume',
    name,
    labels: {
      ...identityLabels(fixtureId, project),
      'com.docker.compose.volume': composeName,
    },
  };
}

function matchesExpectation(
  actual: Awaited<ReturnType<FixtureDocker['findExact']>>,
  expected: GuardedResourceExpectation,
): boolean {
  return (
    actual !== null &&
    actual.kind === expected.kind &&
    actual.name === expected.name &&
    Object.entries(expected.labels).every(([name, value]) => actual.labels[name] === value) &&
    (expected.internal === undefined || actual.internal === expected.internal) &&
    (expected.limits === undefined || sameLimits(actual.limits, expected.limits))
  );
}

function sameLimits(
  actual: { cpus: number; memoryBytes: number; pidsLimit: number } | undefined,
  expected: { cpus: number; memoryBytes: number; pidsLimit: number },
): boolean {
  return (
    actual?.cpus === expected.cpus &&
    actual.memoryBytes === expected.memoryBytes &&
    actual.pidsLimit === expected.pidsLimit
  );
}
