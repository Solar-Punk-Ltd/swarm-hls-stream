import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFixturePlan, ResourceJournal, type FixturePlan } from '../src/continuation/fixture.js';
import type { HeldUploaderProfile } from '../src/continuation/managerProfile.js';
import {
  GuardedApplicationProvisioner,
  SpawnBoundedProcess,
  type ProcessInvocation,
  type ProcessResult,
  type ReleaseFixtureTargets,
} from '../src/continuation/provisioner.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_NAME = 'srs-a1b2c3d4-uploader';

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

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(structuredClone(invocation));
    if (invocation.file === 'docker' && invocation.args[0] === 'ps') {
      return { stdout: 'manager-api-container\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
}

class ProfileClient {
  calls = 0;
  fail = false;

  async createHeldUploaderProfile(): Promise<HeldUploaderProfile> {
    this.calls += 1;
    if (this.fail) throw new Error('synthetic lost reply');
    return { name: PROFILE_NAME, instanceId: INSTANCE_ID, portSlot: 1 };
  }
}

function provisioner(
  fixturePlan: FixturePlan,
  process: RecordingProcess,
  profiles: ProfileClient,
  journal = new ResourceJournal(fixturePlan.outputRoot),
): GuardedApplicationProvisioner {
  journal.initialize(fixturePlan, []);
  return new GuardedApplicationProvisioner({
    plan: fixturePlan,
    targets: targets(),
    process,
    profiles,
    journal,
    managerUsername: 'srs-a1b2c3d4-operator',
    managerPassword: 'synthetic-manager-password',
    feedPrivateKey: 'synthetic-feed-private-key',
  });
}

describe('GuardedApplicationProvisioner', () => {
  it('installs one fixture guard and performs the approved two-stage guarded activation', async () => {
    const fixturePlan = plan();
    const process = new RecordingProcess();
    const profiles = new ProfileClient();
    const subject = provisioner(fixturePlan, process, profiles);

    const topology = await subject.provision();

    assert.equal(topology.guardedActivations.at(-1)?.slot.id, INSTANCE_ID);
    assert.equal(profiles.calls, 1);
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
      'uploader',
      'retry',
      'retry',
      'retry',
      'retry',
    ]);
    assert.equal(guardCalls[0]?.args.includes('--managed-lifecycle-version'), false);
    assert.deepEqual(
      guardCalls[2]?.args.slice(-4),
      ['--managed-lifecycle-version', '1', '--managed-uploader-id', INSTANCE_ID],
    );
    assert.deepEqual(
      guardCalls[4]?.args.slice(-2),
      ['--slot-id', INSTANCE_ID],
    );
    assert.deepEqual(
      guardCalls.slice(5).map((call) => call.args.slice(-4)),
      [
        ['--role', 'manager', '--admin-url', 'http://127.0.0.1:18080'],
        ['--role', 'admin', '--admin-url', 'http://127.0.0.1:18080'],
        ['--role', 'viewer', '--admin-url', 'http://127.0.0.1:18080'],
        ['--slot-id', INSTANCE_ID, '--admin-url', 'http://127.0.0.1:18080'],
      ],
    );

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
      journal,
      managerUsername: 'srs-a1b2c3d4-operator',
      managerPassword: 'synthetic-manager-password',
      feedPrivateKey: 'synthetic-feed-private-key',
    });
    await assert.rejects(restarted.provision(), /unresolved.*manual reconciliation/i);
    assert.equal(profiles.calls, 1);
  });
});

describe('SpawnBoundedProcess', () => {
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
