import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TREE_DIGEST = '1'.repeat(64);
const FIXTURE_ID = 'srs-continuation-20260920-abc12345';
const FIXTURE_NETWORK = Object.freeze({
  name: `${FIXTURE_ID}-network`,
  fixtureId: FIXTURE_ID,
});
const FIXTURE_NETWORK_ID = '9'.repeat(64);
const FIXTURE_VOLUME_NAMES = Object.freeze(['release-a_srs-media', 'release-a_uploader-state']);
const IMAGE_IDS = Object.freeze({
  'stream-uploader': `sha256:${'a'.repeat(64)}`,
  srs: `sha256:${'b'.repeat(64)}`,
  client: `sha256:${'c'.repeat(64)}`,
  'bee-gateway': `sha256:${'d'.repeat(64)}`,
  'bee-uploader': `sha256:${'e'.repeat(64)}`,
});
const IMAGE_REFERENCES = Object.freeze({
  srs: 'ossrs/srs:6',
  'bee-uploader': 'ethersphere/bee:2.8.2',
  'bee-gateway': 'ethersphere/bee:2.8.2',
});
const roots = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(role, services, overrides = {}) {
  const container = mkdtempSync(join(tmpdir(), `release-${role}-`));
  roots.push(container);
  const rootPath = join(container, 'candidate');
  const workPath = join(container, 'work');
  mkdirSync(rootPath);
  mkdirSync(workPath);
  const root = realpathSync(rootPath);
  const work = realpathSync(workPath);
  mkdirSync(join(root, 'deploy', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
  for (const name of [
    '_lib.sh',
    'assert-started.sh',
    'release-effective-config.mjs',
    'release-adapter.sh',
    'viewer-release-adapter.sh',
  ]) {
    cpSync(join(REPO_ROOT, 'deploy', 'scripts', name), join(root, 'deploy', 'scripts', name));
  }
  for (const name of [
    'docker-compose.yml',
    'docker-compose.host.yml',
    'docker-compose.nat.yml',
    'docker-compose.srs-conf.yml',
  ]) {
    cpSync(join(REPO_ROOT, 'deploy', name), join(root, 'deploy', name));
  }
  for (const name of ['entrypoint.sh', 'healthcheck.sh', 'srs.conf.template']) {
    cpSync(join(REPO_ROOT, 'engines', 'srs', name), join(root, 'engines', 'srs', name));
  }
  writeFileSync(join(root, 'engines', 'srs', '.env.release-a'), 'SRS_HTTP_PORT=8080\n');
  writeFileSync(join(root, 'engines', 'srs', 'custom.conf'), 'synthetic\n');
  writeFileSync(
    join(root, '.env.release-a'),
    [
      'STAMP=synthetic-stamp',
      'STREAM_KEY=synthetic-stream-key',
      'API_AUTH_TOKEN=synthetic-api-token-value-1234567890',
      'ADMIN_API_URL=http://admin.internal',
      'ADMIN_API_TOKEN=SENTINEL_ADMIN_TOKEN_MUST_NOT_APPEAR',
      'SRS_LIFECYCLE_VERSION=1',
      'SRS_UPLOADER_ID=srs-uploader-a',
      'ENGINE=srs',
      `LOCAL_BEE_UPLOADER=${services.includes('bee-uploader') ? 'true' : 'false'}`,
      'BEE_URL=http://external-bee.internal:1633',
      `SRS_CONF_FILE=${join(root, 'engines', 'srs', 'custom.conf')}`,
      'CLIENT_BEE_GATEWAY_HOST=external-gateway.internal',
      'CLIENT_BEE_GATEWAY_PORT=1733',
      '',
    ].join('\n'),
  );
  const known = [
    'srs',
    'stream-uploader',
    'bee-uploader',
    'bee-gateway',
    'bee-uploader-480p',
    'bee-uploader-720p',
    'bee-uploader-1080p',
    'client',
  ];
  writeFileSync(
    join(root, 'deploy', 'config.json'),
    JSON.stringify({
      services: Object.fromEntries(known.map((service) => [service, services.includes(service) ? 'localhost' : false])),
    }),
  );
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const journal = join(root, 'docker.log');
  writeFileSync(journal, '');
  writeNodeStub(join(bin, 'docker'), dockerStub(journal, root));
  writeFileSync(join(root, 'gate.log'), '');
  writeFileSync(
    join(root, 'deploy', 'scripts', 'assert-started.sh'),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$ADAPTER_GATE_JOURNAL"\n',
  );
  chmodSync(join(root, 'deploy', 'scripts', 'assert-started.sh'), 0o755);
  const argumentsValue = {
    target: {
      profile: 'release-a',
      portSlot: 7,
      target: 'local',
      services,
      ...overrides.target,
    },
    ...(overrides.fixtureNetwork ? { fixtureNetwork: overrides.fixtureNetwork } : {}),
    ...(overrides.operation ? { operation: overrides.operation } : {}),
  };
  return {
    root,
    work,
    bin,
    journal,
    gate: join(root, 'gate.log'),
    role,
    services,
    argumentsValue,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: root,
      ADAPTER_GATE_JOURNAL: join(root, 'gate.log'),
      DOCKER_STUB_NETWORK_MODE: overrides.fixtureNetwork ? FIXTURE_NETWORK.name : 'release-a_default',
      ...overrides.env,
    },
  };
}

function planFor(f, phase, changes = {}) {
  const operation = f.argumentsValue.operation;
  const imageServices = operation?.kind === 'prepare' ? operation.mutatingServices : f.services;
  const images =
    phase === 'transition' || phase === 'verify' || phase === 'validate'
      ? imageServices
          .slice()
          .sort()
          .map((service) => ({ service, imageId: IMAGE_IDS[service] }))
      : [];
  return {
    schemaVersion: 1,
    phase,
    temporaryProject: `release-${TREE_DIGEST.slice(0, 20)}`,
    candidateRoot: f.root,
    treeDigest: TREE_DIGEST,
    slot: { role: f.role, id: f.role === 'uploader' ? 'srs-uploader-a' : 'default' },
    images,
    activeArtifactPath: null,
    arguments:
      f.argumentsValue.fixtureNetwork && phase !== 'preflight'
        ? {
            ...f.argumentsValue,
            fixtureNetwork: {
              ...f.argumentsValue.fixtureNetwork,
              networkId: FIXTURE_NETWORK_ID,
            },
            ...(f.role === 'uploader' ? { fixtureVolumeNames: FIXTURE_VOLUME_NAMES } : {}),
          }
        : f.argumentsValue,
    ...changes,
  };
}

function srsConfigDigestFromOverride(f) {
  const override = readFileSync(join(f.work, 'release-image-override.yml'), 'utf8');
  return override.match(/org\.solarpunk\.srs-continuation\.srs-config: "([0-9a-f]{64})"/)?.[1] ?? '';
}

async function run(f, script, phase, changes = {}) {
  const plan = join(f.work, `${phase}.json`);
  const output = join(f.work, `${phase}-output.json`);
  writeFileSync(plan, JSON.stringify(planFor(f, phase, changes)));
  const args = [join(f.root, 'deploy', 'scripts', script), phase, '--plan', plan];
  if (phase !== 'transition') {
    args.push('--output', output);
  }
  try {
    const result = await execFileAsync('bash', args, { env: f.env });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, output };
  } catch (error) {
    return { exitCode: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '', output };
  }
}

describe('guarded uploader release adapter', () => {
  it('prepares only the reserved non-uploader services while lifecycle reporting is disabled', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader', 'bee-uploader'], {
      operation: { kind: 'prepare', mutatingServices: ['bee-uploader', 'srs'] },
    });
    const envPath = join(f.root, '.env.release-a');
    writeFileSync(
      envPath,
      readFileSync(envPath, 'utf8')
        .replace('SRS_LIFECYCLE_VERSION=1', 'SRS_LIFECYCLE_VERSION=')
        .replace('STAMP=synthetic-stamp\n', ''),
    );

    const preflight = await run(f, 'release-adapter.sh', 'preflight');
    assert.equal(preflight.exitCode, 0, `${preflight.stdout}${preflight.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(preflight.output, 'utf8')), {
      schemaVersion: 1,
      preparationReady: true,
    });

    const fixturePreparation = fixture('uploader', ['srs', 'stream-uploader'], {
      operation: { kind: 'prepare', mutatingServices: ['srs'] },
      fixtureNetwork: FIXTURE_NETWORK,
    });
    const fixtureEnvPath = join(fixturePreparation.root, '.env.release-a');
    writeFileSync(
      fixtureEnvPath,
      readFileSync(fixtureEnvPath, 'utf8').replace('SRS_LIFECYCLE_VERSION=1', 'SRS_LIFECYCLE_VERSION='),
    );
    const fixturePreflight = await run(fixturePreparation, 'release-adapter.sh', 'preflight');
    assert.equal(fixturePreflight.exitCode, 0, `${fixturePreflight.stdout}${fixturePreflight.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(fixturePreflight.output, 'utf8')), {
      schemaVersion: 1,
      preparationReady: true,
      fixtureNetworkId: FIXTURE_NETWORK_ID,
      fixtureVolumeNames: FIXTURE_VOLUME_NAMES,
    });
    const fixtureTransition = await run(fixturePreparation, 'release-adapter.sh', 'transition');
    assert.equal(fixtureTransition.exitCode, 0, `${fixtureTransition.stdout}${fixtureTransition.stderr}`);
    fixturePreparation.env.DOCKER_STUB_SRS_CONFIG_DIGEST = srsConfigDigestFromOverride(fixturePreparation);
    fixturePreparation.env.DOCKER_STUB_MISSING_VOLUME = 'release-a_uploader-state';
    const fixtureVerify = await run(fixturePreparation, 'release-adapter.sh', 'verify');
    assert.equal(fixtureVerify.exitCode, 0, `${fixtureVerify.stdout}${fixtureVerify.stderr}`);

    const built = await run(f, 'release-adapter.sh', 'build');
    assert.equal(built.exitCode, 0, `${built.stdout}${built.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(built.output, 'utf8')).images, [
      { service: 'bee-uploader', imageId: IMAGE_IDS['bee-uploader'] },
      { service: 'srs', imageId: IMAGE_IDS.srs },
    ]);

    const transitioned = await run(f, 'release-adapter.sh', 'transition');
    assert.equal(transitioned.exitCode, 0, `${transitioned.stdout}${transitioned.stderr}`);
    const calls = readFileSync(f.journal, 'utf8').split('\n');
    const up = calls.find((call) => call.includes(' up -d '));
    assert.match(up ?? '', / up -d --no-deps --no-build /);
    assert.match(up ?? '', /bee-uploader srs$/);
    assert.equal(readFileSync(f.gate, 'utf8').trim(), 'release-a bee-uploader srs');

    const verified = await run(f, 'release-adapter.sh', 'verify');
    assert.equal(verified.exitCode, 0, `${verified.stdout}${verified.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(verified.output, 'utf8')).images, [
      { service: 'bee-uploader', imageId: IMAGE_IDS['bee-uploader'] },
      { service: 'srs', imageId: IMAGE_IDS.srs },
    ]);
  });

  it('validates untouched services before updating only the reserved uploader subset', async () => {
    const prepared = fixture('uploader', ['srs', 'stream-uploader'], {
      operation: { kind: 'prepare', mutatingServices: ['srs'] },
      fixtureNetwork: FIXTURE_NETWORK,
    });
    const preparedEnvPath = join(prepared.root, '.env.release-a');
    writeFileSync(
      preparedEnvPath,
      readFileSync(preparedEnvPath, 'utf8').replace('SRS_LIFECYCLE_VERSION=1', 'SRS_LIFECYCLE_VERSION='),
    );
    const preparation = await run(prepared, 'release-adapter.sh', 'transition');
    assert.equal(preparation.exitCode, 0, `${preparation.stdout}${preparation.stderr}`);
    const preparedSrsDigest = srsConfigDigestFromOverride(prepared);
    assert.match(preparedSrsDigest, /^[0-9a-f]{64}$/);

    const f = fixture('uploader', ['srs', 'stream-uploader'], {
      operation: { kind: 'update', mutatingServices: ['stream-uploader'] },
      fixtureNetwork: FIXTURE_NETWORK,
      env: {
        DOCKER_STUB_ABSENT_SERVICE: 'stream-uploader',
        DOCKER_STUB_SRS_BIND_ROOT: prepared.root,
        DOCKER_STUB_SRS_CONFIG_DIGEST: preparedSrsDigest,
      },
    });

    const built = await run(f, 'release-adapter.sh', 'build');
    assert.equal(built.exitCode, 0, `${built.stdout}${built.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(built.output, 'utf8')).images, [
      { service: 'srs', imageId: IMAGE_IDS.srs },
      { service: 'stream-uploader', imageId: IMAGE_IDS['stream-uploader'] },
    ]);

    f.env.DOCKER_STUB_WRONG_IMAGE = 'srs';
    const validated = await run(f, 'release-adapter.sh', 'validate');
    assert.equal(validated.exitCode, 0, `${validated.stdout}${validated.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(validated.output, 'utf8')).images, [
      { service: 'srs', imageId: `sha256:${'f'.repeat(64)}` },
    ]);
    assert.equal(
      readFileSync(f.journal, 'utf8')
        .split('\n')
        .some((call) => call.includes(' up -d ')),
      false,
    );
    delete f.env.DOCKER_STUB_WRONG_IMAGE;
    delete f.env.DOCKER_STUB_ABSENT_SERVICE;

    const transitioned = await run(f, 'release-adapter.sh', 'transition');
    assert.equal(transitioned.exitCode, 0, `${transitioned.stdout}${transitioned.stderr}`);
    const calls = readFileSync(f.journal, 'utf8').split('\n');
    const up = calls.find((call) => call.includes(' up -d '));
    assert.match(up ?? '', / up -d --no-deps --no-build /);
    assert.match(up ?? '', /stream-uploader$/);
    assert.doesNotMatch(up ?? '', / up -d .* srs( |$)/);
    assert.equal(readFileSync(f.gate, 'utf8').trim(), 'release-a stream-uploader');

    const verified = await run(f, 'release-adapter.sh', 'verify');
    assert.equal(verified.exitCode, 0, `${verified.stdout}${verified.stderr}`);
    assert.equal(JSON.parse(readFileSync(verified.output, 'utf8')).images.length, 2);
  });

  it('refuses changed untouched SRS bytes or resolved environment before updater movement', async () => {
    const prepared = fixture('uploader', ['srs', 'stream-uploader'], {
      operation: { kind: 'prepare', mutatingServices: ['srs'] },
    });
    const preparedEnvPath = join(prepared.root, '.env.release-a');
    writeFileSync(
      preparedEnvPath,
      readFileSync(preparedEnvPath, 'utf8').replace('SRS_LIFECYCLE_VERSION=1', 'SRS_LIFECYCLE_VERSION='),
    );
    const preparation = await run(prepared, 'release-adapter.sh', 'transition');
    assert.equal(preparation.exitCode, 0, `${preparation.stdout}${preparation.stderr}`);
    const preparedSrsDigest = srsConfigDigestFromOverride(prepared);

    const f = fixture('uploader', ['srs', 'stream-uploader'], {
      operation: { kind: 'update', mutatingServices: ['stream-uploader'] },
      env: {
        DOCKER_STUB_SRS_BIND_ROOT: prepared.root,
        DOCKER_STUB_SRS_CONFIG_DIGEST: preparedSrsDigest,
      },
    });
    f.env.DOCKER_STUB_ACTUAL_SRS_ADAPTER_PORT = '3999';
    const changedRuntime = await run(f, 'release-adapter.sh', 'validate');
    assert.notEqual(changedRuntime.exitCode, 0);
    assert.match(changedRuntime.stderr, /effective configuration/);
    assert.equal(
      readFileSync(f.journal, 'utf8')
        .split('\n')
        .some((call) => call.includes(' up -d ')),
      false,
    );
    delete f.env.DOCKER_STUB_ACTUAL_SRS_ADAPTER_PORT;

    const customConfig = join(f.root, 'engines', 'srs', 'custom.conf');
    writeFileSync(customConfig, 'changed-config-at-the-same-path\n');
    const changedBytes = await run(f, 'release-adapter.sh', 'validate');
    assert.notEqual(changedBytes.exitCode, 0);
    assert.match(changedBytes.stderr, /effective configuration/);
    assert.doesNotMatch(`${changedBytes.stdout}${changedBytes.stderr}`, new RegExp(preparedSrsDigest));
    assert.equal(
      readFileSync(f.journal, 'utf8')
        .split('\n')
        .some((call) => call.includes(' up -d ')),
      false,
    );

    writeFileSync(customConfig, 'synthetic\n');
    const envPath = join(f.root, '.env.release-a');
    writeFileSync(envPath, `${readFileSync(envPath, 'utf8')}HLS_FRAGMENT=0.75\n`);
    const changedEnvironment = await run(f, 'release-adapter.sh', 'validate');
    assert.notEqual(changedEnvironment.exitCode, 0);
    assert.match(changedEnvironment.stderr, /effective configuration/);
    assert.equal(
      readFileSync(f.journal, 'utf8')
        .split('\n')
        .some((call) => call.includes(' up -d ')),
      false,
    );
  });

  it('refuses a changed untouched Bee configuration before updater movement', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader', 'bee-uploader'], {
      operation: { kind: 'update', mutatingServices: ['srs', 'stream-uploader'] },
    });
    const accepted = await run(f, 'release-adapter.sh', 'validate');
    assert.equal(accepted.exitCode, 0, `${accepted.stdout}${accepted.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(accepted.output, 'utf8')).images, [
      { service: 'bee-uploader', imageId: IMAGE_IDS['bee-uploader'] },
    ]);
    assert.match(
      readFileSync(f.journal, 'utf8'),
      /release-validation-image-override\.yml .*config --hash bee-uploader/,
    );

    f.env.DOCKER_STUB_BAD_BEE_CONFIG_HASH = '1';
    const result = await run(f, 'release-adapter.sh', 'validate');

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /effective configuration/);
    assert.equal(
      readFileSync(f.journal, 'utf8')
        .split('\n')
        .some((call) => call.includes(' up -d ')),
      false,
    );
  });

  it('refuses invalid preparation and update mutation sets before Docker moves anything', async () => {
    for (const operation of [
      { kind: 'prepare', mutatingServices: ['srs', 'stream-uploader'] },
      { kind: 'update', mutatingServices: ['srs'] },
      { kind: 'update', mutatingServices: ['stream-uploader', 'srs'] },
      { kind: 'update', mutatingServices: ['stream-uploader', 'unknown'] },
      { kind: 'prepare', mutatingServices: [''] },
    ]) {
      const f = fixture('uploader', ['srs', 'stream-uploader'], { operation });
      const result = await run(f, 'release-adapter.sh', 'transition');
      assert.notEqual(result.exitCode, 0);
      assert.equal(readFileSync(f.journal, 'utf8'), '');
    }
  });

  it('refuses an external mutable SRS configuration for a partial guarded operation', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader'], {
      operation: { kind: 'prepare', mutatingServices: ['srs'] },
    });
    const externalRoot = mkdtempSync(join(tmpdir(), 'release-external-srs-'));
    roots.push(externalRoot);
    const externalConfig = join(externalRoot, 'srs.conf');
    writeFileSync(externalConfig, 'external mutable configuration\n');
    const envPath = join(f.root, '.env.release-a');
    writeFileSync(
      envPath,
      readFileSync(envPath, 'utf8')
        .replace('SRS_LIFECYCLE_VERSION=1', 'SRS_LIFECYCLE_VERSION=')
        .replace(/^SRS_CONF_FILE=.*$/m, `SRS_CONF_FILE=${externalConfig}`),
    );

    const result = await run(f, 'release-adapter.sh', 'preflight');

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /inside its immutable candidate/);
    assert.equal(readFileSync(f.journal, 'utf8'), '');
  });

  it('binds an internal labeled fixture network during preflight', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader'], {
      fixtureNetwork: FIXTURE_NETWORK,
    });
    const result = await run(f, 'release-adapter.sh', 'preflight');

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(result.output, 'utf8')), {
      schemaVersion: 1,
      lifecycleVersion: 1,
      uploaderId: 'srs-uploader-a',
      adminApiConfigured: true,
      fixtureNetworkId: FIXTURE_NETWORK_ID,
      fixtureVolumeNames: FIXTURE_VOLUME_NAMES,
    });
    assert.match(readFileSync(f.journal, 'utf8'), new RegExp(`network inspect .*${FIXTURE_NETWORK.name}`));
  });

  it('refuses a fixture network that is public or carries the wrong owner label', async () => {
    const publicNetwork = fixture('uploader', ['srs', 'stream-uploader'], {
      fixtureNetwork: FIXTURE_NETWORK,
      env: { DOCKER_STUB_NETWORK_INTERNAL: 'false' },
    });
    const publicResult = await run(publicNetwork, 'release-adapter.sh', 'preflight');
    assert.notEqual(publicResult.exitCode, 0);
    assert.match(publicResult.stderr, /fixture network/);

    const wrongOwner = fixture('uploader', ['srs', 'stream-uploader'], {
      fixtureNetwork: FIXTURE_NETWORK,
      env: { DOCKER_STUB_FIXTURE_LABEL: 'srs-continuation-20260920-wrong999' },
    });
    const wrongOwnerResult = await run(wrongOwner, 'release-adapter.sh', 'preflight');
    assert.notEqual(wrongOwnerResult.exitCode, 0);
    assert.match(wrongOwnerResult.stderr, /fixture network/);
  });

  it('removes every uploader port and binds selected services to the fixture network', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader'], {
      fixtureNetwork: FIXTURE_NETWORK,
    });
    const result = await run(f, 'release-adapter.sh', 'transition');

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    const reset = readFileSync(join(f.work, 'release-fixture-port-reset.yml'), 'utf8');
    const override = readFileSync(join(f.work, 'release-image-override.yml'), 'utf8');
    assert.match(reset, /srs:\n {4}ports: !reset \[\]/);
    assert.match(reset, /stream-uploader:\n {4}ports: !reset \[\]/);
    assert.match(override, new RegExp(`name: ${FIXTURE_NETWORK.name}`));
    assert.match(override, new RegExp(`org\\.solarpunk\\.srs-continuation\\.fixture: "${FIXTURE_ID}"`));
    assert.match(override, /org\.solarpunk\.srs-continuation\.managed: "true"/);
    assert.doesNotMatch(override, /127\.0\.0\.1:/);
    assert.match(override, /srs-media:\n {4}labels:/);
    assert.match(override, /uploader-state:\n {4}labels:/);
  });

  it('refuses receipt when a selected container is not on the bound fixture network id', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader'], {
      fixtureNetwork: FIXTURE_NETWORK,
      env: { DOCKER_STUB_CONTAINER_NETWORK_ID: '8'.repeat(64) },
    });
    assert.equal((await run(f, 'release-adapter.sh', 'transition')).exitCode, 0);
    const result = await run(f, 'release-adapter.sh', 'verify');

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /fixture network/);
  });

  it('refuses receipt for an unlabeled fixture volume or an unexpected published port', async () => {
    const unlabeledVolume = fixture('uploader', ['srs', 'stream-uploader'], {
      fixtureNetwork: FIXTURE_NETWORK,
    });
    assert.equal((await run(unlabeledVolume, 'release-adapter.sh', 'transition')).exitCode, 0);
    unlabeledVolume.env.DOCKER_STUB_VOLUME_MANAGED_LABEL = 'false';
    const unlabeledResult = await run(unlabeledVolume, 'release-adapter.sh', 'verify');
    assert.notEqual(unlabeledResult.exitCode, 0);
    assert.match(unlabeledResult.stderr, /fixture volume/);

    const publishedPort = fixture('uploader', ['srs', 'stream-uploader'], {
      fixtureNetwork: FIXTURE_NETWORK,
    });
    assert.equal((await run(publishedPort, 'release-adapter.sh', 'transition')).exitCode, 0);
    publishedPort.env.DOCKER_STUB_PUBLISHED_PORTS = 'unexpected';
    const publishedResult = await run(publishedPort, 'release-adapter.sh', 'verify');
    assert.notEqual(publishedResult.exitCode, 0);
    assert.match(publishedResult.stderr, /published ports/);
  });

  it('refuses receipt for missing container labels or incorrect volume mounts', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader'], {
      fixtureNetwork: FIXTURE_NETWORK,
    });
    assert.equal((await run(f, 'release-adapter.sh', 'transition')).exitCode, 0);

    f.env.DOCKER_STUB_CONTAINER_MANAGED_LABEL = 'false';
    const unlabeled = await run(f, 'release-adapter.sh', 'verify');
    assert.notEqual(unlabeled.exitCode, 0);
    assert.match(unlabeled.stderr, /fixture labels/);

    delete f.env.DOCKER_STUB_CONTAINER_MANAGED_LABEL;
    f.env.DOCKER_STUB_WRONG_MOUNTS = '1';
    const wrongMount = await run(f, 'release-adapter.sh', 'verify');
    assert.notEqual(wrongMount.exitCode, 0);
    assert.match(wrongMount.stderr, /fixture mounts/);
  });

  it('reports only the bounded effective managed configuration', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader']);
    const result = await run(f, 'release-adapter.sh', 'preflight');

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(result.output, 'utf8')), {
      schemaVersion: 1,
      lifecycleVersion: 1,
      uploaderId: 'srs-uploader-a',
      adminApiConfigured: true,
    });
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}${readFileSync(result.output, 'utf8')}`,
      /SENTINEL_ADMIN_TOKEN/,
    );
  });

  it('refuses a mismatched uploader identity without printing secret values', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader']);
    const envPath = join(f.root, '.env.release-a');
    writeFileSync(
      envPath,
      readFileSync(envPath, 'utf8').replace('SRS_UPLOADER_ID=srs-uploader-a', 'SRS_UPLOADER_ID=other-uploader'),
    );
    const result = await run(f, 'release-adapter.sh', 'preflight');

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /SRS_UPLOADER_ID/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SENTINEL_ADMIN_TOKEN/);
  });

  it('refuses transition when managed lifecycle preflight would fail', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader']);
    const envPath = join(f.root, '.env.release-a');
    writeFileSync(envPath, readFileSync(envPath, 'utf8').replace('SRS_LIFECYCLE_VERSION=1', 'SRS_LIFECYCLE_VERSION=0'));
    const result = await run(f, 'release-adapter.sh', 'transition');

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /SRS_LIFECYCLE_VERSION/);
    assert.equal(readFileSync(f.journal, 'utf8'), '');
  });

  it('accepts the bounded existing combined SRS profile services', async () => {
    const f = fixture('uploader', [
      'srs',
      'stream-uploader',
      'bee-uploader',
      'bee-gateway',
      'bee-uploader-480p',
      'bee-uploader-720p',
      'bee-uploader-1080p',
      'client',
    ]);
    const result = await run(f, 'release-adapter.sh', 'preflight');

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
  });

  it('builds under the isolated project, pulls external images, and returns exact ids', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader', 'bee-uploader']);
    const result = await run(f, 'release-adapter.sh', 'build');

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    const calls = readFileSync(f.journal, 'utf8');
    assert.match(calls, new RegExp(`--project-name release-${TREE_DIGEST.slice(0, 20)} .* build stream-uploader`));
    assert.match(calls, / pull .*srs.*bee-uploader| pull .*bee-uploader.*srs/);
    assert.match(calls, / config --images bee-uploader/);
    assert.match(calls, / config --images srs/);
    assert.doesNotMatch(calls, / images -q/);
    assert.doesNotMatch(calls, / up /, 'build created a temporary container to discover an image');
    assert.match(calls, /effective BEE_URL=http:\/\/bee-uploader:10075/);
    assert.deepEqual(JSON.parse(readFileSync(result.output, 'utf8')).images, [
      { service: 'bee-uploader', imageId: IMAGE_IDS['bee-uploader'] },
      { service: 'srs', imageId: IMAGE_IDS.srs },
      { service: 'stream-uploader', imageId: IMAGE_IDS['stream-uploader'] },
    ]);
  });

  it('transitions with exact ids, no pull or build, and runs the existing start gate', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader']);
    const result = await run(f, 'release-adapter.sh', 'transition');

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    const calls = readFileSync(f.journal, 'utf8');
    assert.match(calls, / up -d --no-build --pull never srs stream-uploader/);
    assert.doesNotMatch(calls, / up -d --no-deps /);
    assert.equal(
      calls.split('\n').some((call) => /(^| )(build|pull)( |$)/.test(call)),
      false,
    );
    assert.equal(readFileSync(f.gate, 'utf8').trim(), 'release-a srs stream-uploader');
    const overridePath = join(f.work, 'release-image-override.yml');
    const override = readFileSync(overridePath, 'utf8');
    assert.match(override, new RegExp(IMAGE_IDS.srs));
    assert.match(override, new RegExp(IMAGE_IDS['stream-uploader']));
    assert.match(calls, /docker-compose\.srs-conf\.yml/);
  });

  it('verifies every running healthy container and returns its actual ids', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader']);
    assert.equal((await run(f, 'release-adapter.sh', 'transition')).exitCode, 0);
    const result = await run(f, 'release-adapter.sh', 'verify');

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(result.output, 'utf8')).images, [
      { service: 'srs', imageId: IMAGE_IDS.srs },
      { service: 'stream-uploader', imageId: IMAGE_IDS['stream-uploader'] },
    ]);
  });

  it('refuses an unhealthy service and a running service on the wrong image', async () => {
    const unhealthy = fixture('uploader', ['srs', 'stream-uploader'], {
      env: { DOCKER_STUB_UNHEALTHY: 'stream-uploader' },
    });
    assert.equal((await run(unhealthy, 'release-adapter.sh', 'transition')).exitCode, 0);
    const unhealthyResult = await run(unhealthy, 'release-adapter.sh', 'verify');
    assert.notEqual(unhealthyResult.exitCode, 0);
    assert.match(unhealthyResult.stderr, /not healthy/);

    const wrongImage = fixture('uploader', ['srs', 'stream-uploader'], {
      env: { DOCKER_STUB_WRONG_IMAGE: 'srs' },
    });
    assert.equal((await run(wrongImage, 'release-adapter.sh', 'transition')).exitCode, 0);
    const wrongImageResult = await run(wrongImage, 'release-adapter.sh', 'verify');
    assert.notEqual(wrongImageResult.exitCode, 0);
    assert.match(wrongImageResult.stderr, /does not match/);
  });

  it('refuses a missing engine input without creating it in the candidate', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader']);
    rmSync(join(f.root, 'engines', 'srs', '.env.release-a'));
    const before = candidateEntries(f.root);
    const result = await run(f, 'release-adapter.sh', 'preflight');

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /SRS environment/);
    assert.deepEqual(candidateEntries(f.root), before);
    assert.equal(readFileSync(f.journal, 'utf8'), '');
  });

  it('refuses unknown services before Docker moves anything', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader', 'ome']);
    const result = await run(f, 'release-adapter.sh', 'transition');

    assert.notEqual(result.exitCode, 0);
    assert.equal(readFileSync(f.journal, 'utf8'), '');
  });

  it('refuses a retargeted candidate before Docker moves anything', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader']);
    const result = await run(f, 'release-adapter.sh', 'transition', { candidateRoot: f.work });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /candidate root/);
    assert.equal(readFileSync(f.journal, 'utf8'), '');
  });
});

describe('guarded viewer release adapter', () => {
  it('publishes only the derived loopback client port on a fixture network', async () => {
    const f = fixture('viewer', ['client'], { fixtureNetwork: FIXTURE_NETWORK });
    const preflight = await run(f, 'viewer-release-adapter.sh', 'preflight');
    assert.equal(preflight.exitCode, 0, `${preflight.stdout}${preflight.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(preflight.output, 'utf8')), {
      schemaVersion: 1,
      fixtureNetworkId: FIXTURE_NETWORK_ID,
    });

    const transition = await run(f, 'viewer-release-adapter.sh', 'transition');
    assert.equal(transition.exitCode, 0, `${transition.stdout}${transition.stderr}`);
    const reset = readFileSync(join(f.work, 'release-fixture-port-reset.yml'), 'utf8');
    const override = readFileSync(join(f.work, 'release-image-override.yml'), 'utf8');
    assert.match(reset, /client:\n {4}ports: !reset \[\]/);
    assert.match(override, /127\.0\.0\.1:10074:80/);

    const verified = await run(f, 'viewer-release-adapter.sh', 'verify');
    assert.equal(verified.exitCode, 0, `${verified.stdout}${verified.stderr}`);

    f.env.DOCKER_STUB_PUBLISHED_PORTS = 'unexpected';
    const exposed = await run(f, 'viewer-release-adapter.sh', 'verify');
    assert.notEqual(exposed.exitCode, 0);
    assert.match(exposed.stderr, /published ports/);
  });

  it('accepts a client that preserves its configured external gateway', async () => {
    const f = fixture('viewer', ['client']);
    const result = await run(f, 'viewer-release-adapter.sh', 'preflight');

    assert.equal(result.exitCode, 0, `${result.stdout}${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(result.output, 'utf8')), { schemaVersion: 1 });

    assert.equal((await run(f, 'viewer-release-adapter.sh', 'build')).exitCode, 0);
    assert.equal((await run(f, 'viewer-release-adapter.sh', 'transition')).exitCode, 0);
    f.env.DOCKER_STUB_NO_HEALTH = 'client';
    const verified = await run(f, 'viewer-release-adapter.sh', 'verify');
    assert.equal(verified.exitCode, 0, `${verified.stdout}${verified.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(verified.output, 'utf8')).images, [
      { service: 'client', imageId: IMAGE_IDS.client },
    ]);
  });

  it('accepts the bounded local gateway pair and rejects every other shape', async () => {
    const accepted = fixture('viewer', ['bee-gateway', 'client']);
    assert.equal((await run(accepted, 'viewer-release-adapter.sh', 'preflight')).exitCode, 0);
    assert.equal((await run(accepted, 'viewer-release-adapter.sh', 'build')).exitCode, 0);
    assert.match(
      readFileSync(accepted.journal, 'utf8'),
      /effective .*CLIENT_BEE_GATEWAY_HOST=bee-gateway CLIENT_BEE_GATEWAY_PORT=10077/,
    );

    const rejected = fixture('viewer', ['client', 'srs']);
    const result = await run(rejected, 'viewer-release-adapter.sh', 'transition');
    assert.notEqual(result.exitCode, 0);
    assert.equal(readFileSync(rejected.journal, 'utf8'), '');
  });
});

function candidateEntries(root, relative = '') {
  const entries = [];
  for (const name of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, name.name);
    if (name.isDirectory()) {
      entries.push(...candidateEntries(root, path));
    } else {
      entries.push(`${path}:${readFileSync(join(root, path)).toString('hex')}`);
    }
  }
  return entries.sort();
}

function writeNodeStub(path, body) {
  writeFileSync(`${path}.cjs`, body);
  writeFileSync(path, '#!/bin/sh\nexec node -- "$0.cjs" "$@"\n');
  chmodSync(path, 0o755);
}

function dockerStub(journal, candidateRoot) {
  return `const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(journal)}, argv.join(' ') + '\\n');
fs.appendFileSync(${JSON.stringify(
    journal,
  )}, 'effective BEE_URL=' + (process.env.BEE_URL || '') + ' CLIENT_BEE_GATEWAY_HOST=' + (process.env.CLIENT_BEE_GATEWAY_HOST || '') + ' CLIENT_BEE_GATEWAY_PORT=' + (process.env.CLIENT_BEE_GATEWAY_PORT || '') + '\\n');
const ids = ${JSON.stringify(IMAGE_IDS)};
const references = ${JSON.stringify(IMAGE_REFERENCES)};
const fixtureId = process.env.DOCKER_STUB_FIXTURE_LABEL || ${JSON.stringify(FIXTURE_ID)};
const fixtureNetworkId = process.env.DOCKER_STUB_NETWORK_ID || ${JSON.stringify(FIXTURE_NETWORK_ID)};
const composeHash = '7'.repeat(64);
function serviceFrom(value) {
  for (const [service, reference] of Object.entries(references)) if (value === reference) return service;
  for (const service of Object.keys(ids)) if (value === service || value.endsWith('-' + service) || value === 'c-' + service) return service;
  return '';
}
if (argv[0] === 'image' && argv[1] === 'inspect') {
  if ((argv[3] || '').includes('.Config.Env')) console.log(JSON.stringify(['BASE_IMAGE_ENV=1']));
  else console.log(ids[serviceFrom(argv.at(-1))] || '');
  process.exit(0);
}
if (argv[0] === 'network' && argv[1] === 'inspect') {
  console.log(JSON.stringify([{
    Id: fixtureNetworkId,
    Internal: (process.env.DOCKER_STUB_NETWORK_INTERNAL || 'true') === 'true',
    Labels: {
      'org.solarpunk.srs-continuation.fixture': fixtureId,
      'org.solarpunk.srs-continuation.managed': process.env.DOCKER_STUB_MANAGED_LABEL || 'true',
    },
  }]));
  process.exit(0);
}
if (argv[0] === 'volume' && argv[1] === 'inspect') {
  if (process.env.DOCKER_STUB_MISSING_VOLUME === argv.at(-1)) process.exit(1);
  console.log(JSON.stringify([{
    Name: argv.at(-1),
    Labels: {
      'org.solarpunk.srs-continuation.fixture': fixtureId,
      'org.solarpunk.srs-continuation.managed': process.env.DOCKER_STUB_VOLUME_MANAGED_LABEL || 'true',
    },
  }]));
  process.exit(0);
}
if (argv[0] === 'compose') {
  const command = ['build', 'pull', 'up', 'ps', 'images', 'config'].find((value) => argv.includes(value));
  const service = serviceFrom(argv.at(-1));
  if (command === 'ps' && process.env.DOCKER_STUB_ABSENT_SERVICE !== service) console.log('c-' + argv.at(-1));
  if (command === 'config' && argv.includes('--images')) console.log(references[service] || '');
  if (command === 'config' && argv.includes('--hash')) console.log(service + ' ' + (argv.some((value) => value.includes('release-validation-image-override.yml')) ? composeHash : '6'.repeat(64)));
  if (command === 'config' && argv.includes('--format')) console.log(JSON.stringify({
    services: {
      srs: {
        environment: {
          HLS_FRAGMENT: process.env.HLS_FRAGMENT || '0.5',
          SRS_ADAPTER_HOST: process.env.SRS_ADAPTER_HOST || 'stream-uploader',
          SRS_ADAPTER_PORT: process.env.SRS_ADAPTER_PORT || '3000',
          SRS_WEBHOOK_TOKEN: process.env.SRS_WEBHOOK_TOKEN || '',
        },
        entrypoint: ['/bin/bash', '/usr/local/srs/conf/entrypoint.sh'],
        networks: { default: null },
        volumes: [
          { type: 'bind', source: ${JSON.stringify(
            join(candidateRoot, 'engines/srs/srs.conf.template'),
          )}, target: '/usr/local/srs/conf/srs.conf.template', read_only: true },
          { type: 'bind', source: ${JSON.stringify(
            join(candidateRoot, 'engines/srs/entrypoint.sh'),
          )}, target: '/usr/local/srs/conf/entrypoint.sh', read_only: true },
          { type: 'bind', source: ${JSON.stringify(
            join(candidateRoot, 'engines/srs/healthcheck.sh'),
          )}, target: '/usr/local/srs/conf/healthcheck.sh', read_only: true },
          ...(process.env.SRS_CONF_FILE ? [{ type: 'bind', source: process.env.SRS_CONF_FILE, target: '/usr/local/srs/conf/srs.conf.custom', read_only: true }] : []),
          { type: 'volume', source: 'srs-media', target: '/usr/local/srs/objs/nginx/html' },
        ],
      },
    },
  }));
  process.exit(0);
}
if (argv[0] === 'inspect') {
  const format = argv[2] || '';
  const service = serviceFrom(argv.at(-1));
  const srsBindRoot = process.env.DOCKER_STUB_SRS_BIND_ROOT || ${JSON.stringify(candidateRoot)};
  if (format.includes('.State.Status')) console.log('running');
  else if (format.includes('.State.Health')) console.log(process.env.DOCKER_STUB_NO_HEALTH === service ? '' : process.env.DOCKER_STUB_UNHEALTHY === service ? 'unhealthy' : 'healthy');
  else if (format.includes('.Image')) console.log(process.env.DOCKER_STUB_WRONG_IMAGE === service ? 'sha256:' + 'f'.repeat(64) : ids[service]);
  else if (format.includes('.Config.Env')) console.log(JSON.stringify([
    'BASE_IMAGE_ENV=1',
    'HLS_FRAGMENT=' + (process.env.HLS_FRAGMENT || '0.5'),
    'SRS_ADAPTER_HOST=' + (process.env.SRS_ADAPTER_HOST || 'stream-uploader'),
    'SRS_ADAPTER_PORT=' + (process.env.DOCKER_STUB_ACTUAL_SRS_ADAPTER_PORT || process.env.SRS_ADAPTER_PORT || '3000'),
    'SRS_WEBHOOK_TOKEN=' + (process.env.SRS_WEBHOOK_TOKEN || ''),
  ]));
  else if (format.includes('.Config.Entrypoint')) console.log(JSON.stringify(['/bin/bash', '/usr/local/srs/conf/entrypoint.sh']));
  else if (format.includes('.HostConfig.NetworkMode')) console.log(process.env.DOCKER_STUB_NETWORK_MODE || 'release-a_default');
  else if (format.includes('.NetworkSettings.Networks')) console.log(process.env.DOCKER_STUB_CONTAINER_NETWORK_ID || fixtureNetworkId);
  else if (format.includes('com.docker.compose.config-hash')) console.log(process.env.DOCKER_STUB_BAD_BEE_CONFIG_HASH === '1' ? '8'.repeat(64) : composeHash);
  else if (format.includes('com.docker.compose.project')) console.log('release-a');
  else if (format.includes('com.docker.compose.service')) console.log(service);
  else if (format.includes('org.solarpunk.srs-continuation.srs-config')) console.log(process.env.DOCKER_STUB_SRS_CONFIG_DIGEST || '');
  else if (format.includes('.Config.Labels')) console.log(JSON.stringify({
    'org.solarpunk.srs-continuation.fixture': fixtureId,
    'org.solarpunk.srs-continuation.managed': process.env.DOCKER_STUB_CONTAINER_MANAGED_LABEL || 'true',
    'org.solarpunk.srs-continuation.srs-config': process.env.DOCKER_STUB_SRS_CONFIG_DIGEST || '',
    'com.docker.compose.config-hash': process.env.DOCKER_STUB_BAD_BEE_CONFIG_HASH === '1' ? '8'.repeat(64) : composeHash,
    'com.docker.compose.project': 'release-a',
    'com.docker.compose.service': service,
  }));
  else if (format.includes('.NetworkSettings.Ports')) {
    if (process.env.DOCKER_STUB_PUBLISHED_PORTS === 'unexpected') console.log(JSON.stringify({ '1935/tcp': [{ HostIp: '0.0.0.0', HostPort: '1935' }] }));
    else if (process.env.RELEASE_ADAPTER_ROLE === 'viewer') console.log(JSON.stringify({ '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '10074' }] }));
    else console.log(JSON.stringify({ '3000/tcp': null }));
  } else if (format.includes('.Mounts')) {
    if (process.env.DOCKER_STUB_WRONG_MOUNTS === '1') console.log('[]');
    else if (service === 'srs') console.log(JSON.stringify([
      { Type: 'bind', Source: srsBindRoot + '/engines/srs/srs.conf.template', Destination: '/usr/local/srs/conf/srs.conf.template', RW: false },
      { Type: 'bind', Source: srsBindRoot + '/engines/srs/entrypoint.sh', Destination: '/usr/local/srs/conf/entrypoint.sh', RW: false },
      { Type: 'bind', Source: srsBindRoot + '/engines/srs/healthcheck.sh', Destination: '/usr/local/srs/conf/healthcheck.sh', RW: false },
      ...(process.env.SRS_CONF_FILE ? [{ Type: 'bind', Source: srsBindRoot + '/engines/srs/custom.conf', Destination: '/usr/local/srs/conf/srs.conf.custom', RW: false }] : []),
      { Type: 'volume', Name: 'release-a_srs-media', Destination: '/usr/local/srs/objs/nginx/html', RW: true },
    ]));
    else if (service === 'stream-uploader') console.log(JSON.stringify([
      { Type: 'volume', Name: 'release-a_srs-media', Destination: '/media' },
      { Type: 'volume', Name: 'release-a_uploader-state', Destination: '/app/state' },
    ]));
    else console.log('[]');
  }
  process.exit(0);
}
process.exit(0);
`;
}
