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

type Config = (typeof import('../src/utils/config.js'))['config'];

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
  { name: 'MANIFEST_ACCESS_URL', field: 'manifestAccessUrl', sample: 'http://manifest.test', fallback: '', refused: [] },
  { name: 'API_PORT', field: 'apiPort', sample: '4444', fallback: 3000, refused: ['-1', '65536'] },
  { name: 'STATE_DIR', field: 'stateDir', sample: '/var/lib/uploader', fallback: './state', refused: [] },
  { name: 'MAX_QUEUE_SIZE', field: 'maxQueueSize', sample: '7', fallback: 100, refused: ['0'] },
  { name: 'RECOVERY_TIMEOUT', field: 'recoveryTimeout', sample: '1234', fallback: 60000, refused: ['0'] },
  { name: 'SEGMENT_STALL_MS', field: 'segmentStallMs', sample: '4321', fallback: 30000, refused: ['0'] },
  { name: 'ORPHAN_REAP_MS', field: 'orphanReapMs', sample: '9876', fallback: 60000, refused: ['0'] },
  { name: 'SEGMENT_DEDUP_WINDOW', field: 'segmentDedupWindow', sample: '55', fallback: 10000, refused: ['0'] },
  { name: 'ENGINE', field: 'engine', sample: 'ome', fallback: '', refused: [] },
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
    const module = (await import(`../src/utils/config.js?case=${++caseCount}`)) as typeof import('../src/utils/config.js');
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
      assert.equal(config[variable.field], expected(variable), `${variable.name} did not reach config.${variable.field}`);
    }
  });

  it('falls back to the shipped default when an optional variable is absent', async () => {
    const config = await loadConfig(requiredEnv());

    for (const variable of OPTIONAL_ENV) {
      assert.equal(
        config[variable.field],
        variable.fallback,
        `config.${variable.field} defaulted to something other than the documented ${JSON.stringify(variable.fallback)}`,
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
    for (const { name } of [...REQUIRED_ENV, ...OPTIONAL_ENV]) {
      assert.ok(declared.has(name), `config.ts reads ${name}, which deploy/docker-compose.yml never sets`);
    }
  });
});
