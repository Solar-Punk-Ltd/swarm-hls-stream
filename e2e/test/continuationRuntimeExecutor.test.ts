import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { BoundedCommand, CommandResult } from '../src/continuation/dockerCli.js';
import { createFixturePlan } from '../src/continuation/fixture.js';
import {
  ContinuationFixtureRuntime,
  type ContinuationFixtureRuntimeSecrets,
} from '../src/continuation/runtimeExecutor.js';

const COMMIT = '1'.repeat(40);
const IMAGE = `sha256:${'2'.repeat(64)}`;
const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';

class PreflightCommand implements BoundedCommand {
  readonly calls: Array<{ file: string; args: readonly string[] }> = [];

  constructor(
    private readonly dirty = false,
    private readonly occupiedProject?: string,
  ) {}

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ file, args });
    if (file === 'git' && args.includes('rev-parse')) {
      return { stdout: `${COMMIT}\n`, stderr: '' };
    }
    if (file === 'git' && args.includes('status')) {
      return { stdout: this.dirty ? ' M changed.ts\n' : '', stderr: '' };
    }
    if (file === 'docker') {
      if (this.occupiedProject && args.includes(`label=com.docker.compose.project=${this.occupiedProject}`)) {
        return { stdout: `${'f'.repeat(64)}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error('unexpected preflight command');
  }
}

function plan() {
  const outputRoot = join(mkdtempSync(join(tmpdir(), 'continuation-runtime-')), FIXTURE_ID);
  return createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot,
    candidates: [
      { role: 'stack', root: '/synthetic/stack', commit: COMMIT },
      { role: 'admin', root: '/synthetic/admin', commit: COMMIT },
      { role: 'manager', root: '/synthetic/manager', commit: COMMIT },
    ],
    candidateImages: {
      postgres: IMAGE,
      srs: IMAGE,
      uploader: IMAGE,
      adminApi: IMAGE,
      adminWeb: IMAGE,
      viewer: IMAGE,
      mediaSender: IMAGE,
      browser: IMAGE,
    },
    loopbackPorts: { rpc: 49_101, admin: 49_102, viewer: 49_103 },
    minimumStorageBytes: 1_024,
    minimumStorageTtlSeconds: 600,
    expectedChainId: 1_337,
  });
}

function targets() {
  return {
    manager: {
      projectName: 'srs-a1b2c3d4-manager',
      postgresVolumeName: 'srs-a1b2c3d4-manager-pg',
      postgresPort: 54_321,
      webPort: 49_104,
    },
    admin: {
      projectName: 'srs-a1b2c3d4-admin',
      postgresVolumeName: 'srs-a1b2c3d4-admin-pg',
      webPort: 49_102,
    },
    uploader: { profile: 'srs-a1b2c3d4-uploader', portSlot: 1, services: ['srs', 'stream-uploader'] as const },
    viewer: { profile: 'srs-a1b2c3d4-viewer', portSlot: 1, services: ['client'] as const },
  };
}

const secrets: ContinuationFixtureRuntimeSecrets = {
  beePassword: 'synthetic-bee-password',
  managerPassword: 'synthetic-manager-password',
  adminPassword: 'synthetic-admin-password',
  feedPrivateKey: 'synthetic-feed-private-key',
  srtPassphrase: 'synthetic-srt-passphrase',
};

describe('concrete continuation fixture runtime', () => {
  it('checks every frozen candidate before any Docker collision read', async () => {
    const command = new PreflightCommand(true);
    const runtime = new ContinuationFixtureRuntime({
      plan: plan(),
      targets: targets(),
      managerUsername: 'fixture-manager',
      adminUsername: 'fixture-admin',
    }, secrets, {
      command,
      createControls: () => ({ run: async () => new Uint8Array() }),
    });

    await assert.rejects(runtime.preflight(), /candidate stack is not the frozen clean commit/);
    assert.equal(command.calls.some(({ file }) => file === 'docker'), false);
  });

  it('refuses missing process inputs before any preflight command can run', () => {
    assert.throws(() => new ContinuationFixtureRuntime({
      plan: plan(),
      targets: targets(),
      managerUsername: 'fixture-manager',
      adminUsername: 'fixture-admin',
    }, { ...secrets, adminPassword: '' }, {
      command: new PreflightCommand(),
      createControls: () => ({ run: async () => new Uint8Array() }),
    }), /fixture process input is missing or malformed/);
  });

  it('refuses a foreign Compose project before any fixture provisioner can run', async () => {
    const occupiedProject = targets().admin.projectName;
    const command = new PreflightCommand(false, occupiedProject);
    const runtime = new ContinuationFixtureRuntime(
      {
        plan: plan(),
        targets: targets(),
        managerUsername: 'fixture-manager',
        adminUsername: 'fixture-admin',
      },
      secrets,
      {
        command,
        createControls: () => ({ run: async () => new Uint8Array() }),
      },
    );

    await assert.rejects(runtime.preflight(), /guarded Compose project already exists/);
    assert.equal(command.calls.some(({ args }) => args.includes('install-release-guard.sh')), false);
  });

  it('rejects target names that are not derived from the fixture identity', () => {
    assert.throws(
      () =>
        new ContinuationFixtureRuntime(
          {
            plan: plan(),
            targets: {
              ...targets(),
              admin: { ...targets().admin, projectName: 'foreign-admin' },
            },
            managerUsername: 'fixture-manager',
            adminUsername: 'fixture-admin',
          },
          secrets,
          {
            command: new PreflightCommand(),
            createControls: () => ({ run: async () => new Uint8Array() }),
          },
        ),
      /guarded application target is malformed/,
    );
  });
});
