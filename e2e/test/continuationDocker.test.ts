import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type BoundedCommand,
  type CommandResult,
  DockerCliFixture,
  ExecFileCommand,
} from '../src/continuation/dockerCli.js';
import { createFixturePlan, type FixturePlan } from '../src/continuation/fixture.js';

const FIXTURE_ID = 'srs-continuation-20260920-d0c0a001';
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;

function plan(): FixturePlan {
  return createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: `/tmp/${FIXTURE_ID}`,
    candidates: [
      { role: 'stack', root: '/candidate/stack', commit: 'a'.repeat(40) },
      { role: 'admin', root: '/candidate/admin', commit: 'a'.repeat(40) },
      { role: 'manager', root: '/candidate/manager', commit: 'a'.repeat(40) },
    ],
    candidateImages: {
      postgres: IMAGE_ID,
      srs: IMAGE_ID,
      uploader: IMAGE_ID,
      adminApi: IMAGE_ID,
      adminWeb: IMAGE_ID,
      viewer: IMAGE_ID,
      mediaSender: IMAGE_ID,
      browser: IMAGE_ID,
    },
    loopbackPorts: { rpc: 18_545, admin: 18_080, viewer: 18_081 },
    minimumStorageBytes: 1_000_000,
    minimumStorageTtlSeconds: 900,
    expectedChainId: 1337,
  });
}

class RecordingCommands implements BoundedCommand {
  readonly calls: Array<{ file: string; args: readonly string[] }> = [];
  wrongContainerLimits = false;
  wrongContainerImage = false;
  private readonly inspections = new Map<string, object>();
  private nextId = 1;

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ file, args: [...args] });
    if (args[0] === 'image' && args[1] === 'inspect') return { stdout: `${IMAGE_ID}\n`, stderr: '' };
    if (args[0] === 'network' && args[1] === 'create') {
      const id = `network-${this.nextId++}`;
      this.inspections.set(id, {
        id,
        name: args.at(-1),
        labels: this.labels(args),
        internal: args.includes('--internal'),
      });
      return { stdout: `${id}\n`, stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      const id = String(args.at(-1));
      this.inspections.set(id, { id, name: id, labels: this.labels(args) });
      return { stdout: `${id}\n`, stderr: '' };
    }
    if (args[0] === 'create') {
      const id = `container-${this.nextId++}`;
      const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
      this.inspections.set(id, {
        id,
        name: `/${valueAfter('--name')}`,
        labels: this.labels(args),
        imageId: this.wrongContainerImage ? `sha256:${'c'.repeat(64)}` : IMAGE_ID,
        nanoCpus: Number(valueAfter('--cpus')) * 1_000_000_000,
        memoryBytes: Number(String(valueAfter('--memory')).slice(0, -1)),
        pidsLimit: Number(valueAfter('--pids-limit')),
      });
      return { stdout: `${id}\n`, stderr: '' };
    }
    if (args[1] === 'inspect') {
      const inspection = structuredClone(this.inspections.get(String(args.at(-1))));
      if (this.wrongContainerLimits && inspection && 'nanoCpus' in inspection) inspection.nanoCpus = 0;
      return { stdout: JSON.stringify(inspection), stderr: '' };
    }
    throw new Error(`unexpected command ${args.join(' ')}`);
  }

  private labels(args: readonly string[]): Record<string, string> {
    const labels: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== '--label') continue;
      const [key, value] = String(args[index + 1]).split('=', 2);
      labels[key] = value;
    }
    return labels;
  }
}

describe('continuation fixture Docker adapter', () => {
  it('creates only an internal labeled network', async () => {
    const fixturePlan = plan();
    const commands = new RecordingCommands();
    const docker = new DockerCliFixture(fixturePlan, commands);

    await docker.create('network', fixturePlan.network.name, fixturePlan.network.labels, fixturePlan.network);

    assert.deepEqual(commands.calls[0], {
      file: 'docker',
      args: [
        'network',
        'create',
        '--internal',
        '--label',
        `org.solarpunk.srs-continuation.fixture=${FIXTURE_ID}`,
        '--label',
        'org.solarpunk.srs-continuation.managed=true',
        fixturePlan.network.name,
      ],
    });
    assert.equal(commands.calls[1]?.args[0], 'network');
    assert.equal(commands.calls[1]?.args[1], 'inspect');
  });

  it('passes explicit caps, private network, and loopback-only ports to every container create', async () => {
    const fixturePlan = plan();
    const commands = new RecordingCommands();
    const docker = new DockerCliFixture(fixturePlan, commands);

    for (const resource of fixturePlan.resources) {
      if (resource.kind === 'container') {
        await docker.create(resource.kind, resource.name, resource.labels, resource);
      }
    }

    const creates = commands.calls.filter((call) => call.args[0] === 'create');
    assert.equal(creates.length, 14);
    for (const call of creates) {
      assert.ok(call.args.includes('--cpus'));
      assert.ok(call.args.includes('--memory'));
      assert.ok(call.args.includes('--pids-limit'));
      assert.deepEqual(call.args.slice(call.args.indexOf('--network'), call.args.indexOf('--network') + 2), [
        '--network',
        fixturePlan.network.name,
      ]);
      for (const publish of call.args.filter((value, index) => call.args[index - 1] === '--publish')) {
        assert.match(publish, /^127\.0\.0\.1:[0-9]+:[0-9]+$/);
      }
    }
  });

  it('keeps the journal-owned browser and media sender available for bounded exec probes', async () => {
    const fixturePlan = plan();
    const commands = new RecordingCommands();
    const docker = new DockerCliFixture(fixturePlan, commands);
    const companions = fixturePlan.resources.filter(
      (resource) => resource.kind === 'container' && ['browser', 'media-sender'].includes(resource.role),
    );

    for (const companion of companions) {
      if (companion.kind === 'container') {
        await docker.create('container', companion.name, companion.labels, companion);
      }
    }

    const creates = commands.calls.filter(({ args }) => args[0] === 'create');
    assert.equal(creates.length, 2);
    for (const { args } of creates) {
      assert.deepEqual(args.slice(-4), [
        IMAGE_ID,
        'node',
        '-e',
        'setInterval(() => undefined, 2147483647)',
      ]);
    }
  });

  it('withholds arbitrary Docker output from bounded command failures', async () => {
    const sentinel = 'development-private-key-sentinel';
    const commands: BoundedCommand = {
      async run(): Promise<CommandResult> {
        const error = new Error('docker command failed');
        Object.assign(error, { stdout: sentinel, stderr: JSON.stringify({ privateKey: sentinel }) });
        throw error;
      },
    };
    const fixturePlan = plan();
    const docker = new DockerCliFixture(fixturePlan, commands);

    await assert.rejects(docker.startContainer('container-id'), (error: Error) => {
      assert.match(error.message, /Docker start failed/);
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      assert.doesNotMatch(error.message, /privateKey/);
      return true;
    });
  });

  it('refuses when runtime inspection does not show the requested caps', async () => {
    const fixturePlan = plan();
    const commands = new RecordingCommands();
    commands.wrongContainerLimits = true;
    const docker = new DockerCliFixture(fixturePlan, commands);
    const container = fixturePlan.resources.find((resource) => resource.kind === 'container');
    assert.ok(container);

    await assert.rejects(
      docker.create(container.kind, container.name, container.labels, container),
      /malformed container resource limits|did not apply the resource limits/,
    );
  });

  it('refuses when the created container uses another resolved image', async () => {
    const fixturePlan = plan();
    const commands = new RecordingCommands();
    commands.wrongContainerImage = true;
    const docker = new DockerCliFixture(fixturePlan, commands);
    const container = fixturePlan.resources.find((resource) => resource.kind === 'container');
    assert.ok(container);

    await assert.rejects(docker.create(container.kind, container.name, container.labels, container), /planned image/);
  });

  it('bounds a real argv-only command and reports counts without its output bytes', async () => {
    const sentinel = 'development-private-key-sentinel';
    const command = new ExecFileCommand();

    await assert.rejects(
      command.run(process.execPath, [
        '-e',
        `process.stdout.write(${JSON.stringify(
          sentinel,
        )}); process.stderr.write(JSON.stringify({privateKey:${JSON.stringify(sentinel)}})); process.exit(9)`,
      ]),
      (error: Error) => {
        assert.match(error.message, /failed with exit 9 \(stdout [1-9][0-9]* bytes, stderr [1-9][0-9]* bytes\)/);
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        assert.doesNotMatch(error.message, /privateKey/);
        return true;
      },
    );
  });
});
