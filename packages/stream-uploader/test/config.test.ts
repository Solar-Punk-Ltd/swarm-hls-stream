/**
 * Which env vars a deployment actually has to supply.
 *
 * `config` is a module-level const evaluated at import, so each case imports a fresh copy with a
 * cache-busting query. `env.ts` runs `dotenv.config()` on the way in and dotenv never overrides a
 * key that is already present — setting a variable to `''` here therefore means "empty", not
 * "unset", and the developer's own root `.env` cannot leak into the assertions.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const BATCH = '1'.repeat(64);
const PUBLISHERS = `360p@http://localhost:1633<${BATCH}> 1080p@http://localhost:1663<${'4'.repeat(64)}>`;

const BASE = {
  BEE_URL: 'http://localhost:1633',
  STREAM_KEY: `0x${'1'.repeat(64)}`,
  STREAM_LIST_TOPIC: 'swarm-stream',
  ENGINE: '',
  ABR_ENABLED: 'true',
  BEE_PUBLISHERS: '',
  STAMP: '',
};

let instance = 0;

async function load(overrides: Record<string, string>) {
  const saved = process.env;
  process.env = { ...saved, ...BASE, ...overrides };
  try {
    instance += 1;
    const mod = await import(`../src/utils/config.js?case=${instance}`);
    return mod.config as { stamp: string; publishers: unknown[] };
  } finally {
    process.env = saved;
  }
}

describe('config — STAMP', () => {
  it('is not required when BEE_PUBLISHERS supplies a batch per rung', async () => {
    // The pool-backed deployment: no batch of its own, and none needed. This
    // used to throw "Missing required env var: STAMP" — on the one kind of
    // deployment that legitimately has no stamp.
    const config = await load({ BEE_PUBLISHERS: PUBLISHERS, STAMP: '' });
    assert.equal(config.stamp, '');
    assert.equal(config.publishers.length, 2);
  });

  it('is still required for a single-node deployment', async () => {
    // Nothing supplies a batch here, so an empty STAMP really is a broken
    // config and refusing at startup beats failing on the first upload.
    await assert.rejects(
      load({ BEE_PUBLISHERS: '', STAMP: '' }),
      /Missing required env var: STAMP/,
    );
  });

  it('still reads STAMP when a single-node deployment provides one', async () => {
    const config = await load({ BEE_PUBLISHERS: '', STAMP: BATCH });
    assert.equal(config.stamp, BATCH);
    assert.equal(config.publishers.length, 0);
  });
});
