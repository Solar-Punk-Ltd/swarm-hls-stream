import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { uploaderMetricsScript } from '../harness/uploaderMetrics.js';

import type { BoundedCommand } from './dockerCli.js';
import { FixtureRefusal } from './fixture.js';
import type { RuntimeContainerBinding } from './readinessSource.js';
import type { TopologyServiceRole } from './topology.js';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const FIXTURE_ID = /^srs-continuation-20260920-[a-z0-9]{8,16}$/;
const EXPECTED_ROLES: readonly TopologyServiceRole[] = [
  'blockchain', 'bee-queen', 'bee-worker-1', 'bee-worker-2', 'bee-worker-3', 'bee-worker-4',
  'postgres', 'admin-api', 'admin-web', 'srs', 'uploader', 'viewer', 'browser', 'media-sender',
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

export interface ContinuationMeasurementInput {
  fixtureId: string;
  outputRoot: string;
  phase: 'before' | 'after';
  probeContainerId: string;
  containers: ReadonlyMap<TopologyServiceRole, RuntimeContainerBinding>;
}

/** Captures the complete available metric surfaces and exact fixture capacity context without logging response bodies. */
export async function captureContinuationMeasurements(
  command: BoundedCommand,
  input: ContinuationMeasurementInput,
): Promise<string> {
  const containers = validateInput(input);
  const uploader = containers.get('uploader')!;
  const serviceMetrics: Record<string, string> = {};
  const metricEndpoints = new Map<string, string>([
    ['bee-queen', `http://${input.fixtureId}-bee-queen:1634/metrics`],
    ['bee-worker-1', `http://${input.fixtureId}-bee-worker-1:1636/metrics`],
    ['bee-worker-2', `http://${input.fixtureId}-bee-worker-2:1638/metrics`],
    ['bee-worker-3', `http://${input.fixtureId}-bee-worker-3:1640/metrics`],
    ['bee-worker-4', `http://${input.fixtureId}-bee-worker-4:1642/metrics`],
    ['srs', 'http://srs:10019/api/v1/summaries'],
  ]);
  for (const [name, url] of metricEndpoints) {
    const result = await command.run('docker', [
      'exec', input.probeContainerId, 'node', '-e', HTTP_TEXT_SCRIPT, url, String(2 * 1024 * 1024),
    ]);
    serviceMetrics[name] = result.stdout;
  }
  serviceMetrics.uploader = (await command.run('docker', [
    'exec', uploader.id, 'node', '-e', uploaderMetricsScript(),
  ])).stdout;

  const ids = EXPECTED_ROLES.map((role) => containers.get(role)!.id);
  const stats = (await command.run('docker', [
    'stats', '--no-stream', '--format',
    '{"id":{{json .ID}},"name":{{json .Name}},"cpu":{{json .CPUPerc}},"memory":{{json .MemUsage}},"pids":{{json .PIDs}},"net":{{json .NetIO}},"block":{{json .BlockIO}}}',
    ...ids,
  ])).stdout;
  const limits: Record<string, string> = {};
  for (const role of EXPECTED_ROLES) {
    const binding = containers.get(role)!;
    limits[role] = (await command.run('docker', [
      'inspect', '--format',
      '{"id":{{json .Id}},"nanoCpus":{{json .HostConfig.NanoCpus}},"memory":{{json .HostConfig.Memory}},"pids":{{json .HostConfig.PidsLimit}}}',
      binding.id,
    ])).stdout;
  }
  const coTenancy = (await command.run('docker', [
    'ps', '--no-trunc', '--format', '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}}}',
  ])).stdout;

  const directory = join(input.outputRoot, 'measurements');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${input.phase}.json`);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    fixtureId: input.fixtureId,
    phase: input.phase,
    capturedAt: new Date().toISOString(),
    serviceMetrics,
    exactContainerStats: stats,
    exactContainerLimits: limits,
    coTenancy,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

function validateInput(input: ContinuationMeasurementInput): Map<TopologyServiceRole, RuntimeContainerBinding> {
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
  return containers;
}
