import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  type ContainerPlan,
  type ContainerResourceLimits,
  type FixtureDocker,
  type FixturePlan,
  FixtureRefusal,
  type FixtureResourcePlan,
  type InspectedResource,
  type ResourceKind,
} from './fixture.js';

const execFileAsync = promisify(execFile);
const DOCKER_TIMEOUT_MS = 30_000;
const DOCKER_OUTPUT_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const COMPANION_IDLE_COMMAND = ['node', '-e', 'setInterval(() => undefined, 2147483647)'] as const;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface BoundedCommand {
  run(file: string, args: readonly string[]): Promise<CommandResult>;
}

export class ExecFileCommand implements BoundedCommand {
  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    try {
      const result = await execFileAsync(file, [...args], {
        encoding: 'utf8',
        maxBuffer: DOCKER_OUTPUT_BYTES,
        timeout: DOCKER_TIMEOUT_MS,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const output = error as {
        stdout?: unknown;
        stderr?: unknown;
        code?: unknown;
        signal?: unknown;
        killed?: unknown;
      };
      const stdoutBytes = Buffer.byteLength(typeof output.stdout === 'string' ? output.stdout : '');
      const stderrBytes = Buffer.byteLength(typeof output.stderr === 'string' ? output.stderr : '');
      const outcome = output.killed
        ? 'timed out'
        : `failed with exit ${typeof output.code === 'number' ? output.code : 'unknown'}${
            typeof output.signal === 'string' ? ` and signal ${output.signal}` : ''
          }`;
      throw new FixtureRefusal(`bounded command ${outcome} (stdout ${stdoutBytes} bytes, stderr ${stderrBytes} bytes)`);
    }
  }
}

interface SafeInspection {
  id: string;
  name: string;
  labels: Record<string, string>;
  imageId?: string;
  internal?: boolean;
  nanoCpus?: number;
  memoryBytes?: number;
  pidsLimit?: number;
}

function labelsArgs(labels: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

function parseInspection(kind: ResourceKind, stdout: string): InspectedResource {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new FixtureRefusal(`Docker returned malformed ${kind} inspection`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FixtureRefusal(`Docker returned malformed ${kind} inspection`);
  }
  const inspected = value as Partial<SafeInspection>;
  const name = kind === 'container' && inspected.name?.startsWith('/') ? inspected.name.slice(1) : inspected.name;
  if (
    typeof inspected.id !== 'string' ||
    !SAFE_ID.test(inspected.id) ||
    typeof name !== 'string' ||
    !SAFE_ID.test(name) ||
    inspected.labels === null ||
    typeof inspected.labels !== 'object' ||
    Array.isArray(inspected.labels) ||
    Object.values(inspected.labels).some((label) => typeof label !== 'string')
  ) {
    throw new FixtureRefusal(`Docker returned malformed ${kind} inspection`);
  }
  const resource: InspectedResource = {
    kind,
    id: inspected.id,
    name,
    labels: { ...inspected.labels },
  };
  if (kind === 'container') {
    if (
      !Number.isSafeInteger(inspected.nanoCpus) ||
      inspected.nanoCpus! < 1 ||
      !Number.isSafeInteger(inspected.memoryBytes) ||
      inspected.memoryBytes! < 1 ||
      !Number.isSafeInteger(inspected.pidsLimit) ||
      inspected.pidsLimit! < 1
    ) {
      throw new FixtureRefusal('Docker returned malformed container resource limits');
    }
    resource.limits = {
      cpus: inspected.nanoCpus! / 1_000_000_000,
      memoryBytes: inspected.memoryBytes!,
      pidsLimit: inspected.pidsLimit!,
    };
    if (typeof inspected.imageId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(inspected.imageId)) {
      throw new FixtureRefusal('Docker returned malformed container image identity');
    }
    resource.imageId = inspected.imageId;
  } else if (kind === 'network') {
    if (typeof inspected.internal !== 'boolean') {
      throw new FixtureRefusal('Docker returned malformed network isolation evidence');
    }
    resource.internal = inspected.internal;
  }
  return resource;
}

function outputId(stdout: string): string {
  const value = stdout.trim();
  if (!SAFE_ID.test(value)) {
    throw new FixtureRefusal('Docker returned an invalid resource identity');
  }
  return value;
}

function sameLimits(left: ContainerResourceLimits | undefined, right: ContainerResourceLimits): boolean {
  return left?.cpus === right.cpus && left.memoryBytes === right.memoryBytes && left.pidsLimit === right.pidsLimit;
}

export class DockerCliFixture implements FixtureDocker {
  constructor(private readonly plan: FixturePlan, private readonly command: BoundedCommand = new ExecFileCommand()) {}

  async findExact(kind: ResourceKind, name: string): Promise<InspectedResource | null> {
    const args =
      kind === 'container'
        ? ['ps', '--all', '--quiet', '--filter', `name=^${name}$`]
        : [kind, 'ls', '--quiet', '--filter', `name=^${name}$`];
    const result = await this.invoke(`${kind} lookup`, args);
    const ids = result.stdout.trim() === '' ? [] : result.stdout.trim().split(/\s+/);
    if (ids.length > 1) {
      throw new FixtureRefusal(`Docker returned multiple ${kind} objects named ${name}`);
    }
    return ids[0] ? this.inspect(kind, outputId(ids[0])) : null;
  }

  async create(
    kind: ResourceKind,
    name: string,
    labels: Readonly<Record<string, string>>,
    resource?: FixtureResourcePlan,
  ): Promise<InspectedResource> {
    if (!resource || resource.kind !== kind || resource.name !== name) {
      throw new FixtureRefusal(`Docker create plan does not match ${name}`);
    }
    let result: CommandResult;
    if (resource.kind === 'network') {
      if (!resource.internal || resource.name !== this.plan.network.name) {
        throw new FixtureRefusal('fixture network must be the planned internal network');
      }
      result = await this.invoke('network create', ['network', 'create', '--internal', ...labelsArgs(labels), name]);
    } else if (resource.kind === 'volume') {
      result = await this.invoke('volume create', ['volume', 'create', ...labelsArgs(labels), name]);
    } else {
      const expectedImageId = await this.resolveImageId(resource.image);
      result = await this.invoke('container create', this.containerCreateArgs(resource));
      const created = await this.inspect(kind, outputId(result.stdout));
      if (!created) {
        throw new FixtureRefusal(`Docker did not retain the created ${name}`);
      }
      if (created.name !== name) {
        throw new FixtureRefusal(`Docker created ${created.name} instead of ${name}`);
      }
      if (created.imageId !== expectedImageId) {
        throw new FixtureRefusal(`Docker did not create ${name} from its planned image`);
      }
      if (!sameLimits(created.limits, resource.limits)) {
        throw new FixtureRefusal(`Docker did not apply the resource limits for ${name}`);
      }
      return created;
    }
    const created = await this.inspect(kind, outputId(result.stdout));
    if (!created) {
      throw new FixtureRefusal(`Docker did not retain the created ${name}`);
    }
    if (created.name !== name) {
      throw new FixtureRefusal(`Docker created ${created.name} instead of ${name}`);
    }
    return created;
  }

  async startContainer(id: string): Promise<void> {
    await this.invoke('start', ['start', checkedId(id)]);
  }

  async inspect(kind: ResourceKind, id: string): Promise<InspectedResource | null> {
    const safeId = checkedId(id);
    const format =
      kind === 'container'
        ? '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"imageId":{{json .Image}},"nanoCpus":{{json .HostConfig.NanoCpus}},"memoryBytes":{{json .HostConfig.Memory}},"pidsLimit":{{json .HostConfig.PidsLimit}}}'
        : kind === 'network'
        ? '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Labels}},"internal":{{json .Internal}}}'
        : '{"id":{{json .Name}},"name":{{json .Name}},"labels":{{json .Labels}}}';
    const result = await this.invoke(`${kind} inspect`, [kind, 'inspect', '--format', format, safeId]);
    return parseInspection(kind, result.stdout);
  }

  async remove(kind: ResourceKind, id: string): Promise<void> {
    const safeId = checkedId(id);
    const args = kind === 'container' ? ['container', 'rm', '--force', safeId] : [kind, 'rm', safeId];
    await this.invoke(`${kind} remove`, args);
  }

  private containerCreateArgs(resource: ContainerPlan): string[] {
    const bindingRole = resource.role === 'admin-api' ? 'admin' : resource.role;
    const binding = this.plan.publishedPorts.find((port) => port.role === bindingRole);
    return [
      'create',
      '--name',
      resource.name,
      '--network',
      this.plan.network.name,
      '--cpus',
      String(resource.limits.cpus),
      '--memory',
      `${resource.limits.memoryBytes}b`,
      '--pids-limit',
      String(resource.limits.pidsLimit),
      ...labelsArgs(resource.labels),
      ...(binding ? ['--publish', `${binding.host}:${binding.hostPort}:${binding.containerPort}`] : []),
      resource.image,
      ...(['browser', 'media-sender'].includes(resource.role) ? COMPANION_IDLE_COMMAND : []),
    ];
  }

  private async resolveImageId(reference: string): Promise<string> {
    const result = await this.invoke('image inspect', ['image', 'inspect', '--format', '{{.Id}}', reference]);
    const imageId = result.stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
      throw new FixtureRefusal('Docker returned an invalid planned image identity');
    }
    return imageId;
  }

  private async invoke(phase: string, args: readonly string[]): Promise<CommandResult> {
    try {
      return await this.command.run('docker', args);
    } catch (error) {
      throw new FixtureRefusal(`fixture Docker ${phase} failed`, { cause: error });
    }
  }
}

function checkedId(id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new FixtureRefusal('Docker resource identity is invalid');
  }
  return id;
}
