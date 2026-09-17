import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// `dotenv` runs at module scope inside `utils/env.js` and writes into whatever object `process.env`
// points at when it runs, so it has to run against the real environment before any case below
// installs a fabricated one. Without this the first case inherits the developer's own root `.env`,
// where `ENGINE=srs` is enough to make a shipped default of `''` read back as `'srs'`.
import '../src/utils/env.js';

import { BeePublisherPool } from '../src/libs/BeePublisherPool.js';

type Config = typeof import('../src/utils/config.js')['config'];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface EnvVar {
  name: string;
  field: keyof Config;
  /** Distinct from the default on purpose, so a variable read under the wrong name cannot pass. */
  sample: string;
}

interface OptionalEnvVar extends EnvVar {
  fallback: string | number;
  /** Values the declared range must refuse at startup. Empty where the variable carries no range. */
  refused: string[];
}

const REQUIRED_ENV: EnvVar[] = [
  { name: 'BEE_URL', field: 'beeUrl', sample: 'http://bee.test:1633' },
  { name: 'STAMP', field: 'stamp', sample: 'stamp-batch-id' },
  { name: 'STREAM_KEY', field: 'streamKey', sample: 'stream-key' },
  { name: 'STREAM_LIST_TOPIC', field: 'streamListTopic', sample: 'stream-list-topic' },
  { name: 'API_AUTH_TOKEN', field: 'apiAuthToken', sample: 'api-auth-token' },
];

const OPTIONAL_ENV: OptionalEnvVar[] = [
  { name: 'API_PORT', field: 'apiPort', sample: '4444', fallback: 3000, refused: ['-1', '65536'] },
  { name: 'STATE_DIR', field: 'stateDir', sample: '/var/lib/uploader', fallback: './state', refused: [] },
  { name: 'MAX_QUEUE_SIZE', field: 'maxQueueSize', sample: '7', fallback: 100, refused: ['0'] },
  { name: 'RECOVERY_TIMEOUT', field: 'recoveryTimeout', sample: '1234', fallback: 60000, refused: ['0'] },
  { name: 'SEGMENT_STALL_MS', field: 'segmentStallMs', sample: '4321', fallback: 30000, refused: ['0'] },
  { name: 'ORPHAN_REAP_MS', field: 'orphanReapMs', sample: '9876', fallback: 60000, refused: ['0'] },
  { name: 'SEGMENT_DEDUP_WINDOW', field: 'segmentDedupWindow', sample: '55', fallback: 10000, refused: ['0'] },
  {
    name: 'BEE_REQUEST_TIMEOUT_MS',
    field: 'beeRequestTimeoutMs',
    sample: '2500',
    fallback: 4000,
    refused: ['0', '-1'],
  },
  { name: 'ENGINE', field: 'engine', sample: 'ome', fallback: '', refused: [] },
  {
    name: 'CHEQUEBOOK_MIN_BZZ',
    field: 'chequebookMinBzz',
    sample: '0.25',
    fallback: 0.5,
    refused: ['half', '-0.5', '10000'],
  },
  {
    name: 'STAMP_MIN_TTL_HOURS',
    field: 'stampMinTtlHours',
    sample: '3',
    fallback: 12,
    refused: ['hours', '-1', '8761'],
  },
  {
    name: 'STAMP_MAX_UTILIZATION',
    field: 'stampMaxUtilization',
    sample: '0.75',
    fallback: 0.9,
    refused: ['most', '-0.1', '1.1'],
  },
  {
    name: 'START_GATE_TIMEOUT_MS',
    field: 'startGateTimeoutMs',
    sample: '9000',
    fallback: 20000,
    refused: ['0', '-1', '20s', '600001'],
  },
];

const requiredEnv = (): Record<string, string> =>
  Object.fromEntries(REQUIRED_ENV.map((variable) => [variable.name, variable.sample]));

const expected = (variable: OptionalEnvVar): string | number =>
  typeof variable.fallback === 'number' ? Number(variable.sample) : variable.sample;

let caseCount = 0;

/** `config.ts` reads `process.env` once at module scope, so every case needs its own instance of it. */
async function loadConfig(env: Record<string, string>): Promise<Config> {
  const saved = process.env;
  process.env = { ...env } as NodeJS.ProcessEnv;
  try {
    const module = (await import(
      `../src/utils/config.js?case=${++caseCount}`
    )) as typeof import('../src/utils/config.js');
    return module.config;
  } finally {
    process.env = saved;
  }
}

/**
 * The names and defaults in `config.ts` are the contract an operator configures the service through,
 * and nothing else asserts them: every variable could be renamed and every default changed with the
 * suite staying green. A rename is invisible at runtime too, because an unread variable falls back
 * to a working default rather than failing, so the service starts and quietly ignores the setting.
 */
describe('the environment contract', () => {
  it('reads every value under the name the deployment sets', async () => {
    const config = await loadConfig({
      ...requiredEnv(),
      ...Object.fromEntries(OPTIONAL_ENV.map((variable) => [variable.name, variable.sample])),
    });

    for (const variable of REQUIRED_ENV) {
      assert.equal(config[variable.field], variable.sample, `${variable.name} did not reach config.${variable.field}`);
    }
    for (const variable of OPTIONAL_ENV) {
      assert.equal(
        config[variable.field],
        expected(variable),
        `${variable.name} did not reach config.${variable.field}`,
      );
    }
  });

  it('falls back to the shipped default when an optional variable is absent', async () => {
    const config = await loadConfig(requiredEnv());

    for (const variable of OPTIONAL_ENV) {
      assert.equal(
        config[variable.field],
        variable.fallback,
        `config.${variable.field} defaulted to something other than the documented ${JSON.stringify(
          variable.fallback,
        )}`,
      );
    }
  });

  for (const variable of REQUIRED_ENV) {
    it(`refuses to start when ${variable.name} is absent, and says which one`, async () => {
      const env = requiredEnv();
      delete env[variable.name];

      await assert.rejects(() => loadConfig(env), new RegExp(variable.name));
    });
  }

  for (const variable of OPTIONAL_ENV) {
    for (const value of variable.refused) {
      it(`refuses to start on ${variable.name}=${value}, which its range excludes`, async () => {
        await assert.rejects(
          () => loadConfig({ ...requiredEnv(), [variable.name]: value }),
          new RegExp(variable.name),
          `${value} was accepted, so the range on ${variable.name} is not being applied`,
        );
      });
    }
  }

  /**
   * The floor's name, default and refusals live in the OPTIONAL_ENV table above like every other
   * setting. What the table cannot express is here: values whose meaning is the point, not their
   * plumbing.
   */
  describe('the chequebook floor', () => {
    const floor = async (value?: string) =>
      (await loadConfig(value === undefined ? requiredEnv() : { ...requiredEnv(), CHEQUEBOOK_MIN_BZZ: value }))
        .chequebookMinBzz;

    it('reads a fraction of a BZZ, which is the whole reason it is not an integer setting', async () => {
      assert.equal(await floor('0.25'), 0.25);
      assert.equal(await floor('2'), 2);
    });

    // Zero is the deliberate opt-out and has to survive the falsy-string check that a bare `||`
    // fallback would fail, turning an explicit "no floor" into the shipped 0.5.
    it('accepts an explicit zero rather than falling back over it', async () => {
      assert.equal(await floor('0'), 0);
    });

    it('reads a blank setting as an absent one, not as a floor of zero', async () => {
      assert.equal(await floor(''), 0.5);
    });
  });

  /**
   * ⛔ **The default is derived from the windows it has to fit inside, and nothing else keeps the two
   * in step.** Every bee call the uploader makes is wrapped in `retryUntilDeadlineAsync`, so a
   * per-request timeout longer than half its window buys one attempt where the window was written to
   * pay for several. Lowering any of those windows without lowering this leaves the retry with
   * nowhere to retry, silently, and the symptom is a rung that gives up on the first slow answer.
   *
   * The windows are read out of the sources that declare them rather than restated here, because a
   * number copied into a test is the thing that goes stale.
   */
  describe('the bee request timeout', () => {
    const WINDOW_SOURCES = [
      'packages/stream-uploader/src/libs/StreamUploader.ts',
      'packages/stream-uploader/src/libs/StreamCatalog.ts',
      'packages/stream-uploader/src/libs/MasterFeedWriter.ts',
    ];

    /** `backoffDelayMs(0)` with the shipped base, before jitter takes it down to somewhere in [175, 350). */
    const FIRST_BACKOFF_MS = 350;

    const windows = WINDOW_SOURCES.flatMap((source) => {
      const text = readFileSync(resolve(REPO_ROOT, source), 'utf8');
      return [...text.matchAll(/^const ([A-Z0-9_]+WINDOW_MS) = ([\d_]+);$/gm)].map((match) => ({
        name: match[1],
        ms: Number(match[2].replace(/_/g, '')),
      }));
    });

    it('finds the retry windows it is derived from, so an empty match cannot pass silently', () => {
      assert.ok(
        windows.length >= 5,
        `only found ${windows.length} retry window(s), so the pattern has stopped matching: ${WINDOW_SOURCES.join(
          ', ',
        )}`,
      );
    });

    it('leaves room for two whole attempts inside the shortest of them', async () => {
      const shortest = windows.reduce((lowest, window) => (window.ms < lowest.ms ? window : lowest));
      const { beeRequestTimeoutMs } = await loadConfig(requiredEnv());

      assert.ok(
        2 * beeRequestTimeoutMs + FIRST_BACKOFF_MS <= shortest.ms,
        `a ${beeRequestTimeoutMs}ms request timeout leaves ${shortest.name} (${shortest.ms}ms) room for one ` +
          'attempt, not the two its backoff was written for',
      );
    });
  });

  /**
   * What the two startup gates do to a deployment that cannot answer them, which is the owner's
   * ruling of 2026-09-17 in both its halves: the uploader starts whatever the chequebook says, and a
   * postage batch that cannot carry a broadcast still stops it.
   */
  describe('the start gates', () => {
    const gatesFor = async (mode?: string) =>
      (await loadConfig(mode === undefined ? requiredEnv() : { ...requiredEnv(), UPLOADER_START_GATES: mode }))
        .startGates;

    it('warns on the chequebook and refuses on postage by default', async () => {
      assert.deepEqual(await gatesFor(), { chequebookRefuses: false, postageRefuses: true });
    });

    it('takes warn as both gates warning', async () => {
      assert.deepEqual(await gatesFor('warn'), { chequebookRefuses: false, postageRefuses: false });
    });

    it('takes refuse as both gates refusing, which is what every boot did before that date', async () => {
      assert.deepEqual(await gatesFor('refuse'), { chequebookRefuses: true, postageRefuses: true });
    });

    // An operator writing the mode into a `.env` by hand should not be refused over a capital.
    it('reads a mode written with padding or capitals as the mode it spells', async () => {
      assert.deepEqual(await gatesFor('  Refuse '), { chequebookRefuses: true, postageRefuses: true });
    });

    it('reads a blank setting as the default rather than refusing during import', async () => {
      assert.deepEqual(await gatesFor('   '), { chequebookRefuses: false, postageRefuses: true });
    });

    for (const written of ['on', 'strict', 'warn refuse', 'postage-warn']) {
      it(`refuses to start on UPLOADER_START_GATES=${written}, naming the variable`, async () => {
        await assert.rejects(
          () => loadConfig({ ...requiredEnv(), UPLOADER_START_GATES: written }),
          /UPLOADER_START_GATES/,
        );
      });
    }
  });

  /**
   * ⛔ The gates read a chequebook and a postage batch, and both answers come off the chain rather
   * than out of the node's memory, so they are slower than every other call the service makes. They
   * were bounded by BEE_REQUEST_TIMEOUT_MS until 2026-09-17, whose 4000ms is derived from the retry
   * windows of the upload loop and has nothing to do with how long a chain-backed read takes. On the
   * live host that timeout is what refused a start, so the two are separated here: this asserts that
   * moving one leaves the other where its own derivation put it.
   */
  describe('the start gate timeout', () => {
    it('is longer than the per-request deadline the upload loop runs on', async () => {
      const { startGateTimeoutMs, beeRequestTimeoutMs } = await loadConfig(requiredEnv());

      assert.ok(
        startGateTimeoutMs > beeRequestTimeoutMs,
        `a ${startGateTimeoutMs}ms gate timeout is no longer than the ${beeRequestTimeoutMs}ms upload deadline, ` +
          'so the gates are back on a window derived for something else',
      );
    });

    // The two-zero slip is what this range catches: 2000000 is 33 minutes for one read and over four
    // hours for a warn pass over four nodes, spent again on every attempt of a wait that retries for
    // ever. The one-zero slip is not caught, because 200000 sits under the ceiling and is a setting an
    // operator could mean, and it costs about 26 minutes a pass.
    it('refuses a timeout longer than any node read could need', async () => {
      await assert.rejects(
        () => loadConfig({ ...requiredEnv(), START_GATE_TIMEOUT_MS: '2000000' }),
        /START_GATE_TIMEOUT_MS/,
      );
      assert.equal(
        (await loadConfig({ ...requiredEnv(), START_GATE_TIMEOUT_MS: '600000' })).startGateTimeoutMs,
        600000,
      );
    });

    it('leaves the deadline of the upload loop alone when a deployment moves it', async () => {
      const config = await loadConfig({ ...requiredEnv(), START_GATE_TIMEOUT_MS: '45000' });

      assert.equal(config.startGateTimeoutMs, 45000);
      assert.equal(config.beeRequestTimeoutMs, 4000);
    });
  });

  /**
   * Names read by `config.ts` whose value is not a scalar, so the table above cannot carry them.
   * `UPLOADER_START_GATES` reaches config as the pair of gate policies it resolves to.
   */
  const DECLARED_ONLY = ['UPLOADER_START_GATES'];

  // Without this the pair can drift apart silently and in the direction that looks fine: the service
  // starts, every default applies, and the operator's setting is read from a name nothing sets.
  it('reads only names the deployment actually declares', () => {
    const compose = readFileSync(resolve(REPO_ROOT, 'deploy/docker-compose.yml'), 'utf8');
    // Scoped to the uploader's own service block: a name declared under a different service is
    // declared nowhere as far as this container is concerned.
    const service = /^ {2}stream-uploader:$([\s\S]*?)(?=^ {2}\S)/m.exec(compose)?.[1];
    assert.ok(service, 'no stream-uploader service found in docker-compose.yml, so this test checks nothing');

    const declared = new Set([...service.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]));

    assert.ok(declared.size > 0, 'no environment names parsed out of docker-compose.yml, so this test checks nothing');
    for (const name of [...REQUIRED_ENV, ...OPTIONAL_ENV].map((variable) => variable.name).concat(DECLARED_ONLY)) {
      assert.ok(declared.has(name), `config.ts reads ${name}, which deploy/docker-compose.yml never sets`);
    }
  });
});

/**
 * One batch per rung, which is what a deployment that splits its bees carries instead of a single
 * STAMP. Sixty-four hex characters because that is what a batch id is, and a shorter one is the
 * shape a truncated paste takes.
 */
const PER_RUNG = [
  '360p@http://localhost:1633',
  '480p@http://localhost:11001',
  '720p@http://localhost:11003',
  '1080p@http://localhost:11005',
]
  .map((node, index) => `${node}<${String(index + 1).repeat(64)}>`)
  .join(' ');

/** The required set without STAMP, which is the deployment a per-rung pool describes. */
function envWithoutStamp(): Record<string, string> {
  const { STAMP: _single, ...rest } = requiredEnv();
  return rest;
}

/**
 * Who has to carry a postage batch, and who does not.
 *
 * `buildPublishers` takes the per-rung pool the moment BEE_PUBLISHERS names one, and
 * `BeePublisherPool.single` is the only reader of `stamp` in the whole service. Requiring STAMP
 * regardless meant an ABR deployment could not start without a batch nothing would ever spend, and
 * the only way past it was to invent one. An invented batch id is worse than an absent one: it is
 * indistinguishable from a real one until something tries to pay with it.
 *
 * Found live on 2026-09-14, one layer under the deploy script's own guard, which had the same gap.
 */
describe('the postage a deployment has to name', () => {
  it('starts a per-rung deployment with no STAMP set at all', async () => {
    const config = await loadConfig({ ...envWithoutStamp(), BEE_PUBLISHERS: PER_RUNG });

    assert.equal(config.publishers.length, 4);
    assert.deepEqual(
      config.publishers.map((publisher) => publisher.rung),
      ['360p', '480p', '720p', '1080p'],
    );
    assert.equal(config.stamp, '');
  });

  it('starts a per-rung deployment whose STAMP is present and empty', async () => {
    const config = await loadConfig({ ...envWithoutStamp(), STAMP: '', BEE_PUBLISHERS: PER_RUNG });

    assert.equal(config.publishers.length, 4);
    assert.equal(config.stamp, '');
  });

  it('builds the pool the service publishes through from that configuration', async () => {
    const config = await loadConfig({ ...envWithoutStamp(), BEE_PUBLISHERS: PER_RUNG });
    const pool = BeePublisherPool.perRung(
      config.publishers,
      ['360p', '480p', '720p', '1080p'],
      config.beeRequestTimeoutMs,
    );

    assert.equal(pool.nodes().length, 4);
  });

  it('still refuses a single-node deployment with no STAMP', async () => {
    await assert.rejects(() => loadConfig(envWithoutStamp()), /STAMP/);
  });

  it('still refuses a single-node deployment whose STAMP is empty', async () => {
    await assert.rejects(() => loadConfig({ ...envWithoutStamp(), STAMP: '   ' }), /STAMP/);
  });

  it('still refuses a pool an operator mistyped, rather than falling back to one node', async () => {
    await assert.rejects(() => loadConfig({ ...envWithoutStamp(), BEE_PUBLISHERS: '360p@http://localhost:1633' }));
  });

  it('still refuses a pool that does not cover the ladder it is given', async () => {
    const config = await loadConfig({ ...envWithoutStamp(), BEE_PUBLISHERS: PER_RUNG });

    assert.throws(() =>
      BeePublisherPool.perRung(
        config.publishers,
        ['360p', '480p', '720p', '1080p', '1440p'],
        config.beeRequestTimeoutMs,
      ),
    );
  });
});
