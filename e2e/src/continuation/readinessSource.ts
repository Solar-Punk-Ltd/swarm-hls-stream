import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { BoundedCommand } from './dockerCli.js';
import { type CandidateRole, FixtureRefusal } from './fixture.js';
import type {
  BoundedHttpRequest,
  BoundedHttpResponse,
  CapabilityReadObservation,
  ContainerReadinessObservation,
  GuardedReleaseObservation,
  ReadinessObservationSource,
} from './readinessTransport.js';
import type {
  ReadinessProbeId,
  ReleaseGuardRole,
  TopologyServiceRole,
} from './topology.js';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_DATABASE_BYTES = 256 * 1024;
const MAX_ACTIVE_ARTIFACT_BYTES = 64 * 1024;
const MAX_TREE_FILES = 50_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface RuntimeContainerBinding {
  id: string;
  name: string;
  configuredImage: string;
}

export interface GuardCandidateBinding {
  role: CandidateRole;
  root: string;
  commit: string;
}

export interface RuntimeReadinessBindings {
  probeContainerId: string;
  postgresContainerId: string;
  allowedHttpOrigins: ReadonlySet<string>;
  containers: ReadonlyMap<TopologyServiceRole, RuntimeContainerBinding>;
  guardSlots: ReadonlyMap<ReleaseGuardRole, string>;
  candidates: ReadonlyMap<ReleaseGuardRole, GuardCandidateBinding>;
}

export interface ReadinessControlExecutor {
  run(probeId: ReadinessProbeId, maxResponseBytes: number): Promise<Uint8Array>;
}

interface DockerContainerInspection {
  id: string;
  name: string;
  imageId: string;
  state: string;
  health: string;
  labels: Record<string, string>;
  mounts: unknown;
}

interface StoredGuardReceipt {
  schemaVersion: number;
  installationId: string;
  generation: string;
  stateDigest: string;
  role: string;
  slotId: string;
  minimumSrsLifecycle: number;
  treeDigest: string;
  images: unknown;
}

interface StoredCapability {
  uploaderId: string;
  lifecycleVersion: number;
  profiles: unknown;
  receivedAt: string;
  freshUntil: string;
  serverNow: string;
}

/** Reads only exact journal bindings, internal endpoints and persisted admin facts. */
export class DockerReadinessObservationSource implements ReadinessObservationSource {
  constructor(
    private readonly command: BoundedCommand,
    private readonly bindings: RuntimeReadinessBindings,
    private readonly controls: ReadinessControlExecutor,
  ) {
    checkedId(bindings.probeContainerId, 'probe container');
    checkedId(bindings.postgresContainerId, 'postgres container');
    for (const origin of bindings.allowedHttpOrigins) {internalHttpUrl(origin);}
  }

  async request(request: BoundedHttpRequest): Promise<BoundedHttpResponse> {
    if (request.maxResponseBytes < 1 || request.maxResponseBytes > 64 * 1024) {
      throw new FixtureRefusal('readiness HTTP response bound is invalid');
    }
    const url = internalHttpUrl(request.url);
    if (!this.bindings.allowedHttpOrigins.has(url.origin)) {
      throw new FixtureRefusal('readiness HTTP URL is not an allowed internal fixture endpoint');
    }
    const headers = Object.entries(request.headers);
    if (
      headers.some(([name, value]) =>
        !['accept', 'content-type'].includes(name.toLowerCase()) ||
        typeof value !== 'string' ||
        value.length > 100,
      )
    ) {
      throw new FixtureRefusal('readiness HTTP headers are not allowed');
    }
    const input = Buffer.from(JSON.stringify({
      url: url.toString(),
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? null : Buffer.from(request.body).toString('base64'),
      maximum: request.maxResponseBytes,
    })).toString('base64');
    const result = await this.command.run('docker', [
      'exec',
      checkedId(this.bindings.probeContainerId, 'probe container'),
      'node',
      '-e',
      HTTP_PROBE_SCRIPT,
      input,
    ]);
    const envelope = parseJsonObject('HTTP probe', result.stdout, request.maxResponseBytes * 2 + 4096);
    if (!Number.isSafeInteger(envelope.status) || Number(envelope.status) < 100 || Number(envelope.status) > 599) {
      throw new FixtureRefusal('readiness HTTP probe status is malformed');
    }
    if (typeof envelope.body !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.body)) {
      throw new FixtureRefusal('readiness HTTP probe body is malformed');
    }
    const body = Buffer.from(envelope.body, 'base64');
    if (body.byteLength > request.maxResponseBytes) {
      throw new FixtureRefusal('readiness HTTP response exceeded its byte bound');
    }
    return { status: Number(envelope.status), body };
  }

  async inspectContainer(role: TopologyServiceRole): Promise<ContainerReadinessObservation> {
    const binding = this.bindings.containers.get(role);
    if (!binding) {throw new FixtureRefusal(`${role} runtime container binding is missing`);}
    const result = await this.command.run('docker', [
      'container',
      'inspect',
      '--format',
      CONTAINER_INSPECT_FORMAT,
      checkedId(binding.id, `${role} container`),
    ]);
    const raw = parseJsonObject(`${role} container`, result.stdout, 64 * 1024) as Partial<DockerContainerInspection>;
    const name = typeof raw.name === 'string' && raw.name.startsWith('/') ? raw.name.slice(1) : raw.name;
    if (
      raw.id !== binding.id ||
      name !== binding.name ||
      typeof raw.imageId !== 'string' ||
      typeof raw.state !== 'string' ||
      typeof raw.health !== 'string' ||
      !isStringRecord(raw.labels)
    ) {
      throw new FixtureRefusal(`${role} runtime container identity is malformed`);
    }
    const activeArtifact = role === 'admin-api'
      ? readActiveArtifact(raw.mounts)
      : undefined;
    return {
      role,
      name,
      expectedName: binding.name,
      configuredImage: binding.configuredImage,
      imageId: raw.imageId,
      state: raw.state === 'running' ? 'running' : 'stopped',
      health: raw.health === '' ? 'none' : raw.health === 'healthy' ? 'healthy' : 'unhealthy',
      labels: raw.labels,
      ...(activeArtifact === undefined ? {} : { activeArtifact }),
    };
  }

  async inspectGuard(role: ReleaseGuardRole): Promise<GuardedReleaseObservation> {
    const candidate = this.bindings.candidates.get(role);
    if (!candidate || !isAbsolute(candidate.root) || !/^[0-9a-f]{40}$/.test(candidate.commit)) {
      throw new FixtureRefusal(`${role} guard candidate binding is malformed`);
    }
    const slotId = this.bindings.guardSlots.get(role);
    if (!slotId || !SAFE_ID.test(slotId)) {
      throw new FixtureRefusal(`${role} guard slot binding is missing`);
    }
    const stored = parseStoredGuardReceipt(
      await this.databaseJson(guardReceiptQuery(role, slotId)),
      role,
      slotId,
    );
    const generation = Number(stored.generation);
    return {
      slot: { role, id: slotId },
      installationId: stored.installationId,
      generation,
      stateDigest: stored.stateDigest,
      artifact: {
        treeDigest: stored.treeDigest,
        images: parseImages(stored.images),
      },
      candidate: {
        ...candidate,
        treeDigest: await digestCandidateRoot(candidate.root),
      },
    };
  }

  async readUploaderCapability(uploaderId: string): Promise<CapabilityReadObservation> {
    if (!SAFE_ID.test(uploaderId)) {throw new FixtureRefusal('uploader capability identity is malformed');}
    const stored = parseStoredCapability(await this.databaseJson(capabilityQuery(uploaderId)));
    if (!Array.isArray(stored.profiles)) {
      throw new FixtureRefusal('uploader capability profiles are malformed');
    }
    return {
      uploaderId: stored.uploaderId,
      lifecycleVersion: stored.lifecycleVersion,
      profileDigests: stored.profiles.map(profileDigest),
      receivedAt: stored.receivedAt,
      freshUntil: stored.freshUntil,
      serverNow: stored.serverNow,
    };
  }

  runControl(probeId: ReadinessProbeId, maxResponseBytes: number): Promise<Uint8Array> {
    return this.controls.run(probeId, maxResponseBytes);
  }

  private async databaseJson(query: string): Promise<Record<string, unknown>> {
    const result = await this.command.run('docker', [
      'exec',
      checkedId(this.bindings.postgresContainerId, 'postgres container'),
      'psql',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--username',
      'web2admin',
      '--dbname',
      'web2admin',
      '--command',
      query,
    ]);
    return parseJsonObject('admin database observation', result.stdout.trim(), MAX_DATABASE_BYTES);
  }
}

function guardReceiptQuery(role: ReleaseGuardRole, slotId: string): string {
  if (!SAFE_ID.test(slotId)) {throw new FixtureRefusal('guard receipt slot is malformed');}
  return `SELECT json_build_object('schemaVersion', 1, 'installationId', installation_id::text, 'generation', generation::text, 'stateDigest', state_digest, 'role', role, 'slotId', slot_id, 'minimumSrsLifecycle', minimum_srs_lifecycle, 'treeDigest', tree_digest, 'images', images)::text FROM release_guard_receipts WHERE role = '${role}' AND slot_id = '${slotId}'`;
}

function capabilityQuery(uploaderId: string): string {
  return `SELECT json_build_object('uploaderId', uploader_id, 'lifecycleVersion', lifecycle_version, 'profiles', profiles, 'receivedAt', received_at, 'freshUntil', received_at + interval '30 seconds', 'serverNow', clock_timestamp())::text FROM uploader_capability_receipts WHERE uploader_id = '${uploaderId}'`;
}

function profileDigest(raw: unknown): { mediaType: 'audio' | 'video'; digest: string } {
  if (!isRecord(raw) || (raw.mediaType !== 'audio' && raw.mediaType !== 'video') || !Array.isArray(raw.renditions)) {
    throw new FixtureRefusal('uploader capability profile is malformed');
  }
  const renditions = raw.renditions.map((rendition) => {
    if (
      !isRecord(rendition) ||
      typeof rendition.name !== 'string' ||
      typeof rendition.width !== 'number' ||
      !Number.isSafeInteger(rendition.width) ||
      typeof rendition.height !== 'number' ||
      !Number.isSafeInteger(rendition.height) ||
      typeof rendition.bandwidth !== 'number' ||
      !Number.isSafeInteger(rendition.bandwidth) ||
      typeof rendition.avgBandwidth !== 'number' ||
      !Number.isSafeInteger(rendition.avgBandwidth)
    ) {
      throw new FixtureRefusal('uploader capability rendition is malformed');
    }
    if (
      rendition.name.length < 1 ||
      rendition.name.length > 100 ||
      rendition.width < 1 ||
      rendition.height < 1 ||
      rendition.bandwidth < 1 ||
      rendition.avgBandwidth < 1
    ) {
      throw new FixtureRefusal('uploader capability rendition is malformed');
    }
    return {
      name: rendition.name,
      width: rendition.width,
      height: rendition.height,
      bandwidth: rendition.bandwidth,
      avgBandwidth: rendition.avgBandwidth,
    };
  }).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  if (new Set(renditions.map(({ name }) => name)).size !== renditions.length) {
    throw new FixtureRefusal('uploader capability rendition is malformed');
  }
  const normalized = { mediaType: raw.mediaType, renditions };
  return {
    mediaType: raw.mediaType,
    digest: createHash('sha256').update(canonicalJson(normalized)).digest('hex'),
  };
}

function parseImages(raw: unknown): Array<{ service: string; imageId: string }> {
  if (!Array.isArray(raw)) {throw new FixtureRefusal('guard receipt images are malformed');}
  return raw.map((image) => {
    if (!isRecord(image) || typeof image.service !== 'string' || typeof image.imageId !== 'string') {
      throw new FixtureRefusal('guard receipt images are malformed');
    }
    return { service: image.service, imageId: image.imageId };
  });
}

function readActiveArtifact(mounts: unknown): ContainerReadinessObservation['activeArtifact'] {
  if (!Array.isArray(mounts)) {
    throw new FixtureRefusal('admin active artifact mount is malformed');
  }
  const matching = mounts.filter((mount) =>
    isRecord(mount) && mount.Destination === '/run/streaming-release/active-artifact.json',
  );
  if (matching.length !== 1) {throw new FixtureRefusal('admin active artifact mount is malformed');}
  const mount = matching[0];
  const path = mount.Source;
  if (mount.Type !== 'bind' || typeof path !== 'string' || !isAbsolute(path) || mount.RW !== false) {
    throw new FixtureRefusal('admin active artifact mount is malformed');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ACTIVE_ARTIFACT_BYTES) {
    throw new FixtureRefusal('admin active artifact file is malformed');
  }
  return parseActiveArtifact(
    parseJsonObject('admin active artifact', readFileSync(path, 'utf8'), MAX_ACTIVE_ARTIFACT_BYTES),
  );
}

function parseActiveArtifact(raw: Record<string, unknown>): NonNullable<ContainerReadinessObservation['activeArtifact']> {
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.installationId !== 'string' ||
    !Number.isSafeInteger(raw.generation) ||
    Number(raw.generation) < 1 ||
    !isRecord(raw.slot) ||
    raw.slot.role !== 'admin' ||
    raw.slot.id !== 'default' ||
    !isRecord(raw.artifact) ||
    typeof raw.artifact.treeDigest !== 'string' ||
    !DIGEST.test(raw.artifact.treeDigest)
  ) {
    throw new FixtureRefusal('admin active artifact file is malformed');
  }
  return {
    schemaVersion: 1,
    installationId: raw.installationId,
    generation: Number(raw.generation),
    slot: { role: 'admin', id: 'default' },
    artifact: {
      treeDigest: raw.artifact.treeDigest,
      images: parseImages(raw.artifact.images),
    },
  };
}

function parseStoredGuardReceipt(
  raw: Record<string, unknown>,
  role: ReleaseGuardRole,
  slotId: string,
): StoredGuardReceipt {
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.installationId !== 'string' ||
    typeof raw.generation !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(raw.generation) ||
    typeof raw.stateDigest !== 'string' ||
    !DIGEST.test(raw.stateDigest) ||
    raw.role !== role ||
    raw.slotId !== slotId ||
    raw.minimumSrsLifecycle !== 1 ||
    typeof raw.treeDigest !== 'string' ||
    !DIGEST.test(raw.treeDigest)
  ) {
    throw new FixtureRefusal('guard receipt database observation is malformed');
  }
  const generation = Number(raw.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new FixtureRefusal('guard receipt database observation is malformed');
  }
  return {
    schemaVersion: 1,
    installationId: raw.installationId,
    generation: raw.generation,
    stateDigest: raw.stateDigest,
    role,
    slotId,
    minimumSrsLifecycle: 1,
    treeDigest: raw.treeDigest,
    images: raw.images,
  };
}

function parseStoredCapability(raw: Record<string, unknown>): StoredCapability {
  if (
    typeof raw.uploaderId !== 'string' ||
    !SAFE_ID.test(raw.uploaderId) ||
    raw.lifecycleVersion !== 1 ||
    !Array.isArray(raw.profiles) ||
    typeof raw.receivedAt !== 'string' ||
    typeof raw.freshUntil !== 'string' ||
    typeof raw.serverNow !== 'string'
  ) {
    throw new FixtureRefusal('uploader capability database observation is malformed');
  }
  return {
    uploaderId: raw.uploaderId,
    lifecycleVersion: 1,
    profiles: raw.profiles,
    receivedAt: raw.receivedAt,
    freshUntil: raw.freshUntil,
    serverNow: raw.serverNow,
  };
}

function parseJsonObject(name: string, body: string, maximumBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(body) < 1 || Buffer.byteLength(body) > maximumBytes) {
    throw new FixtureRefusal(`${name} exceeded its byte bound`);
  }
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) {throw new Error('not object');}
    return value;
  } catch {
    throw new FixtureRefusal(`${name} is malformed`);
  }
}

function internalHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FixtureRefusal('readiness HTTP URL is malformed');
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    throw new FixtureRefusal('readiness HTTP URL is not an internal fixture endpoint');
  }
  return url;
}

function checkedId(value: string, name: string): string {
  if (!SAFE_ID.test(value)) {throw new FixtureRefusal(`${name} identity is malformed`);}
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(',')}]`;}
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {throw new FixtureRefusal('canonical readiness value is unsupported');}
  return encoded;
}

async function digestCandidateRoot(supplied: string): Promise<string> {
  const suppliedStat = await lstat(supplied);
  if (!suppliedStat.isDirectory() || suppliedStat.isSymbolicLink()) {
    throw new FixtureRefusal('readiness candidate root is malformed');
  }
  const root = await realpath(supplied);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new FixtureRefusal('readiness candidate root is malformed');
  }
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.scratch') {continue;}
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        hash.update(`directory\0${name}\0${stat.mode & 0o777}\0`);
        await visit(path);
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        bytes += Buffer.byteLength(target);
        if (bytes > MAX_TREE_BYTES) {throw new FixtureRefusal('readiness candidate tree is oversized');}
        hash.update(`symlink\0${name}\0${target}\0`);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > MAX_TREE_FILES || bytes > MAX_TREE_BYTES) {
          throw new FixtureRefusal('readiness candidate tree is oversized');
        }
        hash.update(`file\0${name}\0${stat.mode & 0o777}\0${stat.size}\0`);
        await new Promise<void>((resolveStream, rejectStream) => {
          const stream = createReadStream(path);
          stream.on('data', (chunk) => hash.update(chunk));
          stream.on('error', rejectStream);
          stream.on('end', resolveStream);
        });
        hash.update('\0');
      } else {
        throw new FixtureRefusal(`readiness candidate tree contains unsupported entry ${name}`);
      }
    }
  };
  await visit(root);
  return hash.digest('hex');
}

const CONTAINER_INSPECT_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}""{{end}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}';

const HTTP_PROBE_SCRIPT = String.raw`
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);
try {
  const response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body === null ? undefined : Buffer.from(input.body, 'base64'),
    redirect: 'error',
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0;
  while (reader) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > input.maximum) {
      await reader.cancel();
      process.exit(41);
    }
    chunks.push(Buffer.from(part.value));
  }
  process.stdout.write(JSON.stringify({ status: response.status, body: Buffer.concat(chunks).toString('base64') }));
} finally {
  clearTimeout(timeout);
}
`;
