import {
  type ContainerPlan,
  FIXTURE_LABEL,
  type FixtureDocker,
  type FixturePlan,
  FixtureRefusal,
  MANAGED_LABEL,
  ResourceJournal,
  type ResourceJournalDocument,
  validateFixturePlan,
} from './fixture.js';
import type { BoundedProcess, ProcessInvocation, ProcessResult } from './provisioner.js';
import type { RuntimeContainerBinding } from './readinessSource.js';
import type { BootstrapOutput, ContinuationBootstrap, LoadAnvilStateStep, TopologyServiceRole } from './topology.js';

const RAW_ROLES = [
  'blockchain',
  'bee-queen',
  'bee-worker-1',
  'bee-worker-2',
  'bee-worker-3',
  'bee-worker-4',
] as const satisfies readonly TopologyServiceRole[];
const BEE_ROLES = RAW_ROLES.slice(1) as readonly BeeRole[];
const BEE_PORTS = new Map<BeeRole, readonly [number, number]>([
  ['bee-queen', [1_633, 1_634]],
  ['bee-worker-1', [1_635, 1_636]],
  ['bee-worker-2', [1_637, 1_638]],
  ['bee-worker-3', [1_639, 1_640]],
  ['bee-worker-4', [1_641, 1_642]],
]);
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const ETHEREUM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BATCH_ID = /^(?:0x)?[0-9a-fA-F]{64}$/;
const OVERLAY = /^(?:0x)?[0-9a-fA-F]{64}$/;
const MULTIADDRESS = /^\/ip4\/(?!127\.0\.0\.1)(?!0\.0\.0\.0)[0-9.]+\/tcp\/[0-9]+\/p2p\/[A-Za-z0-9_-]{1,200}$/;
const PROCESS_OUTPUT_BYTES = 256 * 1024;
const BEE_ATTEMPTS = 60;
const BEE_WAIT_MS = 2_000;
const STORAGE_MARGIN_SECONDS = 300;

type BeeRole = Exclude<(typeof RAW_ROLES)[number], 'blockchain'>;

interface ContractAddresses {
  bzzToken: string;
  postageStamp: string;
  postageStampStartBlock: number;
  priceOracle: string;
  stakeRegistry: string;
  redistribution: string;
  swapFactory: string;
  swapPriceOracle: string;
}

interface AnvilSnapshot {
  state: string;
  addresses: ContractAddresses;
}

interface PrivateChainProvisioningInput {
  plan: FixturePlan;
  bootstrap: ContinuationBootstrap;
  beePassword: string;
}

interface PrivateChainProvisioningDependencies {
  journal: ResourceJournal;
  docker: FixtureDocker;
  process: BoundedProcess;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface PrivateChainProvisioningResult {
  rawContainers: ReadonlyMap<TopologyServiceRole, RuntimeContainerBinding>;
  outputs: ReadonlyMap<BootstrapOutput, string>;
  journal: ResourceJournalDocument;
}

/**
 * Creates and boots the pinned BeeFactory chain, queen and four workers.
 * The caller owns browser and media-sender creation after guarded applications are ready.
 */
export async function provisionPrivateChain(
  input: PrivateChainProvisioningInput,
  dependencies: PrivateChainProvisioningDependencies,
): Promise<PrivateChainProvisioningResult> {
  validatePrivateChainInput(input, dependencies.journal);
  const wait =
    dependencies.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const plans = new Map(RAW_ROLES.map((role) => [role, containerPlan(input.plan, role)] as const));

  await refuseCollisions(input.plan, plans, dependencies.docker);
  const expectedImages = await resolveImageIdentities(plans, dependencies.process);
  const network = await createNetwork(input.plan, dependencies);
  const containers = new Map<TopologyServiceRole, RuntimeContainerBinding>();

  const blockchainPlan = plans.get('blockchain')!;
  const blockchain = await createContainer(
    blockchainPlan,
    expectedImages.get('blockchain')!,
    blockchainCreateArguments(input.plan, blockchainPlan),
    undefined,
    dependencies,
  );
  containers.set('blockchain', binding(blockchainPlan, blockchain.id));
  await runStage(dependencies.journal, 'start-blockchain', ['docker', 'start', blockchain.id], async () => {
    await dependencies.docker.startContainer(blockchain.id);
    await waitForAnvil(input.plan, dependencies.process, wait);
  });

  const loadState = input.bootstrap.bootstrap.find(
    (step): step is LoadAnvilStateStep => step.kind === 'load-anvil-state',
  )!;
  const snapshot = await runStage(
    dependencies.journal,
    'load-chain-state',
    ['docker', 'exec', blockchain.id, 'cat', loadState.sourcePath],
    async () => {
      const value = await readSnapshot(blockchain.id, loadState, dependencies.process);
      await loadAndVerifyChain(input.plan, value, loadState.maxStateBytes, dependencies.process, now);
      return value;
    },
  );

  const queenPlan = plans.get('bee-queen')!;
  const queen = await createContainer(
    queenPlan,
    expectedImages.get('bee-queen')!,
    beeCreateArguments(input.plan, queenPlan, snapshot.addresses),
    { BEE_PASSWORD: input.beePassword },
    dependencies,
  );
  containers.set('bee-queen', binding(queenPlan, queen.id));
  await runStage(dependencies.journal, 'start-queen', ['docker', 'start', queen.id], async () => {
    await dependencies.docker.startContainer(queen.id);
    await waitForBee('bee-queen', queen.id, BEE_PORTS.get('bee-queen')![0], false, dependencies.process, wait);
  });
  const queenBootnode = await runStage(
    dependencies.journal,
    'discover-queen',
    ['docker', 'exec', queen.id, 'curl', 'http://127.0.0.1:1633/addresses'],
    () => readBeeAddress(queen.id, 1_633, dependencies.process),
  );

  await runStage(dependencies.journal, 'start-workers', ['docker', 'start', '<four-workers>'], async () => {
    for (const role of BEE_ROLES.slice(1)) {
      const plan = plans.get(role)!;
      const created = await createContainer(
        plan,
        expectedImages.get(role)!,
        beeCreateArguments(input.plan, plan, snapshot.addresses, queenBootnode),
        { BEE_PASSWORD: input.beePassword },
        dependencies,
      );
      containers.set(role, binding(plan, created.id));
      await dependencies.docker.startContainer(created.id);
    }
    for (const role of BEE_ROLES.slice(1)) {
      const ports = BEE_PORTS.get(role)!;
      await waitForBee(role, containers.get(role)!.id, ports[0], false, dependencies.process, wait);
    }
    for (const role of BEE_ROLES) {
      const ports = BEE_PORTS.get(role)!;
      await waitForBee(role, containers.get(role)!.id, ports[0], true, dependencies.process, wait);
    }
  });

  await runStage(
    dependencies.journal,
    'form-peer-mesh',
    ['docker', 'exec', '<each-bee>', 'curl', '<peer-connect>'],
    async () => {
      await formPeerMesh(containers, dependencies.process);
    },
  );
  await runStage(dependencies.journal, 'advance-private-chain', ['curl', 'anvil_mine', '160'], async () => {
    await anvilRpc(input.plan, dependencies.process, 'anvil_mine', ['0xa0']);
    await waitForReserveSampler(containers.get('bee-queen')!.id, dependencies.process, wait);
  });
  const postageBatchId = await runStage(
    dependencies.journal,
    'provision-postage',
    ['docker', 'exec', queen.id, 'curl', 'POST', '/stamps/<amount>/<depth>'],
    () => provisionPostage(input.plan, queen.id, dependencies.process, wait),
  );

  const outputs = new Map<BootstrapOutput, string>([
    ['bee.queenBootnode', queenBootnode],
    ['chain.bzzTokenAddress', snapshot.addresses.bzzToken],
    ['chain.postageStampAddress', snapshot.addresses.postageStamp],
    ['chain.postageStampStartBlock', String(snapshot.addresses.postageStampStartBlock)],
    ['chain.redistributionAddress', snapshot.addresses.redistribution],
    ['chain.stakingAddress', snapshot.addresses.stakeRegistry],
    ['chain.swapFactoryAddress', snapshot.addresses.swapFactory],
    ['chain.swapPriceOracleAddress', snapshot.addresses.swapPriceOracle],
    ['storage.postageBatchId', postageBatchId],
  ]);
  if (network.name !== input.plan.network.name) {
    throw new FixtureRefusal('created fixture network identity changed unexpectedly');
  }
  return { rawContainers: containers, outputs, journal: dependencies.journal.read() };
}

function validatePrivateChainInput(input: PrivateChainProvisioningInput, journal: ResourceJournal): void {
  validateFixturePlan(input.plan);
  if (
    input.bootstrap.schemaVersion !== 1 ||
    input.bootstrap.fixtureId !== input.plan.fixtureId ||
    input.bootstrap.network !== input.plan.network.name
  ) {
    throw new FixtureRefusal('private-chain bootstrap does not belong to the fixture plan');
  }
  const kinds = input.bootstrap.bootstrap.slice(0, 8).map((step) => step.kind);
  if (
    kinds.join(',') !==
    'start-services,load-anvil-state,start-services,discover-bee-bootnode,start-services,form-bee-peer-mesh,advance-anvil-chain,provision-postage'
  ) {
    throw new FixtureRefusal('private-chain bootstrap sequence is unsupported');
  }
  if (input.plan.expectedChainId !== 1_337) {
    throw new FixtureRefusal('pinned BeeFactory fixture requires chain 1337');
  }
  if (input.beePassword.length < 1 || input.beePassword.length > 200 || /[\0\r\n]/.test(input.beePassword)) {
    throw new FixtureRefusal('synthetic Bee password is malformed');
  }
  if (journal.outputRoot !== input.plan.outputRoot || journal.read().fixtureId !== input.plan.fixtureId) {
    throw new FixtureRefusal('resource journal does not belong to the fixture plan');
  }
}

async function refuseCollisions(
  plan: FixturePlan,
  plans: ReadonlyMap<TopologyServiceRole, ContainerPlan>,
  docker: FixtureDocker,
): Promise<void> {
  const resources = [plan.network, ...plans.values()];
  for (const resource of resources) {
    if (await docker.findExact(resource.kind, resource.name)) {
      throw new FixtureRefusal(`resource ${resource.name} already exists`);
    }
  }
}

async function resolveImageIdentities(
  plans: ReadonlyMap<TopologyServiceRole, ContainerPlan>,
  process: BoundedProcess,
): Promise<Map<TopologyServiceRole, string>> {
  const resolved = new Map<TopologyServiceRole, string>();
  for (const [role, plan] of plans) {
    const result = await safeProcess(
      process,
      { file: 'docker', args: ['image', 'inspect', '--format', '{{.Id}}', plan.image], maxOutputBytes: 4_096 },
      'planned image identity could not be verified',
    );
    const imageId = result.stdout.trim();
    if (!IMAGE_ID.test(imageId)) {
      throw new FixtureRefusal('planned image identity is malformed');
    }
    resolved.set(role, imageId);
  }
  return resolved;
}

async function createNetwork(plan: FixturePlan, dependencies: PrivateChainProvisioningDependencies) {
  dependencies.journal.planResource(plan.network);
  try {
    const created = await dependencies.docker.create('network', plan.network.name, plan.network.labels, plan.network);
    if (
      created.kind !== 'network' ||
      created.name !== plan.network.name ||
      created.internal !== true ||
      !hasFixtureLabels(created.labels, plan.fixtureId)
    ) {
      throw new FixtureRefusal('Docker returned the wrong internal fixture network');
    }
    dependencies.journal.recordResource(created);
    return created;
  } catch {
    throw new FixtureRefusal(
      `creation outcome for ${plan.network.name} is unresolved and requires exact-name recovery`,
    );
  }
}

async function createContainer(
  plan: ContainerPlan,
  expectedImageId: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> | undefined,
  dependencies: PrivateChainProvisioningDependencies,
) {
  dependencies.journal.planResource(plan);
  let id: string;
  try {
    const result = await safeProcess(
      dependencies.process,
      { file: 'docker', args, environment, maxOutputBytes: 4_096 },
      `Docker create for ${plan.role} did not complete`,
    );
    id = result.stdout.trim();
    if (!CONTAINER_ID.test(id)) {
      throw new FixtureRefusal(`Docker returned an invalid identity for ${plan.role}`);
    }
  } catch {
    throw new FixtureRefusal(`creation outcome for ${plan.name} is unresolved and requires exact-name recovery`);
  }
  const created = await dependencies.docker.inspect('container', id);
  if (
    !created ||
    created.kind !== 'container' ||
    created.name !== plan.name ||
    created.imageId !== expectedImageId ||
    !hasFixtureLabels(created.labels, plan.labels[FIXTURE_LABEL]) ||
    created.limits?.cpus !== plan.limits.cpus ||
    created.limits.memoryBytes !== plan.limits.memoryBytes ||
    created.limits.pidsLimit !== plan.limits.pidsLimit
  ) {
    throw new FixtureRefusal(`created ${plan.name} does not match its pinned image, labels, or limits`);
  }
  try {
    dependencies.journal.recordResource(created);
  } catch {
    throw new FixtureRefusal(`created ${plan.name} but its journal intent remains unresolved`);
  }
  return created;
}

function commonCreateArguments(plan: FixturePlan, container: ContainerPlan): string[] {
  return [
    'create',
    '--name',
    container.name,
    '--hostname',
    container.role,
    '--network',
    plan.network.name,
    '--network-alias',
    container.role,
    '--cpus',
    String(container.limits.cpus),
    '--memory',
    `${container.limits.memoryBytes}b`,
    '--pids-limit',
    String(container.limits.pidsLimit),
    '--label',
    `${FIXTURE_LABEL}=${plan.fixtureId}`,
    '--label',
    `${MANAGED_LABEL}=true`,
  ];
}

function blockchainCreateArguments(plan: FixturePlan, container: ContainerPlan): string[] {
  const binding = plan.publishedPorts.find((port) => port.role === 'blockchain');
  if (!binding || binding.host !== '127.0.0.1' || binding.containerPort !== 8_545) {
    throw new FixtureRefusal('private-chain RPC must use its planned loopback binding');
  }
  return [
    ...commonCreateArguments(plan, container),
    '--publish',
    `${binding.host}:${binding.hostPort}:${binding.containerPort}`,
    container.image,
    'anvil --host 0.0.0.0 --chain-id 1337 --accounts 20 --balance 10000 --block-time 1',
  ];
}

function beeCreateArguments(
  fixture: FixturePlan,
  container: ContainerPlan,
  contracts: ContractAddresses,
  bootnode?: string,
): string[] {
  const role = container.role as BeeRole;
  const [apiPort, p2pPort] = BEE_PORTS.get(role) ?? [];
  if (!apiPort || !p2pPort) {
    throw new FixtureRefusal(`unsupported Bee role ${container.role}`);
  }
  const blockchain = containerPlan(fixture, 'blockchain');
  return [
    ...commonCreateArguments(fixture, container),
    '--env',
    'BEE_PASSWORD',
    container.image,
    'start',
    '--full-node',
    `--api-addr=:${apiPort}`,
    `--p2p-addr=:${p2pPort}`,
    `--blockchain-rpc-endpoint=http://${blockchain.name}:8545`,
    '--block-time=1',
    '--verbosity=5',
    '--network-id=1337',
    '--mainnet=false',
    '--allow-private-cidrs',
    '--welcome-message=continuation-fixture',
    '--cors-allowed-origins=*',
    '--skip-postage-snapshot',
    '--warmup-time=1s',
    '--swap-enable',
    '--swap-initial-deposit=100000000000000000',
    `--postage-stamp-address=${contracts.postageStamp}`,
    `--price-oracle-address=${contracts.swapPriceOracle}`,
    `--staking-address=${contracts.stakeRegistry}`,
    `--redistribution-address=${contracts.redistribution}`,
    `--swap-factory-address=${contracts.swapFactory}`,
    `--postage-stamp-start-block=${contracts.postageStampStartBlock}`,
    `--bzz-token-address=${contracts.bzzToken}`,
    ...(bootnode === undefined ? [] : [`--bootnode=${bootnode}`]),
  ];
}

async function readSnapshot(
  containerId: string,
  step: LoadAnvilStateStep,
  process: BoundedProcess,
): Promise<AnvilSnapshot> {
  const result = await safeProcess(
    process,
    {
      file: 'docker',
      args: ['exec', containerId, 'cat', step.sourcePath],
      maxOutputBytes: step.maxStateBytes,
      timeoutMs: 30_000,
    },
    'pinned Anvil state could not be read',
  );
  if (Buffer.byteLength(result.stdout) > step.maxStateBytes) {
    throw new FixtureRefusal('pinned Anvil state exceeds its byte bound');
  }
  const value = parseObject(result.stdout, 'pinned Anvil state');
  const addresses = parseContractAddresses(value.addresses);
  if (typeof value.state !== 'string' || value.state.length < 1) {
    throw new FixtureRefusal('pinned Anvil state is malformed');
  }
  return { state: value.state, addresses };
}

async function loadAndVerifyChain(
  plan: FixturePlan,
  snapshot: AnvilSnapshot,
  maxStateBytes: number,
  process: BoundedProcess,
  now: () => number,
): Promise<void> {
  await anvilRpc(plan, process, 'anvil_loadState', [snapshot.state], 120_000, maxStateBytes);
  try {
    await anvilRpc(plan, process, 'evm_setTime', [Math.floor(now() / 1_000)]);
  } catch {
    // This method varies across pinned Anvil builds. The timestamp check below remains authoritative.
  }
  await anvilRpc(plan, process, 'anvil_mine', ['0x1']);
  const chainId = await anvilRpc(plan, process, 'eth_chainId', []);
  if (chainId !== `0x${plan.expectedChainId.toString(16)}`) {
    throw new FixtureRefusal('private chain identity does not match the fixture plan');
  }
  const block = await anvilRpc(plan, process, 'eth_getBlockByNumber', ['latest', false]);
  const timestamp = isObject(block) && typeof block.timestamp === 'string' ? Number.parseInt(block.timestamp, 16) : NaN;
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(now() / 1_000) - timestamp) > 60) {
    throw new FixtureRefusal('private chain clock was not re-anchored');
  }
}

async function waitForAnvil(
  plan: FixturePlan,
  process: BoundedProcess,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < BEE_ATTEMPTS; attempt += 1) {
    try {
      const chainId = await anvilRpc(plan, process, 'eth_chainId', []);
      if (typeof chainId === 'string' && /^0x[0-9a-f]+$/i.test(chainId)) {
        return;
      }
    } catch {
      // The bounded loop waits for the pinned Anvil RPC without reading container logs.
    }
    await wait(BEE_WAIT_MS);
  }
  throw new FixtureRefusal('private-chain RPC did not become ready within the bounded fixture wait');
}

async function anvilRpc(
  plan: FixturePlan,
  process: BoundedProcess,
  method: string,
  params: readonly unknown[],
  timeoutMs = 30_000,
  maxInputBytes = 64 * 1024,
): Promise<unknown> {
  const port = plan.publishedPorts.find((binding) => binding.role === 'blockchain')?.hostPort;
  if (!Number.isSafeInteger(port)) {
    throw new FixtureRefusal('private-chain loopback port is missing');
  }
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
  if (Buffer.byteLength(body) > maxInputBytes) {
    throw new FixtureRefusal(`private-chain RPC ${method} exceeded its input byte bound`);
  }
  const result = await safeProcess(
    process,
    {
      file: 'curl',
      args: [
        '--silent',
        '--show-error',
        '--fail-with-body',
        '--max-time',
        String(Math.ceil(timeoutMs / 1_000)),
        '--header',
        'Content-Type: application/json',
        '--data-binary',
        '@-',
        `http://127.0.0.1:${port}`,
      ],
      stdin: body,
      maxInputBytes,
      maxOutputBytes: PROCESS_OUTPUT_BYTES,
      timeoutMs,
    },
    `private-chain RPC ${method} failed`,
  );
  const envelope = parseObject(result.stdout, `private-chain RPC ${method}`);
  if (envelope.jsonrpc !== '2.0' || envelope.id !== 1 || 'error' in envelope || !('result' in envelope)) {
    throw new FixtureRefusal(`private-chain RPC ${method} returned a refusal`);
  }
  return envelope.result;
}

async function waitForBee(
  role: BeeRole,
  containerId: string,
  port: number,
  requireWarmupComplete: boolean,
  process: BoundedProcess,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < BEE_ATTEMPTS; attempt += 1) {
    try {
      const health = await beeJson(process, containerId, port, 'GET', '/health');
      const status = requireWarmupComplete ? await beeJson(process, containerId, port, 'GET', '/status') : undefined;
      if (health.status === 'ok' && (!requireWarmupComplete || status?.isWarmingUp === false)) {
        return;
      }
    } catch {
      // A bounded retry hides raw service output while the pinned process starts.
    }
    await wait(BEE_WAIT_MS);
  }
  throw new FixtureRefusal(`${role} did not become ready within the bounded fixture wait`);
}

async function readBeeAddress(containerId: string, port: number, process: BoundedProcess): Promise<string> {
  const value = await beeJson(process, containerId, port, 'GET', '/addresses');
  if (!Array.isArray(value.underlay)) {
    throw new FixtureRefusal('Bee underlay addresses are malformed');
  }
  const underlay = value.underlay.find(
    (entry): entry is string => typeof entry === 'string' && MULTIADDRESS.test(entry),
  );
  if (!underlay) {
    throw new FixtureRefusal('Bee did not publish a private-network underlay address');
  }
  return underlay;
}

async function formPeerMesh(
  containers: ReadonlyMap<TopologyServiceRole, RuntimeContainerBinding>,
  process: BoundedProcess,
): Promise<void> {
  const addresses = new Map<BeeRole, string>();
  for (const role of BEE_ROLES) {
    addresses.set(role, await readBeeAddress(containers.get(role)!.id, BEE_PORTS.get(role)![0], process));
  }
  for (const source of BEE_ROLES) {
    for (const target of BEE_ROLES) {
      if (source === target) {
        continue;
      }
      await connectBeePeer(
        process,
        containers.get(source)!.id,
        BEE_PORTS.get(source)![0],
        `/connect/${encodeURIComponent(addresses.get(target)!.slice(1))}`,
      );
    }
  }
}

async function connectBeePeer(process: BoundedProcess, containerId: string, port: number, path: string): Promise<void> {
  if (!CONTAINER_ID.test(containerId) || !path.startsWith('/connect/') || path.length > 1_024) {
    throw new FixtureRefusal('Bee peer request identity is malformed');
  }
  const result = await safeProcess(
    process,
    {
      file: 'docker',
      args: [
        'exec',
        containerId,
        'curl',
        '--silent',
        '--show-error',
        '--max-time',
        '20',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        '--request',
        'POST',
        `http://127.0.0.1:${port}${path}`,
      ],
      maxOutputBytes: 16,
      timeoutMs: 30_000,
    },
    'bounded Bee peer connection failed',
  );
  const status = Number(result.stdout.trim());
  if (!Number.isSafeInteger(status) || status < 200 || status >= 500) {
    throw new FixtureRefusal('Bee peer connection returned an invalid status');
  }
}

async function waitForReserveSampler(
  queenId: string,
  process: BoundedProcess,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < BEE_ATTEMPTS; attempt += 1) {
    try {
      const addresses = await beeJson(process, queenId, 1_633, 'GET', '/addresses');
      if (typeof addresses.overlay === 'string' && OVERLAY.test(addresses.overlay)) {
        await beeJson(process, queenId, 1_633, 'GET', `/rchash/0/${addresses.overlay}/${addresses.overlay}`);
        return;
      }
    } catch {
      // Reserve sampling becomes available after Bee processes the advanced chain.
    }
    await wait(3_000);
  }
  throw new FixtureRefusal('Bee reserve sampler did not become ready');
}

async function provisionPostage(
  plan: FixturePlan,
  queenId: string,
  process: BoundedProcess,
  wait: (milliseconds: number) => Promise<void>,
): Promise<string> {
  const chainState = await beeJson(process, queenId, 1_633, 'GET', '/chainstate');
  const currentPrice = numericInteger(chainState.currentPrice);
  if (currentPrice < 1) {
    throw new FixtureRefusal('Bee chain price is unavailable for postage sizing');
  }
  const depth = Math.max(17, Math.ceil(Math.log2(plan.minimumStorageBytes / 4_096)));
  const capacity = 4_096n * 2n ** BigInt(depth);
  if (capacity < BigInt(plan.minimumStorageBytes)) {
    throw new FixtureRefusal('postage capacity cannot satisfy the fixture minimum');
  }
  const amount = BigInt(currentPrice) * BigInt(plan.minimumStorageTtlSeconds + STORAGE_MARGIN_SECONDS);
  const created = await beeJson(process, queenId, 1_633, 'POST', `/stamps/${amount}/${depth}?immutable=true`);
  if (typeof created.batchID !== 'string' || !BATCH_ID.test(created.batchID)) {
    throw new FixtureRefusal('Bee returned a malformed postage batch identity');
  }
  const batchId = created.batchID.replace(/^0x/, '').toLowerCase();
  for (let attempt = 0; attempt < BEE_ATTEMPTS; attempt += 1) {
    try {
      const batch = await beeJson(process, queenId, 1_633, 'GET', `/stamps/${batchId}`);
      const ttl = numericInteger(batch.batchTTL);
      const actualDepth = numericInteger(batch.depth);
      if (batch.usable === true) {
        if (ttl < plan.minimumStorageTtlSeconds) {
          throw new FixtureRefusal('postage batch lifetime is below the fixture minimum');
        }
        if (4_096n * 2n ** BigInt(actualDepth) < BigInt(plan.minimumStorageBytes)) {
          throw new FixtureRefusal('postage batch capacity is below the fixture minimum');
        }
        return batchId;
      }
    } catch (error) {
      if (error instanceof FixtureRefusal && /below the fixture minimum/.test(error.message)) {
        throw error;
      }
    }
    await wait(BEE_WAIT_MS);
  }
  throw new FixtureRefusal('postage batch did not become usable within the bounded fixture wait');
}

async function beeJson(
  process: BoundedProcess,
  containerId: string,
  port: number,
  method: 'GET' | 'POST',
  path: string,
): Promise<Record<string, unknown>> {
  if (!CONTAINER_ID.test(containerId) || !path.startsWith('/') || path.length > 1_024) {
    throw new FixtureRefusal('Bee request identity is malformed');
  }
  const result = await safeProcess(
    process,
    {
      file: 'docker',
      args: [
        'exec',
        containerId,
        'curl',
        '--silent',
        '--show-error',
        '--fail-with-body',
        '--max-time',
        '20',
        '--request',
        method,
        '--header',
        'Content-Type: application/json',
        `http://127.0.0.1:${port}${path}`,
      ],
      maxOutputBytes: PROCESS_OUTPUT_BYTES,
      timeoutMs: 30_000,
    },
    'bounded Bee API request failed',
  );
  return parseObject(result.stdout, 'Bee API response');
}

async function runStage<T>(
  journal: ResourceJournal,
  name: string,
  command: readonly string[],
  action: () => Promise<T>,
): Promise<T> {
  try {
    const result = await action();
    journal.recordStage({ name, status: 'passed', command, stdout: '', stderr: '' });
    return result;
  } catch (error) {
    const message = error instanceof FixtureRefusal ? error.message : `${name} failed`;
    journal.recordStage({ name, status: 'failed', command, stdout: '', stderr: message });
    throw error instanceof FixtureRefusal ? error : new FixtureRefusal(message);
  }
}

async function safeProcess(
  process: BoundedProcess,
  invocation: ProcessInvocation,
  failure: string,
): Promise<ProcessResult> {
  try {
    return await process.run(invocation);
  } catch {
    throw new FixtureRefusal(failure);
  }
}

function parseContractAddresses(value: unknown): ContractAddresses {
  if (!isObject(value)) {
    throw new FixtureRefusal('pinned Anvil contract addresses are malformed');
  }
  const names = [
    'bzzToken',
    'postageStamp',
    'priceOracle',
    'stakeRegistry',
    'redistribution',
    'swapFactory',
    'swapPriceOracle',
  ] as const;
  for (const name of names) {
    if (typeof value[name] !== 'string' || !ETHEREUM_ADDRESS.test(value[name])) {
      throw new FixtureRefusal('pinned Anvil contract addresses are malformed');
    }
  }
  if (!Number.isSafeInteger(value.postageStampStartBlock) || Number(value.postageStampStartBlock) < 0) {
    throw new FixtureRefusal('pinned Anvil postage start block is malformed');
  }
  return value as unknown as ContractAddresses;
}

function parseObject(text: string, subject: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new FixtureRefusal(`${subject} is malformed`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numericInteger(value: unknown): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new FixtureRefusal('numeric Bee response field is malformed');
  }
  return parsed;
}

function containerPlan(plan: FixturePlan, role: TopologyServiceRole): ContainerPlan {
  const resource = plan.resources.find((entry) => entry.kind === 'container' && entry.role === role);
  if (!resource || resource.kind !== 'container') {
    throw new FixtureRefusal(`${role} container plan is missing`);
  }
  return resource;
}

function hasFixtureLabels(labels: Readonly<Record<string, string>>, fixtureId: string): boolean {
  return labels[FIXTURE_LABEL] === fixtureId && labels[MANAGED_LABEL] === 'true';
}

function binding(plan: ContainerPlan, id: string): RuntimeContainerBinding {
  return { id, name: plan.name, configuredImage: plan.image };
}
