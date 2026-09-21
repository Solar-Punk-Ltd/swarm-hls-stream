import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { type ManagedFixtureStreamSession, provisionManagedFixtureStream } from './adminFixture.js';
import { type BoundedCommand, DockerCliFixture, ExecFileCommand } from './dockerCli.js';
import type { ContinuationFixtureRunSteps } from './executor.js';
import {
  assertFixtureReadiness,
  type ContainerPlan,
  type FixturePlan,
  FixtureRefusal,
  type InspectedResource,
  type ReadinessEvidence,
  ResourceJournal,
  validateFixturePlan,
} from './fixture.js';
import { GuardedResourceInventory } from './guardedResources.js';
import { FetchManagerProfileClient } from './managerProfile.js';
import { captureContinuationMeasurements } from './measurements.js';
import { DockerMediaScenarioSpawn, LoopbackMediaScenarioFetch } from './mediaRuntime.js';
import {
  type MediaScenarioEvidence,
  type ReconnectAcceptanceEvidence,
  runContinuationMediaScenario,
  runReconnectAcceptanceScenario,
} from './mediaScenario.js';
import { type PrivateChainProvisioningResult, provisionPrivateChain } from './privateChain.js';
import {
  GuardedApplicationProvisioner,
  type GuardReceiptVerifier,
  type ReleaseFixtureTargets,
  SpawnBoundedProcess,
  validateReleaseFixtureTargets,
} from './provisioner.js';
import {
  DockerReadinessObservationSource,
  type ReadinessControlExecutor,
  type RuntimeContainerBinding,
} from './readinessSource.js';
import { ObservedReadinessTransport } from './readinessTransport.js';
import { type ResolvedFixtureRuntime, resolveFixtureRuntime } from './runtimeBindings.js';
import {
  type ContinuationTopology,
  createContinuationBootstrap,
  createContinuationTopology,
  inspectContinuationReadiness,
  type ReleaseGuardRole,
  type TopologyServiceRole,
} from './topology.js';

const POSTAGE_BATCH_ID = /^(?:0x)?[0-9a-fA-F]{64}$/;

export type ContinuationScenario = 'cumulative' | 'reconnect';

export type ScenarioEvidenceMetadata =
  | { evidenceScope: 'cumulative-media-observation' }
  | {
      evidenceScope: 'reconnect-controller-observation';
      remainingWitness: 'srs_on_publish_response_code_1';
    };

export function scenarioEvidenceMetadata(scenario: ContinuationScenario): ScenarioEvidenceMetadata {
  return scenario === 'reconnect'
    ? {
        evidenceScope: 'reconnect-controller-observation',
        remainingWitness: 'srs_on_publish_response_code_1',
      }
    : { evidenceScope: 'cumulative-media-observation' };
}

export interface ContinuationFixtureRuntimeConfiguration {
  scenario: ContinuationScenario;
  plan: FixturePlan;
  targets: ReleaseFixtureTargets;
  managerUsername: string;
  adminUsername: string;
}

export interface ContinuationFixtureRuntimeSecrets {
  beePassword: string;
  managerPassword: string;
  adminPassword: string;
  feedPrivateKey: string;
  srtPassphrase: string;
}

export interface FixtureControlFactoryInput {
  plan: FixturePlan;
  topology: ContinuationTopology;
  runtime: ResolvedFixtureRuntime;
  postageBatchId: string;
  readinessStreamTopic: string;
}

export type FixtureControlFactory = (input: FixtureControlFactoryInput) => ReadinessControlExecutor;

export interface ContinuationFixtureRuntimeDependencies {
  command?: BoundedCommand;
  createControls: FixtureControlFactory;
}

/** Binds the reviewed provisioners and probes to the ordered public fixture command. */
export class ContinuationFixtureRuntime implements ContinuationFixtureRunSteps {
  private readonly command: BoundedCommand;
  private readonly process = new SpawnBoundedProcess();
  private readonly journal: ResourceJournal;
  private readonly docker: DockerCliFixture;
  private privateChain?: PrivateChainProvisioningResult;
  private rawContainers?: Map<TopologyServiceRole, RuntimeContainerBinding>;
  private topology?: ContinuationTopology;
  private runtime?: ResolvedFixtureRuntime;
  private stream?: ManagedFixtureStreamSession;
  private readiness?: ReadinessEvidence;
  private mediaSpawn?: DockerMediaScenarioSpawn;

  constructor(
    private readonly configuration: ContinuationFixtureRuntimeConfiguration,
    private readonly secrets: ContinuationFixtureRuntimeSecrets,
    private readonly dependencies: ContinuationFixtureRuntimeDependencies,
  ) {
    validateFixturePlan(configuration.plan);
    validateReleaseFixtureTargets(configuration.plan, configuration.targets);
    validateSecrets(secrets);
    this.command = dependencies.command ?? new ExecFileCommand();
    this.journal = new ResourceJournal(configuration.plan.outputRoot);
    this.docker = new DockerCliFixture(configuration.plan, this.command);
  }

  async preflight(): Promise<void> {
    for (const candidate of this.configuration.plan.candidates) {
      const [commit, status] = await Promise.all([
        this.command.run('git', ['-C', candidate.root, 'rev-parse', 'HEAD']),
        this.command.run('git', ['-C', candidate.root, 'status', '--porcelain=v1', '--untracked-files=all']),
      ]);
      if (commit.stdout.trim() !== candidate.commit || status.stdout.trim() !== '') {
        throw new FixtureRefusal(`candidate ${candidate.role} is not the frozen clean commit`);
      }
    }
    for (const resource of this.configuration.plan.resources) {
      if (await this.docker.findExact(resource.kind, resource.name)) {
        throw new FixtureRefusal(`resource ${resource.name} already exists`);
      }
    }
    await this.assertReleaseTargetsUnused();
    const targetPorts = new Set([
      ...this.configuration.plan.publishedPorts.map(({ hostPort }) => hostPort),
      this.configuration.targets.manager.postgresPort,
      this.configuration.targets.manager.webPort,
    ]);
    for (const port of targetPorts) {
      if (!(await loopbackPortAvailable(port))) {
        throw new FixtureRefusal(`loopback port ${port} is already occupied`);
      }
    }
  }

  async initializeJournal(): Promise<void> {
    this.journal.initialize(this.configuration.plan, [
      stage('candidate-preflight', 'passed'),
      stage('collision-preflight', 'passed'),
    ]);
  }

  async provisionPrivateChain(): Promise<void> {
    const bootstrap = createContinuationBootstrap(this.configuration.plan);
    this.privateChain = await provisionPrivateChain(
      { plan: this.configuration.plan, bootstrap, beePassword: this.secrets.beePassword },
      { journal: this.journal, docker: this.docker, process: this.process },
    );
    this.rawContainers = new Map(this.privateChain.rawContainers);
    await this.createCompanion('browser', false);
    await this.createCompanion('media-sender', false);
  }

  async provisionApplications(): Promise<void> {
    const plan = this.configuration.plan;
    const targets = this.configuration.targets;
    const profiles = new FetchManagerProfileClient({
      baseUrl: `http://127.0.0.1:${targets.manager.webPort}`,
      username: this.configuration.managerUsername,
      password: this.secrets.managerPassword,
      maximumPolls: 600,
    });
    const receipts: GuardReceiptVerifier = {
      inspectGuard: async (role) => {
        const runtime = await this.resolveCurrentRuntime();
        const source = new DockerReadinessObservationSource(this.command, runtime.readiness, refusingControls());
        return source.inspectGuard(role);
      },
    };
    const provisioner = new GuardedApplicationProvisioner({
      plan,
      targets,
      process: this.process,
      profiles,
      receipts,
      journal: this.journal,
      resources: new GuardedResourceInventory(plan.fixtureId, targets, this.journal, this.docker),
      managerUsername: this.configuration.managerUsername,
      managerPassword: this.secrets.managerPassword,
      feedPrivateKey: this.secrets.feedPrivateKey,
      postageBatchId: this.postageBatchId(),
    });
    this.topology = await provisioner.provision();
    const browser = this.requireRawContainer('browser');
    await this.docker.startContainer(browser.id);
  }

  async resolveRuntime(): Promise<void> {
    this.runtime = await this.resolveCurrentRuntime();
  }

  async provisionManagedStream(): Promise<void> {
    const runtime = this.requireRuntime();
    const uploaderId = uploaderSlot(this.requireTopology());
    const api = runtime.readiness.containers.get('admin-api');
    if (!api) {
      throw new FixtureRefusal('admin API runtime binding is missing');
    }
    this.stream = await provisionManagedFixtureStream(
      {
        fixtureId: this.configuration.plan.fixtureId,
        uploaderId,
        apiContainerId: api.id,
        adminBaseUrl: `http://127.0.0.1:${this.configuration.targets.admin.webPort}`,
        username: this.configuration.adminUsername,
        password: this.secrets.adminPassword,
      },
      { process: this.process },
    );
  }

  async inspectReadiness(): Promise<void> {
    const runtime = this.requireRuntime();
    const topology = this.requireTopology();
    const stream = this.requireStream();
    const controls = this.dependencies.createControls({
      plan: this.configuration.plan,
      topology,
      runtime,
      postageBatchId: this.postageBatchId(),
      readinessStreamTopic: stream.stream.topic,
    });
    const source = new DockerReadinessObservationSource(this.command, runtime.readiness, controls);
    const transport = new ObservedReadinessTransport(this.configuration.plan, topology, source);
    this.readiness = await inspectContinuationReadiness(this.configuration.plan, topology, transport);
    assertFixtureReadiness(this.configuration.plan, this.readiness);
    this.journal.recordReadiness(this.readiness);
  }

  async captureMeasurements(phase: 'before' | 'after'): Promise<void> {
    const runtime = this.requireRuntime();
    await captureContinuationMeasurements(this.command, {
      fixtureId: this.configuration.plan.fixtureId,
      outputRoot: this.configuration.plan.outputRoot,
      phase,
      probeContainerId: runtime.readiness.probeContainerId,
      containers: runtime.readiness.containers,
    });
  }

  async startMediaSender(): Promise<void> {
    await this.docker.startContainer(this.requireRawContainer('media-sender').id);
  }

  async runMediaScenario(): Promise<MediaScenarioEvidence | ReconnectAcceptanceEvidence> {
    const runtime = this.requireRuntime();
    const stream = this.requireStream();
    const sender = this.requireRawContainer('media-sender');
    const ownerReference = 'fixture-owner-session';
    const publishReference = 'fixture-publish-key';
    const passphraseReference = 'fixture-srt-passphrase';
    const secrets = new Map([
      [ownerReference, stream.ownerCookie],
      [publishReference, stream.publishKey],
      [passphraseReference, this.secrets.srtPassphrase],
    ]);
    this.mediaSpawn = new DockerMediaScenarioSpawn({ senderContainerId: sender.id, secrets, command: this.command });
    const input = {
      fixtureId: this.configuration.plan.fixtureId,
      srs: runtime.endpoints.srs,
      viewer: {
        controlBaseUrl: loopbackUrl(this.configuration.plan, 'viewer'),
        mediaBaseUrl: runtime.endpoints.viewerMediaBaseUrl,
      },
      adminBaseUrl: loopbackUrl(this.configuration.plan, 'admin'),
      stream: stream.stream,
      uploaderId: stream.uploaderId,
      authReferences: {
        owner: ownerReference,
        publishKey: publishReference,
        srtPassphrase: passphraseReference,
      },
    } as const;
    const deps = {
      fetch: new LoopbackMediaScenarioFetch({ secrets }),
      spawn: this.mediaSpawn,
      clock: {
        now: Date.now,
        sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      },
    };
    return this.configuration.scenario === 'reconnect'
      ? runReconnectAcceptanceScenario(input, deps)
      : runContinuationMediaScenario(input, deps);
  }

  async writeEvidence(evidence: unknown): Promise<void> {
    if (this.readiness === undefined) {
      throw new FixtureRefusal('fixture readiness evidence is missing');
    }
    writeFileSync(
      join(this.configuration.plan.outputRoot, 'scenario-evidence.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          fixtureId: this.configuration.plan.fixtureId,
          scenario: this.configuration.scenario,
          ...scenarioEvidenceMetadata(this.configuration.scenario),
          readiness: this.readiness,
          media: evidence,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  async settleOwnedProcesses(): Promise<boolean> {
    if (!this.mediaSpawn) {
      return false;
    }
    this.mediaSpawn.assertIdle();
    return true;
  }

  private async createCompanion(role: 'browser' | 'media-sender', start: boolean): Promise<void> {
    const plan = containerPlan(this.configuration.plan, role);
    this.journal.planResource(plan);
    let created: InspectedResource;
    try {
      created = await this.docker.create('container', plan.name, plan.labels, plan);
    } catch {
      throw new FixtureRefusal(`creation outcome for ${plan.name} is unresolved and requires exact-name recovery`);
    }
    this.journal.recordResource(created);
    this.rawContainers!.set(role, { id: created.id, name: created.name, configuredImage: plan.image });
    if (start) {
      await this.docker.startContainer(created.id);
    }
  }

  private async assertReleaseTargetsUnused(): Promise<void> {
    const targets = this.configuration.targets;
    const projects = [
      targets.manager.projectName,
      targets.admin.projectName,
      targets.uploader.profile,
      targets.viewer.profile,
    ];
    for (const project of projects) {
      for (const [kind, command] of [
        ['container', ['ps', '--all', '--quiet', '--no-trunc']] as const,
        ['network', ['network', 'ls', '--quiet']] as const,
        ['volume', ['volume', 'ls', '--quiet']] as const,
      ]) {
        const result = await this.command.run('docker', [
          ...command,
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ]);
        if (result.stdout.trim() !== '') {
          throw new FixtureRefusal(`guarded Compose project already exists for ${kind} resources`);
        }
      }
    }
    const exactTargets = [
      ['volume', targets.manager.postgresVolumeName],
      ['volume', targets.admin.postgresVolumeName],
      ['volume', `${targets.uploader.profile}_srs-media`],
      ['volume', `${targets.uploader.profile}_uploader-state`],
      ['network', `${targets.manager.projectName}-fixture-manager`],
      ['network', `${targets.admin.projectName}-fixture-db`],
    ] as const;
    for (const [kind, name] of exactTargets) {
      if (await this.docker.findExact(kind, name)) {
        throw new FixtureRefusal(`guarded ${kind} target ${name} already exists`);
      }
    }
  }

  private async resolveCurrentRuntime(): Promise<ResolvedFixtureRuntime> {
    const document = this.journal.read();
    const profile = document.managerProfile;
    if (!profile || profile.status === 'creating') {
      throw new FixtureRefusal('manager uploader identity is unavailable for runtime resolution');
    }
    const topology = this.topology ?? createContinuationTopology(this.configuration.plan, profile.instanceId);
    const network = document.resources.find(
      (resource) => resource.kind === 'network' && resource.name === this.configuration.plan.network.name,
    );
    if (!network || !this.rawContainers) {
      throw new FixtureRefusal('raw fixture resources are incomplete');
    }
    return resolveFixtureRuntime(this.command, {
      plan: this.configuration.plan,
      topology,
      projects: {
        admin: this.configuration.targets.admin.projectName,
        uploader: this.configuration.targets.uploader.profile,
        viewer: this.configuration.targets.viewer.profile,
      },
      fixtureNetworkId: network.id,
      rawContainers: this.rawContainers,
      guardSlots: guardSlots(profile.instanceId),
    });
  }

  private postageBatchId(): string {
    const value = this.privateChain?.outputs.get('storage.postageBatchId');
    if (!value || !POSTAGE_BATCH_ID.test(value)) {
      throw new FixtureRefusal('private-chain postage output is missing');
    }
    return value;
  }

  private requireRuntime(): ResolvedFixtureRuntime {
    if (!this.runtime) {
      throw new FixtureRefusal('fixture runtime has not been resolved');
    }
    return this.runtime;
  }

  private requireTopology(): ContinuationTopology {
    if (!this.topology) {
      throw new FixtureRefusal('fixture topology has not been finalized');
    }
    return this.topology;
  }

  private requireStream(): ManagedFixtureStreamSession {
    if (!this.stream) {
      throw new FixtureRefusal('managed fixture stream has not been provisioned');
    }
    return this.stream;
  }

  private requireRawContainer(role: 'browser' | 'media-sender'): RuntimeContainerBinding {
    const value = this.rawContainers?.get(role);
    if (!value) {
      throw new FixtureRefusal(`${role} fixture container is missing`);
    }
    return value;
  }
}

function refusingControls(): ReadinessControlExecutor {
  return {
    run: async () => {
      throw new FixtureRefusal('readiness controls are unavailable during receipt reconciliation');
    },
  };
}

function guardSlots(uploaderId: string): ReadonlyMap<ReleaseGuardRole, string> {
  return new Map<ReleaseGuardRole, string>([
    ['manager', 'default'],
    ['admin', 'default'],
    ['viewer', 'default'],
    ['uploader', uploaderId],
  ]);
}

function uploaderSlot(topology: ContinuationTopology): string {
  const value = topology.guardedActivations.find(({ role }) => role === 'uploader')?.slot.id;
  if (!value) {
    throw new FixtureRefusal('uploader guard slot is missing');
  }
  return value;
}

function containerPlan(plan: FixturePlan, role: TopologyServiceRole): ContainerPlan {
  const matches = plan.resources.filter(
    (resource): resource is ContainerPlan => resource.kind === 'container' && resource.role === role,
  );
  if (matches.length !== 1) {
    throw new FixtureRefusal(`fixture requires one ${role} container plan`);
  }
  return matches[0];
}

function loopbackUrl(plan: FixturePlan, role: 'admin' | 'viewer'): string {
  const binding = plan.publishedPorts.find((port) => port.role === role);
  if (!binding) {
    throw new FixtureRefusal(`${role} loopback endpoint is missing`);
  }
  return `http://${binding.host}:${binding.hostPort}`;
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function validateSecrets(secrets: ContinuationFixtureRuntimeSecrets): void {
  for (const value of Object.values(secrets)) {
    if (value.length < 1 || Buffer.byteLength(value) > 16 * 1024 || /[\0\r\n]/.test(value)) {
      throw new FixtureRefusal('fixture process input is missing or malformed');
    }
  }
}

function stage(name: string, status: 'passed') {
  return { name, status, command: [], stdout: '', stderr: '' } as const;
}
