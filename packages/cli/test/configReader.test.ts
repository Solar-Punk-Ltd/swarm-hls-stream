import { config as loadDotenv } from 'dotenv';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import {
  readDeployConfig,
  resolveBeeGatewayTarget,
  resolveBeeUploaderTarget,
  resolvePublisherTargets,
  SVC_BEE_UPLOADER,
} from '../src/lib/config-reader.js';

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function configFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'config-reader-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, contents);
  return path;
}

function missingConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'config-reader-'));
  dirs.push(dir);
  return join(dir, 'config.json');
}

describe('config.json parse failure (OPS-8)', () => {
  // The catch used to swallow everything and return `{ services: {} }`, and every resolver below
  // reads a missing service as localhost. So one trailing comma pointed `pnpm stamp:setup` at
  // localhost on a machine whose bee node is somewhere else, and bought the batch there.
  it('throws on a corrupt config rather than returning an empty one', () => {
    const path = configFile('{ "services": { "bee-uploader": "streamhost", } }');

    assert.throws(() => readDeployConfig(path), /is not valid JSON/);
  });

  it('names the file and the parse error, so the operator can find the typo', () => {
    const path = configFile('{ not json at all');

    assert.throws(
      () => readDeployConfig(path),
      (err: Error) => {
        assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(err.message, /setup\.sh/, 'the message must say how to get a working config back');
        return true;
      },
    );
  });

  // The other half, and the one an over-strict fix breaks. A fresh clone has no config.json at all,
  // which is the case setup.sh exists to fix, and localhost is the right guess until someone says
  // otherwise. Refusing here would make the CLI unusable before setup had ever been run.
  it('still defaults to an empty config when the file does not exist', () => {
    assert.deepEqual(readDeployConfig(missingConfigPath()), { services: {} });
  });

  it('parses a valid config', () => {
    const path = configFile(JSON.stringify({ services: { 'bee-uploader': 'streamhost' } }));

    assert.deepEqual(readDeployConfig(path), { services: { 'bee-uploader': 'streamhost' } });
  });

  // The unit test above proves the throw. This proves nothing swallows it on the way out, which is
  // the property that actually matters: the harm was never a bad parse, it was a bad parse that
  // resolved to a plausible-looking localhost target and got acted on.
  it('does not resolve a bee target from a corrupt config', () => {
    const path = configFile('{ "services": ');

    assert.throws(() => resolveBeeUploaderTarget(path), /is not valid JSON/);
    assert.throws(() => resolveBeeGatewayTarget(path), /is not valid JSON/);
  });

  it('resolves the uploader to localhost when there is no config at all', () => {
    const target = resolveBeeUploaderTarget(missingConfigPath());

    assert.equal(target.host, 'localhost');
  });
});

describe('BEE_PUBLISHERS set but unreadable (finding 22)', () => {
  const saved = process.env.BEE_PUBLISHERS;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.BEE_PUBLISHERS;
    } else {
      process.env.BEE_PUBLISHERS = saved;
    }
  });

  /** Load a real `.env` the way the CLI does, so dotenv's own handling of the value is in the loop. */
  function loadEnvFixture(contents: string): void {
    const dir = mkdtempSync(join(tmpdir(), 'publishers-env-'));
    dirs.push(dir);
    const path = join(dir, '.env');
    writeFileSync(path, contents);
    delete process.env.BEE_PUBLISHERS;
    loadDotenv({ path, override: true });
  }

  // The trigger publishers.test.ts cannot reach. It passes the string straight in, but a real `.env`
  // goes through dotenv first, where an unquoted `#` opens a comment. dotenv truncates the value at
  // the first one, so the parser never sees a batch and every entry after it vanishes. Read as unset,
  // that silently becomes the single node while the rungs it named go unchecked.
  it('refuses when an unquoted # form was truncated to nothing readable', () => {
    loadEnvFixture(`BEE_PUBLISHERS=360p@http://n1:1633#${'1'.repeat(64)} 720p@http://n2:1633#${'3'.repeat(64)}\n`);

    // Proven, not assumed: dotenv kept only up to the first #.
    assert.equal(process.env.BEE_PUBLISHERS, '360p@http://n1:1633');
    assert.throws(() => resolvePublisherTargets(), /set but no entry could be read/);
    assert.throws(() => resolvePublisherTargets(), /360p@http:\/\/n1:1633/);
  });

  // Unset is the single node, and that must keep working: a fresh deployment has no BEE_PUBLISHERS.
  it('still reads unset as the single node', () => {
    delete process.env.BEE_PUBLISHERS;

    const targets = resolvePublisherTargets();

    assert.equal(targets.length, 1);
    assert.equal(targets[0].name, SVC_BEE_UPLOADER);
  });

  // The bracketed form is not a comment, so a correctly written ladder survives a real `.env`.
  it('reads the bracketed form from a real .env as the full ladder', () => {
    loadEnvFixture(`BEE_PUBLISHERS=360p@http://n1:1633<${'1'.repeat(64)}> 720p@http://n2:1633<${'3'.repeat(64)}>\n`);

    assert.deepEqual(
      resolvePublisherTargets().map((node) => node.rung),
      ['360p', '720p'],
    );
  });
});
