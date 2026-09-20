import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const SRS_BIND_ROLES = new Map([
  ['/usr/local/srs/conf/entrypoint.sh', 'entrypoint'],
  ['/usr/local/srs/conf/healthcheck.sh', 'healthcheck'],
  ['/usr/local/srs/conf/srs.conf.custom', 'custom'],
  ['/usr/local/srs/conf/srs.conf.template', 'template'],
]);

function refuse() {
  process.stderr.write('release effective configuration is invalid\n');
  process.exit(1);
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      refuse();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

async function digestFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_FILE_BYTES) {
    refuse();
  }
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function normalizeSrs(service) {
  if (service === null || typeof service !== 'object' || Array.isArray(service)) {
    refuse();
  }
  if (!Array.isArray(service.volumes)) {
    refuse();
  }
  const hasCustom = service.volumes.some(
    (volume) => volume?.type === 'bind' && volume?.target === '/usr/local/srs/conf/srs.conf.custom',
  );
  const volumes = [];
  for (const volume of service.volumes) {
    if (volume === null || typeof volume !== 'object' || Array.isArray(volume)) {
      refuse();
    }
    if (volume.type !== 'bind') {
      volumes.push(volume);
      continue;
    }
    const role = SRS_BIND_ROLES.get(volume.target);
    if (role === undefined || typeof volume.source !== 'string') {
      refuse();
    }
    const selected = role !== 'template' || !hasCustom;
    volumes.push({
      ...volume,
      source: selected ? `role:${role}:sha256:${await digestFile(volume.source)}` : 'role:template:unused',
    });
  }
  return { ...service, volumes };
}

try {
  if (process.argv[2] !== 'srs') {
    refuse();
  }
  const fixtureNetworkId = process.argv[3] ?? '';
  if (fixtureNetworkId !== '' && !/^[0-9a-f]{64}$/.test(fixtureNetworkId)) {
    refuse();
  }
  const parsed = JSON.parse(await readInput());
  const service = await normalizeSrs(parsed?.services?.srs);
  const payload = canonical({
    version: 1,
    service,
    fixtureNetworkId: fixtureNetworkId || null,
  });
  process.stdout.write(createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
} catch {
  refuse();
}
