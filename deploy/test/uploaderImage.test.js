import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * That every entry point the shared package advertises survives being vendored into the image.
 *
 * This is the check that was missing on 2026-08-03, and its absence cost a crash-looping deployment.
 * `@swarm-hls-stream/shared` gained a `./publishKey` subpath, `vendor-shared.mjs` wrote a manifest
 * with a hand-listed `.` entry and nothing else, and the uploader died at its first import with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Every check in the repository was green while it did, because
 * nothing outside the image resolves the vendored copy: `pnpm verify`, `tsx` and `tsc` all follow
 * the workspace symlink to the source package, whose `exports` was correct the whole time.
 *
 * So this reads both manifests and compares them, which is the one question the suite could not
 * otherwise ask. It deliberately does not re-derive the compiled paths with the same expression the
 * script uses, because a test that repeats the implementation agrees with it however wrong it is.
 */
describe('the vendored shared manifest keeps every advertised entry point', () => {
  const sourceManifest = JSON.parse(readFileSync(resolve(ROOT, 'packages/shared/package.json'), 'utf8'));
  const vendoredPath = resolve(
    ROOT,
    'packages/stream-uploader/dist/node_modules/@swarm-hls-stream/shared/package.json',
  );

  /**
   * Says which precondition is missing rather than surfacing a bare ENOENT.
   *
   * These two read a build artifact, and for a while CI ran `pnpm test` before `pnpm build`. The
   * result was two failures on every clean checkout and none on any machine that had built once,
   * reported as an unreadable path error. The ordering is fixed in both `verify` and the workflow,
   * so this should now be unreachable, and it is here to name the cause if it ever is not.
   */
  function readVendored() {
    if (!existsSync(vendoredPath)) {
      throw new Error(
        `${vendoredPath} does not exist, so the uploader has not been built in this tree. ` +
          'Run `pnpm build` first. These tests assert a property of the build output and cannot ' +
          'run without it.',
      );
    }
    return JSON.parse(readFileSync(vendoredPath, 'utf8'));
  }

  it('exports the same subpaths the source package does', () => {
    const vendored = readVendored();

    assert.deepEqual(
      Object.keys(vendored.exports).sort(),
      Object.keys(sourceManifest.exports).sort(),
      'a subpath the source advertises is missing from the image, so it throws ERR_PACKAGE_PATH_NOT_EXPORTED at runtime',
    );
  });

  /**
   * The other half of the same failure. A subpath present but pointing at a file the compiler never
   * emitted fails identically from the outside, and `.ts` surviving into the manifest is the exact
   * shape that would do it, since the source really does point its `exports` at TypeScript.
   */
  it('points every export at a file that exists next to it', () => {
    const vendored = readVendored();
    const vendorDir = dirname(vendoredPath);

    for (const [subpath, entry] of Object.entries(vendored.exports)) {
      // Spelled as what each condition must be rather than as what it must not be. The first version
      // of this banned a trailing `.ts` and failed on `./index.d.ts`, which is the correct value for
      // `types`: a declaration file ends in `.ts` too.
      assert.match(entry.default, /\.js$/, `${subpath} must load JavaScript, not ${entry.default}`);
      assert.match(entry.types, /\.d\.ts$/, `${subpath} must be typed by a declaration, not ${entry.types}`);

      for (const target of [entry.types, entry.default]) {
        assert.ok(existsSync(resolve(vendorDir, target)), `${subpath} points at ${target}, which was not emitted`);
      }
    }
  });
});
