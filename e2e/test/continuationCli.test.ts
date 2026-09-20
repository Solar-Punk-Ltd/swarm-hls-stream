import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runContinuationCli } from '../src/continuation/cli.js';
import { createFixturePlan } from '../src/continuation/fixture.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const COMMIT = '1'.repeat(40);
const IMAGE = `sha256:${'2'.repeat(64)}`;

function configuration() {
  const parent = mkdtempSync(join(tmpdir(), 'continuation-cli-'));
  const plan = createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: join(parent, FIXTURE_ID),
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
    loopbackPorts: { rpc: 49_201, admin: 49_202, viewer: 49_203 },
    minimumStorageBytes: 1_024,
    minimumStorageTtlSeconds: 600,
    expectedChainId: 1_337,
  });
  return {
    parent,
    value: {
      schemaVersion: 1,
      plan,
      targets: {
        manager: {
          projectName: 'srs-a1b2c3d4-manager',
          postgresVolumeName: 'srs-a1b2c3d4-manager-pg',
          postgresPort: 54_322,
          webPort: 49_204,
        },
        admin: {
          projectName: 'srs-a1b2c3d4-admin',
          postgresVolumeName: 'srs-a1b2c3d4-admin-pg',
          webPort: 49_202,
        },
        uploader: { profile: 'srs-a1b2c3d4-uploader', portSlot: 1, services: ['srs', 'stream-uploader'] },
        viewer: { profile: 'srs-a1b2c3d4-viewer', portSlot: 1, services: ['client'] },
      },
      managerUsername: 'fixture-manager',
      adminUsername: 'fixture-admin',
    },
  };
}

const environment = {
  SRS_FIXTURE_BEE_PASSWORD: 'synthetic-bee-password',
  SRS_FIXTURE_MANAGER_PASSWORD: 'synthetic-manager-password',
  SRS_FIXTURE_ADMIN_PASSWORD: 'synthetic-admin-password',
  FEED_PRIVATE_KEY: 'synthetic-feed-private-key',
  INGEST_SRT_PASSPHRASE: 'synthetic-srt-passphrase',
};

describe('continuation fixture CLI', () => {
  it('routes a bounded non-secret config and process-only inputs into the concrete runner', async () => {
    const { parent, value } = configuration();
    const path = join(parent, 'fixture.json');
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    const observed: unknown[] = [];

    const result = await runContinuationCli(
      ['run', '--scenario', 'cumulative', '--config', path],
      environment,
      async (configuration, secrets, scenario) => {
        observed.push(configuration, secrets, scenario);
      },
    );

    assert.deepEqual(result, {
      schemaVersion: 1,
      fixtureId: FIXTURE_ID,
      scenario: 'cumulative',
      status: 'passed',
      evidencePath: join(value.plan.outputRoot, 'scenario-evidence.json'),
    });
    assert.equal(observed.length, 3);
    assert.deepEqual(observed[1], {
      beePassword: environment.SRS_FIXTURE_BEE_PASSWORD,
      managerPassword: environment.SRS_FIXTURE_MANAGER_PASSWORD,
      adminPassword: environment.SRS_FIXTURE_ADMIN_PASSWORD,
      feedPrivateKey: environment.FEED_PRIVATE_KEY,
      srtPassphrase: environment.INGEST_SRT_PASSPHRASE,
    });
    assert.equal(observed[2], 'cumulative');
  });

  it('refuses credential-shaped configuration before invoking the runner', async () => {
    const { parent, value } = configuration();
    const path = join(parent, 'fixture.json');
    writeFileSync(path, JSON.stringify({ ...value, managerPassword: 'must-not-be-here' }), { mode: 0o600 });
    let invoked = false;

    await assert.rejects(
      runContinuationCli(['run', '--scenario', 'cumulative', '--config', path], environment, async () => {
        invoked = true;
      }),
      /configuration contains a credential field/,
    );
    assert.equal(invoked, false);
  });

  it('selects reconnect as a separate fresh-fixture scenario', async () => {
    const { parent, value } = configuration();
    const path = join(parent, 'fixture.json');
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    let selected: unknown;

    const result = await runContinuationCli(
      ['run', '--scenario', 'reconnect', '--config', path],
      environment,
      async (_configuration, _secrets, scenario) => {
        selected = scenario;
      },
    );

    assert.equal(selected, 'reconnect');
    assert.equal(result.scenario, 'reconnect');
  });

  it('withholds configuration and environment values from malformed-input failures', async () => {
    const { parent, value } = configuration();
    const sentinel = 'credential-sentinel-must-not-appear';
    const path = join(parent, 'fixture.json');
    writeFileSync(path, JSON.stringify({ ...value, token: sentinel }), { mode: 0o600 });

    await assert.rejects(
      runContinuationCli(
        ['run', '--scenario', 'cumulative', '--config', path],
        { ...environment, SRS_FIXTURE_ADMIN_PASSWORD: sentinel },
        async () => undefined,
      ),
      (error: Error) => {
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        return true;
      },
    );
  });
});
