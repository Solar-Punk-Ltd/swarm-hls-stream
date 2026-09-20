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
const SRS_VOLUME_ROLES = new Map([['/usr/local/srs/objs/nginx/html', 'media']]);

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

function environmentFromEntries(entries) {
  if (!Array.isArray(entries)) {
    refuse();
  }
  const environment = {};
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      refuse();
    }
    const separator = entry.indexOf('=');
    const key = separator === -1 ? entry : entry.slice(0, separator);
    if (key === '' || Object.hasOwn(environment, key)) {
      refuse();
    }
    environment[key] = separator === -1 ? '' : entry.slice(separator + 1);
  }
  return environment;
}

function candidateEnvironment(baseEntries, configured) {
  if (configured === null || typeof configured !== 'object' || Array.isArray(configured)) {
    refuse();
  }
  const environment = environmentFromEntries(baseEntries);
  for (const [key, value] of Object.entries(configured)) {
    if (key === '' || typeof value !== 'string') {
      refuse();
    }
    environment[key] = value;
  }
  return environment;
}

function normalizeEntrypoint(value) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    refuse();
  }
  return value;
}

async function normalizedBind(source, target, readOnly, hasCustom) {
  const role = SRS_BIND_ROLES.get(target);
  if (role === undefined || typeof source !== 'string' || typeof readOnly !== 'boolean') {
    refuse();
  }
  const selected = role !== 'template' || !hasCustom;
  return {
    type: 'bind',
    role,
    target,
    readOnly,
    content: selected ? `sha256:${await digestFile(source)}` : 'unused',
  };
}

function normalizedVolume(target, readOnly) {
  const role = SRS_VOLUME_ROLES.get(target);
  if (role === undefined || typeof readOnly !== 'boolean') {
    refuse();
  }
  return { type: 'volume', role, target, readOnly };
}

async function candidateMounts(volumes) {
  if (!Array.isArray(volumes)) {
    refuse();
  }
  const hasCustom = volumes.some(
    (volume) => volume?.type === 'bind' && volume?.target === '/usr/local/srs/conf/srs.conf.custom',
  );
  const normalized = [];
  for (const volume of volumes) {
    if (volume === null || typeof volume !== 'object' || Array.isArray(volume)) {
      refuse();
    }
    if (volume.type === 'bind') {
      normalized.push(await normalizedBind(volume.source, volume.target, volume.read_only === true, hasCustom));
    } else if (volume.type === 'volume') {
      normalized.push(normalizedVolume(volume.target, volume.read_only === true));
    } else {
      refuse();
    }
  }
  return normalized.sort((left, right) => compareCodeUnits(left.target, right.target));
}

async function actualMounts(mounts) {
  if (!Array.isArray(mounts)) {
    refuse();
  }
  const hasCustom = mounts.some(
    (mount) => mount?.Type === 'bind' && mount?.Destination === '/usr/local/srs/conf/srs.conf.custom',
  );
  const normalized = [];
  for (const mount of mounts) {
    if (mount === null || typeof mount !== 'object' || Array.isArray(mount) || typeof mount.RW !== 'boolean') {
      refuse();
    }
    if (mount.Type === 'bind') {
      normalized.push(await normalizedBind(mount.Source, mount.Destination, !mount.RW, hasCustom));
    } else if (mount.Type === 'volume') {
      normalized.push(normalizedVolume(mount.Destination, !mount.RW));
    } else {
      refuse();
    }
  }
  return normalized.sort((left, right) => compareCodeUnits(left.target, right.target));
}

async function validateSrsRuntime(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse();
  }
  const candidate = payload.candidate;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    refuse();
  }
  const expected = canonical({
    environment: candidateEnvironment(payload.baseImageEnvironment, candidate.environment),
    entrypoint: normalizeEntrypoint(candidate.entrypoint),
    mounts: await candidateMounts(candidate.volumes),
  });
  const actual = canonical({
    environment: environmentFromEntries(payload.actualEnvironment),
    entrypoint: normalizeEntrypoint(payload.actualEntrypoint),
    mounts: await actualMounts(payload.actualMounts),
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    refuse();
  }
}

try {
  if (process.argv[2] === 'srs-runtime') {
    await validateSrsRuntime(JSON.parse(await readInput()));
  } else {
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
  }
} catch {
  refuse();
}
