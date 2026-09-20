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
  writeFileSync(join(root, 'engines', 'srs', '.env.release-a'), 'SRS_HTTP_PORT=8080\n');
  writeFileSync(join(root, 'engines', 'srs', 'custom.conf'), 'synthetic\n');
  writeFileSync(join(root, '.env.release-a'), [
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
  ].join('\n'));
  const known = [
    'srs', 'stream-uploader', 'bee-uploader', 'bee-gateway',
    'bee-uploader-480p', 'bee-uploader-720p', 'bee-uploader-1080p', 'client',
  ];
  writeFileSync(join(root, 'deploy', 'config.json'), JSON.stringify({
    services: Object.fromEntries(known.map((service) => [service, services.includes(service) ? 'localhost' : false])),
  }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const journal = join(root, 'docker.log');
  writeFileSync(journal, '');
  writeNodeStub(join(bin, 'docker'), dockerStub(journal));
  writeFileSync(join(root, 'gate.log'), '');
  writeFileSync(join(root, 'deploy', 'scripts', 'assert-started.sh'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$ADAPTER_GATE_JOURNAL"\n');
  chmodSync(join(root, 'deploy', 'scripts', 'assert-started.sh'), 0o755);
  const argumentsValue = {
    target: {
      profile: 'release-a',
      portSlot: 7,
      target: 'local',
      services,
      ...overrides.target,
    },
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
      ...overrides.env,
    },
  };
}

function planFor(f, phase, changes = {}) {
  const images = phase === 'transition' || phase === 'verify'
    ? f.services.slice().sort().map((service) => ({ service, imageId: IMAGE_IDS[service] }))
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
    arguments: f.argumentsValue,
    ...changes,
  };
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
    assert.doesNotMatch(`${result.stdout}${result.stderr}${readFileSync(result.output, 'utf8')}`, /SENTINEL_ADMIN_TOKEN/);
  });

  it('refuses a mismatched uploader identity without printing secret values', async () => {
    const f = fixture('uploader', ['srs', 'stream-uploader']);
    const envPath = join(f.root, '.env.release-a');
    writeFileSync(envPath, readFileSync(envPath, 'utf8').replace('SRS_UPLOADER_ID=srs-uploader-a', 'SRS_UPLOADER_ID=other-uploader'));
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
    assert.equal(calls.split('\n').some((call) => /(^| )(build|pull)( |$)/.test(call)), false);
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

function dockerStub(journal) {
  return `const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(journal)}, argv.join(' ') + '\\n');
const ids = ${JSON.stringify(IMAGE_IDS)};
const references = ${JSON.stringify(IMAGE_REFERENCES)};
function serviceFrom(value) {
  for (const [service, reference] of Object.entries(references)) if (value === reference) return service;
  for (const service of Object.keys(ids)) if (value === service || value.endsWith('-' + service) || value === 'c-' + service) return service;
  return '';
}
if (argv[0] === 'image' && argv[1] === 'inspect') {
  console.log(ids[serviceFrom(argv.at(-1))] || '');
  process.exit(0);
}
if (argv[0] === 'compose') {
  const command = ['build', 'pull', 'up', 'ps', 'images', 'config'].find((value) => argv.includes(value));
  if (command === 'ps') console.log('c-' + argv.at(-1));
  if (command === 'config') console.log(references[serviceFrom(argv.at(-1))] || '');
  process.exit(0);
}
if (argv[0] === 'inspect') {
  const format = argv[2] || '';
  const service = serviceFrom(argv.at(-1));
  if (format.includes('.State.Status')) console.log('running');
  else if (format.includes('.State.Health')) console.log(process.env.DOCKER_STUB_NO_HEALTH === service ? '' : process.env.DOCKER_STUB_UNHEALTHY === service ? 'unhealthy' : 'healthy');
  else if (format.includes('.Image')) console.log(process.env.DOCKER_STUB_WRONG_IMAGE === service ? 'sha256:' + 'f'.repeat(64) : ids[service]);
  process.exit(0);
}
process.exit(0);
`;
}
