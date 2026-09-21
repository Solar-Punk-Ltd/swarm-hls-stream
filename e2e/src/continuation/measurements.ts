import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { uploaderMetricsScript } from '../harness/uploaderMetrics.js';

import type { BoundedCommand } from './dockerCli.js';
import { FixtureRefusal } from './fixture.js';
import type { RuntimeContainerBinding } from './readinessSource.js';
import type { TopologyServiceRole } from './topology.js';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const FIXTURE_ID = /^srs-continuation-20260920-[a-z0-9]{8,16}$/;
const SERVICE_METRIC_MAX_BYTES = 256 * 1024;
const SAFE_COMMAND_DIAGNOSTIC =
  /^bounded command (?:timed out|failed with exit (?:unknown|-?\d+)(?: and signal [A-Za-z0-9]+)?) \(stdout \d+ bytes, stderr \d+ bytes\)$/;
const GENERIC_COMMAND_DIAGNOSTIC = 'bounded command failed';
type ManagerMeasurementRole = 'manager-postgres' | 'manager-api' | 'manager-web';
export type MeasurementContainerRole = TopologyServiceRole | ManagerMeasurementRole;

const EXPECTED_ROLES: readonly MeasurementContainerRole[] = [
  'blockchain',
  'bee-queen',
  'bee-worker-1',
  'bee-worker-2',
  'bee-worker-3',
  'bee-worker-4',
  'postgres',
  'admin-api',
  'admin-web',
  'srs',
  'uploader',
  'viewer',
  'browser',
  'media-sender',
  'manager-postgres',
  'manager-api',
  'manager-web',
];
const ROLES_WITHOUT_SERVICE_METRICS: readonly MeasurementContainerRole[] = [
  'blockchain',
  'postgres',
  'admin-api',
  'admin-web',
  'viewer',
  'browser',
  'media-sender',
  'manager-postgres',
  'manager-api',
  'manager-web',
];

const HTTP_TEXT_SCRIPT = `
const url = process.argv[1];
const maximum = Number(process.argv[2]);
fetch(url).then(async response => {
  if (!response.ok || response.body === null) throw new Error('bounded metric endpoint refused');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.byteLength;
    if (total > maximum) throw new Error('bounded metric endpoint exceeded limit');
    chunks.push(Buffer.from(next.value));
  }
  process.stdout.write(Buffer.concat(chunks, total));
}).catch(() => process.exit(1));
`.trim();

interface ContinuationMeasurementInput {
  fixtureId: string;
  outputRoot: string;
  phase: 'before' | 'after';
  probeContainerId: string;
  containers: ReadonlyMap<MeasurementContainerRole, RuntimeContainerBinding>;
}

interface ContinuationMeasurementFailure {
  surface: string;
  diagnostic: string;
}

class IncompleteContinuationMeasurements extends FixtureRefusal {
  constructor(readonly snapshotPath: string, readonly failedSurfaces: readonly string[]) {
    super('continuation measurement snapshot is incomplete');
    this.name = 'IncompleteContinuationMeasurements';
  }
}

/** Captures the complete available metric surfaces and exact fixture capacity context without logging response bodies. */
export async function captureContinuationMeasurements(
  command: BoundedCommand,
  input: ContinuationMeasurementInput,
): Promise<string> {
  const containers = validateInput(input);
  const uploader = containers.get('uploader')!;
  const failures: ContinuationMeasurementFailure[] = [];
  const serviceMetrics: Record<string, string> = {};
  const metricEndpoints = new Map<string, string>([
    ['bee-queen', `http://${input.fixtureId}-bee-queen:1633/metrics`],
    ['bee-worker-1', `http://${input.fixtureId}-bee-worker-1:1635/metrics`],
    ['bee-worker-2', `http://${input.fixtureId}-bee-worker-2:1637/metrics`],
    ['bee-worker-3', `http://${input.fixtureId}-bee-worker-3:1639/metrics`],
    ['bee-worker-4', `http://${input.fixtureId}-bee-worker-4:1641/metrics`],
    ['srs', 'http://srs:10019/api/v1/summaries'],
  ]);
  for (const [name, url] of metricEndpoints) {
    const result = await captureSurface(failures, `serviceMetrics.${name}`, () =>
      command.run('docker', [
        'exec',
        input.probeContainerId,
        'node',
        '-e',
        HTTP_TEXT_SCRIPT,
        url,
        String(SERVICE_METRIC_MAX_BYTES),
      ]),
    );
    if (result) {
      serviceMetrics[name] = result.stdout;
    }
  }
  const uploaderMetrics = await captureSurface(failures, 'serviceMetrics.uploader', () =>
    command.run('docker', ['exec', uploader.id, 'node', '-e', uploaderMetricsScript()]),
  );
  if (uploaderMetrics) {
    serviceMetrics.uploader = uploaderMetrics.stdout;
  }

  const ids = EXPECTED_ROLES.map((role) => containers.get(role)!.id);
  const stats = await captureSurface(failures, 'exactContainerStats', async () => {
    const result = await command.run('docker', [
      'stats',
      '--no-stream',
      '--no-trunc',
      '--format',
      '{"id":{{json .ID}},"name":{{json .Name}},"cpu":{{json .CPUPerc}},"memory":{{json .MemUsage}},"pids":{{json .PIDs}},"net":{{json .NetIO}},"block":{{json .BlockIO}}}',
      ...ids,
    ]);
    validateExactStats(result.stdout, ids);
    return result;
  });
  const limits: Record<string, string> = {};
  for (const role of EXPECTED_ROLES) {
    const binding = containers.get(role)!;
    const result = await captureSurface(failures, `exactContainerLimits.${role}`, async () => {
      const observed = await command.run('docker', [
        'inspect',
        '--format',
        '{"id":{{json .Id}},"nanoCpus":{{json .HostConfig.NanoCpus}},"memory":{{json .HostConfig.Memory}},"pids":{{json .HostConfig.PidsLimit}}}',
        binding.id,
      ]);
      validateExactLimit(observed.stdout, binding.id);
      return observed;
    });
    if (result) {
      limits[role] = result.stdout;
    }
  }
  const coTenancy = await captureSurface(failures, 'coTenancy', () =>
    command.run('docker', [
      'ps',
      '--no-trunc',
      '--format',
      '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}}}',
    ]),
  );

  const directory = join(input.outputRoot, 'measurements');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${input.phase}.json`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        fixtureId: input.fixtureId,
        phase: input.phase,
        capturedAt: new Date().toISOString(),
        complete: failures.length === 0,
        failures,
        serviceMetrics,
        rolesWithoutServiceMetrics: ROLES_WITHOUT_SERVICE_METRICS,
        exactContainerStats: stats?.stdout ?? null,
        exactContainerLimits: limits,
        coTenancy: coTenancy?.stdout ?? null,
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  if (failures.length > 0) {
    throw new IncompleteContinuationMeasurements(
      path,
      failures.map(({ surface }) => surface),
    );
  }
  return path;
}

async function captureSurface<T>(
  failures: ContinuationMeasurementFailure[],
  surface: string,
  capture: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await capture();
  } catch (error) {
    failures.push({ surface, diagnostic: safeCommandDiagnostic(error) });
    return undefined;
  }
}

function safeCommandDiagnostic(error: unknown): string {
  if (error instanceof FixtureRefusal && SAFE_COMMAND_DIAGNOSTIC.test(error.message)) {
    return error.message;
  }
  return GENERIC_COMMAND_DIAGNOSTIC;
}

function validateInput(input: ContinuationMeasurementInput): Map<MeasurementContainerRole, RuntimeContainerBinding> {
  if (!FIXTURE_ID.test(input.fixtureId) || !SAFE_ID.test(input.probeContainerId)) {
    throw new FixtureRefusal('continuation measurement identity is malformed');
  }
  const containers = new Map(input.containers);
  if (
    containers.size !== EXPECTED_ROLES.length ||
    EXPECTED_ROLES.some((role) => {
      const binding = containers.get(role);
      return !binding || !SAFE_ID.test(binding.id) || !SAFE_ID.test(binding.name) || binding.configuredImage.length < 1;
    })
  ) {
    throw new FixtureRefusal('continuation measurement container set is incomplete');
  }
  if (new Set([...containers.values()].map(({ id }) => id)).size !== EXPECTED_ROLES.length) {
    throw new FixtureRefusal('continuation measurement container identities are not distinct');
  }
  return containers;
}

function validateExactStats(value: string, expectedIds: readonly string[]): void {
  const rows = value.trim() === '' ? [] : value.trim().split('\n');
  const observed = rows.map((row) => parseExactId(row));
  if (
    observed.length !== expectedIds.length ||
    new Set(observed).size !== observed.length ||
    observed.some((id) => !expectedIds.includes(id))
  ) {
    throw new FixtureRefusal('exact container stats identity set is incomplete');
  }
}

function validateExactLimit(value: string, expectedId: string): void {
  if (parseExactId(value) !== expectedId) {
    throw new FixtureRefusal('exact container limit identity does not match');
  }
}

function parseExactId(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { id?: unknown }).id === 'string' &&
      SAFE_ID.test((parsed as { id: string }).id)
    ) {
      return (parsed as { id: string }).id;
    }
  } catch {
    throw new FixtureRefusal('exact container observation is malformed');
  }
  throw new FixtureRefusal('exact container observation is malformed');
}
