import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyWeeb3Runtime, WEEB3_RUNTIME_ENTRIES, weeb3PackageDir } from '../scripts/copy-weeb3-runtime.mjs';

const CLIENT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The two files weeb-3's glue imports out of `snippets/`, named here rather than discovered, because
 * a copy that walked the directory and found it empty would pass a discovery-based check.
 */
const SNIPPET_FILES = [
  join('snippets', 'web3-0742d85b024bb6f5', 'inline0.js'),
  join('snippets', 'weeb_3-03f860286800ffdb', 'static', 'hls_loader.js'),
];

/**
 * What the runtime reaches for, in the order it reaches: the worker script, the glue it imports, the
 * wasm the glue fetches beside itself, the snippets the glue imports by relative path, and the
 * ServiceWorker the glue registers at boot.
 */
const SERVED_FILES = ['worker.js', 'weeb_3.js', 'weeb_3_bg.wasm', ...SNIPPET_FILES, 'service.js'];

describe('copying weeb-3 runtime into the tree the client serves', () => {
  let servedDir: string;

  beforeEach(() => {
    servedDir = join(mkdtempSync(join(tmpdir(), 'weeb3-runtime-')), 'weeb-3');
  });

  afterEach(() => {
    rmSync(dirname(servedDir), { recursive: true, force: true });
  });

  it('resolves the installed package, so the served bytes are the ones the bundle was built from', () => {
    expect(existsSync(join(weeb3PackageDir(), 'worker.js'))).toBe(true);
  });

  it('copies every file the shared worker loads', () => {
    copyWeeb3Runtime(weeb3PackageDir(), servedDir);

    const missing = SERVED_FILES.filter((file) => !existsSync(join(servedDir, file)));

    expect(missing).toEqual([]);
  });

  it('copies them byte for byte, so the glue and its wasm still agree', () => {
    const packageDir = weeb3PackageDir();

    copyWeeb3Runtime(packageDir, servedDir);

    const differing = SERVED_FILES.filter(
      (file) => !readFileSync(join(packageDir, file)).equals(readFileSync(join(servedDir, file))),
    );

    expect(differing).toEqual([]);
  });

  // The build runs this on every `vite build`, so a second run has to leave the same tree as the first.
  it('serves the same tree when it runs again', () => {
    const packageDir = weeb3PackageDir();

    copyWeeb3Runtime(packageDir, servedDir);
    copyWeeb3Runtime(packageDir, servedDir);

    const missing = SERVED_FILES.filter((file) => !existsSync(join(servedDir, file)));

    expect(missing).toEqual([]);
    expect(readFileSync(join(servedDir, 'weeb_3.js')).equals(readFileSync(join(packageDir, 'weeb_3.js')))).toBe(true);
  });

  /**
   * The served names carry no content hash, so a file the package stopped shipping would otherwise be
   * served for ever beside the ones that replaced it, with nothing to tell a reader the two came from
   * different versions.
   */
  it('drops a file the package no longer ships', () => {
    copyWeeb3Runtime(weeb3PackageDir(), servedDir);
    writeFileSync(join(servedDir, 'weeb_3_old.js'), 'export const gone = true;\n');

    copyWeeb3Runtime(weeb3PackageDir(), servedDir);

    expect(existsSync(join(servedDir, 'weeb_3_old.js'))).toBe(false);
  });

  /**
   * A rename upstream must stop the build rather than produce a site that answers 404 for one import
   * of a chain nothing checks until a viewer opens the tab.
   */
  it('refuses a package missing a file the worker needs, naming it', () => {
    const partial = mkdtempSync(join(tmpdir(), 'weeb3-partial-'));
    for (const entry of WEEB3_RUNTIME_ENTRIES.filter((name) => name !== 'worker.js')) {
      mkdirSync(join(partial, entry), { recursive: true });
    }

    expect(() => copyWeeb3Runtime(partial, servedDir)).toThrow(/worker\.js/);

    rmSync(partial, { recursive: true, force: true });
  });
});

/**
 * The copy is the only thing that puts these files in the served tree, and nothing else in the build
 * would notice its absence: `vite build` succeeds, every other test passes, and the deployed site
 * answers `/weeb-3/worker.js` with whatever the SPA fallback hands out. So the wiring is asserted
 * rather than assumed, in the one file that records what the script is for.
 */
describe('wiring the copy into the client build', () => {
  const scripts = JSON.parse(readFileSync(join(CLIENT_ROOT, 'package.json'), 'utf8')).scripts;

  it('runs before vite build, which is what puts the runtime inside dist', () => {
    expect(scripts.prebuild).toMatch(/copy-weeb3-runtime\.mjs/);
  });

  it('runs before the dev server too, which serves the same public directory', () => {
    expect(scripts.predev).toMatch(/copy-weeb3-runtime\.mjs/);
  });
});
