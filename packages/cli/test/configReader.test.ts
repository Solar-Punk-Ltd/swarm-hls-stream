import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { readDeployConfig, resolveBeeGatewayTarget, resolveBeeUploaderTarget } from '../src/lib/config-reader.js';

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
