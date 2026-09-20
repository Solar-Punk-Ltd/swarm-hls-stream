import { join } from 'node:path';

import {
  type CandidateRole,
  type ContainerPlan,
  type FixturePlan,
  FixtureRefusal,
  type PublishedPort,
  type ReadinessEvidence,
  validateFixturePlan,
} from './fixture.js';

export const FIXTURE_UPLOADER_ID = 'fixture-srs-uploader';

export type TopologyServiceRole =
  | 'blockchain'
  | 'bee-queen'
  | 'bee-worker-1'
  | 'bee-worker-2'
  | 'bee-worker-3'
  | 'bee-worker-4'
  | 'postgres'
  | 'admin-api'
  | 'admin-web'
  | 'srs'
  | 'uploader'
  | 'viewer'
  | 'browser'
  | 'media-sender';

export type FixtureInput =
  | 'adminInternalApiToken'
  | 'beePassword'
  | 'feedPrivateKey'
  | 'postgresPassword'
  | 'publishKeySecret'
  | 'srsPassphrase'
  | 'srsWebhookToken'
  | 'uploaderApiToken';

export type BootstrapOutput =
  | 'bee.queenBootnode'
  | 'chain.bzzTokenAddress'
  | 'chain.postageStampAddress'
  | 'chain.postageStampStartBlock'
  | 'chain.redistributionAddress'
  | 'chain.stakingAddress'
  | 'chain.swapFactoryAddress'
  | 'chain.swapPriceOracleAddress'
  | 'storage.postageBatchId';

export type RuntimeValue =
  | { kind: 'literal'; value: string }
  | { kind: 'input'; input: FixtureInput }
  | { kind: 'endpoint'; endpoint: keyof FixturePlan['internalEndpoints'] }
  | { kind: 'bootstrap'; output: BootstrapOutput }
  | {
      kind: 'postgres-url';
      username: 'web2admin';
      password: 'postgresPassword';
      host: 'postgres';
      port: 5432;
      database: 'web2admin';
    };

export type CommandPart =
  | { kind: 'literal'; value: string }
  | { kind: 'input'; input: FixtureInput; prefix?: string }
  | { kind: 'bootstrap'; output: BootstrapOutput; prefix?: string };

export interface EnvironmentBinding {
  name: string;
  value: RuntimeValue;
}

export interface TopologyPort {
  name: string;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export type MountSource =
  | { kind: 'volume'; role: string; name: string }
  | { kind: 'candidate'; role: CandidateRole; root: string; relativePath: string }
  | { kind: 'fixture-file'; role: 'admin-active-artifact'; path: string };

export interface TopologyMount {
  source: MountSource;
  target: string;
  readOnly: boolean;
}

export interface ServiceTopology {
  role: TopologyServiceRole;
  container: ContainerPlan;
  aliases: readonly string[];
  entrypointAssumption: readonly string[];
  entrypointAssumptionStatus: 'source-verified' | 'runtime-unverified';
  command: readonly CommandPart[];
  environment: readonly EnvironmentBinding[];
  mounts: readonly TopologyMount[];
  ports: readonly TopologyPort[];
  dependsOn: readonly TopologyServiceRole[];
  startAfterReadiness: boolean;
}

interface BootstrapStepBase {
  id: string;
  kind: string;
  services?: readonly TopologyServiceRole[];
  after: readonly string[];
}

export interface StartServicesStep extends BootstrapStepBase {
  kind: 'start-services';
  services: readonly TopologyServiceRole[];
}

export interface LoadAnvilStateStep extends BootstrapStepBase {
  kind: 'load-anvil-state';
  service: 'blockchain';
  sourcePath: '/anvil-state.json';
  maxStateBytes: number;
  outputs: readonly BootstrapOutput[];
  reanchorClock: true;
}

export interface DiscoverBeeBootnodeStep extends BootstrapStepBase {
  kind: 'discover-bee-bootnode';
  service: 'bee-queen';
  endpoint: string;
  output: 'bee.queenBootnode';
  maxResponseBytes: number;
}

export interface FormBeePeerMeshStep extends BootstrapStepBase {
  kind: 'form-bee-peer-mesh';
  services: readonly ['bee-queen', 'bee-worker-1', 'bee-worker-2', 'bee-worker-3', 'bee-worker-4'];
  maxResponseBytes: number;
}

export interface AdvanceAnvilChainStep extends BootstrapStepBase {
  kind: 'advance-anvil-chain';
  service: 'blockchain';
  blocks: 160;
}

export interface ProvisionPostageStep extends BootstrapStepBase {
  kind: 'provision-postage';
  service: 'bee-queen';
  minimumStorageBytes: number;
  minimumStorageTtlSeconds: number;
  output: 'storage.postageBatchId';
}

export type ReleaseGuardRole = 'manager' | 'admin' | 'uploader' | 'viewer';

export interface ReleaseGuardSlot {
  role: ReleaseGuardRole;
  id: string;
}

export interface GuardedServiceBinding {
  adapterService: string;
  topologyRole: TopologyServiceRole;
}

export interface FixtureNetworkBinding {
  name: string;
  fixtureId: string;
}

export interface GuardedActivation {
  role: ReleaseGuardRole;
  slot: ReleaseGuardSlot;
  candidateRole: CandidateRole;
  services: readonly string[];
  serviceBindings: readonly GuardedServiceBinding[];
  fixtureNetwork?: FixtureNetworkBinding;
  startsEnrollmentDisabled?: true;
}

export interface ActivateGuardedReleaseStep extends BootstrapStepBase {
  kind: 'activate-guarded-release';
  activationRole: ReleaseGuardRole;
}

export interface SubmitReleaseGuardReceiptsStep extends BootstrapStepBase {
  kind: 'submit-release-guard-receipts';
  endpointTemplate: string;
  authenticatedBy: 'adminInternalApiToken';
  source: 'guard-persisted-receipts';
  mode: 'retry-and-verify';
  slots: readonly ReleaseGuardSlot[];
}

export type BootstrapStep =
  | StartServicesStep
  | LoadAnvilStateStep
  | DiscoverBeeBootnodeStep
  | FormBeePeerMeshStep
  | AdvanceAnvilChainStep
  | ProvisionPostageStep
  | ActivateGuardedReleaseStep
  | SubmitReleaseGuardReceiptsStep;

export type ReadinessProbeId =
  | 'chain'
  | 'blockchain'
  | 'bee'
  | 'srs'
  | 'uploader'
  | 'admin'
  | 'viewer'
  | 'storage'
  | 'callbacks'
  | 'openingFormat'
  | 'browserDecode'
  | 'falseCodec'
  | 'capacity';

export interface ReadinessProbe {
  id: ReadinessProbeId;
  kind:
    | 'chain-identity'
    | 'component-identity'
    | 'storage-control'
    | 'callback-control'
    | 'opening-format-control'
    | 'browser-decode-control'
    | 'false-codec-control'
    | 'capacity-control';
  url: string;
  maxResponseBytes: number;
  expectedIdentity?: string;
  expectedVersion?: string;
  expectedUploaderId?: string;
}

export interface ContinuationTopology {
  schemaVersion: 1;
  fixtureId: string;
  network: string;
  services: readonly ServiceTopology[];
  publishedPorts: readonly PublishedPort[];
  guardedActivations: readonly GuardedActivation[];
  bootstrap: readonly BootstrapStep[];
  readiness: readonly ReadinessProbe[];
}

export interface ReadinessProbeTransport {
  /**
   * Returns normalized evidence derived from the real bounded probe named by the spec.
   * Raw health endpoints do not all expose this common identity shape. The executor owns
   * that translation and must stop reading at maxResponseBytes. This module does not
   * implement the transport or treat fabricated identity fields as runtime evidence.
   */
  probe(probe: ReadinessProbe): Promise<unknown>;
}

const EXPECTED_ROLES: readonly TopologyServiceRole[] = [
  'blockchain',
  'bee-queen',
  'bee-worker-1',
  'bee-worker-2',
  'bee-worker-3',
  'bee-worker-4',
  'postgres',
  'admin-api',
  'admin-web',
  'srs',
  'uploader',
  'viewer',
  'browser',
  'media-sender',
];

const BEE_PORTS = new Map<TopologyServiceRole, readonly [number, number]>([
  ['bee-queen', [1633, 1634]],
  ['bee-worker-1', [1635, 1636]],
  ['bee-worker-2', [1637, 1638]],
  ['bee-worker-3', [1639, 1640]],
  ['bee-worker-4', [1641, 1642]],
]);

const MAX_JSON_BYTES = 64 * 1024;

function candidateRoot(plan: FixturePlan, role: CandidateRole): string {
  const candidate = plan.candidates.find((entry) => entry.role === role);
  if (!candidate) {
    throw new FixtureRefusal(`candidate ${role} is absent from the fixture plan`);
  }
  return candidate.root;
}

function containerFor(plan: FixturePlan, role: TopologyServiceRole): ContainerPlan {
  const matches = plan.resources.filter(
    (resource): resource is ContainerPlan => resource.kind === 'container' && resource.role === role,
  );
  if (matches.length !== 1) {
    throw new FixtureRefusal(`fixture needs exactly one ${role} container`);
  }
  return matches[0];
}

function volumeMount(plan: FixturePlan, role: string, target: string): TopologyMount {
  const volume = plan.resources.find((resource) => resource.kind === 'volume' && resource.role === role);
  if (!volume || volume.kind !== 'volume') {
    throw new FixtureRefusal(`fixture needs the ${role} volume`);
  }
  return { source: { kind: 'volume', role, name: volume.name }, target, readOnly: false };
}

function candidateMount(plan: FixturePlan, role: CandidateRole, relativePath: string, target: string): TopologyMount {
  return {
    source: { kind: 'candidate', role, root: candidateRoot(plan, role), relativePath },
    target,
    readOnly: true,
  };
}

function literal(name: string, value: string): EnvironmentBinding {
  return { name, value: { kind: 'literal', value } };
}

function input(name: string, source: FixtureInput): EnvironmentBinding {
  return { name, value: { kind: 'input', input: source } };
}

function endpoint(name: string, source: keyof FixturePlan['internalEndpoints']): EnvironmentBinding {
  return { name, value: { kind: 'endpoint', endpoint: source } };
}

function bootstrap(name: string, output: BootstrapOutput): EnvironmentBinding {
  return { name, value: { kind: 'bootstrap', output } };
}

function beeCommand(role: TopologyServiceRole): readonly CommandPart[] {
  const ports = BEE_PORTS.get(role);
  if (!ports) {
    throw new FixtureRefusal(`${role} is not a Bee service`);
  }
  const [api, p2p] = ports;
  const common: CommandPart[] = [
    { kind: 'literal', value: 'start' },
    { kind: 'literal', value: '--full-node' },
    { kind: 'literal', value: `--api-addr=:${api}` },
    { kind: 'literal', value: `--p2p-addr=:${p2p}` },
    { kind: 'literal', value: '--blockchain-rpc-endpoint=http://blockchain:8545' },
    { kind: 'literal', value: '--block-time=1' },
    { kind: 'input', input: 'beePassword', prefix: '--password=' },
    { kind: 'literal', value: '--verbosity=5' },
    { kind: 'literal', value: '--network-id=1337' },
    { kind: 'literal', value: '--mainnet=false' },
    { kind: 'literal', value: '--allow-private-cidrs' },
    { kind: 'literal', value: '--welcome-message=continuation-fixture' },
    { kind: 'literal', value: '--cors-allowed-origins=*' },
    { kind: 'literal', value: '--skip-postage-snapshot' },
    { kind: 'literal', value: '--warmup-time=1s' },
    { kind: 'literal', value: '--swap-enable' },
    { kind: 'literal', value: '--swap-initial-deposit=100000000000000000' },
    { kind: 'bootstrap', output: 'chain.postageStampAddress', prefix: '--postage-stamp-address=' },
    { kind: 'bootstrap', output: 'chain.swapPriceOracleAddress', prefix: '--price-oracle-address=' },
    { kind: 'bootstrap', output: 'chain.stakingAddress', prefix: '--staking-address=' },
    { kind: 'bootstrap', output: 'chain.redistributionAddress', prefix: '--redistribution-address=' },
    { kind: 'bootstrap', output: 'chain.swapFactoryAddress', prefix: '--swap-factory-address=' },
    { kind: 'bootstrap', output: 'chain.postageStampStartBlock', prefix: '--postage-stamp-start-block=' },
    { kind: 'bootstrap', output: 'chain.bzzTokenAddress', prefix: '--bzz-token-address=' },
  ];
  if (role !== 'bee-queen') {
    common.push({ kind: 'bootstrap', output: 'bee.queenBootnode', prefix: '--bootnode=' });
  }
  return common;
}

function serviceTopology(plan: FixturePlan, role: TopologyServiceRole): ServiceTopology {
  const container = containerFor(plan, role);
  const base = {
    role,
    container,
    aliases: [role],
    entrypointAssumption: [] as readonly string[],
    entrypointAssumptionStatus: 'runtime-unverified' as const,
    command: [] as readonly CommandPart[],
    environment: [] as readonly EnvironmentBinding[],
    mounts: [] as readonly TopologyMount[],
    ports: [] as readonly TopologyPort[],
    dependsOn: [] as readonly TopologyServiceRole[],
    startAfterReadiness: role === 'media-sender',
  };

  if (role === 'blockchain') {
    return {
      ...base,
      aliases: ['blockchain', 'anvil'],
      entrypointAssumption: ['/bin/sh', '-c'],
      entrypointAssumptionStatus: 'source-verified',
      command: [
        {
          kind: 'literal',
          value: `anvil --host 0.0.0.0 --chain-id ${plan.expectedChainId} --accounts 20 --balance 10000 --block-time 1`,
        },
      ],
      ports: [{ name: 'rpc', containerPort: 8545, protocol: 'tcp' }],
    };
  }
  if (BEE_PORTS.has(role)) {
    const [api, p2p] = BEE_PORTS.get(role)!;
    return {
      ...base,
      entrypointAssumption: ['bee'],
      entrypointAssumptionStatus: 'source-verified',
      command: beeCommand(role),
      ports: [
        { name: 'api', containerPort: api, protocol: 'tcp' },
        { name: 'p2p', containerPort: p2p, protocol: 'tcp' },
      ],
      dependsOn: role === 'bee-queen' ? ['blockchain'] : ['blockchain', 'bee-queen'],
    };
  }
  if (role === 'postgres') {
    return {
      ...base,
      environment: [
        literal('POSTGRES_DB', 'web2admin'),
        literal('POSTGRES_USER', 'web2admin'),
        input('POSTGRES_PASSWORD', 'postgresPassword'),
      ],
      mounts: [volumeMount(plan, 'postgres-data', '/var/lib/postgresql/data')],
      ports: [{ name: 'postgres', containerPort: 5432, protocol: 'tcp' }],
    };
  }
  if (role === 'admin-api') {
    return {
      ...base,
      aliases: ['admin-api', 'api'],
      entrypointAssumption: ['node', 'dist/index.js'],
      entrypointAssumptionStatus: 'source-verified',
      environment: [
        {
          name: 'DATABASE_URL',
          value: {
            kind: 'postgres-url',
            username: 'web2admin',
            password: 'postgresPassword',
            host: 'postgres',
            port: 5432,
            database: 'web2admin',
          },
        },
        literal('WEB2_ADMIN_HOST', '0.0.0.0'),
        literal('WEB2_ADMIN_PORT', '9877'),
        literal('FEED_GATEWAY', 'bee'),
        endpoint('BEE_URL', 'bee'),
        bootstrap('POSTAGE_BATCH_ID', 'storage.postageBatchId'),
        input('FEED_PRIVATE_KEY', 'feedPrivateKey'),
        literal('FEED_TOPIC', 'swarm-stream'),
        input('INTERNAL_API_TOKEN', 'adminInternalApiToken'),
        literal('INGEST_HOST', 'srs'),
        literal('INGEST_SRT_PORT', '10080'),
        literal('INGEST_RTMP_PORT', '1935'),
        input('INGEST_SRT_PASSPHRASE', 'srsPassphrase'),
        literal('INGEST_KEY_VERIFIED', 'true'),
        literal('INGEST_MANAGED_LIFECYCLE_VERSION', '1'),
        literal('INGEST_MANAGED_UPLOADER_ID', FIXTURE_UPLOADER_ID),
      ],
      mounts: [
        {
          source: {
            kind: 'fixture-file',
            role: 'admin-active-artifact',
            path: join(plan.outputRoot, 'active-artifact.json'),
          },
          target: '/run/streaming-release/active-artifact.json',
          readOnly: true,
        },
      ],
      ports: [{ name: 'api', containerPort: 9877, protocol: 'tcp' }],
      dependsOn: ['postgres', 'bee-queen'],
    };
  }
  if (role === 'admin-web') {
    return {
      ...base,
      aliases: ['admin-web'],
      entrypointAssumption: ['/docker-entrypoint.sh', 'nginx', '-g', 'daemon off;'],
      entrypointAssumptionStatus: 'source-verified',
      ports: [{ name: 'http', containerPort: 80, protocol: 'tcp' }],
      dependsOn: ['admin-api'],
    };
  }
  if (role === 'srs') {
    return {
      ...base,
      entrypointAssumption: ['/bin/bash', '/usr/local/srs/conf/entrypoint.sh'],
      entrypointAssumptionStatus: 'source-verified',
      environment: [
        input('SRT_PASSPHRASE', 'srsPassphrase'),
        input('SRS_WEBHOOK_TOKEN', 'srsWebhookToken'),
        literal('SRS_ADAPTER_HOST', 'uploader'),
        literal('SRS_ADAPTER_PORT', '3000'),
        literal('SRS_RTMP_PORT', '1935'),
        literal('SRS_HTTP_PORT', '8080'),
        literal('SRS_SRT_PORT', '10080'),
        literal('SRS_HTTP_API_PORT', '1985'),
        literal('HLS_FRAGMENT', '0.5'),
        literal('HLS_SEGMENT_MAX', '2.5'),
        literal('HLS_WINDOW', '15'),
        literal('SRT_LATENCY', '200'),
        literal('ABR_ENABLED', 'false'),
      ],
      mounts: [
        candidateMount(plan, 'stack', 'engines/srs/entrypoint.sh', '/usr/local/srs/conf/entrypoint.sh'),
        candidateMount(plan, 'stack', 'engines/srs/healthcheck.sh', '/usr/local/srs/conf/healthcheck.sh'),
        candidateMount(plan, 'stack', 'engines/srs/srs.conf.template', '/usr/local/srs/conf/srs.conf.template'),
        volumeMount(plan, 'srs-media', '/usr/local/srs/objs/nginx/html'),
      ].sort((left, right) => left.target.localeCompare(right.target)),
      ports: [
        { name: 'rtmp', containerPort: 1935, protocol: 'tcp' },
        { name: 'api', containerPort: 1985, protocol: 'tcp' },
        { name: 'http', containerPort: 8080, protocol: 'tcp' },
        { name: 'srt', containerPort: 10080, protocol: 'udp' },
      ],
      dependsOn: ['uploader'],
    };
  }
  if (role === 'uploader') {
    return {
      ...base,
      entrypointAssumption: ['node', 'dist/index.js'],
      entrypointAssumptionStatus: 'source-verified',
      environment: [
        endpoint('BEE_URL', 'bee'),
        bootstrap('STAMP', 'storage.postageBatchId'),
        input('STREAM_KEY', 'feedPrivateKey'),
        literal('STREAM_LIST_TOPIC', 'swarm-stream'),
        input('API_AUTH_TOKEN', 'uploaderApiToken'),
        input('SRS_WEBHOOK_TOKEN', 'srsWebhookToken'),
        input('PUBLISH_KEY_SECRET', 'publishKeySecret'),
        endpoint('ADMIN_API_URL', 'admin'),
        input('ADMIN_API_TOKEN', 'adminInternalApiToken'),
        literal('SRS_LIFECYCLE_VERSION', '1'),
        literal('SRS_UPLOADER_ID', FIXTURE_UPLOADER_ID),
        literal('API_PORT', '3000'),
        literal('STATE_DIR', '/app/state'),
        literal('ENGINE', 'srs'),
        literal('SRS_MEDIA_PATH', '/media'),
        literal('UPLOADER_START_GATES', 'refuse'),
      ],
      mounts: [volumeMount(plan, 'uploader-data', '/app/state'), volumeMount(plan, 'srs-media', '/media')],
      ports: [{ name: 'api', containerPort: 3000, protocol: 'tcp' }],
      dependsOn: ['bee-queen', 'admin-api'],
    };
  }
  if (role === 'viewer') {
    return {
      ...base,
      entrypointAssumption: ['/docker-entrypoint.sh', 'nginx', '-g', 'daemon off;'],
      entrypointAssumptionStatus: 'source-verified',
      environment: [literal('BEE_GATEWAY_HOST', 'bee-queen'), literal('BEE_GATEWAY_PORT', '1633')],
      ports: [{ name: 'http', containerPort: 80, protocol: 'tcp' }],
      dependsOn: ['bee-queen'],
    };
  }
  if (role === 'browser') {
    return {
      ...base,
      entrypointAssumption: ['/usr/local/bin/browser-entrypoint.sh'],
      entrypointAssumptionStatus: 'source-verified',
      dependsOn: ['viewer', 'admin-web'],
    };
  }
  if (role === 'media-sender') {
    return {
      ...base,
      environment: [literal('SRS_RTMP_URL', 'rtmp://srs:1935/live'), input('SRT_PASSPHRASE', 'srsPassphrase')],
      dependsOn: ['srs', 'uploader'],
    };
  }
  throw new FixtureRefusal(`unsupported topology role ${String(role)}`);
}

function endpointUrl(plan: FixturePlan, name: keyof FixturePlan['internalEndpoints'], path: string): string {
  return `${plan.internalEndpoints[name]}${path}`;
}

function readinessProbes(plan: FixturePlan): readonly ReadinessProbe[] {
  const stackCommit = plan.candidates.find((entry) => entry.role === 'stack')?.commit;
  const adminCommit = plan.candidates.find((entry) => entry.role === 'admin')?.commit;
  if (!stackCommit || !adminCommit) {
    throw new FixtureRefusal('candidate commits are incomplete');
  }
  return [
    { id: 'chain', kind: 'chain-identity', url: plan.internalEndpoints.rpc, maxResponseBytes: MAX_JSON_BYTES },
    {
      id: 'blockchain',
      kind: 'component-identity',
      url: plan.internalEndpoints.rpc,
      maxResponseBytes: MAX_JSON_BYTES,
      expectedIdentity: 'anvil',
    },
    {
      id: 'bee',
      kind: 'component-identity',
      url: endpointUrl(plan, 'bee', '/health'),
      maxResponseBytes: MAX_JSON_BYTES,
      expectedIdentity: 'bee',
      expectedVersion: '2.8.2',
    },
    {
      id: 'srs',
      kind: 'component-identity',
      url: endpointUrl(plan, 'srs', '/api/v1/versions'),
      maxResponseBytes: MAX_JSON_BYTES,
      expectedIdentity: 'srs',
    },
    {
      id: 'uploader',
      kind: 'component-identity',
      url: endpointUrl(plan, 'uploader', '/health'),
      maxResponseBytes: MAX_JSON_BYTES,
      expectedIdentity: 'stream-uploader',
      expectedVersion: stackCommit,
      expectedUploaderId: FIXTURE_UPLOADER_ID,
    },
    {
      id: 'admin',
      kind: 'component-identity',
      url: endpointUrl(plan, 'admin', '/api/health'),
      maxResponseBytes: MAX_JSON_BYTES,
      expectedIdentity: 'web2-admin',
      expectedVersion: adminCommit,
      expectedUploaderId: FIXTURE_UPLOADER_ID,
    },
    {
      id: 'viewer',
      kind: 'component-identity',
      url: endpointUrl(plan, 'viewer', '/build-stamp.json'),
      maxResponseBytes: MAX_JSON_BYTES,
      expectedIdentity: 'viewer',
      expectedVersion: stackCommit,
    },
    {
      id: 'storage',
      kind: 'storage-control',
      url: endpointUrl(plan, 'bee', '/stamps'),
      maxResponseBytes: MAX_JSON_BYTES,
    },
    {
      id: 'callbacks',
      kind: 'callback-control',
      url: endpointUrl(plan, 'uploader', '/health'),
      maxResponseBytes: MAX_JSON_BYTES,
    },
    {
      id: 'openingFormat',
      kind: 'opening-format-control',
      url: endpointUrl(plan, 'uploader', '/health'),
      maxResponseBytes: MAX_JSON_BYTES,
    },
    {
      id: 'browserDecode',
      kind: 'browser-decode-control',
      url: plan.internalEndpoints.viewer,
      maxResponseBytes: MAX_JSON_BYTES,
    },
    {
      id: 'falseCodec',
      kind: 'false-codec-control',
      url: plan.internalEndpoints.viewer,
      maxResponseBytes: MAX_JSON_BYTES,
    },
    {
      id: 'capacity',
      kind: 'capacity-control',
      url: plan.internalEndpoints.rpc,
      maxResponseBytes: MAX_JSON_BYTES,
    },
  ];
}

function assertEndpoint(plan: FixturePlan, key: keyof FixturePlan['internalEndpoints'], port: number): void {
  const url = new URL(plan.internalEndpoints[key]);
  const role = key === 'rpc' ? 'blockchain' : key === 'bee' ? 'bee-queen' : key === 'admin' ? 'admin-api' : key;
  const container = containerFor(plan, role as TopologyServiceRole);
  const parsedPort = url.port === '' && url.protocol === 'http:' ? 80 : Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== container.name || parsedPort !== port) {
    throw new FixtureRefusal(`${String(key)} endpoint must use ${container.name}:${port}`);
  }
}

function validateTopologyPrerequisites(plan: FixturePlan): void {
  validateFixturePlan(plan);
  for (const role of EXPECTED_ROLES) {
    containerFor(plan, role);
  }
  assertEndpoint(plan, 'rpc', 8545);
  assertEndpoint(plan, 'bee', 1633);
  assertEndpoint(plan, 'admin', 9877);
  assertEndpoint(plan, 'srs', 1985);
  assertEndpoint(plan, 'uploader', 3000);
  assertEndpoint(plan, 'viewer', 80);
  volumeMount(plan, 'srs-media', '/unused');
  const published = new Map(plan.publishedPorts.map((entry) => [entry.role, entry]));
  const expected = new Map<PublishedPort['role'], number>([
    ['blockchain', 8545],
    ['admin', 9877],
    ['viewer', 80],
  ]);
  if (published.size !== expected.size) {
    throw new FixtureRefusal('only blockchain, admin, and viewer may be published');
  }
  for (const [role, port] of expected) {
    const binding = published.get(role);
    if (!binding || binding.host !== '127.0.0.1' || binding.containerPort !== port) {
      throw new FixtureRefusal(`${role} must publish its exact service port on loopback`);
    }
  }
}

export function createContinuationTopology(plan: FixturePlan): ContinuationTopology {
  validateTopologyPrerequisites(plan);
  const services = EXPECTED_ROLES.map((role) => serviceTopology(plan, role));
  const workers = ['bee-worker-1', 'bee-worker-2', 'bee-worker-3', 'bee-worker-4'] as const;
  const fixtureNetwork = { name: plan.network.name, fixtureId: plan.fixtureId };
  const guardedActivations: readonly GuardedActivation[] = [
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
      fixtureNetwork,
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
      fixtureNetwork,
    },
    {
      role: 'uploader',
      slot: { role: 'uploader', id: FIXTURE_UPLOADER_ID },
      candidateRole: 'stack',
      services: ['srs', 'stream-uploader'],
      serviceBindings: [
        { adapterService: 'srs', topologyRole: 'srs' },
        { adapterService: 'stream-uploader', topologyRole: 'uploader' },
      ],
      fixtureNetwork,
    },
  ];
  const bootstrap: readonly BootstrapStep[] = [
    { id: 'start-blockchain', kind: 'start-services', services: ['blockchain'], after: [] },
    {
      id: 'load-chain-state',
      kind: 'load-anvil-state',
      service: 'blockchain',
      sourcePath: '/anvil-state.json',
      maxStateBytes: 16 * 1024 * 1024,
      outputs: [
        'chain.bzzTokenAddress',
        'chain.postageStampAddress',
        'chain.postageStampStartBlock',
        'chain.redistributionAddress',
        'chain.stakingAddress',
        'chain.swapFactoryAddress',
        'chain.swapPriceOracleAddress',
      ],
      reanchorClock: true,
      after: ['start-blockchain'],
    },
    { id: 'start-queen', kind: 'start-services', services: ['bee-queen'], after: ['load-chain-state'] },
    {
      id: 'discover-queen',
      kind: 'discover-bee-bootnode',
      service: 'bee-queen',
      endpoint: `${plan.internalEndpoints.bee}/addresses`,
      output: 'bee.queenBootnode',
      maxResponseBytes: MAX_JSON_BYTES,
      after: ['start-queen'],
    },
    { id: 'start-workers', kind: 'start-services', services: workers, after: ['discover-queen'] },
    {
      id: 'form-peer-mesh',
      kind: 'form-bee-peer-mesh',
      services: ['bee-queen', ...workers],
      maxResponseBytes: MAX_JSON_BYTES,
      after: ['start-workers'],
    },
    {
      id: 'advance-private-chain',
      kind: 'advance-anvil-chain',
      service: 'blockchain',
      blocks: 160,
      after: ['form-peer-mesh'],
    },
    {
      id: 'provision-postage',
      kind: 'provision-postage',
      service: 'bee-queen',
      minimumStorageBytes: plan.minimumStorageBytes,
      minimumStorageTtlSeconds: plan.minimumStorageTtlSeconds,
      output: 'storage.postageBatchId',
      after: ['advance-private-chain'],
    },
    {
      id: 'activate-admin',
      kind: 'activate-guarded-release',
      activationRole: 'admin',
      after: ['provision-postage'],
    },
    {
      id: 'activate-manager',
      kind: 'activate-guarded-release',
      activationRole: 'manager',
      after: ['activate-admin'],
    },
    {
      id: 'activate-viewer',
      kind: 'activate-guarded-release',
      activationRole: 'viewer',
      after: ['activate-manager'],
    },
    {
      id: 'activate-uploader',
      kind: 'activate-guarded-release',
      activationRole: 'uploader',
      after: ['activate-viewer'],
    },
    {
      id: 'submit-release-guard-receipts',
      kind: 'submit-release-guard-receipts',
      endpointTemplate: `${plan.internalEndpoints.admin}/api/internal/release-guard/receipts/:role/:id`,
      authenticatedBy: 'adminInternalApiToken',
      source: 'guard-persisted-receipts',
      mode: 'retry-and-verify',
      slots: guardedActivations.map((activation) => activation.slot),
      after: ['activate-uploader'],
    },
    {
      id: 'start-test-controls',
      kind: 'start-services',
      services: ['browser'],
      after: ['submit-release-guard-receipts'],
    },
  ];
  return {
    schemaVersion: 1,
    fixtureId: plan.fixtureId,
    network: plan.network.name,
    services,
    publishedPorts: [...plan.publishedPorts],
    guardedActivations,
    bootstrap,
    readiness: readinessProbes(plan),
  };
}

function objectFor(id: ReadinessProbeId, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FixtureRefusal(`${id} readiness result is malformed`);
  }
  return value as Record<string, unknown>;
}

function boundedString(id: ReadinessProbeId, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new FixtureRefusal(`${id} readiness ${field} is malformed`);
  }
  return value;
}

function booleanField(id: ReadinessProbeId, field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new FixtureRefusal(`${id} readiness ${field} is malformed`);
  }
  return value;
}

function nonNegativeInteger(id: ReadinessProbeId, field: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new FixtureRefusal(`${id} readiness ${field} is malformed`);
  }
  return value as number;
}

function validateProbeOwnership(topology: ContinuationTopology): void {
  const hosts = new Set<string>();
  for (const service of topology.services) {
    hosts.add(service.container.name);
    for (const alias of service.aliases) {
      hosts.add(alias);
    }
  }
  for (const probe of topology.readiness) {
    let url: URL;
    try {
      url = new URL(probe.url);
    } catch {
      throw new FixtureRefusal(`${probe.id} readiness endpoint is malformed`);
    }
    if (url.protocol !== 'http:' || !hosts.has(url.hostname)) {
      throw new FixtureRefusal(`${probe.id} readiness endpoint is outside the fixture network`);
    }
    if (
      !Number.isSafeInteger(probe.maxResponseBytes) ||
      probe.maxResponseBytes < 1 ||
      probe.maxResponseBytes > MAX_JSON_BYTES
    ) {
      throw new FixtureRefusal(`${probe.id} readiness response bound is invalid`);
    }
  }
}

interface ParsedComponent {
  ready: boolean;
}

function parseComponent(probe: ReadinessProbe, value: unknown): ParsedComponent {
  const result = objectFor(probe.id, value);
  const identity = boundedString(probe.id, 'identity', result.identity);
  if (identity !== probe.expectedIdentity) {
    throw new FixtureRefusal(`${probe.id} readiness identity does not match`);
  }
  const version = boundedString(probe.id, 'version', result.version);
  if (probe.expectedVersion && version !== probe.expectedVersion) {
    throw new FixtureRefusal(`${probe.id} readiness version does not match the candidate`);
  }
  if (probe.id === 'bee' && result.warmingUp !== false) {
    throw new FixtureRefusal('bee readiness still reports warming up');
  }
  if (probe.expectedUploaderId) {
    if (result.lifecycleVersion !== 1) {
      throw new FixtureRefusal(`${probe.id} readiness lifecycle version is not 1`);
    }
    if (result.uploaderId !== probe.expectedUploaderId) {
      throw new FixtureRefusal(`${probe.id} readiness uploader assignment does not match`);
    }
  }
  return { ready: booleanField(probe.id, 'ready', result.ready) };
}

function probeById(topology: ContinuationTopology, id: ReadinessProbeId): ReadinessProbe {
  const matches = topology.readiness.filter((probe) => probe.id === id);
  if (matches.length !== 1) {
    throw new FixtureRefusal(`readiness plan needs exactly one ${id} probe`);
  }
  return matches[0];
}

export async function inspectContinuationReadiness(
  plan: FixturePlan,
  topology: ContinuationTopology,
  transport: ReadinessProbeTransport,
): Promise<ReadinessEvidence> {
  if (topology.fixtureId !== plan.fixtureId || topology.network !== plan.network.name) {
    throw new FixtureRefusal('readiness topology does not belong to this fixture plan');
  }
  validateProbeOwnership(topology);
  const results = new Map<ReadinessProbeId, unknown>();
  for (const probe of topology.readiness) {
    results.set(probe.id, await transport.probe(probe));
  }

  const chain = objectFor('chain', results.get('chain'));
  const chainId = nonNegativeInteger('chain', 'chainId', chain.chainId);
  const chainOwner = boundedString('chain', 'owner', chain.owner);
  if (chainId !== plan.expectedChainId || chainOwner !== plan.fixtureId) {
    throw new FixtureRefusal('chain readiness identity does not belong to this fixture');
  }
  const component = (id: ReadinessProbeId) => parseComponent(probeById(topology, id), results.get(id)).ready;
  const storage = objectFor('storage', results.get('storage'));
  const batchIdHash = boundedString('storage', 'batchIdHash', storage.batchIdHash);
  if (!/^sha256:[0-9a-f]{64}$/.test(batchIdHash)) {
    throw new FixtureRefusal('storage readiness batch fingerprint is malformed');
  }
  const callbacks = objectFor('callbacks', results.get('callbacks'));
  const opening = objectFor('openingFormat', results.get('openingFormat'));
  if (opening.tool !== 'ffprobe' || opening.container !== 'mpegts') {
    throw new FixtureRefusal('openingFormat readiness identity does not match');
  }
  const browser = objectFor('browserDecode', results.get('browserDecode'));
  if (!Array.isArray(browser.codecs) || browser.codecs.length < 1 || browser.codecs.length > 16) {
    throw new FixtureRefusal('browserDecode readiness codecs are malformed');
  }
  for (const codec of browser.codecs) {
    boundedString('browserDecode', 'codec', codec);
  }
  const falseCodec = objectFor('falseCodec', results.get('falseCodec'));
  const capacity = objectFor('capacity', results.get('capacity'));

  return {
    chainId,
    chainOwner,
    components: {
      blockchain: component('blockchain'),
      bee: component('bee'),
      srs: component('srs'),
      uploader: component('uploader'),
      admin: component('admin'),
      viewer: component('viewer'),
    },
    storage: {
      stamp: {
        batchIdHash,
        usable: booleanField('storage', 'usable', storage.usable),
        capacityBytes: nonNegativeInteger('storage', 'capacityBytes', storage.capacityBytes),
        ttlSeconds: nonNegativeInteger('storage', 'ttlSeconds', storage.ttlSeconds),
      },
      controlRoundTrip: booleanField('storage', 'controlRoundTrip', storage.controlRoundTrip),
    },
    callbacksReachUploader: booleanField('callbacks', 'reachedUploader', callbacks.reachedUploader),
    openingFormatVerified: booleanField('openingFormat', 'verified', opening.verified),
    browserDecodedMedia: booleanField('browserDecode', 'decodedMedia', browser.decodedMedia),
    falseCodecControlRefused: booleanField('falseCodec', 'refused', falseCodec.refused),
    capacityAvailable: booleanField('capacity', 'available', capacity.available),
  };
}
