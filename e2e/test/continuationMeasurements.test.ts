import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { BoundedCommand, CommandResult } from '../src/continuation/dockerCli.js';
import { FixtureRefusal } from '../src/continuation/fixture.js';
import { captureContinuationMeasurements, type MeasurementContainerRole } from '../src/continuation/measurements.js';
import type { RuntimeContainerBinding } from '../src/continuation/readinessSource.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';

class RecordingCommand implements BoundedCommand {
  readonly calls: Array<{ file: string; args: readonly string[] }> = [];

  constructor(private readonly refuseFirstBee = false) {}

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ file, args: [...args] });
    if (this.refuseFirstBee && args.includes(`http://${FIXTURE_ID}-bee-queen:1633/metrics`)) {
      throw new Error('synthetic raw command detail must stay private');
    }
    if (args[0] === 'exec' && args.some((argument) => argument.endsWith('/metrics'))) {
      return { stdout: '# full service metrics\nmetric_total 1\n', stderr: '' };
    }
    if (args[0] === 'exec') {
      return { stdout: '{"status":"ok","complete":true}', stderr: '' };
    }
    if (args[0] === 'stats') {
      return {
        stdout:
          args
            .slice(args.indexOf('--format') + 2)
            .map((id) =>
              JSON.stringify({ id, cpu: '0.1%', memory: '1MiB / 1GiB', pids: '1', net: '0B / 0B', block: '0B / 0B' }),
            )
            .join('\n') + '\n',
        stderr: '',
      };
    }
    if (args[0] === 'inspect') {
      return {
        stdout: JSON.stringify({ id: args.at(-1), nanoCpus: 1_000_000_000, memory: 1_073_741_824, pids: 256 }),
        stderr: '',
      };
    }
    if (args[0] === 'ps') {
      return { stdout: '{"id":"foreign","name":"neighbor","image":"synthetic"}\n', stderr: '' };
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  }
}

class BoundedFailureCommand extends RecordingCommand {
  override async run(file: string, args: readonly string[]): Promise<CommandResult> {
    if (args.includes(`http://${FIXTURE_ID}-bee-queen:1633/metrics`)) {
      throw new FixtureRefusal('bounded command timed out (stdout 17 bytes, stderr 23 bytes)');
    }
    return super.run(file, args);
  }
}

function containers(): ReadonlyMap<MeasurementContainerRole, RuntimeContainerBinding> {
  const roles: MeasurementContainerRole[] = [
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
  return new Map(
    roles.map((role) => [
      role,
      {
        id: `${role}-container-id`,
        name: `${FIXTURE_ID}-${role}`,
        configuredImage: `synthetic/${role}`,
      },
    ]),
  );
}

describe('continuation measurement snapshots', () => {
  it('captures complete service metrics, exact-container caps and co-tenancy without printing them', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'continuation-measurements-'));
    const command = new RecordingCommand();

    const path = await captureContinuationMeasurements(command, {
      fixtureId: FIXTURE_ID,
      outputRoot,
      phase: 'before',
      probeContainerId: 'admin-api-container-id',
      containers: containers(),
    });

    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.phase, 'before');
    assert.equal(saved.complete, true);
    assert.deepEqual(saved.failures, []);
    assert.match(JSON.stringify(saved), /full service metrics/);
    assert.match(JSON.stringify(saved), /neighbor/);
    assert.deepEqual(saved.rolesWithoutServiceMetrics, [
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
    ]);
    const metricUrls = command.calls
      .filter(({ args }) => args[0] === 'exec' && args.some((argument) => argument.startsWith('http://')))
      .map(({ args }) => args.find((argument) => argument.startsWith('http://')));
    assert.deepEqual(metricUrls, [
      `http://${FIXTURE_ID}-bee-queen:1633/metrics`,
      `http://${FIXTURE_ID}-bee-worker-1:1635/metrics`,
      `http://${FIXTURE_ID}-bee-worker-2:1637/metrics`,
      `http://${FIXTURE_ID}-bee-worker-3:1639/metrics`,
      `http://${FIXTURE_ID}-bee-worker-4:1641/metrics`,
      'http://srs:10019/api/v1/summaries',
    ]);
    assert.ok(
      command.calls
        .filter(({ args }) => args[0] === 'exec' && args.some((argument) => argument.startsWith('http://')))
        .every(({ args }) => args.at(-1) === String(256 * 1024)),
    );
    assert.equal(command.calls.filter(({ args }) => args[0] === 'stats').length, 1);
    assert.equal(command.calls.filter(({ args }) => args[0] === 'inspect').length, 17);
    const statsCall = command.calls.find(({ args }) => args[0] === 'stats');
    assert.ok(statsCall);
    assert.ok(statsCall.args.includes('--no-trunc'));
    const savedStats = String(saved.exactContainerStats)
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as { id: string });
    assert.equal(savedStats.length, 17);
    assert.equal(new Set(savedStats.map(({ id }) => id)).size, 17);
    assert.deepEqual(new Set(savedStats.map(({ id }) => id)), new Set([...containers().values()].map(({ id }) => id)));
    assert.ok(command.calls.every(({ args }) => !args.includes('env')));
    assert.ok(command.calls.every(({ args }) => !args.includes('logs')));
  });

  it('writes bounded failure evidence after attempting every remaining surface', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'continuation-measurements-failed-'));
    const command = new RecordingCommand(true);
    let rejection: unknown;

    try {
      await captureContinuationMeasurements(command, {
        fixtureId: FIXTURE_ID,
        outputRoot,
        phase: 'after',
        probeContainerId: 'admin-api-container-id',
        containers: containers(),
      });
    } catch (error) {
      rejection = error;
    }

    assert.ok(rejection instanceof Error);
    assert.match(rejection.message, /snapshot is incomplete/i);
    assert.equal(rejection.message.includes('synthetic raw command detail'), false);
    assert.equal(
      (rejection as Error & { snapshotPath?: string }).snapshotPath,
      join(outputRoot, 'measurements', 'after.json'),
    );
    const saved = JSON.parse(readFileSync(join(outputRoot, 'measurements', 'after.json'), 'utf8')) as {
      complete: boolean;
      failures: Array<{ surface: string; diagnostic: string }>;
      serviceMetrics: Record<string, string>;
      exactContainerStats: string | null;
      exactContainerLimits: Record<string, string>;
      coTenancy: string | null;
    };
    assert.equal(saved.complete, false);
    assert.deepEqual(saved.failures, [{ surface: 'serviceMetrics.bee-queen', diagnostic: 'bounded command failed' }]);
    assert.equal(JSON.stringify(saved).includes('synthetic raw command detail'), false);
    assert.equal('bee-queen' in saved.serviceMetrics, false);
    assert.match(saved.serviceMetrics['bee-worker-1'] ?? '', /full service metrics/);
    assert.match(saved.serviceMetrics.uploader ?? '', /"complete":true/);
    assert.match(saved.exactContainerStats ?? '', /"cpu":"0\.1%"/);
    assert.equal(Object.keys(saved.exactContainerLimits).length, 17);
    assert.match(saved.coTenancy ?? '', /neighbor/);
    assert.equal(command.calls.filter(({ args }) => args[0] === 'stats').length, 1);
    assert.equal(command.calls.filter(({ args }) => args[0] === 'inspect').length, 17);
    assert.equal(command.calls.filter(({ args }) => args[0] === 'ps').length, 1);
    const metricUrls = command.calls
      .filter(({ args }) => args[0] === 'exec' && args.some((argument) => argument.startsWith('http://')))
      .map(({ args }) => args.find((argument) => argument.startsWith('http://')));
    assert.deepEqual(metricUrls, [
      `http://${FIXTURE_ID}-bee-queen:1633/metrics`,
      `http://${FIXTURE_ID}-bee-worker-1:1635/metrics`,
      `http://${FIXTURE_ID}-bee-worker-2:1637/metrics`,
      `http://${FIXTURE_ID}-bee-worker-3:1639/metrics`,
      `http://${FIXTURE_ID}-bee-worker-4:1641/metrics`,
      'http://srs:10019/api/v1/summaries',
    ]);
  });

  it('retains only the command runner safe failure diagnostic', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'continuation-measurements-bounded-failure-'));

    await assert.rejects(
      captureContinuationMeasurements(new BoundedFailureCommand(), {
        fixtureId: FIXTURE_ID,
        outputRoot,
        phase: 'after',
        probeContainerId: 'admin-api-container-id',
        containers: containers(),
      }),
      /snapshot is incomplete/i,
    );

    const saved = JSON.parse(readFileSync(join(outputRoot, 'measurements', 'after.json'), 'utf8')) as {
      failures: Array<{ surface: string; diagnostic: string }>;
    };
    assert.deepEqual(saved.failures, [
      {
        surface: 'serviceMetrics.bee-queen',
        diagnostic: 'bounded command timed out (stdout 17 bytes, stderr 23 bytes)',
      },
    ]);
  });

  it('records missing exact stats and mismatched limit identities as incomplete surfaces', async () => {
    class IncompleteIdentityCommand extends RecordingCommand {
      override async run(file: string, args: readonly string[]): Promise<CommandResult> {
        const result = await super.run(file, args);
        if (args[0] === 'stats') {
          return { ...result, stdout: result.stdout.split('\n').slice(1).join('\n') };
        }
        if (args[0] === 'inspect' && args.at(-1) === 'manager-api-container-id') {
          return { ...result, stdout: JSON.stringify({ id: 'foreign-manager-api', nanoCpus: 1, memory: 1, pids: 1 }) };
        }
        return result;
      }
    }
    const outputRoot = mkdtempSync(join(tmpdir(), 'continuation-measurements-identities-'));

    await assert.rejects(
      captureContinuationMeasurements(new IncompleteIdentityCommand(), {
        fixtureId: FIXTURE_ID,
        outputRoot,
        phase: 'before',
        probeContainerId: 'admin-api-container-id',
        containers: containers(),
      }),
      /snapshot is incomplete/i,
    );

    const saved = JSON.parse(readFileSync(join(outputRoot, 'measurements', 'before.json'), 'utf8')) as {
      failures: Array<{ surface: string; diagnostic: string }>;
      exactContainerStats: string | null;
      exactContainerLimits: Record<string, string>;
    };
    assert.deepEqual(saved.failures, [
      { surface: 'exactContainerStats', diagnostic: 'bounded command failed' },
      { surface: 'exactContainerLimits.manager-api', diagnostic: 'bounded command failed' },
    ]);
    assert.equal(saved.exactContainerStats, null);
    assert.equal('manager-api' in saved.exactContainerLimits, false);
    assert.equal(Object.keys(saved.exactContainerLimits).length, 16);
  });
});
