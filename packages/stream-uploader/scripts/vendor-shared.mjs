/**
 * Compile `@swarm-hls-stream/shared` into the uploader's own `dist/node_modules`.
 *
 * The production image copies `packages/stream-uploader/dist/` and then runs `npm install
 * --omit=dev` against the uploader's package.json alone, so a workspace dependency has nowhere to
 * come from: npm does not understand `workspace:*` and the shared package is not published. Node's
 * module resolution walks up from the importing file, so a copy under `dist/node_modules` is found
 * from `dist/index.js` and from `dist/utils/env.js` alike, and it rides into the image inside the
 * `dist/` copy that is already there.
 *
 * Shared is therefore a devDependency of the uploader, because by then it is vendored rather than
 * resolved. **That is not enough on its own.** `--omit=dev` does not save the build: npm parses the
 * whole manifest before it applies the flag and rejects the `workspace:` protocol outright with
 * EUNSUPPORTEDPROTOCOL, dev block or not. `Dockerfile.uploader` deletes `devDependencies` before
 * installing for exactly that reason, and `deploy/test/uploaderImage.test.js` holds the two together.
 *
 * The alternative was bundling, which is rejected for one specific reason: `src/utils/env.ts`
 * resolves the repository root by walking four levels up from its own compiled location, so
 * collapsing `dist/utils/env.js` into `dist/index.js` moves the `.env` it reads without any error.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedRoot = resolve(packageRoot, '../shared');
const vendorDir = resolve(packageRoot, 'dist/node_modules/@swarm-hls-stream/shared');

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });

execFileSync(
  'npx',
  ['tsc', '-p', resolve(sharedRoot, 'tsconfig.json'), '--noEmit', 'false', '--outDir', vendorDir, '--declaration'],
  { cwd: sharedRoot, stdio: 'inherit' },
);

// Written rather than copied: the source package points `exports` at its `.ts` entry, which is what
// lets tsx, vitest and tsc consume it without a build step, and node cannot load that.
//
// **Derived from the source manifest rather than restated.** This used to hard-code a single `.`
// entry, so the day `@swarm-hls-stream/shared` gained a `./publishKey` subpath, every check in the
// repository stayed green and the deployed uploader crash-looped on
// `ERR_PACKAGE_PATH_NOT_EXPORTED` at its first import. Nothing in `pnpm verify` runs the vendored
// copy, because everything outside the image resolves the workspace source directly. Reading the
// real `exports` is what keeps the two from drifting again.
const sourceManifest = JSON.parse(readFileSync(resolve(sharedRoot, 'package.json'), 'utf8'));

/** `./src/publishKey.ts` as the compiler emits it beside `index.js`: `./publishKey.js`. */
function compiledPath(sourcePath, extension) {
  return sourcePath.replace(/^\.\/src\//, './').replace(/\.ts$/, extension);
}

const exports = Object.fromEntries(
  Object.entries(sourceManifest.exports).map(([subpath, entry]) => [
    subpath,
    { types: compiledPath(entry.types, '.d.ts'), default: compiledPath(entry.default, '.js') },
  ]),
);

writeFileSync(
  resolve(vendorDir, 'package.json'),
  `${JSON.stringify(
    {
      name: sourceManifest.name,
      version: sourceManifest.version,
      private: true,
      type: 'module',
      main: exports['.'].default,
      types: exports['.'].types,
      exports,
      // Carried across so the vendored copy states what it needs rather than relying on whatever the
      // image happens to have. It installs nothing by itself, since nothing runs `npm install` inside
      // `dist/node_modules`, so the load-bearing half of this is that the uploader's own manifest
      // declares the same packages. `uploaderImage.test.js` asserts that it does. Without both, an
      // import here resolves only by hoisting luck: `cafe-utility` reached the image because
      // `@ethersphere/bee-js` happens to depend on a compatible range of it.
      dependencies: sourceManifest.dependencies ?? {},
    },
    null,
    2,
  )}\n`,
);
