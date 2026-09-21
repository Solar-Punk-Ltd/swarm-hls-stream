import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  cleanupFixture,
  createFixturePlan,
  type FixtureDocker,
  type FixturePlan,
  type FixtureResourcePlan,
  type InspectedResource,
  ResourceJournal,
  type ResourceKind,
} from '../src/continuation/fixture.js';
import type { GuardedResourceStage, GuardedResourceTracker } from '../src/continuation/guardedResources.js';
import type { HeldUploaderProfile } from '../src/continuation/managerProfile.js';
import {
  GuardedApplicationProvisioner,
  type ProcessInvocation,
  type ProcessResult,
  type ReleaseFixtureTargets,
  SpawnBoundedProcess,
} from '../src/continuation/provisioner.js';
import type { GuardedReleaseObservation } from '../src/continuation/readinessTransport.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_NAME = 'srs-a1b2c3d4-uploader';
const POSTAGE_BATCH_ID = 'ab'.repeat(32);

function plan(): FixturePlan {
  const parent = mkdtempSync(join(tmpdir(), 'continuation-provision-'));
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
    expectedChainId: 1337,
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
    uploader: { profile: PROFILE_NAME, portSlot: 1, services: ['srs', 'stream-uploader'] },
    viewer: { profile: 'srs-a1b2c3d4-viewer', portSlot: 1, services: ['client'] },
  };
}

class RecordingProcess {
  readonly calls: ProcessInvocation[] = [];
  failGuardRole: string | null = null;

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(structuredClone(invocation));
    if (invocation.file.endsWith('/bin/streaming-release-guard') && invocation.args[0] === this.failGuardRole) {
      throw new Error('synthetic guarded activation timeout');
    }
    if (invocation.file === 'docker' && invocation.args[0] === 'ps') {
      return { stdout: 'manager-api-container\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
}

class RemovalTrackingDocker implements FixtureDocker {
  readonly removed: string[] = [];

  constructor(private readonly resource: InspectedResource) {}

  async findExact(): Promise<InspectedResource | null> {return this.resource;}
  async create(
    _kind: ResourceKind,
    _name: string,
    _labels: Readonly<Record<string, string>>,
    _plan?: FixtureResourcePlan,
  ): Promise<InspectedResource> {return this.resource;}
  async startContainer(): Promise<void> {}
  async inspect(): Promise<InspectedResource | null> {return this.resource;}
  async remove(_kind: ResourceKind, id: string): Promise<void> {this.removed.push(id);}
}

class ProfileClient {
  calls = 0;
  startCalls: Array<{ profile: HeldUploaderProfile; postageBatchId: string }> = [];
  fail = false;

  async createHeldUploaderProfile(): Promise<HeldUploaderProfile> {
    this.calls += 1;
    if (this.fail) {throw new Error('synthetic lost reply');}
    return { name: PROFILE_NAME, instanceId: INSTANCE_ID, portSlot: 1 };
  }

  async setStampAndStartUploader(input: { profile: HeldUploaderProfile; postageBatchId: string }): Promise<void> {
    this.startCalls.push(structuredClone(input));
  }
}

class ReceiptVerifier {
  readonly calls: string[] = [];

  async inspectGuard(role: 'manager' | 'admin' | 'viewer' | 'uploader'): Promise<GuardedReleaseObservation> {
    this.calls.push(role);
    return {
      slot: { role, id: role === 'uploader' ? INSTANCE_ID : 'default' },
      installationId: '22222222-2222-4222-8222-222222222222',
      generation: 1,
      stateDigest: 'a'.repeat(64),
      artifact: { treeDigest: 'b'.repeat(64), images: [] },
      candidate: { role: role === 'admin' ? 'admin' : role === 'manager' ? 'manager' : 'stack', root: '/candidate', commit: 'c'.repeat(40), treeDigest: 'b'.repeat(64) },
    };
  }
}

class RecordingResourceTracker implements GuardedResourceTracker {
  readonly calls: GuardedResourceStage[] = [];

  async run<T>(stage: GuardedResourceStage, mutation: () => Promise<T>): Promise<T> {
    this.calls.push(stage);
    return mutation();
  }
}

function provisioner(
  fixturePlan: FixturePlan,
  process: RecordingProcess,
  profiles: ProfileClient,
  journal = new ResourceJournal(fixturePlan.outputRoot),
  receipts = new ReceiptVerifier(),
  resources = new RecordingResourceTracker(),
): GuardedApplicationProvisioner {
  journal.initialize(fixturePlan, []);
  return new GuardedApplicationProvisioner({
    plan: fixturePlan,
    targets: targets(),
    process,
    profiles,
    receipts,
    journal,
    resources,
    managerUsername: 'srs-a1b2c3d4-operator',
    managerPassword: 'synthetic-manager-password',
    feedPrivateKey: 'synthetic-feed-private-key',
    postageBatchId: POSTAGE_BATCH_ID,
  });
}

describe('GuardedApplicationProvisioner', () => {
  it('installs one fixture guard and performs the approved two-stage guarded activation', async () => {
    const fixturePlan = plan();
    const process = new RecordingProcess();
    const profiles = new ProfileClient();
    const receipts = new ReceiptVerifier();
    const resources = new RecordingResourceTracker();
    const subject = provisioner(fixturePlan, process, profiles, undefined, receipts, resources);

    const topology = await subject.provision();

    assert.equal(topology.guardedActivations.at(-1)?.slot.id, INSTANCE_ID);
    assert.equal(profiles.calls, 1);
    assert.deepEqual(profiles.startCalls, [{
      profile: { name: PROFILE_NAME, instanceId: INSTANCE_ID, portSlot: 1 },
      postageBatchId: POSTAGE_BATCH_ID,
    }]);
    const installer = process.calls[0];
    assert.equal(installer.file, '/candidates/manager/deploy/install-release-guard.sh');
    assert.deepEqual(installer.args.slice(-4), [
      '--fixture-network-name', `${FIXTURE_ID}-network`,
      '--fixture-id', FIXTURE_ID,
    ]);
    assert.equal(process.calls.filter((call) => call.file.endsWith('/install-release-guard.sh')).length, 1);

    const guardCalls = process.calls.filter((call) => call.file.endsWith('/bin/streaming-release-guard'));
    assert.deepEqual(guardCalls.map((call) => call.args[0]), [
      'admin',
      'manager',
      'admin',
      'viewer',
    ]);
    assert.equal(guardCalls[0]?.args.includes('--managed-lifecycle-version'), false);
    assert.deepEqual(
      guardCalls[2]?.args.slice(-4),
      ['--managed-lifecycle-version', '1', '--managed-uploader-id', INSTANCE_ID],
    );
    assert.deepEqual(receipts.calls, ['manager', 'admin', 'viewer', 'uploader']);
    assert.deepEqual(resources.calls, [
      'admin-bootstrap',
      'manager',
      'uploader-preparation',
      'admin-managed',
      'viewer',
      'uploader',
    ]);

    const userAdd = process.calls.find((call) => call.file === 'docker' && call.args[0] === 'exec');
    assert.ok(userAdd);
    assert.deepEqual(userAdd.args, [
      'exec', '-i', 'manager-api-container', 'node', 'dist/cli.js',
      'user:add', 'srs-a1b2c3d4-operator', '--password-stdin', '--admin',
    ]);
    assert.equal(userAdd.stdin, 'synthetic-manager-password\n');
    for (const call of process.calls) {
      const argv = [call.file, ...call.args].join(' ');
      assert.doesNotMatch(argv, /synthetic-manager-password|synthetic-feed-private-key/);
    }
  });

  it('leaves a lost profile POST unresolved and refuses a second create', async () => {
    const fixturePlan = plan();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    const process = new RecordingProcess();
    const profiles = new ProfileClient();
    profiles.fail = true;
    const subject = provisioner(fixturePlan, process, profiles, journal);

    await assert.rejects(subject.provision(), /profile creation outcome is unresolved/i);
    assert.deepEqual(journal.read().managerProfile, {
      status: 'creating',
      name: PROFILE_NAME,
      portSlot: 1,
    });

    const restarted = new GuardedApplicationProvisioner({
      plan: fixturePlan,
      targets: targets(),
      process,
      profiles,
      receipts: new ReceiptVerifier(),
      journal,
      resources: new RecordingResourceTracker(),
      managerUsername: 'srs-a1b2c3d4-operator',
      managerPassword: 'synthetic-manager-password',
      feedPrivateKey: 'synthetic-feed-private-key',
      postageBatchId: POSTAGE_BATCH_ID,
    });
    await assert.rejects(restarted.provision(), /unresolved.*manual reconciliation/i);
    assert.equal(profiles.calls, 1);
  });

  it('returns the completed topology after restart without starting a second deployment', async () => {
    const fixturePlan = plan();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    const firstProcess = new RecordingProcess();
    const profiles = new ProfileClient();
    await provisioner(fixturePlan, firstProcess, profiles, journal).provision();

    const restartedProcess = new RecordingProcess();
    const restarted = new GuardedApplicationProvisioner({
      plan: fixturePlan,
      targets: targets(),
      process: restartedProcess,
      profiles,
      receipts: new ReceiptVerifier(),
      journal,
      resources: new RecordingResourceTracker(),
      managerUsername: 'srs-a1b2c3d4-operator',
      managerPassword: 'synthetic-manager-password',
      feedPrivateKey: 'synthetic-feed-private-key',
      postageBatchId: POSTAGE_BATCH_ID,
    });

    const topology = await restarted.provision();

    assert.equal(topology.guardedActivations.at(-1)?.slot.id, INSTANCE_ID);
    assert.equal(restartedProcess.calls.length, 0);
    assert.equal(profiles.calls, 1);
    assert.equal(profiles.startCalls.length, 1);
  });

  it('refuses cleanup when the first admin guard activation times out before profile creation', async () => {
    const fixturePlan = plan();
    const journal = new ResourceJournal(fixturePlan.outputRoot);
    journal.initialize(fixturePlan, []);
    const recordedPlan = fixturePlan.resources.find((resource) => resource.kind === 'volume');
    assert.ok(recordedPlan);
    const recorded: InspectedResource = {
      kind: 'volume',
      id: recordedPlan.name,
      name: recordedPlan.name,
      labels: { ...recordedPlan.labels },
    };
    journal.planResource(recordedPlan);
    journal.recordResource(recorded);
    const docker = new RemovalTrackingDocker(recorded);
    const process = new RecordingProcess();
    process.failGuardRole = 'admin';
    const subject = new GuardedApplicationProvisioner({
      plan: fixturePlan,
      targets: targets(),
      process,
      profiles: new ProfileClient(),
      receipts: new ReceiptVerifier(),
      journal,
      resources: new RecordingResourceTracker(),
      managerUsername: 'srs-a1b2c3d4-operator',
      managerPassword: 'synthetic-manager-password',
      feedPrivateKey: 'synthetic-feed-private-key',
      postageBatchId: POSTAGE_BATCH_ID,
    });

    await assert.rejects(subject.provision(), /admin guarded activation failed/i);
    await assert.rejects(cleanupFixture(journal, docker), /provisioning is unresolved/i);
    assert.deepEqual(docker.removed, []);
  });
});

describe('SpawnBoundedProcess', () => {
  it('accepts a caller-bounded private input above the default stdin limit', async () => {
    const subject = new SpawnBoundedProcess();
    const input = 'x'.repeat(70 * 1024);
    const invocation = {
      file: process.execPath,
      args: [
        '-e',
        "let bytes=0;process.stdin.on('data',chunk=>bytes+=chunk.length);process.stdin.on('end',()=>process.stdout.write(String(bytes)))",
      ],
      stdin: input,
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    };

    await assert.rejects(subject.run(invocation), /malformed/);
    const result = await subject.run({ ...invocation, maxInputBytes: 128 * 1024 });

    assert.equal(result.stdout, String(Buffer.byteLength(input)));
  });

  it('accepts a caller-bounded private output above the default capture limit', async () => {
    const subject = new SpawnBoundedProcess();
    const bytes = 1024 * 1024 + 1;

    const result = await subject.run({
      file: process.execPath,
      args: ['-e', `process.stdout.write('x'.repeat(${bytes}))`],
      timeoutMs: 2_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });

    assert.equal(Buffer.byteLength(result.stdout), bytes);
  });

  it('routes process-only stdin and environment without putting either value in argv', async () => {
    const subject = new SpawnBoundedProcess();
    const result = await subject.run({
      file: process.execPath,
      args: [
        '-e',
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({stdin:d.length,env:process.env.FIXTURE_SENTINEL?.length})))",
      ],
      stdin: 'synthetic-stdin-secret',
      environment: { FIXTURE_SENTINEL: 'synthetic-env-secret' },
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    });

    assert.deepEqual(JSON.parse(result.stdout), { stdin: 22, env: 20 });
  });

  it('reports only bounded byte counts when a child prints secret values and fails', async () => {
    const subject = new SpawnBoundedProcess();
    const sentinel = 'synthetic-child-secret';

    await assert.rejects(
      subject.run({
        file: process.execPath,
        args: ['-e', 'process.stdin.pipe(process.stdout);process.stdin.on(\'end\',()=>{process.stderr.write(process.env.FIXTURE_SENTINEL ?? \'\');process.exitCode=7})'],
        stdin: sentinel,
        environment: { FIXTURE_SENTINEL: sentinel },
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exit 7.*stdout [1-9][0-9]* bytes.*stderr [1-9][0-9]* bytes/i);
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        return true;
      },
    );
  });
});
