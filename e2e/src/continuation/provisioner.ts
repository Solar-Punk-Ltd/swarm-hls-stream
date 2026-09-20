import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type FixturePlan, FixtureRefusal, ResourceJournal } from './fixture.js';
import type {
  CreateHeldUploaderProfileInput,
  HeldUploaderProfile,
  StartHeldUploaderInput,
} from './managerProfile.js';
import { managerUploaderProfileName } from './managerProfile.js';
import type { GuardedReleaseObservation } from './readinessTransport.js';
import { type ContinuationTopology,createContinuationTopology } from './topology.js';

const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_USERNAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_CONTAINER_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const FIXTURE_ROOT = '/home/solarpunk/srs-continuation-tests-20260920';

export interface ProcessInvocation {
  file: string;
  args: readonly string[];
  stdin?: string;
  environment?: Readonly<Record<string, string | null>>;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface BoundedProcess {
  run(invocation: ProcessInvocation): Promise<ProcessResult>;
}

export class SpawnBoundedProcess implements BoundedProcess {
  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    const timeoutMs = boundedProcessInteger(invocation.timeoutMs ?? 30_000, 1, 10 * 60_000, 'process timeout');
    const maxInputBytes = boundedProcessInteger(
      invocation.maxInputBytes ?? 64 * 1024,
      1,
      16 * 1024 * 1024,
      'process input bound',
    );
    const maxOutputBytes = boundedProcessInteger(
      invocation.maxOutputBytes ?? 256 * 1024,
      1,
      16 * 1024 * 1024,
      'process output bound',
    );
    if (
      invocation.file.length < 1 ||
      invocation.file.length > 4_096 ||
      invocation.args.length > 200 ||
      invocation.args.some((argument) => argument.length > 16 * 1024) ||
      (invocation.stdin !== undefined && Buffer.byteLength(invocation.stdin) > maxInputBytes)
    ) {
      throw new FixtureRefusal('bounded process invocation is malformed');
    }
    const environment = { ...process.env };
    for (const [name, value] of Object.entries(invocation.environment ?? {})) {
      if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(name)) {
        throw new FixtureRefusal('bounded process environment name is malformed');
      }
      if (value === null) {
        delete environment[name];
      } else if (value.length > 16 * 1024) {
        throw new FixtureRefusal('bounded process environment value exceeds its byte bound');
      } else {
        environment[name] = value;
      }
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(invocation.file, [...invocation.args], {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let exceeded = false;
      let timedOut = false;
      let spawnError = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          exceeded = true;
          child.kill('SIGKILL');
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          exceeded = true;
          child.kill('SIGKILL');
          return;
        }
        stderr.push(chunk);
      });
      child.stdin.on('error', () => {});
      child.on('error', () => {
        spawnError = true;
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new FixtureRefusal(`bounded process timed out (stdout ${stdoutBytes} bytes, stderr ${stderrBytes} bytes)`));
          return;
        }
        if (exceeded) {
          reject(new FixtureRefusal('bounded process exceeded its output byte limit'));
          return;
        }
        if (spawnError) {
          reject(new FixtureRefusal('bounded process could not start'));
          return;
        }
        if (code !== 0) {
          reject(new FixtureRefusal(
            `bounded process failed with exit ${code === null ? 'unknown' : code}${
              signal === null ? '' : ` and signal ${signal}`
            } (stdout ${stdoutBytes} bytes, stderr ${stderrBytes} bytes)`,
          ));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
          stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
        });
      });
      child.stdin.end(invocation.stdin ?? '');
    });
  }
}

export interface ReleaseFixtureTargets {
  manager: {
    projectName: string;
    postgresVolumeName: string;
    postgresPort: number;
    webPort: number;
  };
  admin: {
    projectName: string;
    postgresVolumeName: string;
    webPort: number;
  };
  uploader: {
    profile: string;
    portSlot: number;
    services: readonly ['srs', 'stream-uploader'];
  };
  viewer: {
    profile: string;
    portSlot: number;
    services: readonly ['client'];
  };
}

export interface HeldUploaderProfileClient {
  createHeldUploaderProfile(input: CreateHeldUploaderProfileInput): Promise<HeldUploaderProfile>;
  setStampAndStartUploader(input: StartHeldUploaderInput): Promise<void>;
}

export interface GuardReceiptVerifier {
  inspectGuard(role: 'manager' | 'admin' | 'viewer' | 'uploader'): Promise<GuardedReleaseObservation>;
}

export interface GuardedApplicationProvisionerOptions {
  plan: FixturePlan;
  targets: ReleaseFixtureTargets;
  process: BoundedProcess;
  profiles: HeldUploaderProfileClient;
  receipts: GuardReceiptVerifier;
  journal: ResourceJournal;
  managerUsername: string;
  managerPassword: string;
  feedPrivateKey: string;
  postageBatchId: string;
}

/** Runs the installed guard through both bootstrap phases and returns the final UUID-bound topology. */
export class GuardedApplicationProvisioner {
  private readonly fixtureRoot: string;
  private readonly guardRoot: string;
  private readonly guard: string;
  private readonly stateRoot: string;
  private readonly adminUrl: string;

  constructor(private readonly options: GuardedApplicationProvisionerOptions) {
    validateInputs(options);
    this.fixtureRoot = join(FIXTURE_ROOT, options.plan.fixtureId);
    this.guardRoot = join(this.fixtureRoot, 'guard');
    this.guard = join(this.guardRoot, 'bin/streaming-release-guard');
    this.stateRoot = join(this.guardRoot, 'state/streaming-release-guard');
    this.adminUrl = `http://127.0.0.1:${options.targets.admin.webPort}`;
  }

  async provision(): Promise<ContinuationTopology> {
    const document = this.options.journal.read();
    const current = document.managerProfile;
    if (document.applicationProvisioning?.status === 'ready' && current?.status === 'ready') {
      return createContinuationTopology(this.options.plan, current.instanceId);
    }
    if (document.applicationProvisioning !== undefined || current !== undefined) {
      throw new FixtureRefusal('application provisioning is unresolved and needs manual reconciliation');
    }
    this.options.journal.beginApplicationProvisioning();
    let profile: HeldUploaderProfile;
    await this.guardMutation('release guard install', {
      file: managerCandidate(this.options.plan, 'deploy/install-release-guard.sh'),
      args: installerArguments(this.options.plan, this.options.targets),
      timeoutMs: 120_000,
    });
    await this.activate('admin', 'admin', 'default', {
      INGEST_MANAGED_LIFECYCLE_VERSION: null,
      INGEST_MANAGED_UPLOADER_ID: null,
    });
    await this.activate('manager', 'manager', 'default');
    await this.createManagerOperator();

    const name = managerUploaderProfileName(this.options.plan.fixtureId);
    this.options.journal.beginManagerProfile(name, this.options.targets.uploader.portSlot);
    try {
      profile = await this.options.profiles.createHeldUploaderProfile({
        fixtureId: this.options.plan.fixtureId,
        expectedPortSlot: this.options.targets.uploader.portSlot,
        beeUrl: this.options.plan.internalEndpoints.bee,
        privateKey: this.options.feedPrivateKey,
      });
    } catch {
      throw new FixtureRefusal('manager profile creation outcome is unresolved');
    }
    if (profile.name !== name || profile.portSlot !== this.options.targets.uploader.portSlot) {
      throw new FixtureRefusal('manager profile result does not match its installed target');
    }
    this.options.journal.completeManagerProfile(profile.name, profile.portSlot, profile.instanceId);

    await this.activate(
      'admin',
      'admin',
      'default',
      {
        INGEST_MANAGED_LIFECYCLE_VERSION: '1',
        INGEST_MANAGED_UPLOADER_ID: profile.instanceId,
      },
      ['--managed-lifecycle-version', '1', '--managed-uploader-id', profile.instanceId],
    );
    await this.activate('viewer', 'stack', 'default');
    this.recordGuardStage('manager uploader guarded activation', 'planned');
    try {
      await this.options.profiles.setStampAndStartUploader({
        profile,
        postageBatchId: this.options.postageBatchId,
      });
      this.recordGuardStage('manager uploader guarded activation', 'passed');
    } catch {
      this.recordGuardStage('manager uploader guarded activation', 'failed');
      throw new FixtureRefusal('manager uploader guarded activation failed');
    }
    for (const [role, id] of [
      ['manager', 'default'],
      ['admin', 'default'],
      ['viewer', 'default'],
      ['uploader', profile.instanceId],
    ] as const) {
      if (this.pendingReceipt(role, id)) {
        await this.retryReceipt(role, id);
      }
      const receipt = await this.options.receipts.inspectGuard(role);
      if (receipt.slot.role !== role || receipt.slot.id !== id) {
        throw new FixtureRefusal(`${role} acknowledged release receipt does not match its exact slot`);
      }
    }
    this.options.journal.markManagerProfileReady(profile.instanceId);
    this.options.journal.markApplicationProvisioningReady();
    return createContinuationTopology(this.options.plan, profile.instanceId);
  }

  private async activate(
    role: 'manager' | 'admin' | 'viewer' | 'uploader',
    candidateRole: 'manager' | 'admin' | 'stack',
    slotId: string,
    environment?: Readonly<Record<string, string | null>>,
    extraArguments: readonly string[] = [],
  ): Promise<void> {
    await this.guardMutation(`${role} guarded activation`, {
      file: this.guard,
      args: [
        role,
        '--state-root', this.stateRoot,
        '--candidate-root', candidateRoot(this.options.plan, candidateRole),
        '--work-root', join(this.guardRoot, `work/${role}-${slotId}`),
        '--admin-url', this.adminUrl,
        ...extraArguments,
      ],
      environment,
      timeoutMs: 10 * 60_000,
    });
  }

  private async createManagerOperator(): Promise<void> {
    const result = await this.run('manager API container lookup', {
      file: 'docker',
      args: [
        'ps', '--quiet',
        '--filter', `label=com.docker.compose.project=${this.options.targets.manager.projectName}`,
        '--filter', 'label=com.docker.compose.service=api',
        '--filter', 'label=com.docker.compose.oneoff=False',
      ],
    });
    const ids = result.stdout.trim() === '' ? [] : result.stdout.trim().split(/\s+/);
    if (ids.length !== 1 || !SAFE_CONTAINER_ID.test(ids[0] ?? '')) {
      throw new FixtureRefusal('manager guarded activation did not expose one exact API container');
    }
    await this.run('manager fixture operator creation', {
      file: 'docker',
      args: [
        'exec', '-i', ids[0], 'node', 'dist/cli.js',
        'user:add', this.options.managerUsername, '--password-stdin', '--admin',
      ],
      stdin: `${this.options.managerPassword}\n`,
      timeoutMs: 30_000,
    });
  }

  private async retryReceipt(role: 'manager' | 'admin' | 'viewer' | 'uploader', slotId: string): Promise<void> {
    await this.guardMutation(`${role} release receipt reconciliation`, {
      file: this.guard,
      args: [
        'retry',
        '--state-root', this.stateRoot,
        '--role', role,
        ...(role === 'uploader' ? ['--slot-id', slotId] : []),
        '--admin-url', this.adminUrl,
      ],
      timeoutMs: 30_000,
    });
  }

  private pendingReceipt(role: 'manager' | 'admin' | 'viewer' | 'uploader', slotId: string): boolean {
    const path = join(this.stateRoot, 'pending', `${role}-${slotId}.json`);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw new FixtureRefusal(`${role} release receipt outbox could not be inspected`);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 64 * 1024) {
      throw new FixtureRefusal(`${role} release receipt outbox is malformed`);
    }
    let receipt: unknown;
    try {
      receipt = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      throw new FixtureRefusal(`${role} release receipt outbox is malformed`);
    }
    if (
      receipt === null ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      (receipt as Record<string, unknown>).schemaVersion !== 1 ||
      ((receipt as Record<string, unknown>).slot as Record<string, unknown> | undefined)?.role !== role ||
      ((receipt as Record<string, unknown>).slot as Record<string, unknown> | undefined)?.id !== slotId
    ) {
      throw new FixtureRefusal(`${role} release receipt outbox does not match its exact slot`);
    }
    return true;
  }

  private async guardMutation(label: string, invocation: ProcessInvocation): Promise<ProcessResult> {
    this.recordGuardStage(label, 'planned');
    try {
      const result = await this.run(label, invocation);
      this.recordGuardStage(label, 'passed');
      return result;
    } catch (error) {
      this.recordGuardStage(label, 'failed');
      throw error;
    }
  }

  private recordGuardStage(label: string, status: 'planned' | 'passed' | 'failed'): void {
    this.options.journal.recordStage({ name: label, status, command: [], stdout: '', stderr: '' });
  }

  private async run(label: string, invocation: ProcessInvocation): Promise<ProcessResult> {
    try {
      return await this.options.process.run(invocation);
    } catch {
      throw new FixtureRefusal(`${label} failed without exposing child output`);
    }
  }
}

function installerArguments(plan: FixturePlan, targets: ReleaseFixtureTargets): string[] {
  return [
    '--manager-mode', 'isolated',
    '--manager-project-name', targets.manager.projectName,
    '--manager-postgres-volume-name', targets.manager.postgresVolumeName,
    '--manager-postgres-port', String(targets.manager.postgresPort),
    '--manager-web-port', String(targets.manager.webPort),
    '--admin-project-name', targets.admin.projectName,
    '--admin-postgres-volume-name', targets.admin.postgresVolumeName,
    '--admin-web-port', String(targets.admin.webPort),
    '--uploader-profile', targets.uploader.profile,
    '--uploader-port-slot', String(targets.uploader.portSlot),
    '--uploader-services', targets.uploader.services.join(','),
    '--viewer-profile', targets.viewer.profile,
    '--viewer-port-slot', String(targets.viewer.portSlot),
    '--viewer-services', targets.viewer.services.join(','),
    '--fixture-network-name', plan.network.name,
    '--fixture-id', plan.fixtureId,
  ];
}

function managerCandidate(plan: FixturePlan, relative: string): string {
  return join(candidateRoot(plan, 'manager'), relative);
}

function candidateRoot(plan: FixturePlan, role: 'manager' | 'admin' | 'stack'): string {
  const candidate = plan.candidates.find((entry) => entry.role === role);
  if (!candidate) {throw new FixtureRefusal(`${role} candidate is missing`);}
  return candidate.root;
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function boundedProcessInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FixtureRefusal(`${label} is outside its allowed range`);
  }
  return value;
}

function validateInputs(options: GuardedApplicationProvisionerOptions): void {
  const { targets } = options;
  validateReleaseFixtureTargets(options.plan, targets);
  if (
    !SAFE_USERNAME.test(options.managerUsername) ||
    options.managerPassword.length < 1 ||
    options.managerPassword.length > 16 * 1024 ||
    options.feedPrivateKey.length < 1 ||
    options.feedPrivateKey.length > 16 * 1024 ||
    !/^(?:0x)?[0-9a-fA-F]{64}$/.test(options.postageBatchId)
  ) {
    throw new FixtureRefusal('guarded application provision input is malformed');
  }
}

export function validateReleaseFixtureTargets(plan: FixturePlan, targets: ReleaseFixtureTargets): void {
  const uploaderProfile = managerUploaderProfileName(plan.fixtureId);
  const fixtureStem = uploaderProfile.slice(0, -'-uploader'.length);
  if (
    targets.manager.projectName !== `${fixtureStem}-manager` ||
    targets.manager.postgresVolumeName !== `${fixtureStem}-manager-pg` ||
    !validPort(targets.manager.postgresPort) ||
    !validPort(targets.manager.webPort) ||
    targets.admin.projectName !== `${fixtureStem}-admin` ||
    targets.admin.postgresVolumeName !== `${fixtureStem}-admin-pg` ||
    !validPort(targets.admin.webPort) ||
    !SAFE_PROFILE.test(targets.uploader.profile) ||
    targets.uploader.profile !== uploaderProfile ||
    targets.uploader.portSlot !== 1 ||
    targets.uploader.services.join(',') !== 'srs,stream-uploader' ||
    targets.viewer.profile !== `${fixtureStem}-viewer` ||
    targets.viewer.portSlot !== 1 ||
    targets.viewer.services.join(',') !== 'client'
  ) {
    throw new FixtureRefusal('guarded application target is malformed');
  }
  const adminPort = plan.publishedPorts.find((binding) => binding.role === 'admin')?.hostPort;
  if (adminPort !== targets.admin.webPort) {
    throw new FixtureRefusal('guarded admin target does not match the fixture loopback port');
  }
  const reservedPorts = [
    ...plan.publishedPorts.map(({ hostPort }) => hostPort),
    targets.manager.postgresPort,
    targets.manager.webPort,
  ];
  if (new Set(reservedPorts).size !== reservedPorts.length) {
    throw new FixtureRefusal('guarded application loopback ports overlap');
  }
}
