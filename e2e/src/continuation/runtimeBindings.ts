import type { BoundedCommand } from './dockerCli.js';
import { FIXTURE_LABEL, type FixturePlan, FixtureRefusal, MANAGED_LABEL } from './fixture.js';
import type { MeasurementContainerRole } from './measurements.js';
import type { GuardCandidateBinding, RuntimeContainerBinding, RuntimeReadinessBindings } from './readinessSource.js';
import type { ContinuationTopology, ReleaseGuardRole, TopologyServiceRole } from './topology.js';

const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,200}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const NETWORK_ID = /^[0-9a-f]{64}$/;

interface GuardProjects {
  manager: string;
  admin: string;
  uploader: string;
  viewer: string;
}

interface ResolveFixtureRuntimeInput {
  plan: FixturePlan;
  topology: ContinuationTopology;
  projects: GuardProjects;
  fixtureNetworkId: string;
  rawContainers: ReadonlyMap<TopologyServiceRole, RuntimeContainerBinding>;
  guardSlots: ReadonlyMap<ReleaseGuardRole, string>;
}

interface ResolvedFixtureEndpoints {
  srs: { host: string; rtmpPort: number; srtPort: number };
  viewerMediaBaseUrl: string;
  adminInternalBaseUrl: string;
}

export interface ResolvedFixtureRuntime {
  readiness: RuntimeReadinessBindings;
  measurements: {
    containers: ReadonlyMap<MeasurementContainerRole, RuntimeContainerBinding>;
  };
  endpoints: ResolvedFixtureEndpoints;
}

interface NetworkInspection {
  networkId: string;
  aliases: string[];
}

interface ContainerInspection {
  id: string;
  name: string;
  configuredImage: string;
  imageId: string;
  labels: Record<string, string>;
  networks: Record<string, NetworkInspection>;
  exposedPorts: Record<string, unknown>;
}

interface GuardedContainer {
  role: TopologyServiceRole;
  project: keyof GuardProjects;
  service: string;
  requiredAlias?: string;
  requiredPorts?: readonly string[];
  requiredEnvironment?: Readonly<Record<string, string>>;
  requiresFixtureNetwork?: true;
}

const GUARDED_CONTAINERS: readonly GuardedContainer[] = [
  { role: 'postgres', project: 'admin', service: 'postgres', requiredPorts: ['5432/tcp'] },
  {
    role: 'admin-api',
    project: 'admin',
    service: 'api',
    requiredAlias: 'fixture-admin-api',
    requiredPorts: ['9877/tcp'],
    requiresFixtureNetwork: true,
  },
  { role: 'admin-web', project: 'admin', service: 'web', requiredPorts: ['80/tcp'] },
  {
    role: 'srs',
    project: 'uploader',
    service: 'srs',
    requiredAlias: 'srs',
    requiredEnvironment: {
      SRS_RTMP_PORT: '10012',
      SRS_HTTP_PORT: '10013',
      SRS_SRT_PORT: '10011',
      SRS_HTTP_API_PORT: '10019',
    },
    requiresFixtureNetwork: true,
  },
  {
    role: 'uploader',
    project: 'uploader',
    service: 'stream-uploader',
    requiredAlias: 'stream-uploader',
    requiredEnvironment: { API_PORT: '10010' },
    requiresFixtureNetwork: true,
  },
  {
    role: 'viewer',
    project: 'viewer',
    service: 'client',
    requiredAlias: 'client',
    requiredPorts: ['80/tcp'],
    requiresFixtureNetwork: true,
  },
];

const MANAGER_MEASUREMENT_CONTAINERS: ReadonlyArray<{
  role: Extract<MeasurementContainerRole, `manager-${string}`>;
  service: string;
}> = [
  { role: 'manager-postgres', service: 'postgres' },
  { role: 'manager-api', service: 'api' },
  { role: 'manager-web', service: 'web' },
];

/** Resolves guard-owned runtime identities without reading container environments or logs. */
export async function resolveFixtureRuntime(
  command: BoundedCommand,
  input: ResolveFixtureRuntimeInput,
): Promise<ResolvedFixtureRuntime> {
  if (input.topology.fixtureId !== input.plan.fixtureId || input.topology.network !== input.plan.network.name) {
    throw new FixtureRefusal('runtime topology does not belong to the fixture plan');
  }
  if (!NETWORK_ID.test(input.fixtureNetworkId)) {
    throw new FixtureRefusal('journaled fixture network identity is malformed');
  }
  const guarded = new Map<TopologyServiceRole, { binding: RuntimeContainerBinding; inspection: ContainerInspection }>();
  for (const expected of GUARDED_CONTAINERS) {
    const project = checkedName(input.projects[expected.project], `${expected.project} project`);
    const id = await exactComposeContainer(command, input.plan.fixtureId, project, expected.service, expected.role);
    const inspection = await inspectContainer(command, id, input.plan.fixtureId);
    if (
      inspection.labels['com.docker.compose.project'] !== project ||
      inspection.labels['com.docker.compose.service'] !== expected.service
    ) {
      throw new FixtureRefusal(`${expected.role} runtime Compose identity does not match`);
    }
    if (expected.requiresFixtureNetwork) {
      const network = inspection.networks[input.plan.network.name];
      if (!network || network.networkId !== input.fixtureNetworkId) {
        throw new FixtureRefusal(`${expected.role} is outside the exact fixture network`);
      }
      const requiredAlias =
        expected.requiredAlias === 'fixture-admin-api' ? `${input.plan.fixtureId}-admin-api` : expected.requiredAlias;
      if (requiredAlias && !network.aliases.includes(requiredAlias)) {
        throw new FixtureRefusal(`${expected.role} runtime alias does not match`);
      }
    }
    for (const port of expected.requiredPorts ?? []) {
      if (!(port in inspection.exposedPorts)) {
        throw new FixtureRefusal(`${expected.role} does not expose the slot-1 ${port} port`);
      }
    }
    if (expected.requiredEnvironment) {
      await requirePortEnvironment(command, inspection.id, expected.role, expected.requiredEnvironment);
    }
    guarded.set(expected.role, {
      binding: {
        id: inspection.id,
        name: inspection.name,
        configuredImage: inspection.configuredImage,
      },
      inspection,
    });
  }

  const containers = new Map<TopologyServiceRole, RuntimeContainerBinding>(input.rawContainers);
  for (const [role, value] of guarded) {
    containers.set(role, value.binding);
  }
  for (const service of input.topology.services) {
    if (!containers.has(service.role)) {
      throw new FixtureRefusal(`${service.role} runtime container binding is missing`);
    }
  }
  const measurementContainers = new Map<MeasurementContainerRole, RuntimeContainerBinding>(containers);
  const managerProject = checkedName(input.projects.manager, 'manager project');
  for (const expected of MANAGER_MEASUREMENT_CONTAINERS) {
    const id = await exactComposeContainer(
      command,
      input.plan.fixtureId,
      managerProject,
      expected.service,
      expected.role,
    );
    const inspection = await inspectContainer(command, id, input.plan.fixtureId);
    if (
      inspection.labels['com.docker.compose.project'] !== managerProject ||
      inspection.labels['com.docker.compose.service'] !== expected.service
    ) {
      throw new FixtureRefusal(`${expected.role} runtime Compose identity does not match`);
    }
    measurementContainers.set(expected.role, {
      id: inspection.id,
      name: inspection.name,
      configuredImage: inspection.configuredImage,
    });
  }
  if (
    measurementContainers.size !== 17 ||
    new Set([...measurementContainers.values()].map(({ id }) => id)).size !== 17
  ) {
    throw new FixtureRefusal('runtime measurement container identities are incomplete');
  }

  const candidates = new Map<ReleaseGuardRole, GuardCandidateBinding>();
  for (const activation of input.topology.guardedActivations) {
    const candidate = input.plan.candidates.find(({ role }) => role === activation.candidateRole);
    if (!candidate) {
      throw new FixtureRefusal(`${activation.role} guard candidate is missing`);
    }
    candidates.set(activation.role, candidate);
  }
  const admin = guarded.get('admin-api');
  const postgres = guarded.get('postgres');
  const srsNetwork = guarded.get('srs')?.inspection.networks[input.plan.network.name];
  const viewerNetwork = guarded.get('viewer')?.inspection.networks[input.plan.network.name];
  if (!admin || !postgres || !srsNetwork || !viewerNetwork) {
    throw new FixtureRefusal('runtime endpoint bindings are incomplete');
  }
  const adminAlias = `${input.plan.fixtureId}-admin-api`;
  const allowedHttpOrigins = new Set<string>([
    `http://${input.plan.fixtureId}-blockchain:8545`,
    `http://${input.plan.fixtureId}-bee-queen:1633`,
    `http://srs:10019`,
    `http://stream-uploader:10010`,
    `http://${adminAlias}:9877`,
    'http://client',
  ]);
  return {
    readiness: {
      probeContainerId: admin.binding.id,
      postgresContainerId: postgres.binding.id,
      allowedHttpOrigins,
      containers,
      guardSlots: new Map(input.guardSlots),
      candidates,
    },
    measurements: { containers: measurementContainers },
    endpoints: {
      srs: { host: 'srs', rtmpPort: 10_012, srtPort: 10_011 },
      viewerMediaBaseUrl: 'http://client',
      adminInternalBaseUrl: `http://${adminAlias}:9877`,
    },
  };
}

async function exactComposeContainer(
  command: BoundedCommand,
  fixtureId: string,
  project: string,
  service: string,
  diagnosticRole: string,
): Promise<string> {
  const result = await command.run('docker', [
    'ps',
    '--quiet',
    '--no-trunc',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--filter',
    'label=com.docker.compose.oneoff=False',
    '--filter',
    `label=${FIXTURE_LABEL}=${fixtureId}`,
    '--filter',
    `label=${MANAGED_LABEL}=true`,
  ]);
  const ids = result.stdout.trim() === '' ? [] : result.stdout.trim().split(/\s+/);
  if (ids.length !== 1 || !SAFE_NAME.test(ids[0] ?? '')) {
    throw new FixtureRefusal(`${diagnosticRole} guarded runtime did not resolve to one exact container`);
  }
  return ids[0];
}

async function requirePortEnvironment(
  command: BoundedCommand,
  containerId: string,
  role: TopologyServiceRole,
  expected: Readonly<Record<string, string>>,
): Promise<void> {
  const names = Object.keys(expected);
  const result = await command.run('docker', [
    'exec',
    checkedName(containerId, `${role} container id`),
    'printenv',
    ...names,
  ]);
  const values = result.stdout.replace(/\n$/, '').split('\n');
  if (values.length !== names.length || names.some((name, index) => values[index] !== expected[name])) {
    throw new FixtureRefusal(`${role} runtime does not use the slot-1 port contract`);
  }
}

async function inspectContainer(command: BoundedCommand, id: string, fixtureId: string): Promise<ContainerInspection> {
  const result = await command.run('docker', [
    'container',
    'inspect',
    '--format',
    '{"id":{{json .Id}},"name":{{json .Name}},"configuredImage":{{json .Config.Image}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"networks":{{json .NetworkSettings.Networks}},"exposedPorts":{{json .Config.ExposedPorts}}}',
    checkedName(id, 'container id'),
  ]);
  const raw = parseObject(result.stdout, 'runtime container inspection');
  const name = typeof raw.name === 'string' && raw.name.startsWith('/') ? raw.name.slice(1) : raw.name;
  if (
    raw.id !== id ||
    typeof name !== 'string' ||
    !SAFE_NAME.test(name) ||
    typeof raw.configuredImage !== 'string' ||
    raw.configuredImage.length < 1 ||
    raw.configuredImage.length > 500 ||
    typeof raw.imageId !== 'string' ||
    !IMAGE_ID.test(raw.imageId) ||
    !isStringRecord(raw.labels) ||
    raw.labels[FIXTURE_LABEL] !== fixtureId ||
    raw.labels[MANAGED_LABEL] !== 'true' ||
    !isObject(raw.networks) ||
    !isObject(raw.exposedPorts)
  ) {
    throw new FixtureRefusal('guarded runtime container identity is malformed');
  }
  const networks: Record<string, NetworkInspection> = {};
  for (const [networkName, value] of Object.entries(raw.networks)) {
    const networkId = isObject(value) ? value.networkId ?? value.NetworkID : undefined;
    const rawAliases = isObject(value) ? value.aliases ?? value.Aliases : undefined;
    if (!isObject(value) || typeof networkId !== 'string' || !Array.isArray(rawAliases)) {
      throw new FixtureRefusal('guarded runtime network identity is malformed');
    }
    const aliases = rawAliases.filter((alias): alias is string => typeof alias === 'string');
    if (aliases.length !== rawAliases.length || aliases.some((alias) => !SAFE_NAME.test(alias))) {
      throw new FixtureRefusal('guarded runtime network aliases are malformed');
    }
    networks[networkName] = { networkId, aliases };
  }
  return {
    id,
    name,
    configuredImage: raw.configuredImage,
    imageId: raw.imageId,
    labels: raw.labels,
    networks,
    exposedPorts: raw.exposedPorts,
  };
}

function checkedName(value: string, label: string): string {
  if (!SAFE_NAME.test(value)) {
    throw new FixtureRefusal(`${label} is malformed`);
  }
  return value;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isObject(parsed)) {
      return parsed;
    }
  } catch {
    throw new FixtureRefusal(`${label} is malformed`);
  }
  throw new FixtureRefusal(`${label} is malformed`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
