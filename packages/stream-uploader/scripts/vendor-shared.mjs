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
 * Shared is therefore a devDependency of the uploader: `--omit=dev` skips it, which is correct,
 * because by then it is vendored rather than resolved.
 *
 * The alternative was bundling, which is rejected for one specific reason: `src/utils/env.ts`
 * resolves the repository root by walking four levels up from its own compiled location, so
 * collapsing `dist/utils/env.js` into `dist/index.js` moves the `.env` it reads without any error.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
writeFileSync(
  resolve(vendorDir, 'package.json'),
  `${JSON.stringify(
    {
      name: '@swarm-hls-stream/shared',
      version: '0.1.0',
      private: true,
      type: 'module',
      main: './index.js',
      types: './index.d.ts',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    },
    null,
    2,
  )}\n`,
);
