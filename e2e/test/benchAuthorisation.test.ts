import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireBenchAuthorised } from '../src/bench/authorisation.js';
import { type E2EConfig, loadConfig } from '../src/config.js';
import type { Host, Stamp } from '../src/harness/host.js';
import type { PublisherRoute } from '../src/harness/publishers.js';

/**
 * The gate that stops `pnpm bench:latency` and `pnpm bench:longrun` publishing a broadcast nobody
 * authorised, on a stage that cannot pay for it or cannot stamp it.
 *
 * Both scripts publish through the deployment's own Bee nodes and spend real postage and bandwidth,
 * and until 2026-09-16 neither read the owner's ledger, either chequebook or any publisher's postage
 * TTL. `deploy/scripts/bench-on-host.sh` prepends the preflight suites to a bench launched through
 * it, which is an instruction rather than a control: the README documented a bare `pnpm bench:latency`
 * and that path was ungated.
 *
 * The rules themselves are covered next door, in `spendCeiling.test.ts` and `stageStamps.test.ts`,
 * because the gate calls those helpers rather than restating them. What is left here, and it is the
 * part a bench can get wrong on its own, is which questions get asked, in which order, and whether a
 * no is a refusal: a missing ledger has to stop the run before anything reaches the deployment, and
 * every other no has to throw rather than be returned, since only a throw reaches `main().catch` and
 * becomes a non-zero exit.
 */

const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const PLUR_PER_BZZ = 10n ** 16n;

/** BZZ written in thousandths, so every fixture below is an exact integer rather than a float. */
function bzzMilli(thousandths: bigint): bigint {
  return thousandths * (PLUR_PER_BZZ / 1000n);
}

/** Two publisher nodes on the deployment host's loopback, which is what a split ladder reports. */
const LOW_RUNG_PORT = 10075;
const HIGH_RUNG_PORT = 11075;

const ROUTES: PublisherRoute[] = [
  { rung: '360p', url: `http://127.0.0.1:${LOW_RUNG_PORT}`, batch: '11111111…' },
  { rung: '1080p', url: `http://127.0.0.1:${HIGH_RUNG_PORT}`, batch: '22222222…' },
];

const BATCH_BY_PORT: Record<number, string> = {
  [LOW_RUNG_PORT]: '11111111aaaaaaaa',
  [HIGH_RUNG_PORT]: '22222222bbbbbbbb',
};

/** Comfortably past the 0.5 BZZ bandwidth floor and past every ceiling these cases authorise. */
const FUNDED_PLUR = bzzMilli(5_000n);
/** Comfortably past both the shared 600s floor and the half-hour a long run asks for. */
const HEALTHY_TTL_S = 86_400;

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-bench-auth-'));
  dirs.push(dir);
  return dir;
}

/**
 * A config pointed at an empty root, so the ports below are the harness defaults rather than whatever
 * the machine running this happens to have deployed.
 */
const cfg: E2EConfig = loadConfig({ env: {}, rootDir: tempDir() });
const GATEWAY_PORT = cfg.ports.beeGatewayApi;

/** Every node the gate reads a chequebook on: both publishers and the gateway, which also spends. */
const SPENDING_PORTS = [LOW_RUNG_PORT, HIGH_RUNG_PORT, GATEWAY_PORT];

function stamp(batchID: string, batchTTL: number): Stamp {
  return {
    batchID,
    utilization: 1,
    usable: true,
    depth: 22,
    amount: '100000000',
    bucketDepth: 16,
    immutableFlag: true,
    exists: true,
    batchTTL,
  };
}

interface Stage {
  /** `availableBalance` in PLUR, by port. Anything unnamed holds {@link FUNDED_PLUR}. */
  readonly balances?: Readonly<Record<number, bigint>>;
  /** Seconds of TTL left on that node's configured batch. Anything unnamed holds a day. */
  readonly ttlS?: Readonly<Record<number, number>>;
}

/** A deployment that answers the three reads the gate makes, and remembers what it was asked. */
function stageHost({ balances = {}, ttlS = {} }: Stage = {}): { host: Host; asked: string[] } {
  const asked: string[] = [];
  const host = {
    localJson: async (port: number, path: string): Promise<unknown> => {
      asked.push(`${port}${path}`);
      if (port === cfg.ports.uploaderApi && path === '/health') {
        return { status: 'ok', reasons: [], activeStreams: 0, engines: ['srs'], publishers: ROUTES };
      }
      if (path === '/chequebook/balance') {
        const available = String(balances[port] ?? FUNDED_PLUR);
        return { availableBalance: available, totalBalance: available };
      }
      if (path === '/stamps') {
        return { stamps: [stamp(BATCH_BY_PORT[port], ttlS[port] ?? HEALTHY_TTL_S)] };
      }
      throw new Error(`the gate asked for ${path} on ${port}, which this stage does not answer`);
    },
  } as unknown as Host;

  return { host, asked };
}

/** The authorisation as the owner writes it, with a baseline for every node that can spend. */
function ledger({ ceilingPlur = bzzMilli(2_400n), starts = {} as Record<number, bigint> } = {}): string {
  const path = join(tempDir(), '.spend-ledger.env');
  writeFileSync(
    path,
    [
      '# a bench sitting, authorised by the owner',
      'authorised_at=2026-09-16T09:00:00Z',
      `ceiling_plur=${ceilingPlur}`,
      ...SPENDING_PORTS.map((port) => `node_${port}_start_plur=${starts[port] ?? FUNDED_PLUR}`),
      '',
    ].join('\n'),
  );
  return path;
}

/** A path where no ledger was ever written, which is the case the gate is for. */
function noLedger(): string {
  return join(tempDir(), '.spend-ledger.env');
}

describe('requireBenchAuthorised', () => {
  it('clears a stage that is authorised, funded and stamped, and says what is left to spend', async () => {
    const { host } = stageHost({ balances: { [LOW_RUNG_PORT]: bzzMilli(4_900n) } });

    const summary = await requireBenchAuthorised(host, cfg, { ledgerPath: ledger() });

    assert.match(summary, /^authorised 2026-09-16T09:00:00Z: 0\.100 BZZ spent of 2\.400 authorised/);
    assert.match(summary, /2 publisher node\(s\) funded, and stamped for longer than 600s\./);
  });

  /**
   * ⛔ The whole point of the ledger, and the reason a missing one is not "no limit recorded". Nothing
   * is authorised to spend until the owner has written what it may spend.
   *
   * The deployment is proved untouched rather than assumed, because the refusal says in as many words
   * that nothing on it was, and a gate that had already read three nodes would be printing a sentence
   * it had made false.
   */
  it('refuses a run with no ledger at all, before a single request reaches the deployment', async () => {
    const { host, asked } = stageHost();

    await assert.rejects(requireBenchAuthorised(host, cfg, { ledgerPath: noLedger() }), /No spend ledger at/);
    assert.deepEqual(asked, []);
  });

  it('refuses a run that would spend past the ceiling the owner authorised', async () => {
    const { host } = stageHost({ balances: { [LOW_RUNG_PORT]: bzzMilli(2_000n) } });

    await assert.rejects(
      requireBenchAuthorised(host, cfg, { ledgerPath: ledger() }),
      /would spend past what the owner authorised. 3\.000 BZZ spent of 2\.400 authorised/,
    );
  });

  /**
   * The postage read is deliberately last: it polls a node that cannot answer for a minute before it
   * gives up, and that minute is only worth spending once the money questions have said this run may
   * happen at all.
   */
  it('refuses a publisher that cannot pay for its bandwidth, without going on to read postage', async () => {
    const short = bzzMilli(400n);
    const { host, asked } = stageHost({ balances: { [HIGH_RUNG_PORT]: short } });

    await assert.rejects(
      requireBenchAuthorised(host, cfg, { ledgerPath: ledger({ starts: { [HIGH_RUNG_PORT]: short } }) }),
      /1 of 2 bee node\(s\) cannot pay for bandwidth/,
    );
    assert.deepEqual(
      asked.filter((call) => call.endsWith('/stamps')),
      [],
    );
  });

  it('refuses a publisher whose configured batch expires inside the run', async () => {
    const { host } = stageHost({ ttlS: { [HIGH_RUNG_PORT]: 300 } });

    await assert.rejects(
      requireBenchAuthorised(host, cfg, { ledgerPath: ledger() }),
      /1080p on :11075 configured batch 22222222 has 300s of TTL left/,
    );
  });

  /**
   * What `bench/longrun.ts` needs and a scenario does not. Ten minutes of TTL clears the floor every
   * suite uses and still expires twenty minutes into a half-hour broadcast, so a run that lasts longer
   * than the floor asks for its own length instead.
   */
  it('holds a batch to the run length when the caller asks for more than the shared floor', async () => {
    const halfHourStage = (): Host => stageHost({ ttlS: { [LOW_RUNG_PORT]: 900 } }).host;

    await assert.rejects(
      requireBenchAuthorised(halfHourStage(), cfg, { ledgerPath: ledger(), minStampTtlS: 1_800 }),
      /360p on :10075 configured batch 11111111 has 900s of TTL left/,
    );
    assert.match(await requireBenchAuthorised(halfHourStage(), cfg, { ledgerPath: ledger() }), /^authorised/);
  });
});

/**
 * ⛔ That the two benches actually call the gate, which is a grep because it cannot be anything else.
 *
 * `bench/latency.ts` and `bench/longrun.ts` run their own `main()` on import and reach ffmpeg, a
 * gateway and a deployment before the gate, so nothing here can drive one. The finding this closes was
 * exactly an uncalled gate: the helpers all existed, the preflight suites used them, and the two
 * scripts that spend called none of them. A gate nothing calls is what was already shipping.
 */
describe('the benches that publish call the gate', () => {
  for (const script of ['latency.ts', 'longrun.ts']) {
    it(`bench/${script} requires the run to be authorised before it publishes`, () => {
      const source = readFileSync(join(E2E_DIR, 'bench', script), 'utf8');
      const gate = source.indexOf('await requireBenchAuthorised(');
      const spend = source.indexOf('await measureLatency(');

      assert.ok(gate > 0, `bench/${script} does not call requireBenchAuthorised, so nothing gates its spend`);
      assert.ok(spend > gate, `bench/${script} publishes before it asks whether it may spend`);
    });
  }
});
