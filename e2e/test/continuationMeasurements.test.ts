import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { BoundedCommand, CommandResult } from '../src/continuation/dockerCli.js';
import { captureContinuationMeasurements } from '../src/continuation/measurements.js';
import type { RuntimeContainerBinding } from '../src/continuation/readinessSource.js';
import type { TopologyServiceRole } from '../src/continuation/topology.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';

class RecordingCommand implements BoundedCommand {
  readonly calls: Array<{ file: string; args: readonly string[] }> = [];

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ file, args: [...args] });
    if (args[0] === 'exec' && args.includes('/metrics')) {
      return { stdout: '# full service metrics\nmetric_total 1\n', stderr: '' };
    }
    if (args[0] === 'exec') {
      return { stdout: '{"status":"ok","complete":true}', stderr: '' };
    }
    if (args[0] === 'stats') {
      return { stdout: '{"ID":"one","CPUPerc":"0.1%"}\n', stderr: '' };
    }
    if (args[0] === 'inspect') {
      return { stdout: '{"id":"one","nanoCpus":1000000000,"memory":1073741824,"pids":256}', stderr: '' };
    }
    if (args[0] === 'ps') {
      return { stdout: '{"id":"foreign","name":"neighbor","image":"synthetic"}\n', stderr: '' };
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  }
}

function containers(): ReadonlyMap<TopologyServiceRole, RuntimeContainerBinding> {
  const roles: TopologyServiceRole[] = [
    'blockchain', 'bee-queen', 'bee-worker-1', 'bee-worker-2', 'bee-worker-3', 'bee-worker-4',
    'postgres', 'admin-api', 'admin-web', 'srs', 'uploader', 'viewer', 'browser', 'media-sender',
  ];
  return new Map(roles.map((role) => [role, {
    id: `${role}-container-id`,
    name: `${FIXTURE_ID}-${role}`,
    configuredImage: `synthetic/${role}`,
  }]));
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
    assert.match(JSON.stringify(saved), /full service metrics/);
    assert.match(JSON.stringify(saved), /neighbor/);
    assert.equal(command.calls.filter(({ args }) => args[0] === 'stats').length, 1);
    assert.equal(command.calls.filter(({ args }) => args[0] === 'inspect').length, 14);
    assert.ok(command.calls.every(({ args }) => !args.includes('env')));
    assert.ok(command.calls.every(({ args }) => !args.includes('logs')));
  });
});
