#!/usr/bin/env node
/**
 * Put weeb-3's SharedWorker runtime into the tree this client serves.
 *
 * ## Why the client has to host these bytes at all
 *
 * From 0.0.341001 `Weeb3No103` owns no node. It is a window-side facade and every call is correlated
 * over one SharedWorker, which the package constructs from `/weeb-3/worker.js` resolved against the
 * page. A SharedWorker script must be same-origin, so the package cannot serve its own runtime from a
 * CDN and there is no in-page mode left to fall back to: a page that does not serve these files gets
 * "SharedWorker request timed out" and no node.
 *
 * The chain is four links and they all resolve relative to each other, so they have to land in one
 * directory: `worker.js` imports `./weeb_3.js`, that glue fetches `weeb_3_bg.wasm` beside itself and
 * imports two files out of `snippets/`.
 *
 * ## What this writes
 *
 * `public/weeb-3/`, which vite copies into `dist/` verbatim. Generated, not committed: the directory
 * is rewritten from `node_modules` on every run, so the lockfile is the only thing that says which
 * version a deployment serves.
 *
 * Usage:
 *   node packages/client/scripts/copy-weeb3-runtime.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Everything the runtime reaches for at boot, and nothing else the package ships. `service.js` is a
 * ServiceWorker the glue registers under `/weeb-3/` as soon as the node starts, whether or not the
 * page ever uses the `/bzz/` routes it intercepts: left out, every page load logs a failed
 * registration at 404. Its scope is `/weeb-3/`, so it can never see this client's own requests. The
 * `.d.ts` files are for the bundler rather than for a browser.
 */
export const WEEB3_RUNTIME_ENTRIES = ['worker.js', 'weeb_3.js', 'weeb_3_bg.wasm', 'snippets', 'service.js'];

/** Where the package default `/weeb-3/worker.js` lands once vite has copied `public/` into `dist/`. */
export const WEEB3_SERVED_DIR = resolve(HERE, '..', 'public', 'weeb-3');

/**
 * The installed package directory, resolved through node rather than assembled from a path, because
 * pnpm links it out of a content-addressed store and the real location carries the version in it.
 */
export function weeb3PackageDir() {
  return dirname(createRequire(import.meta.url).resolve('@lat-murmeldjur/weeb_3'));
}

/**
 * @param {string} packageDir the installed `@lat-murmeldjur/weeb_3`
 * @param {string} servedDir the directory a browser will reach as `/weeb-3/`
 */
export function copyWeeb3Runtime(packageDir, servedDir) {
  const missing = WEEB3_RUNTIME_ENTRIES.filter((entry) => !existsSync(join(packageDir, entry)));
  if (missing.length > 0) {
    throw new Error(
      `@lat-murmeldjur/weeb_3 in ${packageDir} ships no ${missing.join(', ')}, ` +
        'so the shared worker would 404 on an import nothing checks until a viewer opens the tab',
    );
  }

  // Replaced rather than merged. The served names carry no content hash, so a file the package
  // stopped shipping would otherwise sit beside the ones that replaced it with nothing to tell a
  // reader they came from different versions.
  rmSync(servedDir, { recursive: true, force: true });
  mkdirSync(servedDir, { recursive: true });

  for (const entry of WEEB3_RUNTIME_ENTRIES) {
    cpSync(join(packageDir, entry), join(servedDir, entry), { recursive: true });
  }
}

const runFromCommandLine =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (runFromCommandLine) {
  const packageDir = weeb3PackageDir();
  copyWeeb3Runtime(packageDir, WEEB3_SERVED_DIR);

  const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  // The deploy log is the only place a reader can see which runtime a built image serves, because
  // the directory it went into is generated and never committed.
  console.log(`weeb-3 ${version} runtime copied to ${WEEB3_SERVED_DIR}`);
}
