import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExecFileCommand } from './dockerCli.js';
import { runContinuationFixture } from './executor.js';
import { type FixturePlan, FixtureRefusal, validateFixturePlan } from './fixture.js';
import { type ReleaseFixtureTargets, validateReleaseFixtureTargets } from './provisioner.js';
import {
  ContinuationFixtureRuntime,
  type ContinuationFixtureRuntimeConfiguration,
  type ContinuationFixtureRuntimeSecrets,
  type ContinuationScenario,
  scenarioEvidenceMetadata,
} from './runtimeExecutor.js';

const CONFIG_BYTES = 1024 * 1024;
const CONFIG_NODES = 10_000;
const CONFIG_DEPTH = 32;
const USERNAME = /^[A-Za-z0-9_.-]{1,100}$/;
const CREDENTIAL_FIELD = /(?:authorization|cookie|credential|password|passphrase|private.?key|secret|token)/i;

export interface ContinuationCliConfiguration {
  schemaVersion: 1;
  plan: FixturePlan;
  targets: ReleaseFixtureTargets;
  managerUsername: string;
  adminUsername: string;
}

export interface ContinuationCliResult {
  schemaVersion: 1;
  fixtureId: string;
  scenario: ContinuationScenario;
  status: 'completed';
  evidencePath: string;
  evidenceScope: 'cumulative-media-observation' | 'reconnect-controller-observation';
  remainingWitness?: 'srs_on_publish_response_code_1';
}

export type ContinuationCliRunner = (
  configuration: ContinuationCliConfiguration,
  secrets: ContinuationFixtureRuntimeSecrets,
  scenario: ContinuationScenario,
) => Promise<void>;

export async function runContinuationCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  runner: ContinuationCliRunner = runConcreteContinuationFixture,
): Promise<ContinuationCliResult> {
  const { configPath, scenario } = parseArguments(argv);
  const configuration = readConfiguration(configPath);
  const secrets = readProcessInputs(environment);
  await runner(configuration, secrets, scenario);
  return {
    schemaVersion: 1,
    fixtureId: configuration.plan.fixtureId,
    scenario,
    status: 'completed',
    evidencePath: join(configuration.plan.outputRoot, 'scenario-evidence.json'),
    ...scenarioEvidenceMetadata(scenario),
  };
}

async function runConcreteContinuationFixture(
  configuration: ContinuationCliConfiguration,
  secrets: ContinuationFixtureRuntimeSecrets,
  scenario: ContinuationScenario,
): Promise<void> {
  const { FixtureReadinessControlExecutor } = await import('./readinessControls.js');
  const command = new ExecFileCommand();
  const runtimeConfiguration: ContinuationFixtureRuntimeConfiguration = { ...configuration, scenario };
  const runtime = new ContinuationFixtureRuntime(runtimeConfiguration, secrets, {
    command,
    createControls: (input) =>
      new FixtureReadinessControlExecutor(command, {
        fixtureId: input.plan.fixtureId,
        topology: input.topology,
        containers: new Map(
          [...input.runtime.readiness.containers].map(([role, container]) => [
            role,
            { id: container.id, name: container.name },
          ]),
        ),
        postageBatchId: input.postageBatchId,
        viewerMediaBaseUrl: input.runtime.endpoints.viewerMediaBaseUrl,
        srs: {
          host: input.runtime.endpoints.srs.host,
          rtmpPort: input.runtime.endpoints.srs.rtmpPort,
        },
        readinessStreamTopic: input.readinessStreamTopic,
        requiredDiskBytes: input.plan.minimumStorageBytes,
      }),
  });
  await runContinuationFixture(
    { fixtureId: configuration.plan.fixtureId, outputRoot: configuration.plan.outputRoot },
    runtime,
  );
}

function parseArguments(argv: readonly string[]): { configPath: string; scenario: ContinuationScenario } {
  const commandArguments = argv[0] === '--' ? argv.slice(1) : argv;
  if (
    commandArguments.length !== 5 ||
    commandArguments[0] !== 'run' ||
    commandArguments[1] !== '--scenario' ||
    !['cumulative', 'reconnect'].includes(commandArguments[2] ?? '') ||
    commandArguments[3] !== '--config' ||
    !commandArguments[4] ||
    !isAbsolute(commandArguments[4])
  ) {
    throw new FixtureRefusal(
      'usage: fixture:continuation -- run --scenario <cumulative|reconnect> --config <absolute-path>',
    );
  }
  return { configPath: commandArguments[4], scenario: commandArguments[2] as ContinuationScenario };
}

function readConfiguration(path: string): ContinuationCliConfiguration {
  let value: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > CONFIG_BYTES) {
      throw new Error('invalid file');
    }
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new FixtureRefusal('fixture configuration could not be read');
  }
  assertCredentialFree(value);
  if (
    !isObject(value) ||
    !hasExactKeys(value, ['adminUsername', 'managerUsername', 'plan', 'schemaVersion', 'targets'])
  ) {
    throw new FixtureRefusal('fixture configuration is malformed');
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.managerUsername !== 'string' ||
    !USERNAME.test(value.managerUsername) ||
    typeof value.adminUsername !== 'string' ||
    !USERNAME.test(value.adminUsername)
  ) {
    throw new FixtureRefusal('fixture configuration is malformed');
  }
  try {
    validateFixturePlan(value.plan as FixturePlan);
    validateReleaseFixtureTargets(value.plan as FixturePlan, value.targets as ReleaseFixtureTargets);
  } catch {
    throw new FixtureRefusal('fixture configuration is malformed');
  }
  return value as unknown as ContinuationCliConfiguration;
}

function assertCredentialFree(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > CONFIG_NODES || current.depth > CONFIG_DEPTH) {
      throw new FixtureRefusal('fixture configuration is too complex');
    }
    if (Array.isArray(current.value)) {
      for (const value of current.value) {
        pending.push({ value, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isObject(current.value)) {
      continue;
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (CREDENTIAL_FIELD.test(key)) {
        throw new FixtureRefusal('configuration contains a credential field');
      }
      pending.push({ value, depth: current.depth + 1 });
    }
  }
}

function readProcessInputs(
  environment: Readonly<Record<string, string | undefined>>,
): ContinuationFixtureRuntimeSecrets {
  return {
    beePassword: processInput(environment, 'SRS_FIXTURE_BEE_PASSWORD'),
    managerPassword: processInput(environment, 'SRS_FIXTURE_MANAGER_PASSWORD'),
    adminPassword: processInput(environment, 'SRS_FIXTURE_ADMIN_PASSWORD'),
    feedPrivateKey: processInput(environment, 'FEED_PRIVATE_KEY'),
    srtPassphrase: processInput(environment, 'INGEST_SRT_PASSPHRASE'),
  };
}

function processInput(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (!value || Buffer.byteLength(value) > 16 * 1024 || /[\0\r\n]/.test(value)) {
    throw new FixtureRefusal(`required process input ${name} is missing or malformed`);
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function main(): Promise<void> {
  try {
    const result = await runContinuationCli(process.argv.slice(2), process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('continuation fixture refused without exposing configuration or process inputs\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
