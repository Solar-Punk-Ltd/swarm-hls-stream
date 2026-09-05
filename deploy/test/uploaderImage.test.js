import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALL_REMOTE, makeSandbox, removeSandboxes, runScriptOk } from './helpers/sandbox.js';

after(removeSandboxes);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const dockerfile = readFileSync(resolve(ROOT, 'deploy/Dockerfile.uploader'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'packages/stream-uploader/package.json'), 'utf8'));
const rootManifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

/** Where `deploy.sh` puts a deployment on a remote host, as `_lib.sh` hardcodes it. */
const REMOTE_BASE = 'swarm-hls-stream';

/**
 * Every path the image COPYs out of the build context, which is the monorepo root.
 *
 * A `--from=` copy is between stages and comes from an earlier layer rather than from the context,
 * so it is not something a deploy has to ship. The last word of a COPY is the destination.
 */
function contextPaths(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('COPY ') && !line.includes('--from='))
    .flatMap((line) => line.split(/\s+/).slice(1, -1));
}

/**
 * The production uploader image against the tree it installs from.
 *
 * Nothing else checks this pair. CI never builds an image, and the uploader's own tests run under
 * tsx against the workspace symlink rather than against the compiled copy that ships, so the first
 * report of a break here is a failed deploy.
 */
describe('uploader image install (ARCH-1)', () => {
  /**
   * ⛔ The whole point of the pnpm rewrite of 2026-09-05. The image used to install with
   * `npm install --omit=dev` from the uploader manifest alone, with no lockfile in the context, so
   * every transitive range was re-resolved at build time and the reviewed tree never reached
   * production. Measured that day: the root manifest's `pnpm.overrides` pinned axios to ^0.33.0
   * after a provenance check, `pnpm why axios` reported 0.33.0, and the built image ran 0.30.3.
   *
   * `--frozen-lockfile` is what refuses instead of re-resolving. `pnpm deploy` does NOT honour it
   * on pnpm 9.12.0, measured against a manifest whose zod range had been moved off the lockfile's:
   * the deploy re-resolved to the drifted version and exited 0, while `pnpm install` with the same
   * flag exited ERR_PNPM_OUTDATED_LOCKFILE. So the install is the gate and a deploy alone is not.
   */
  it('installs from the workspace lockfile instead of re-resolving every build', () => {
    const install = dockerfile.match(/^RUN .*pnpm install.*$/m);

    assert.ok(install, 'the image no longer installs with pnpm, so this test is checking the wrong thing');
    assert.match(
      install[0],
      /--frozen-lockfile/,
      'without --frozen-lockfile the install resolves its own versions and the audited tree never ships',
    );
  });

  it('copies the lockfile and the root manifest that carries the overrides', () => {
    const copied = contextPaths(dockerfile);

    for (const path of ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml']) {
      assert.ok(copied.includes(path), `${path} is not in the build context, so the install cannot read it`);
    }
  });

  /**
   * One pnpm, named in one place. Corepack activates whatever this line says, so a Dockerfile
   * pinning a different version from the root manifest installs with a resolver the workspace was
   * never checked against.
   */
  it('activates the pnpm version the root manifest names', () => {
    const pinned = rootManifest.packageManager;

    assert.match(pinned, /^pnpm@\d+\.\d+\.\d+$/, `the root manifest no longer pins pnpm: ${pinned}`);
    assert.ok(
      dockerfile.includes(`corepack prepare ${pinned} --activate`),
      `the image must activate ${pinned}, the version the root manifest names`,
    );
  });

  /**
   * ⛔ pnpm resolves a `workspace:` link against the packages it can see BEFORE a filter narrows
   * anything and before `--prod` drops a dev block, so a workspace dependency whose manifest is
   * missing from the context kills the build with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. Measured
   * 2026-09-05 by building without `packages/shared/package.json`.
   *
   * Derived from the manifest and from the packages on disk rather than hardcoded, so a second
   * workspace dependency has to be copied in too.
   */
  it('copies the manifest of every workspace package the uploader declares', () => {
    const workspaceDeps = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(([, range]) => String(range).startsWith('workspace:'))
      .map(([name]) => name);
    const copied = contextPaths(dockerfile);

    for (const name of workspaceDeps) {
      const manifestPath = workspaceManifestPath(name);
      assert.ok(
        copied.includes(manifestPath),
        `${name} is declared as a workspace dependency and ${manifestPath} is not copied, so the install refuses`,
      );
    }
  });

  /**
   * A workspace dependency in the production block would have to be installed rather than skipped,
   * and the image carries no sources for it: only the manifests are in the build context. The copy
   * that ships is the one `vendor-shared.mjs` compiled into `dist/node_modules`.
   */
  it('keeps every workspace dependency out of the production dependencies block', () => {
    const production = Object.entries(manifest.dependencies ?? {}).filter(([, range]) =>
      String(range).startsWith('workspace:'),
    );

    assert.deepEqual(
      production.map(([name]) => name),
      [],
      'a workspace dependency in `dependencies` is one the image would have to install and cannot',
    );
  });

  // The vendored copy is what makes the devDependency safe to skip. If the build stopped producing
  // it, the image would install cleanly and then fail at require time instead.
  it('vendors the shared package into dist as part of the build', () => {
    assert.match(
      manifest.scripts.build,
      /vendor-shared\.mjs/,
      'the build no longer vendors shared, so nothing supplies it at runtime',
    );
  });
});

/** The workspace manifest that declares `name`, as a path relative to the monorepo root. */
function workspaceManifestPath(name) {
  for (const entry of readdirSync(resolve(ROOT, 'packages'))) {
    const relative = `packages/${entry}/package.json`;
    const path = resolve(ROOT, relative);
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).name === name) {
      return relative;
    }
  }
  throw new Error(`no package under packages/ is named ${name}`);
}

/**
 * That a remote deploy leaves the far side holding everything the image COPYs.
 *
 * The uploader image is built ON the deployment host out of whatever `sync_to_remote` put there. A
 * path the Dockerfile needs and the sync does not carry fails as `failed to compute cache key:
 * "/pnpm-lock.yaml": not found`, on a machine nobody is watching, and it reads as a build error
 * rather than as a missing file. This is the failure the client block already carries a comment
 * about, and until 2026-09-05 the uploader block shipped only `dist/` and its own manifest.
 *
 * Read off the Dockerfile rather than from a list written here, so a COPY added there without a
 * matching rsync fails instead of shipping.
 *
 * ⛔ Observed as the files that landed on the sandbox's stand-in remote host, because the rsync stub
 * copies for real. A sandbox is an `mkdtemp` and not a checkout, so the workspace files are seeded
 * into it first: without them the sync has nothing to send and the assertions would be reporting on
 * the seeding rather than on the script.
 */
describe('what a remote deploy leaves in the uploader build context', () => {
  /**
   * What a monorepo root holds that a deploy sends for either image, seeded on top of the
   * Dockerfile's own list so the client half of these tests is asserting the script rather than the
   * seeding. `Dockerfile.client` reads all three of these too.
   */
  const WORKSPACE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/shared/package.json'];

  function seedContext(sandbox) {
    for (const path of new Set([...WORKSPACE_FILES, ...contextPaths(dockerfile)])) {
      const target = join(sandbox.root, path);
      mkdirSync(path.endsWith('/') ? target : dirname(target), { recursive: true });
      const contents = path.endsWith('.json') ? `{"seeded": "${path}"}\n` : `${path}\n`;
      writeFileSync(path.endsWith('/') ? join(target, 'seeded') : target, contents);
    }
  }

  async function deployRemotely(...services) {
    const sandbox = makeSandbox({ config: ALL_REMOTE, project: 'default' });
    seedContext(sandbox);
    await runScriptOk(sandbox, 'deploy.sh', services);
    return sandbox;
  }

  function assertContextArrived(sandbox) {
    for (const path of contextPaths(dockerfile)) {
      assert.ok(
        sandbox.remoteHas(join(REMOTE_BASE, path)),
        `Dockerfile.uploader copies ${path} and no rsync carries it to the deployment host`,
      );
    }
  }

  it('ships every path the uploader image copies', async () => {
    assertContextArrived(await deployRemotely('stream-uploader'));
  });

  /**
   * The root manifests are the client's too, so they are sent once for either service rather than
   * from inside both blocks. A hoist like that is exactly the kind that survives its own test by
   * being reachable from one branch only.
   */
  it('ships them when the client deploys alongside', async () => {
    assertContextArrived(await deployRemotely('stream-uploader', 'client'));
  });

  it('still ships the workspace files a client-only deploy needs', async () => {
    const sandbox = await deployRemotely('client');

    for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      assert.ok(
        sandbox.remoteHas(join(REMOTE_BASE, path)),
        `Dockerfile.client installs from ${path} and no rsync carries it to the deployment host`,
      );
    }
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
  /**
   * What the vendored copy needs at runtime, which is a different question from what it exports.
   *
   * `packages/shared` gained its first runtime dependencies in this branch, `@ethersphere/bee-js` and
   * `cafe-utility`, and its first module importing them, which `index.js` re-exports eagerly. The
   * image installs from the **uploader's** manifest: nothing ever runs an install inside
   * `dist/node_modules`, so a package shared imports but the uploader does not declare reaches the
   * image only if something else happens to put it where Node will look.
   *
   * `cafe-utility` was exactly that. Under the npm install this image used to run it resolved by
   * accident, because `@ethersphere/bee-js` declares a compatible range of it and npm hoists flat.
   * pnpm does not: the top level of the installed tree holds the uploader's own dependencies and
   * nothing else, so an undeclared package now fails outright rather than working until a bee-js
   * release moves off it.
   */
  it('declares in the uploader manifest every package the vendored copy imports', () => {
    for (const [name, range] of Object.entries(sourceManifest.dependencies ?? {})) {
      assert.equal(
        manifest.dependencies?.[name],
        range,
        `shared needs ${name}@${range} at runtime and the image installs only from the uploader's ` +
          'manifest, so it has to be declared there too, at the same version the workspace resolved',
      );
    }
  });

  it('carries the source package dependencies into the vendored manifest', () => {
    assert.deepEqual(
      readVendored().dependencies ?? {},
      sourceManifest.dependencies ?? {},
      'the vendored copy has to state what it needs, or nothing in the image records the requirement',
    );
  });

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
