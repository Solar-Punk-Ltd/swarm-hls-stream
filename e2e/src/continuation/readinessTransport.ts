import { isDeepStrictEqual } from 'node:util';

import {
  type CandidateRole,
  FIXTURE_LABEL,
  type FixturePlan,
  FixtureRefusal,
  MANAGED_LABEL,
} from './fixture.js';
import {
  type ContinuationTopology,
  type ReadinessProbe,
  type ReadinessProbeId,
  type ReadinessProbeTransport,
  type ReleaseGuardRole,
  type TopologyServiceRole,
} from './topology.js';

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UPLOADER_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface BoundedHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  maxResponseBytes: number;
}

export interface BoundedHttpResponse {
  status: number;
  body: Uint8Array;
}

interface ReleaseArtifactObservation {
  treeDigest: string;
  images: Array<{ service: string; imageId: string }>;
}

interface ActiveArtifactObservation {
  schemaVersion: 1;
  installationId: string;
  generation: number;
  slot: { role: 'admin'; id: 'default' };
  artifact: ReleaseArtifactObservation;
}

export interface ContainerReadinessObservation {
  role: TopologyServiceRole;
  name: string;
  configuredImage: string;
  imageId: string;
  state: 'running' | 'stopped';
  health: 'healthy' | 'unhealthy' | 'none';
  labels: Readonly<Record<string, string>>;
  activeArtifact?: ActiveArtifactObservation;
}

export interface GuardedReleaseObservation {
  slot: { role: ReleaseGuardRole; id: string };
  installationId: string;
  generation: number;
  stateDigest: string;
  artifact: ReleaseArtifactObservation;
  candidate: {
    role: CandidateRole;
    commit: string;
    root: string;
    treeDigest: string;
  };
}

export interface CapabilityReadObservation {
  uploaderId: string;
  lifecycleVersion: number;
  profileDigests: Array<{ mediaType: 'audio' | 'video'; digest: string }>;
  receivedAt: string;
  freshUntil: string;
  serverNow: string;
}

export interface ReadinessObservationSource {
  request(request: BoundedHttpRequest): Promise<BoundedHttpResponse>;
  inspectContainer(role: TopologyServiceRole): Promise<ContainerReadinessObservation>;
  inspectGuard(role: ReleaseGuardRole): Promise<GuardedReleaseObservation>;
  readUploaderCapability(uploaderId: string): Promise<CapabilityReadObservation>;
  runControl(probeId: ReadinessProbeId, maxResponseBytes: number): Promise<Uint8Array>;
}

function object(id: ReadinessProbeId, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FixtureRefusal(`${id} readiness observation is malformed`);
  }
  return value as Record<string, unknown>;
}

function stringField(id: ReadinessProbeId, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new FixtureRefusal(`${id} readiness ${field} is malformed`);
  }
  return value;
}

function integerField(id: ReadinessProbeId, field: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new FixtureRefusal(`${id} readiness ${field} is malformed`);
  }
  return value as number;
}

function numberField(id: ReadinessProbeId, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new FixtureRefusal(`${id} readiness ${field} is malformed`);
  }
  return value;
}

function booleanField(id: ReadinessProbeId, field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new FixtureRefusal(`${id} readiness ${field} is malformed`);
  }
  return value;
}

function parseBytes(id: ReadinessProbeId, bytes: Uint8Array, bound: number): Record<string, unknown> {
  if (bytes.byteLength < 1 || bytes.byteLength > bound) {
    throw new FixtureRefusal(`${id} readiness response exceeded its byte bound`);
  }
  try {
    return object(id, JSON.parse(decoder.decode(bytes)));
  } catch (error) {
    if (error instanceof FixtureRefusal) {throw error;}
    throw new FixtureRefusal(`${id} readiness response is not valid JSON`);
  }
}

export class ObservedReadinessTransport implements ReadinessProbeTransport {
  constructor(
    private readonly plan: FixturePlan,
    private readonly topology: ContinuationTopology,
    private readonly source: ReadinessObservationSource,
  ) {}

  async probe(probe: ReadinessProbe): Promise<unknown> {
    switch (probe.id) {
      case 'chain':
        return this.chain(probe);
      case 'blockchain':
        return this.blockchain(probe);
      case 'bee':
        return this.bee(probe);
      case 'srs':
        return this.srs(probe);
      case 'uploader':
        return this.uploader(probe);
      case 'admin':
        return this.admin(probe);
      case 'viewer':
        return this.viewer(probe);
      case 'storage':
      case 'callbacks':
      case 'openingFormat':
      case 'browserDecode':
      case 'falseCodec':
      case 'capacity':
        return this.control(probe);
    }
  }

  private async http(probe: ReadinessProbe, rpcMethod?: string): Promise<Record<string, unknown>> {
    const body = rpcMethod === undefined
      ? undefined
      : encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: rpcMethod, params: [] }));
    const response = await this.source.request({
      url: probe.url,
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
      maxResponseBytes: probe.maxResponseBytes,
    });
    if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 299) {
      throw new FixtureRefusal(`${probe.id} readiness endpoint refused the bounded probe`);
    }
    return parseBytes(probe.id, response.body, probe.maxResponseBytes);
  }

  private async container(role: TopologyServiceRole): Promise<ContainerReadinessObservation> {
    const expected = this.topology.services.find((service) => service.role === role);
    if (!expected) {throw new FixtureRefusal(`${role} readiness service is absent from topology`);}
    const observed = await this.source.inspectContainer(role);
    if (
      observed.role !== role ||
      observed.name !== expected.container.name ||
      observed.state !== 'running' ||
      observed.health === 'unhealthy' ||
      observed.labels[FIXTURE_LABEL] !== this.plan.fixtureId ||
      observed.labels[MANAGED_LABEL] !== 'true' ||
      !IMAGE_ID.test(observed.imageId)
    ) {
      throw new FixtureRefusal(`${role} readiness container identity does not match`);
    }
    return observed;
  }

  private guard(role: ReleaseGuardRole): Promise<GuardedReleaseObservation> {
    return this.readGuard(role);
  }

  private async readGuard(role: ReleaseGuardRole): Promise<GuardedReleaseObservation> {
    const activation = this.topology.guardedActivations.find((entry) => entry.role === role);
    const observed = await this.source.inspectGuard(role);
    if (!activation || !isDeepStrictEqual(observed.slot, activation.slot)) {
      throw new FixtureRefusal(`${role} readiness guard slot does not match`);
    }
    const candidate = this.plan.candidates.find((entry) => entry.role === activation.candidateRole);
    if (
      !candidate ||
      observed.candidate.role !== candidate.role ||
      observed.candidate.commit !== candidate.commit ||
      observed.candidate.root !== candidate.root ||
      observed.candidate.treeDigest !== observed.artifact.treeDigest ||
      !DIGEST.test(observed.artifact.treeDigest) ||
      !UUID.test(observed.installationId) ||
      !Number.isSafeInteger(observed.generation) ||
      observed.generation < 1 ||
      !DIGEST.test(observed.stateDigest)
    ) {
      throw new FixtureRefusal(`${role} readiness guard candidate does not match`);
    }
    const services = observed.artifact.images.map(({ service }) => service);
    if (
      services.length < 1 ||
      services.length > 32 ||
      services.join(',') !== [...new Set(services)].sort().join(',') ||
      observed.artifact.images.some(({ service, imageId }) => service.length < 1 || service.length > 100 || !IMAGE_ID.test(imageId))
    ) {
      throw new FixtureRefusal(`${role} readiness guard artifact is malformed`);
    }
    return observed;
  }

  private async guardedContainer(
    id: ReadinessProbeId,
    topologyRole: TopologyServiceRole,
    guardRole: 'admin' | 'uploader' | 'viewer',
    artifactService: string,
  ): Promise<{ container: ContainerReadinessObservation; guard: GuardedReleaseObservation }> {
    const [container, guard] = await Promise.all([this.container(topologyRole), this.guard(guardRole)]);
    const image = guard.artifact.images.find(({ service }) => service === artifactService);
    if (!image || image.imageId !== container.imageId) {
      throw new FixtureRefusal(`${id} readiness running image does not match its guard artifact`);
    }
    return { container, guard };
  }

  private async capabilityObservation(): Promise<CapabilityReadObservation> {
    return this.readCapability();
  }

  private async readCapability(): Promise<CapabilityReadObservation> {
    const uploaderId = this.topology.guardedActivations.find(({ role }) => role === 'uploader')?.slot.id;
    if (!uploaderId || !UPLOADER_ID.test(uploaderId)) {
      throw new FixtureRefusal('uploader readiness assignment is malformed');
    }
    const observed = await this.source.readUploaderCapability(uploaderId);
    const receivedAt = Date.parse(observed.receivedAt);
    const freshUntil = Date.parse(observed.freshUntil);
    const serverNow = Date.parse(observed.serverNow);
    const mediaTypes = observed.profileDigests.map(({ mediaType }) => mediaType);
    if (
      observed.uploaderId !== uploaderId ||
      observed.lifecycleVersion !== 1 ||
      observed.profileDigests.length < 1 ||
      observed.profileDigests.length > 2 ||
      new Set(mediaTypes).size !== mediaTypes.length ||
      observed.profileDigests.some(({ mediaType, digest }) =>
        (mediaType !== 'audio' && mediaType !== 'video') || !DIGEST.test(digest),
      ) ||
      !Number.isFinite(receivedAt) ||
      !Number.isFinite(freshUntil) ||
      !Number.isFinite(serverNow) ||
      freshUntil - receivedAt !== 30_000 ||
      serverNow < receivedAt ||
      serverNow >= freshUntil
    ) {
      throw new FixtureRefusal('uploader capability is not fresh and assigned');
    }
    return observed;
  }

  private async chain(probe: ReadinessProbe): Promise<unknown> {
    const [response, container] = await Promise.all([
      this.http(probe, 'eth_chainId'),
      this.container('blockchain'),
    ]);
    if (container.configuredImage !== this.topology.services.find(({ role }) => role === 'blockchain')?.container.image) {
      throw new FixtureRefusal('chain readiness image does not match');
    }
    const result = stringField('chain', 'result', response.result);
    if (!/^0x[0-9a-f]+$/.test(result)) {throw new FixtureRefusal('chain readiness result is malformed');}
    return { chainId: Number.parseInt(result.slice(2), 16), owner: container.labels[FIXTURE_LABEL] };
  }

  private async blockchain(probe: ReadinessProbe): Promise<unknown> {
    const [response, container] = await Promise.all([
      this.http(probe, 'web3_clientVersion'),
      this.container('blockchain'),
    ]);
    if (container.configuredImage !== this.topology.services.find(({ role }) => role === 'blockchain')?.container.image) {
      throw new FixtureRefusal('blockchain readiness image does not match');
    }
    const version = stringField('blockchain', 'clientVersion', response.result);
    const match = /^anvil\/v?(.+)$/i.exec(version);
    if (!match) {throw new FixtureRefusal('blockchain readiness client identity does not match');}
    return { ready: true, identity: 'anvil', version: match[1] };
  }

  private async bee(probe: ReadinessProbe): Promise<unknown> {
    const [response, container] = await Promise.all([this.http(probe), this.container('bee-queen')]);
    if (container.configuredImage !== this.topology.services.find(({ role }) => role === 'bee-queen')?.container.image) {
      throw new FixtureRefusal('bee readiness image does not match');
    }
    const status = stringField('bee', 'status', response.status);
    return {
      ready: status === 'ok',
      identity: 'bee',
      version: stringField('bee', 'version', response.version),
      warmingUp: status !== 'ok',
    };
  }

  private async srs(probe: ReadinessProbe): Promise<unknown> {
    const [response] = await Promise.all([
      this.http(probe),
      this.guardedContainer('srs', 'srs', 'uploader', 'srs'),
    ]);
    const data = object('srs', response.data);
    if (response.code !== 0) {throw new FixtureRefusal('srs readiness endpoint is not ready');}
    return { ready: true, identity: 'srs', version: stringField('srs', 'version', data.version) };
  }

  private async uploader(probe: ReadinessProbe): Promise<unknown> {
    const [response, guarded, capability] = await Promise.all([
      this.http(probe),
      this.guardedContainer('uploader', 'uploader', 'uploader', 'stream-uploader'),
      this.capabilityObservation(),
    ]);
    return {
      ready: response.status === 'ok',
      identity: 'stream-uploader',
      version: guarded.guard.candidate.commit,
      lifecycleVersion: capability.lifecycleVersion,
      uploaderId: capability.uploaderId,
    };
  }

  private async admin(probe: ReadinessProbe): Promise<unknown> {
    const [response, guarded, capability] = await Promise.all([
      this.http(probe),
      this.guardedContainer('admin', 'admin-api', 'admin', 'admin-api'),
      this.capabilityObservation(),
    ]);
    const expectedActive = {
      schemaVersion: 1,
      installationId: guarded.guard.installationId,
      generation: guarded.guard.generation,
      slot: { role: 'admin', id: 'default' },
      artifact: guarded.guard.artifact,
    };
    if (!isDeepStrictEqual(guarded.container.activeArtifact, expectedActive)) {
      throw new FixtureRefusal('admin readiness active artifact does not match its guard receipt');
    }
    return {
      ready: response.status === 'ok',
      identity: 'web2-admin',
      version: guarded.guard.candidate.commit,
      lifecycleVersion: capability.lifecycleVersion,
      uploaderId: capability.uploaderId,
    };
  }

  private async viewer(probe: ReadinessProbe): Promise<unknown> {
    const [response, guarded] = await Promise.all([
      this.http(probe),
      this.guardedContainer('viewer', 'viewer', 'viewer', 'client'),
    ]);
    const head = stringField('viewer', 'head', response.head);
    if (response.dirty !== false || head !== guarded.guard.candidate.commit) {
      throw new FixtureRefusal('viewer readiness build stamp does not match its guard candidate');
    }
    return { ready: true, identity: 'viewer', version: head };
  }

  private async control(probe: ReadinessProbe): Promise<unknown> {
    const result = parseBytes(
      probe.id,
      await this.source.runControl(probe.id, probe.maxResponseBytes),
      probe.maxResponseBytes,
    );
    switch (probe.id) {
      case 'storage':
        if (result.source !== 'bee-upload-read-control') {throw new FixtureRefusal('storage readiness source does not match');}
        return {
          batchIdHash: stringField('storage', 'batchIdHash', result.batchIdHash),
          usable: booleanField('storage', 'usable', result.usable),
          capacityBytes: integerField('storage', 'capacityBytes', result.capacityBytes),
          ttlSeconds: integerField('storage', 'ttlSeconds', result.ttlSeconds),
          controlRoundTrip: result.uploadStatus === 201 && result.readStatus === 200 && result.bytesMatch === true,
        };
      case 'callbacks':
        if (result.source !== 'srs-callback-control') {throw new FixtureRefusal('callbacks readiness source does not match');}
        return {
          reachedUploader:
            integerField('callbacks', 'callbacksAfter', result.callbacksAfter) >
            integerField('callbacks', 'callbacksBefore', result.callbacksBefore),
        };
      case 'openingFormat':
        if (result.source !== 'ffprobe') {throw new FixtureRefusal('openingFormat readiness source does not match');}
        return {
          verified: result.exitCode === 0 && result.formatName === 'mpegts',
          tool: 'ffprobe',
          container: stringField('openingFormat', 'formatName', result.formatName),
        };
      case 'browserDecode': {
        if (result.source !== 'browser-media-control') {throw new FixtureRefusal('browserDecode readiness source does not match');}
        const codecs = result.codecs;
        if (!Array.isArray(codecs)) {throw new FixtureRefusal('browserDecode readiness codecs are malformed');}
        return {
          decodedMedia:
            result.playEvent === true &&
            integerField('browserDecode', 'decodedFramesAfter', result.decodedFramesAfter) >
              integerField('browserDecode', 'decodedFramesBefore', result.decodedFramesBefore) &&
            numberField('browserDecode', 'currentTimeAfter', result.currentTimeAfter) >
              numberField('browserDecode', 'currentTimeBefore', result.currentTimeBefore),
          codecs: codecs.map((codec) => stringField('browserDecode', 'codec', codec)),
        };
      }
      case 'falseCodec':
        if (result.source !== 'browser-false-codec-control') {throw new FixtureRefusal('falseCodec readiness source does not match');}
        stringField('falseCodec', 'attemptedCodec', result.attemptedCodec);
        return {
          refused:
            booleanField('falseCodec', 'supported', result.supported) === false &&
            booleanField('falseCodec', 'loadedMetadata', result.loadedMetadata) === false,
        };
      case 'capacity': {
        if (result.source !== 'fixture-capacity-control' || !Array.isArray(result.services) || result.services.length < 1) {
          throw new FixtureRefusal('capacity readiness source does not match');
        }
        const availableDisk = integerField('capacity', 'availableDiskBytes', result.availableDiskBytes);
        const requiredDisk = integerField('capacity', 'requiredDiskBytes', result.requiredDiskBytes);
        const expectedServices = new Map(
          this.topology.services.map(({ role, container }) => [role, container.limits] as const),
        );
        const observedRoles = new Set<string>();
        const resourcesAvailable = result.services.every((raw) => {
          const service = object('capacity', raw);
          const role = stringField('capacity', 'role', service.role);
          const expected = expectedServices.get(role as TopologyServiceRole);
          if (!expected || observedRoles.has(role)) {
            throw new FixtureRefusal('capacity readiness service set does not match the topology');
          }
          observedRoles.add(role);
          if (expected.cpus <= 0 || expected.memoryBytes <= 0 || expected.pidsLimit <= 0) {
            throw new FixtureRefusal('capacity readiness planned limits are malformed');
          }
          return (
            integerField('capacity', 'memoryCurrentBytes', service.memoryCurrentBytes) <
              expected.memoryBytes &&
            integerField('capacity', 'memoryLimitBytes', service.memoryLimitBytes) === expected.memoryBytes &&
            integerField('capacity', 'pidsCurrent', service.pidsCurrent) <
              expected.pidsLimit &&
            integerField('capacity', 'pidsLimit', service.pidsLimit) === expected.pidsLimit &&
            numberField('capacity', 'cpuLimit', service.cpuLimit) === expected.cpus &&
            integerField('capacity', 'cpuThrottledDelta', service.cpuThrottledDelta) === 0
          );
        });
        if (observedRoles.size !== expectedServices.size) {
          throw new FixtureRefusal('capacity readiness service set does not match the topology');
        }
        return {
          available:
            availableDisk >= requiredDisk &&
            booleanField('capacity', 'timeoutsWithinBounds', result.timeoutsWithinBounds) &&
            resourcesAvailable,
        };
      }
      default:
        throw new FixtureRefusal(`${probe.id} readiness control is unsupported`);
    }
  }
}
