import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export const FIXTURE_LABEL = 'org.solarpunk.srs-continuation.fixture';
export const MANAGED_LABEL = 'org.solarpunk.srs-continuation.managed';

const FIXTURE_ID_RE = /^srs-continuation-20260920-[a-z0-9]{8,16}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const BEE_IMAGE_RE = /^docker\.io\/ethersphere\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/;

const BEE_IMAGES = {
  blockchain:
    'docker.io/ethersphere/bee-factory-blockchain@sha256:d63e15b7e5e71159a23a09835f89ba46913d4ba3fb8dd31b90ceaca2e9363d08',
  beeQueen:
    'docker.io/ethersphere/bee-factory-queen@sha256:60bf85b9938da1c9309dd8bb9c0b691963d30338fa2c5d7e75d7a012fdaa5ab4',
  beeWorker1:
    'docker.io/ethersphere/bee-factory-worker-1@sha256:14711443c3de2bae815b7e545b7c6863d397f5ea3527d7490b80ffdd165c631a',
  beeWorker2:
    'docker.io/ethersphere/bee-factory-worker-2@sha256:45ee131a0a53f84ded6c0d57ed74be9dc4b0d8236eb7a9ece9b4a4adb257fd55',
  beeWorker3:
    'docker.io/ethersphere/bee-factory-worker-3@sha256:3d67f8f183f6b15d561cc3d1cebf8ee4c008cfa9c1d9d2e6b345e006bb8e8a64',
  beeWorker4:
    'docker.io/ethersphere/bee-factory-worker-4@sha256:d773d6e0ef3a22b71d8f22d5e9780e66cff4517d1a420a38e09a404a2b621633',
} as const;

export type CandidateRole = 'stack' | 'admin' | 'manager';

export interface Candidate {
  role: CandidateRole;
  root: string;
  commit: string;
}

export interface CandidateImages {
  postgres: string;
  srs: string;
  uploader: string;
  adminApi: string;
  adminWeb: string;
  viewer: string;
  mediaSender: string;
  browser: string;
}

export interface PublishedPort {
  role: 'blockchain' | 'admin' | 'viewer';
  host: '127.0.0.1';
  hostPort: number;
  containerPort: number;
}

export type ResourceKind = 'container' | 'network' | 'volume';

interface ResourcePlanBase {
  kind: ResourceKind;
  name: string;
  role: string;
  labels: Readonly<Record<string, string>>;
}

export interface NetworkPlan extends ResourcePlanBase {
  kind: 'network';
  internal: true;
}

export interface VolumePlan extends ResourcePlanBase {
  kind: 'volume';
}

export interface ContainerPlan extends ResourcePlanBase {
  kind: 'container';
  image: string;
  phase: 'infrastructure' | 'media-sender';
}

export type FixtureResourcePlan = NetworkPlan | VolumePlan | ContainerPlan;

export interface FixturePlan {
  schemaVersion: 1;
  fixtureId: string;
  outputRoot: string;
  candidates: readonly Candidate[];
  network: NetworkPlan;
  resources: readonly FixtureResourcePlan[];
  publishedPorts: readonly PublishedPort[];
  internalEndpoints: Readonly<Record<string, string>>;
  expectedChainId: number;
  minimumStorageBytes: number;
  minimumStorageTtlSeconds: number;
}

export interface CreateFixturePlanInput {
  fixtureId: string;
  outputRoot: string;
  candidates: readonly Candidate[];
  candidateImages: CandidateImages;
  loopbackPorts: { rpc: number; admin: number; viewer: number };
  minimumStorageBytes: number;
  minimumStorageTtlSeconds: number;
  expectedChainId: number;
}

export interface InspectedResource {
  kind: ResourceKind;
  id: string;
  name: string;
  labels: Record<string, string>;
}

export interface FixtureDocker {
  findExact(kind: ResourceKind, name: string): Promise<InspectedResource | null>;
  create(
    kind: ResourceKind,
    name: string,
    labels: Readonly<Record<string, string>>,
    plan?: FixtureResourcePlan,
  ): Promise<InspectedResource>;
  startContainer(id: string): Promise<void>;
  inspect(kind: ResourceKind, id: string): Promise<InspectedResource | null>;
  remove(kind: ResourceKind, id: string): Promise<void>;
}

export interface CandidateVerifier {
  inspect(root: string): Promise<{ commit: string; clean: boolean }>;
}

export interface PortProbe {
  isAvailable(port: number): Promise<boolean>;
}

export interface ReadinessEvidence {
  chainId: number;
  chainOwner: string;
  components: {
    blockchain: boolean;
    bee: boolean;
    srs: boolean;
    uploader: boolean;
    admin: boolean;
    viewer: boolean;
  };
  storage: {
    stamp: {
      batchIdHash: string;
      usable: boolean;
      capacityBytes: number;
      ttlSeconds: number;
    };
    controlRoundTrip: boolean;
  };
  callbacksReachUploader: boolean;
  openingFormatVerified: boolean;
  browserDecodedMedia: boolean;
  falseCodecControlRefused: boolean;
  capacityAvailable: boolean;
}

export interface FixtureHttp {
  inspectReadiness(plan: FixturePlan): Promise<ReadinessEvidence>;
}

export type StageStatus = 'planned' | 'skipped' | 'passed' | 'failed';

export interface StageRecord {
  name: string;
  status: StageStatus;
  command: readonly string[];
  stdout: string;
  stderr: string;
}

export interface ResourceJournalDocument {
  schemaVersion: 1;
  fixtureId: string;
  candidates: readonly Candidate[];
  resources: InspectedResource[];
  intents: ResourceIntent[];
  stages: StageRecord[];
  readiness?: ReadinessEvidence;
}

export interface ResourceIntent {
  kind: ResourceKind;
  name: string;
  labels: Record<string, string>;
  status: 'planned' | 'created' | 'absent';
  id?: string;
}

export class FixtureRefusal extends Error {}

function fixtureLabels(fixtureId: string): Readonly<Record<string, string>> {
  return { [FIXTURE_LABEL]: fixtureId, [MANAGED_LABEL]: 'true' };
}

function resourceName(fixtureId: string, role: string): string {
  return `${fixtureId}-${role}`;
}

function container(
  fixtureId: string,
  role: string,
  image: string,
  phase: ContainerPlan['phase'] = 'infrastructure',
): ContainerPlan {
  return {
    kind: 'container',
    name: resourceName(fixtureId, role),
    role,
    labels: fixtureLabels(fixtureId),
    image,
    phase,
  };
}

function volume(fixtureId: string, role: string): VolumePlan {
  return {
    kind: 'volume',
    name: resourceName(fixtureId, role),
    role,
    labels: fixtureLabels(fixtureId),
  };
}

export function createFixturePlan(input: CreateFixturePlanInput): FixturePlan {
  const network: NetworkPlan = {
    kind: 'network',
    name: resourceName(input.fixtureId, 'network'),
    role: 'network',
    labels: fixtureLabels(input.fixtureId),
    internal: true,
  };
  const containers: ContainerPlan[] = [
    container(input.fixtureId, 'blockchain', BEE_IMAGES.blockchain),
    container(input.fixtureId, 'bee-queen', BEE_IMAGES.beeQueen),
    container(input.fixtureId, 'bee-worker-1', BEE_IMAGES.beeWorker1),
    container(input.fixtureId, 'bee-worker-2', BEE_IMAGES.beeWorker2),
    container(input.fixtureId, 'bee-worker-3', BEE_IMAGES.beeWorker3),
    container(input.fixtureId, 'bee-worker-4', BEE_IMAGES.beeWorker4),
    container(input.fixtureId, 'postgres', input.candidateImages.postgres),
    container(input.fixtureId, 'admin-api', input.candidateImages.adminApi),
    container(input.fixtureId, 'admin-web', input.candidateImages.adminWeb),
    container(input.fixtureId, 'srs', input.candidateImages.srs),
    container(input.fixtureId, 'uploader', input.candidateImages.uploader),
    container(input.fixtureId, 'viewer', input.candidateImages.viewer),
    container(input.fixtureId, 'browser', input.candidateImages.browser),
    container(input.fixtureId, 'media-sender', input.candidateImages.mediaSender, 'media-sender'),
  ];
  const volumes = [
    'blockchain-data',
    'bee-queen-data',
    'bee-worker-1-data',
    'bee-worker-2-data',
    'bee-worker-3-data',
    'bee-worker-4-data',
    'postgres-data',
    'uploader-data',
  ].map((role) => volume(input.fixtureId, role));
  const publishedPorts: PublishedPort[] = [
    {
      role: 'blockchain',
      host: '127.0.0.1',
      hostPort: input.loopbackPorts.rpc,
      containerPort: 8545,
    },
    {
      role: 'admin',
      host: '127.0.0.1',
      hostPort: input.loopbackPorts.admin,
      containerPort: 3000,
    },
    {
      role: 'viewer',
      host: '127.0.0.1',
      hostPort: input.loopbackPorts.viewer,
      containerPort: 80,
    },
  ];
  const internalEndpoints = {
    rpc: `http://${resourceName(input.fixtureId, 'blockchain')}:8545`,
    bee: `http://${resourceName(input.fixtureId, 'bee-queen')}:1633`,
    admin: `http://${resourceName(input.fixtureId, 'admin-api')}:3000`,
    srs: `http://${resourceName(input.fixtureId, 'srs')}:1985`,
    uploader: `http://${resourceName(input.fixtureId, 'uploader')}:3000`,
    viewer: `http://${resourceName(input.fixtureId, 'viewer')}:80`,
  };

  const plan: FixturePlan = {
    schemaVersion: 1,
    fixtureId: input.fixtureId,
    outputRoot: input.outputRoot,
    candidates: [...input.candidates],
    network,
    resources: [network, ...volumes, ...containers],
    publishedPorts,
    internalEndpoints,
    expectedChainId: input.expectedChainId,
    minimumStorageBytes: input.minimumStorageBytes,
    minimumStorageTtlSeconds: input.minimumStorageTtlSeconds,
  };
  validateFixturePlan(plan);
  return plan;
}

export function validateFixturePlan(plan: FixturePlan): void {
  if (!FIXTURE_ID_RE.test(plan.fixtureId)) {
    throw new FixtureRefusal('fixtureId is not a bounded continuation fixture identity');
  }
  if (!isAbsolute(plan.outputRoot) || basename(plan.outputRoot) !== plan.fixtureId) {
    throw new FixtureRefusal('outputRoot must be an absolute directory named for fixtureId');
  }
  if (!Number.isSafeInteger(plan.expectedChainId) || plan.expectedChainId < 1) {
    throw new FixtureRefusal('the fixture chain identity must be a positive integer');
  }
  const candidateRoles = new Set(plan.candidates.map((candidate) => candidate.role));
  if (
    plan.candidates.length !== 3 ||
    !['stack', 'admin', 'manager'].every((role) => candidateRoles.has(role as CandidateRole))
  ) {
    throw new FixtureRefusal('stack, admin, and manager candidates are all required exactly once');
  }
  for (const candidate of plan.candidates) {
    if (!isAbsolute(candidate.root) || !COMMIT_RE.test(candidate.commit)) {
      throw new FixtureRefusal(`candidate ${candidate.role} needs an absolute root and exact commit`);
    }
  }
  const names = new Set<string>();
  for (const resource of plan.resources) {
    if (names.has(resource.name)) {
      throw new FixtureRefusal(`duplicate resource ${resource.name}`);
    }
    names.add(resource.name);
    if (!resource.name.startsWith(`${plan.fixtureId}-`)) {
      throw new FixtureRefusal(`resource ${resource.name} is outside the fixture identity`);
    }
    if (resource.labels[FIXTURE_LABEL] !== plan.fixtureId || resource.labels[MANAGED_LABEL] !== 'true') {
      throw new FixtureRefusal(`resource ${resource.name} lacks exact fixture labels`);
    }
    if (resource.kind === 'container') {
      if (!IMAGE_ID_RE.test(resource.image) && !BEE_IMAGE_RE.test(resource.image)) {
        throw new FixtureRefusal(`container ${resource.name} does not use an immutable image`);
      }
    }
  }
  const hostPorts = new Set<number>();
  for (const binding of plan.publishedPorts) {
    if (binding.host !== '127.0.0.1') {
      throw new FixtureRefusal('fixture endpoints may be published only on loopback');
    }
    if (!Number.isSafeInteger(binding.hostPort) || binding.hostPort < 1 || binding.hostPort > 65_535) {
      throw new FixtureRefusal(`invalid loopback port ${binding.hostPort}`);
    }
    if (hostPorts.has(binding.hostPort)) {
      throw new FixtureRefusal(`loopback port ${binding.hostPort} is assigned twice`);
    }
    hostPorts.add(binding.hostPort);
  }
  for (const [role, endpoint] of Object.entries(plan.internalEndpoints)) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !names.has(url.hostname)) {
      throw new FixtureRefusal(`${role} endpoint is not owned by this fixture network`);
    }
  }
  if (
    !Number.isSafeInteger(plan.minimumStorageBytes) ||
    plan.minimumStorageBytes < 1 ||
    !Number.isSafeInteger(plan.minimumStorageTtlSeconds) ||
    plan.minimumStorageTtlSeconds < 1
  ) {
    throw new FixtureRefusal('storage capacity and lifetime minima must be positive integers');
  }
}

export class ResourceJournal {
  readonly path: string;

  constructor(readonly outputRoot: string) {
    this.path = join(outputRoot, 'resources.json');
  }

  initialize(plan: FixturePlan, stages: readonly StageRecord[]): void {
    mkdirSync(this.outputRoot, { recursive: false, mode: 0o700 });
    this.write({
      schemaVersion: 1,
      fixtureId: plan.fixtureId,
      candidates: plan.candidates,
      resources: [],
      intents: [],
      stages: [...stages],
    });
  }

  read(): ResourceJournalDocument {
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new FixtureRefusal('resource journal is not a regular file');
    }
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as ResourceJournalDocument;
    if (parsed.schemaVersion !== 1 || !FIXTURE_ID_RE.test(parsed.fixtureId)) {
      throw new FixtureRefusal('resource journal is malformed or unsupported');
    }
    return parsed;
  }

  recordResource(resource: InspectedResource): void {
    const document = this.read();
    const intent = document.intents.find((entry) => entry.kind === resource.kind && entry.name === resource.name);
    if (!intent || intent.status !== 'planned') {
      throw new FixtureRefusal(`resource ${resource.name} has no unresolved creation intent`);
    }
    intent.status = 'created';
    intent.id = resource.id;
    document.resources.push({
      ...resource,
      labels: { ...resource.labels },
    });
    this.write(document);
  }

  planResource(resource: FixtureResourcePlan): void {
    const document = this.read();
    if (document.intents.some((intent) => intent.kind === resource.kind && intent.name === resource.name)) {
      throw new FixtureRefusal(`resource ${resource.name} already has a creation intent`);
    }
    document.intents.push({
      kind: resource.kind,
      name: resource.name,
      labels: { ...resource.labels },
      status: 'planned',
    });
    this.write(document);
  }

  recordAbsent(intent: ResourceIntent): void {
    const document = this.read();
    const pending = document.intents.find((entry) => entry.kind === intent.kind && entry.name === intent.name);
    if (!pending || pending.status !== 'planned') {
      throw new FixtureRefusal(`resource ${intent.name} has no unresolved creation intent`);
    }
    pending.status = 'absent';
    this.write(document);
  }

  recordStage(stage: StageRecord): void {
    const document = this.read();
    document.stages.push({ ...stage, command: [...stage.command] });
    this.write(document);
  }

  recordReadiness(readiness: ReadinessEvidence): void {
    const document = this.read();
    document.readiness = structuredClone(readiness);
    this.write(document);
  }

  private write(document: ResourceJournalDocument): void {
    const temporary = `${this.path}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    const directoryFd = openSync(dirname(this.path), 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}

function stage(
  name: string,
  status: StageStatus,
  command: readonly string[] = [],
  stdout = '',
  stderr = '',
): StageRecord {
  return { name, status, command, stdout, stderr };
}

function readinessRefusal(plan: FixturePlan, evidence: ReadinessEvidence): string | null {
  if (evidence.chainId !== plan.expectedChainId || evidence.chainOwner !== plan.fixtureId) {
    return 'private chain endpoint or identity does not belong to this fixture';
  }
  const unavailable = Object.entries(evidence.components)
    .filter(([, ready]) => !ready)
    .map(([name]) => name);
  if (unavailable.length > 0) {
    return `components are not ready: ${unavailable.join(', ')}`;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(evidence.storage.stamp.batchIdHash)) {
    return 'test storage stamp evidence is missing its bounded batch fingerprint';
  }
  if (!evidence.storage.stamp.usable) {
    return 'test storage is not usable';
  }
  if (evidence.storage.stamp.capacityBytes < plan.minimumStorageBytes) {
    return 'test storage capacity is below the scenario minimum';
  }
  if (evidence.storage.stamp.ttlSeconds < plan.minimumStorageTtlSeconds) {
    return 'test storage lifetime is below the scenario minimum';
  }
  if (!evidence.storage.controlRoundTrip) {
    return 'test storage upload/read control failed';
  }
  if (!evidence.callbacksReachUploader) {
    return 'SRS callbacks do not reach the candidate uploader';
  }
  if (!evidence.openingFormatVerified) {
    return 'opening media format control did not pass';
  }
  if (!evidence.browserDecodedMedia) {
    return 'browser decode control did not pass';
  }
  if (!evidence.falseCodecControlRefused) {
    return 'false codec control was not refused';
  }
  if (!evidence.capacityAvailable) {
    return 'host capacity preflight did not pass';
  }
  return null;
}

export interface MediaFixtureRunnerOptions {
  plan: FixturePlan;
  docker: FixtureDocker;
  candidates: CandidateVerifier;
  ports: PortProbe;
  http: FixtureHttp;
  journal: ResourceJournal;
}

const STAGE_NAMES = [
  'candidate-preflight',
  'collision-preflight',
  'create-infrastructure',
  'readiness-preflight',
  'start-media-sender',
] as const;

export class MediaFixtureRunner {
  constructor(private readonly options: MediaFixtureRunnerOptions) {
    validateFixturePlan(options.plan);
    if (options.journal.outputRoot !== options.plan.outputRoot) {
      throw new FixtureRefusal('journal output root does not match the fixture plan');
    }
  }

  plannedStages(): readonly StageRecord[] {
    return STAGE_NAMES.map((name) => stage(name, 'planned'));
  }

  async up(): Promise<void> {
    const { candidates, docker, http, journal, plan, ports } = this.options;
    const completed: StageRecord[] = [];
    for (const candidate of plan.candidates) {
      const actual = await candidates.inspect(candidate.root);
      if (actual.commit !== candidate.commit) {
        throw new FixtureRefusal(`candidate ${candidate.role} changed from ${candidate.commit} to ${actual.commit}`);
      }
      if (!actual.clean) {
        throw new FixtureRefusal(`candidate ${candidate.role} has uncommitted changes`);
      }
    }
    completed.push(stage('candidate-preflight', 'passed'));

    for (const resource of plan.resources) {
      if (await docker.findExact(resource.kind, resource.name)) {
        throw new FixtureRefusal(`resource ${resource.name} already exists`);
      }
    }
    for (const binding of plan.publishedPorts) {
      if (!(await ports.isAvailable(binding.hostPort))) {
        throw new FixtureRefusal(`loopback port ${binding.hostPort} is already occupied`);
      }
    }
    completed.push(stage('collision-preflight', 'passed'));
    journal.initialize(plan, completed);

    try {
      for (const resource of plan.resources) {
        journal.planResource(resource);
        let created: InspectedResource;
        try {
          created = await docker.create(resource.kind, resource.name, resource.labels, resource);
        } catch (error) {
          throw new FixtureRefusal(
            `creation outcome for ${resource.name} is unresolved and requires exact-name recovery`,
            { cause: error },
          );
        }
        if (created.kind !== resource.kind || created.name !== resource.name || !created.id) {
          throw new FixtureRefusal(`Docker returned the wrong identity for ${resource.name}`);
        }
        try {
          journal.recordResource(created);
        } catch (error) {
          throw new FixtureRefusal(`created ${resource.name} but its journal intent remains unresolved`, {
            cause: error,
          });
        }
        if (resource.kind === 'container' && resource.phase === 'infrastructure') {
          await docker.startContainer(created.id);
        }
      }
      journal.recordStage(stage('create-infrastructure', 'passed'));
    } catch (error) {
      journal.recordStage(stage('create-infrastructure', 'failed', [], '', String(error)));
      throw error;
    }

    const evidence = await http.inspectReadiness(plan);
    journal.recordReadiness(evidence);
    const refusal = readinessRefusal(plan, evidence);
    if (refusal) {
      journal.recordStage(stage('readiness-preflight', 'failed', [], '', refusal));
      journal.recordStage(stage('start-media-sender', 'skipped'));
      throw new FixtureRefusal(refusal);
    }
    journal.recordStage(stage('readiness-preflight', 'passed'));

    const senderPlan = plan.resources.find(
      (resource) => resource.kind === 'container' && resource.phase === 'media-sender',
    );
    if (!senderPlan) {
      throw new FixtureRefusal('media sender is absent from the fixture plan');
    }
    const sender = journal.read().resources.find((resource) => resource.name === senderPlan.name);
    if (!sender || sender.kind !== 'container') {
      throw new FixtureRefusal('media sender was not recorded before start');
    }
    await docker.startContainer(sender.id);
    journal.recordStage(stage('start-media-sender', 'passed'));
  }
}

export async function cleanupFixture(journal: ResourceJournal, docker: FixtureDocker): Promise<void> {
  const document = journal.read();
  const unresolved = document.intents.filter((intent) => intent.status === 'planned');
  if (unresolved.length > 0) {
    throw new FixtureRefusal(
      `cleanup refused with unresolved creation intent for ${unresolved.map((intent) => intent.name).join(', ')}`,
    );
  }
  const existing: InspectedResource[] = [];
  for (const recorded of document.resources) {
    const actual = await docker.inspect(recorded.kind, recorded.id);
    if (!actual) {
      continue;
    }
    if (
      actual.id !== recorded.id ||
      actual.name !== recorded.name ||
      actual.labels[FIXTURE_LABEL] !== document.fixtureId ||
      actual.labels[MANAGED_LABEL] !== 'true'
    ) {
      throw new FixtureRefusal(`resource ${recorded.id} label or identity does not match the journal`);
    }
    existing.push(actual);
  }
  for (const resource of existing.reverse()) {
    await docker.remove(resource.kind, resource.id);
  }
}

export async function resolveCreationIntents(journal: ResourceJournal, docker: FixtureDocker): Promise<void> {
  const document = journal.read();
  for (const intent of document.intents.filter((entry) => entry.status === 'planned')) {
    const actual = await docker.findExact(intent.kind, intent.name);
    if (!actual) {
      journal.recordAbsent(intent);
      continue;
    }
    if (
      actual.name !== intent.name ||
      actual.kind !== intent.kind ||
      actual.labels[FIXTURE_LABEL] !== document.fixtureId ||
      actual.labels[MANAGED_LABEL] !== 'true'
    ) {
      throw new FixtureRefusal(`unresolved resource ${intent.name} does not have the full fixture identity`);
    }
    journal.recordResource(actual);
  }
}
