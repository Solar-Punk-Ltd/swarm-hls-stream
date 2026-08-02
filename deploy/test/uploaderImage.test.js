import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const dockerfile = readFileSync(resolve(ROOT, 'deploy/Dockerfile.uploader'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'packages/stream-uploader/package.json'), 'utf8'));

/**
 * The production uploader image against the manifest it installs from.
 *
 * Nothing else checks this pair. CI never builds an image, and the uploader's own tests run under
 * tsx against the workspace symlink rather than against the compiled copy that ships, so the first
 * report of a break here is a failed deploy.
 */
describe('uploader image install (ARCH-1)', () => {
  const workspaceDeps = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, range]) => String(range).startsWith('workspace:'))
    .map(([name]) => name);

  // npm parses the whole manifest before it applies `--omit=dev`, and rejects pnpm's `workspace:`
  // protocol outright with EUNSUPPORTEDPROTOCOL. Putting the dependency in the dev block does not
  // help. Measured against npm 10.9.8, which is what node:22-alpine ships.
  it('strips devDependencies before npm install, while a workspace dependency is declared', () => {
    if (workspaceDeps.length === 0) {
      return;
    }

    const install = dockerfile.match(/^RUN .*npm install.*$/m);
    assert.ok(install, 'the image no longer installs, so this test is checking the wrong thing');
    assert.match(
      install[0],
      /npm pkg delete devDependencies\s*&&/,
      `the manifest declares ${workspaceDeps.join(', ')} as workspace:*, which npm install rejects ` +
        'with EUNSUPPORTEDPROTOCOL before --omit=dev is ever applied',
    );
  });

  // A workspace dependency that reached `dependencies` could not be stripped by the line above, so
  // the image would break in a way the check above is not looking at.
  it('keeps every workspace dependency out of the production dependencies block', () => {
    const production = Object.entries(manifest.dependencies ?? {}).filter(([, range]) =>
      String(range).startsWith('workspace:'),
    );

    assert.deepEqual(
      production.map(([name]) => name),
      [],
      'a workspace dependency in `dependencies` survives `npm pkg delete devDependencies`',
    );
  });

  // The vendored copy is what makes the devDependency safe to strip. If the build stopped producing
  // it, the image would install cleanly and then fail at require time instead.
  it('vendors the shared package into dist as part of the build', () => {
    assert.match(
      manifest.scripts.build,
      /vendor-shared\.mjs/,
      'the build no longer vendors shared, so nothing supplies it at runtime',
    );
  });
});
