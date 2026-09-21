import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoundedCommand, CommandResult } from '../src/continuation/dockerCli.js';
import { createFixturePlan } from '../src/continuation/fixture.js';
import { resolveFixtureRuntime } from '../src/continuation/runtimeBindings.js';
import { createContinuationTopology } from '../src/continuation/topology.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const NETWORK_ID = 'b'.repeat(64);
const UPLOADER_ID = '11111111-1111-4111-8111-111111111111';

function fixturePlan() {
  return createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: `/tmp/${FIXTURE_ID}`,
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
    expectedChainId: 1337,
  });
}

interface ContainerFixture {
  id: string;
  name: string;
  service: string;
  project: string;
  inspectedProject?: string;
  aliases: string[];
  ports: Array<{ port: number; protocol: 'tcp' | 'udp' }>;
}

class DockerObservations implements BoundedCommand {
  readonly calls: string[][] = [];
  networkId = NETWORK_ID;

  constructor(private readonly containers: ContainerFixture[]) {}

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    assert.equal(file, 'docker');
    this.calls.push([...args]);
    if (args[0] === 'ps') {
      assert.ok(args.includes('--no-trunc'));
      const project = args
        .find((value) => value.startsWith('label=com.docker.compose.project='))
        ?.split('=')
        .at(-1);
      const service = args
        .find((value) => value.startsWith('label=com.docker.compose.service='))
        ?.split('=')
        .at(-1);
      const matched = this.containers.filter(
        (container) => container.project === project && container.service === service,
      );
      return { stdout: matched.map(({ id }) => id).join('\n'), stderr: '' };
    }
    if (args[0] === 'exec' && args[2] === 'printenv') {
      const container = this.containers.find((candidate) => candidate.id === args[1]);
      assert.ok(container);
      const values: Record<string, Record<string, string>> = {
        srs: {
          SRS_RTMP_PORT: '10012',
          SRS_HTTP_PORT: '10013',
          SRS_SRT_PORT: '10011',
          SRS_HTTP_API_PORT: '10019',
        },
        'stream-uploader': { API_PORT: '10010' },
      };
      return {
        stdout:
          args
            .slice(3)
            .map((name) => values[container.service]?.[name])
            .join('\n') + '\n',
        stderr: '',
      };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const id = args.at(-1);
      const container = this.containers.find((candidate) => candidate.id === id);
      assert.ok(container);
      return {
        stdout: JSON.stringify({
          id: container.id,
          name: `/${container.name}`,
          configuredImage: `fixture/${container.service}:candidate`,
          imageId: IMAGE_ID,
          labels: {
            'com.docker.compose.project': container.inspectedProject ?? container.project,
            'com.docker.compose.service': container.service,
            'org.solarpunk.srs-continuation.fixture': FIXTURE_ID,
            'org.solarpunk.srs-continuation.managed': 'true',
          },
          networks: {
            [`${FIXTURE_ID}-network`]: { networkId: this.networkId, aliases: container.aliases },
          },
          exposedPorts: Object.fromEntries(container.ports.map(({ port, protocol }) => [`${port}/${protocol}`, {}])),
        }),
        stderr: '',
      };
    }
    throw new Error(`unexpected Docker call ${args.join(' ')}`);
  }
}

function guardedContainers(): ContainerFixture[] {
  return [
    {
      id: 'manager-postgres-id',
      name: 'manager-project-postgres-1',
      project: 'manager-project',
      service: 'postgres',
      aliases: [],
      ports: [{ port: 5432, protocol: 'tcp' }],
    },
    {
      id: 'manager-api-id',
      name: 'manager-project-api-1',
      project: 'manager-project',
      service: 'api',
      aliases: ['manager-api'],
      ports: [],
    },
    {
      id: 'manager-web-id',
      name: 'manager-project-web-1',
      project: 'manager-project',
      service: 'web',
      aliases: [],
      ports: [{ port: 80, protocol: 'tcp' }],
    },
    {
      id: 'admin-postgres-id',
      name: 'admin-project-postgres-1',
      project: 'admin-project',
      service: 'postgres',
      aliases: [],
      ports: [{ port: 5432, protocol: 'tcp' }],
    },
    {
      id: 'admin-api-id',
      name: 'admin-project-api-1',
      project: 'admin-project',
      service: 'api',
      aliases: [`${FIXTURE_ID}-admin-api`],
      ports: [{ port: 9877, protocol: 'tcp' }],
    },
    {
      id: 'admin-web-id',
      name: 'admin-project-web-1',
      project: 'admin-project',
      service: 'web',
      aliases: [],
      ports: [{ port: 80, protocol: 'tcp' }],
    },
    {
      id: 'srs-id',
      name: 'profile-srs-1',
      project: 'profile',
      service: 'srs',
      aliases: ['srs'],
      ports: [
        { port: 10011, protocol: 'udp' },
        { port: 10012, protocol: 'tcp' },
        { port: 10013, protocol: 'tcp' },
        { port: 10019, protocol: 'tcp' },
      ],
    },
    {
      id: 'uploader-id',
      name: 'profile-stream-uploader-1',
      project: 'profile',
      service: 'stream-uploader',
      aliases: ['stream-uploader'],
      ports: [{ port: 10010, protocol: 'tcp' }],
    },
    {
      id: 'viewer-id',
      name: 'viewer-project-client-1',
      project: 'viewer-project',
      service: 'client',
      aliases: ['client'],
      ports: [{ port: 80, protocol: 'tcp' }],
    },
  ];
}

function rawContainers() {
  return new Map([
    ['blockchain', { id: 'blockchain-id', name: `${FIXTURE_ID}-blockchain`, configuredImage: IMAGE_ID }],
    ['bee-queen', { id: 'bee-queen-id', name: `${FIXTURE_ID}-bee-queen`, configuredImage: IMAGE_ID }],
    ['bee-worker-1', { id: 'bee-worker-1-id', name: `${FIXTURE_ID}-bee-worker-1`, configuredImage: IMAGE_ID }],
    ['bee-worker-2', { id: 'bee-worker-2-id', name: `${FIXTURE_ID}-bee-worker-2`, configuredImage: IMAGE_ID }],
    ['bee-worker-3', { id: 'bee-worker-3-id', name: `${FIXTURE_ID}-bee-worker-3`, configuredImage: IMAGE_ID }],
    ['bee-worker-4', { id: 'bee-worker-4-id', name: `${FIXTURE_ID}-bee-worker-4`, configuredImage: IMAGE_ID }],
    ['browser', { id: 'browser-id', name: `${FIXTURE_ID}-browser`, configuredImage: IMAGE_ID }],
    ['media-sender', { id: 'sender-id', name: `${FIXTURE_ID}-media-sender`, configuredImage: IMAGE_ID }],
  ] as const);
}

describe('resolveFixtureRuntime', () => {
  it('binds exact guard-created identities and inspected internal endpoints', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const command = new DockerObservations(guardedContainers());

    const runtime = await resolveFixtureRuntime(command, {
      plan,
      topology,
      projects: { manager: 'manager-project', admin: 'admin-project', uploader: 'profile', viewer: 'viewer-project' },
      fixtureNetworkId: NETWORK_ID,
      rawContainers: rawContainers(),
      guardSlots: new Map([
        ['manager', 'default'],
        ['admin', 'default'],
        ['viewer', 'default'],
        ['uploader', UPLOADER_ID],
      ]),
    });

    assert.equal(runtime.readiness.postgresContainerId, 'admin-postgres-id');
    assert.equal(runtime.readiness.probeContainerId, 'admin-api-id');
    assert.equal(runtime.readiness.containers.get('srs')?.id, 'srs-id');
    assert.equal(runtime.readiness.containers.get('uploader')?.id, 'uploader-id');
    assert.equal(runtime.readiness.containers.get('viewer')?.id, 'viewer-id');
    assert.deepEqual(
      [...runtime.measurements.containers.entries()].filter(([role]) => role.startsWith('manager-')),
      [
        [
          'manager-postgres',
          {
            id: 'manager-postgres-id',
            name: 'manager-project-postgres-1',
            configuredImage: 'fixture/postgres:candidate',
          },
        ],
        [
          'manager-api',
          { id: 'manager-api-id', name: 'manager-project-api-1', configuredImage: 'fixture/api:candidate' },
        ],
        [
          'manager-web',
          { id: 'manager-web-id', name: 'manager-project-web-1', configuredImage: 'fixture/web:candidate' },
        ],
      ],
    );
    assert.equal(runtime.measurements.containers.size, 17);
    assert.equal(new Set([...runtime.measurements.containers.values()].map(({ id }) => id)).size, 17);
    assert.deepEqual(runtime.endpoints, {
      srs: { host: 'srs', rtmpPort: 10012, srtPort: 10011 },
      viewerMediaBaseUrl: 'http://client',
      adminInternalBaseUrl: `http://${FIXTURE_ID}-admin-api:9877`,
    });
    assert.equal(
      command.calls.some((args) => args[0] === 'container' && args[1] === 'inspect' && args.includes('srs-id')),
      true,
    );
  });

  it('refuses a configured base port and a container outside the exact fixture network', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const containers = guardedContainers();
    const srs = containers.find((container) => container.service === 'srs');
    assert.ok(srs);
    srs.ports = [{ port: 1935, protocol: 'tcp' }, ...srs.ports.filter(({ port }) => port !== 10012)];
    srs.aliases = ['old-srs'];

    await assert.rejects(
      resolveFixtureRuntime(new DockerObservations(containers), {
        plan,
        topology,
        projects: { manager: 'manager-project', admin: 'admin-project', uploader: 'profile', viewer: 'viewer-project' },
        fixtureNetworkId: NETWORK_ID,
        rawContainers: rawContainers(),
        guardSlots: new Map(),
      }),
      /SRS.*slot-1|alias/i,
    );
  });

  it('refuses a same-named network whose inspected identity differs from the journal', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const command = new DockerObservations(guardedContainers());
    command.networkId = 'c'.repeat(64);

    await assert.rejects(
      resolveFixtureRuntime(command, {
        plan,
        topology,
        projects: { manager: 'manager-project', admin: 'admin-project', uploader: 'profile', viewer: 'viewer-project' },
        fixtureNetworkId: NETWORK_ID,
        rawContainers: rawContainers(),
        guardSlots: new Map(),
      }),
      /exact fixture network/i,
    );
  });

  it('refuses a missing or foreign manager runtime identity', async () => {
    const plan = fixturePlan();
    const topology = createContinuationTopology(plan, UPLOADER_ID);
    const missing = guardedContainers().filter(
      ({ service, project }) => !(project === 'manager-project' && service === 'api'),
    );
    await assert.rejects(
      resolveFixtureRuntime(new DockerObservations(missing), {
        plan,
        topology,
        projects: { manager: 'manager-project', admin: 'admin-project', uploader: 'profile', viewer: 'viewer-project' },
        fixtureNetworkId: NETWORK_ID,
        rawContainers: rawContainers(),
        guardSlots: new Map(),
      }),
      /manager-api guarded runtime did not resolve/i,
    );

    const wrong = guardedContainers();
    const managerApi = wrong.find(({ service, project }) => project === 'manager-project' && service === 'api');
    assert.ok(managerApi);
    managerApi.inspectedProject = 'foreign-manager-project';
    await assert.rejects(
      resolveFixtureRuntime(new DockerObservations(wrong), {
        plan,
        topology,
        projects: { manager: 'manager-project', admin: 'admin-project', uploader: 'profile', viewer: 'viewer-project' },
        fixtureNetworkId: NETWORK_ID,
        rawContainers: rawContainers(),
        guardSlots: new Map(),
      }),
      /manager-api runtime Compose identity does not match/i,
    );
  });
});
