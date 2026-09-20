import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createFixturePlan,
  FIXTURE_LABEL,
  type FixtureDocker,
  type FixturePlan,
  type FixtureResourcePlan,
  type InspectedResource,
  MANAGED_LABEL,
  ResourceJournal,
  type ResourceKind,
} from '../src/continuation/fixture.js';
import { provisionPrivateChain } from '../src/continuation/privateChain.js';
import type { BoundedProcess, ProcessInvocation, ProcessResult } from '../src/continuation/provisioner.js';
import { createContinuationBootstrap } from '../src/continuation/topology.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const BATCH_ID = 'bc'.repeat(32);
const ADDRESS = (digit: string) => `0x${digit.repeat(40)}`;
const CONTRACTS = {
  bzzToken: ADDRESS('1'),
  postageStamp: ADDRESS('2'),
  postageStampStartBlock: 27,
  priceOracle: ADDRESS('3'),
  stakeRegistry: ADDRESS('4'),
  redistribution: ADDRESS('5'),
  swapFactory: ADDRESS('6'),
  swapPriceOracle: ADDRESS('7'),
};

function fixturePlan(): FixturePlan {
  const parent = mkdtempSync(join(tmpdir(), 'continuation-private-chain-'));
  return createFixturePlan({
    fixtureId: FIXTURE_ID,
    outputRoot: join(parent, FIXTURE_ID),
    candidates: [
      { role: 'stack', root: '/candidates/stack', commit: 'a'.repeat(40) },
      { role: 'admin', root: '/candidates/admin', commit: 'b'.repeat(40) },
      { role: 'manager', root: '/candidates/manager', commit: 'c'.repeat(40) },
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

class FakeDocker implements FixtureDocker {
  readonly resources = new Map<string, InspectedResource>();
  readonly started: string[] = [];
  readonly created: string[] = [];
  containerImageId = IMAGE_ID;
  private nextId = 1;

  constructor(private readonly plan: FixturePlan) {}

  async findExact(_kind: ResourceKind, name: string): Promise<InspectedResource | null> {
    return [...this.resources.values()].find((resource) => resource.name === name) ?? null;
  }

  async create(
    kind: ResourceKind,
    name: string,
    labels: Readonly<Record<string, string>>,
    resource?: FixtureResourcePlan,
  ): Promise<InspectedResource> {
    assert.equal(kind, 'network');
    assert.equal(resource, this.plan.network);
    const created: InspectedResource = {
      kind,
      id: `network-${this.nextId++}`,
      name,
      labels: { ...labels },
      internal: true,
    };
    this.resources.set(created.id, created);
    this.created.push(name);
    return created;
  }

  addContainer(name: string, id: string): void {
    const planned = this.plan.resources.find((resource) => resource.kind === 'container' && resource.name === name);
    assert.ok(planned?.kind === 'container');
    this.resources.set(id, {
      kind: 'container',
      id,
      name,
      labels: { ...planned.labels },
      imageId: this.containerImageId,
      limits: { ...planned.limits },
    });
    this.created.push(name);
  }

  async startContainer(id: string): Promise<void> {
    this.started.push(id);
  }
  async inspect(kind: ResourceKind, id: string): Promise<InspectedResource | null> {
    const value = this.resources.get(id);
    return value?.kind === kind ? value : null;
  }
  async remove(): Promise<void> {}
}

class FakeProcess implements BoundedProcess {
  readonly calls: ProcessInvocation[] = [];
  loseCreateFor: string | null = null;
  wrongChain = false;
  unhealthy = false;
  lowTtl = false;
  lowCapacity = false;
  secretFailure = false;
  snapshotStateBytes = '0xsynthetic-state'.length;
  private nextId = 1;

  constructor(private readonly docker: FakeDocker) {}

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(structuredClone(invocation));
    if (this.secretFailure) {
      throw new Error('synthetic-private-key-sentinel');
    }
    if (invocation.file === 'docker' && invocation.args[0] === 'image') {
      return { stdout: `${IMAGE_ID}\n`, stderr: '' };
    }
    if (invocation.file === 'docker' && invocation.args[0] === 'create') {
      const name = invocation.args[invocation.args.indexOf('--name') + 1];
      assert.ok(name);
      const id = `container-${this.nextId++}`;
      this.docker.addContainer(name, id);
      if (name === this.loseCreateFor) {
        throw new Error('synthetic lost create reply');
      }
      return { stdout: `${id}\n`, stderr: '' };
    }
    if (
      invocation.file === 'docker' &&
      invocation.args[0] === 'exec' &&
      invocation.args.at(-1) === '/anvil-state.json'
    ) {
      return {
        stdout: JSON.stringify({ state: 's'.repeat(this.snapshotStateBytes), addresses: CONTRACTS }),
        stderr: '',
      };
    }
    if (invocation.file === 'curl') {
      const request = JSON.parse(invocation.stdin ?? '{}') as { method?: string };
      const result =
        request.method === 'eth_chainId'
          ? this.wrongChain
            ? '0x1'
            : '0x539'
          : request.method === 'eth_getBlockByNumber'
          ? { timestamp: `0x${Math.floor(Date.now() / 1_000).toString(16)}` }
          : true;
      return { stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, result }), stderr: '' };
    }
    if (invocation.file === 'docker' && invocation.args[0] === 'exec') {
      const containerId = invocation.args[1];
      const url = invocation.args.at(-1) ?? '';
      if (url.endsWith('/health')) {
        return { stdout: JSON.stringify({ status: this.unhealthy ? 'nok' : 'ok' }), stderr: '' };
      }
      if (url.endsWith('/status')) {
        return { stdout: JSON.stringify({ isWarmingUp: this.docker.started.length < 6 }), stderr: '' };
      }
      if (url.endsWith('/addresses')) {
        const index = Number(containerId?.split('-').at(-1) ?? 0);
        return {
          stdout: JSON.stringify({
            underlay: [`/ip4/172.19.0.${index + 10}/tcp/${1_633 + index * 2}/p2p/node-${index}`],
            overlay: `${index + 1}`.repeat(64).slice(0, 64),
          }),
          stderr: '',
        };
      }
      if (url.includes('/connect/')) {
        return { stdout: '200', stderr: '' };
      }
      if (url.includes('/rchash/')) {
        return { stdout: '{}', stderr: '' };
      }
      if (url.endsWith('/chainstate')) {
        return { stdout: JSON.stringify({ currentPrice: 24_000 }), stderr: '' };
      }
      if (url.includes('/stamps/') && invocation.args.includes('POST')) {
        return { stdout: JSON.stringify({ batchID: BATCH_ID }), stderr: '' };
      }
      if (url.endsWith(`/stamps/${BATCH_ID}`)) {
        return {
          stdout: JSON.stringify({
            usable: true,
            batchTTL: this.lowTtl ? 1 : 1_800,
            depth: this.lowCapacity ? 7 : 17,
          }),
          stderr: '',
        };
      }
    }
    throw new Error(`unexpected fake invocation ${invocation.file} ${invocation.args.join(' ')}`);
  }
}

function initializedSubject() {
  const plan = fixturePlan();
  const journal = new ResourceJournal(plan.outputRoot);
  journal.initialize(plan, []);
  const docker = new FakeDocker(plan);
  const process = new FakeProcess(docker);
  return { plan, journal, docker, process };
}

describe('the pinned private-chain and Bee fixture executor', () => {
  it('creates only the internal chain and five Bees with exact commands and returns genuine bootstrap outputs', async () => {
    const subject = initializedSubject();

    const result = await provisionPrivateChain(
      {
        plan: subject.plan,
        bootstrap: createContinuationBootstrap(subject.plan),
        beePassword: 'synthetic-bee-password',
      },
      { journal: subject.journal, docker: subject.docker, process: subject.process, wait: async () => {} },
    );

    assert.deepEqual(
      [...result.rawContainers.keys()],
      ['blockchain', 'bee-queen', 'bee-worker-1', 'bee-worker-2', 'bee-worker-3', 'bee-worker-4'],
    );
    assert.equal(result.outputs.get('bee.queenBootnode'), '/ip4/172.19.0.12/tcp/1637/p2p/node-2');
    assert.equal(result.outputs.get('storage.postageBatchId'), BATCH_ID);
    assert.equal(result.outputs.get('chain.bzzTokenAddress'), CONTRACTS.bzzToken);
    assert.equal(result.journal.resources.length, 7);
    assert.equal(result.journal.resources[0]?.internal, true);
    assert.ok(result.journal.resources.every((resource) => resource.labels[FIXTURE_LABEL] === FIXTURE_ID));
    assert.ok(result.journal.resources.every((resource) => resource.labels[MANAGED_LABEL] === 'true'));

    const createCalls = subject.process.calls.filter((call) => call.file === 'docker' && call.args[0] === 'create');
    assert.equal(createCalls.length, 6);
    const blockchain = createCalls[0];
    assert.ok(blockchain.args.includes(`127.0.0.1:18545:8545`));
    assert.equal(
      blockchain.args.at(-1),
      'anvil --host 0.0.0.0 --chain-id 1337 --accounts 20 --balance 10000 --block-time 1',
    );
    for (const call of createCalls.slice(1)) {
      assert.ok(call.args.includes(subject.plan.network.name));
      assert.ok(call.args.includes('--cpus'));
      assert.ok(call.args.includes('--memory'));
      assert.ok(call.args.includes('--pids-limit'));
      assert.ok(call.args.includes('BEE_PASSWORD'));
      assert.equal(call.environment?.BEE_PASSWORD, 'synthetic-bee-password');
    }
    const serialized = `${JSON.stringify(result.journal)}\n${JSON.stringify(
      subject.process.calls.map(({ args }) => args),
    )}`;
    assert.doesNotMatch(serialized, /synthetic-bee-password/);
  });

  it('refuses a collision before any mutation', async () => {
    const subject = initializedSubject();
    subject.docker.resources.set('foreign', {
      kind: 'container',
      id: 'foreign',
      name: `${FIXTURE_ID}-bee-queen`,
      labels: { foreign: 'true' },
    });

    await assert.rejects(
      provisionPrivateChain(
        { plan: subject.plan, bootstrap: createContinuationBootstrap(subject.plan), beePassword: 'synthetic' },
        { journal: subject.journal, docker: subject.docker, process: subject.process, wait: async () => {} },
      ),
      /already exists/,
    );
    assert.deepEqual(subject.process.calls, []);
    assert.deepEqual(subject.docker.created, []);
  });

  it('keeps an exact planned intent unresolved when a create reply is lost', async () => {
    const subject = initializedSubject();
    subject.process.loseCreateFor = `${FIXTURE_ID}-bee-queen`;

    await assert.rejects(
      provisionPrivateChain(
        { plan: subject.plan, bootstrap: createContinuationBootstrap(subject.plan), beePassword: 'synthetic' },
        { journal: subject.journal, docker: subject.docker, process: subject.process, wait: async () => {} },
      ),
      /creation outcome.*unresolved/i,
    );

    const intent = subject.journal.read().intents.find((entry) => entry.name === `${FIXTURE_ID}-bee-queen`);
    assert.equal(intent?.status, 'planned');
    assert.equal(
      subject.process.calls.some((call) => call.args.includes(`${FIXTURE_ID}-bee-worker-1`)),
      false,
    );
  });

  it('refuses the wrong private chain before starting any Bee', async () => {
    const subject = initializedSubject();
    subject.process.wrongChain = true;

    await assert.rejects(
      provisionPrivateChain(
        { plan: subject.plan, bootstrap: createContinuationBootstrap(subject.plan), beePassword: 'synthetic' },
        { journal: subject.journal, docker: subject.docker, process: subject.process, wait: async () => {} },
      ),
      /chain identity/i,
    );
    assert.equal(
      subject.process.calls.some((call) => call.args.includes(`${FIXTURE_ID}-bee-queen`)),
      false,
    );
  });

  it('refuses a created container whose image ID differs from the pinned image before start', async () => {
    const subject = initializedSubject();
    subject.docker.containerImageId = `sha256:${'f'.repeat(64)}`;

    await assert.rejects(
      provisionPrivateChain(
        { plan: subject.plan, bootstrap: createContinuationBootstrap(subject.plan), beePassword: 'synthetic' },
        { journal: subject.journal, docker: subject.docker, process: subject.process, wait: async () => {} },
      ),
      /pinned image/i,
    );
    assert.deepEqual(subject.docker.started, []);
    assert.equal(subject.journal.read().intents.find((entry) => entry.name.endsWith('-blockchain'))?.status, 'planned');
  });

  it('routes a multi-megabyte pinned state through explicit bounded output and input', async () => {
    const subject = initializedSubject();
    subject.process.snapshotStateBytes = 2 * 1024 * 1024;

    await provisionPrivateChain(
      { plan: subject.plan, bootstrap: createContinuationBootstrap(subject.plan), beePassword: 'synthetic' },
      { journal: subject.journal, docker: subject.docker, process: subject.process, wait: async () => {} },
    );

    const snapshotRead = subject.process.calls.find((call) => call.args.at(-1) === '/anvil-state.json');
    const stateLoad = subject.process.calls.find(
      (call) => call.file === 'curl' && call.stdin?.includes('anvil_loadState'),
    );
    assert.equal(snapshotRead?.maxOutputBytes, 16 * 1024 * 1024);
    assert.equal(stateLoad?.maxInputBytes, 16 * 1024 * 1024);
    assert.ok(Buffer.byteLength(stateLoad?.stdin ?? '') > 1024 * 1024);
  });

  it('refuses failed Bee readiness and storage below the configured lifetime', async () => {
    const unhealthy = initializedSubject();
    unhealthy.process.unhealthy = true;
    await assert.rejects(
      provisionPrivateChain(
        { plan: unhealthy.plan, bootstrap: createContinuationBootstrap(unhealthy.plan), beePassword: 'synthetic' },
        { journal: unhealthy.journal, docker: unhealthy.docker, process: unhealthy.process, wait: async () => {} },
      ),
      /bee-queen.*ready/i,
    );

    const lowTtl = initializedSubject();
    lowTtl.process.lowTtl = true;
    await assert.rejects(
      provisionPrivateChain(
        { plan: lowTtl.plan, bootstrap: createContinuationBootstrap(lowTtl.plan), beePassword: 'synthetic' },
        { journal: lowTtl.journal, docker: lowTtl.docker, process: lowTtl.process, wait: async () => {} },
      ),
      /postage.*lifetime/i,
    );

    const lowCapacity = initializedSubject();
    lowCapacity.process.lowCapacity = true;
    await assert.rejects(
      provisionPrivateChain(
        {
          plan: lowCapacity.plan,
          bootstrap: createContinuationBootstrap(lowCapacity.plan),
          beePassword: 'synthetic',
        },
        {
          journal: lowCapacity.journal,
          docker: lowCapacity.docker,
          process: lowCapacity.process,
          wait: async () => {},
        },
      ),
      /postage.*capacity/i,
    );
  });

  it('does not surface raw command diagnostics or persist private chain material', async () => {
    const subject = initializedSubject();
    subject.process.secretFailure = true;

    let message = '';
    await assert.rejects(
      provisionPrivateChain(
        { plan: subject.plan, bootstrap: createContinuationBootstrap(subject.plan), beePassword: 'synthetic' },
        { journal: subject.journal, docker: subject.docker, process: subject.process, wait: async () => {} },
      ),
      (error: unknown) => {
        message = String(error);
        return /planned image identity could not be verified/i.test(message);
      },
    );
    assert.doesNotMatch(message, /synthetic-private-key-sentinel/);
    assert.doesNotMatch(readFileSync(subject.journal.path, 'utf8'), /synthetic-private-key-sentinel|0xsynthetic-state/);
  });
});
