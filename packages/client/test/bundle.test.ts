import { parse } from 'acorn';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { copyWeeb3Runtime, WEEB3_RUNTIME_ENTRIES, weeb3PackageDir } from '../scripts/copy-weeb3-runtime.mjs';
import { FETCH_BACKEND_HANDLE } from '../src/components/SwarmHlsPlayer/fetchBackendTestHandle';
import { PLAYER_HANDLE } from '../src/components/SwarmHlsPlayer/playerTestHandle';
import { GATEWAY_HANDLE } from '../src/providers/gatewayTestHandle';
import viteConfig from '../vite.config.js';

const CLIENT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD_TIMEOUT_MS = 180_000;

/** Where `public/weeb-3/` lands in the built site, and the prefix the deployed nginx answers. */
const SERVED_RUNTIME_DIR = 'weeb-3';

/**
 * Pinned as a literal, the same way the puller pins its abort default: the value that ships is the
 * one nothing else in the suite would notice changing. Every assertion below is only as meaningful as
 * this list, so raising the floor has to be a commit that says so, which is what `vite.config.js` asks
 * for in its own comment.
 */
const DECLARED_TARGET = ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'];

/** The prelude of every `@media` rule, which is where a range comparison would appear. */
const MEDIA_PRELUDE = /@media([^{]*)\{/g;

/**
 * A wasm-bindgen internal that appears once in weeb-3's glue and nowhere else in this tree.
 *
 * An import-object key rather than an identifier, so minification cannot rename it out from under the
 * assertions below.
 */
const WASM_GLUE_MARKER = '__wbindgen_add_to_stack_pointer';

interface EmittedAssets {
  css: { name: string; source: string }[];
  js: { name: string; source: string }[];
}

function declaredEcmaVersion(target: string[]): number {
  const es = target.find((entry) => /^es\d{4}$/.test(entry));
  if (!es) {
    throw new Error(`build.target names no ECMAScript version, so nothing says what the JS may use: ${target}`);
  }
  return Number(es.slice(2));
}

/** Every file below `dir`, as paths relative to it, sorted so two trees can be compared directly. */
function filesUnder(dir: string): string[] {
  const walk = (current: string): string[] =>
    readdirSync(current).flatMap((entry) => {
      const path = join(current, entry);
      return statSync(path).isDirectory() ? walk(path) : [relative(dir, path)];
    });

  return walk(dir).sort();
}

function readEmittedAssets(outDir: string): EmittedAssets {
  const assetDir = join(outDir, 'assets');
  const read = (name: string) => ({ name, source: readFileSync(join(assetDir, name), 'utf8') });
  const names = readdirSync(assetDir);
  return {
    css: names.filter((name) => name.endsWith('.css')).map(read),
    js: names.filter((name) => name.endsWith('.js')).map(read),
  };
}

/**
 * What a build produces, not that one can be produced. CI already runs `pnpm build`, and that is how a
 * bundler major shipped a silent browser-target change past two review gates and a manual browser
 * check: vite 8 defaults `build.target` to `baseline-widely-available`, which emits `@media
 * (width>=500px)`, and an engine that does not understand range syntax drops the whole rule and
 * reports nothing. Both assertions here were shown to fail against exactly that build before being
 * committed. See TEST-22.
 *
 * The bundle is built here rather than read from `dist/`, because CI runs `pnpm test` before
 * `pnpm build` and a stale `dist/` would pass while saying nothing about the tree under test.
 *
 * Syntax only, which is the limit worth knowing: an API newer than the target, such as
 * `AbortSignal.timeout` against safari14, parses cleanly and is invisible here. See OBS-2.
 */
describe('the emitted bundle honours the declared browser target (TEST-22)', () => {
  // Undefined until the temp directory exists, because `force` does not cover an undefined path:
  // `rmSync` rejects the argument before it ever considers whether the target is there, so an
  // unguarded cleanup would throw ERR_INVALID_ARG_TYPE over whatever really failed.
  let outDir: string | undefined;
  let emitted: EmittedAssets;

  beforeAll(async () => {
    // What `prebuild` does before `vite build`, done here for the same reason the build is done here:
    // `pnpm test` runs before `pnpm build`, so `public/weeb-3/` is empty on a fresh checkout and every
    // assertion about the served runtime would report on whatever an earlier build happened to leave.
    copyWeeb3Runtime(weeb3PackageDir(), join(CLIENT_ROOT, 'public', SERVED_RUNTIME_DIR));

    outDir = mkdtempSync(join(tmpdir(), 'swarm-hls-bundle-'));
    await build({
      configFile: join(CLIENT_ROOT, 'vite.config.js'),
      root: CLIENT_ROOT,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    emitted = readEmittedAssets(outDir);
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    if (outDir) {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('declares the target it does, so the assertions below mean something', async () => {
    const resolved = await viteConfig({ command: 'build', mode: 'production' });

    expect(resolved.build.target).toEqual(DECLARED_TARGET);
  });

  it('emits css and js to assert against', () => {
    // Without this the two tests below pass on an empty list, which is the shape of every gate that
    // reports green while checking nothing.
    expect(emitted.css.length).toBeGreaterThan(0);
    expect(emitted.js.length).toBeGreaterThan(0);
  });

  it('emits no media-query range syntax, which safari14 drops whole rules over', () => {
    const withRangeSyntax = emitted.css.flatMap(({ name, source }) =>
      [...source.matchAll(MEDIA_PRELUDE)]
        .map(([, prelude]) => prelude)
        .filter((prelude) => /[<>]/.test(prelude))
        .map((prelude) => `${name}: @media${prelude}`),
    );

    expect(withRangeSyntax).toEqual([]);
  });

  /**
   * The instrumentation seam must leave no trace in a build that did not ask for it.
   *
   * This asserts the shipping direction, and in doing so it proves the mechanism: the handle only
   * disappears if Vite substituted `import.meta.env.VITE_EXPOSE_PLAYER` with a literal and the
   * minifier dropped the dead branch. **Written as a static member access for exactly that reason.**
   * Behind a named constant the substitution does not happen, the branch survives, and the handle
   * ships. That was measured, not assumed: it was present in a production bundle until the indirection
   * came out. The other direction is covered by `playerTestHandle.test.ts` and by building with the
   * flag set, which is not done here because it costs a second full build.
   */
  it('leaves no instrumentation handle in a build that did not ask for one', () => {
    const leaked = emitted.js.filter(({ source }) => source.includes(PLAYER_HANDLE)).map(({ name }) => name);

    expect(leaked).toEqual([]);
  });

  /**
   * The gateway switch is a second seam behind the same flag, and it needs its own case rather than
   * riding on the one above. They are published from different files and either could lose the static
   * `import.meta.env.VITE_EXPOSE_PLAYER` access independently, which is the exact mistake that shipped
   * the player handle once already.
   */
  it('leaves no gateway switch in a build that did not ask for one', () => {
    const leaked = emitted.js.filter(({ source }) => source.includes(GATEWAY_HANDLE)).map(({ name }) => name);

    expect(leaked).toEqual([]);
  });

  /**
   * The byte-source switch is a third seam behind the same flag, and it needs its own case rather
   * than riding on the two above. All three are published from different files and any one could lose
   * its static `import.meta.env.VITE_EXPOSE_PLAYER` access independently, which is the exact mistake
   * that shipped the player handle once already.
   */
  it('leaves no fetch backend switch in a build that did not ask for one', () => {
    const leaked = emitted.js.filter(({ source }) => source.includes(FETCH_BACKEND_HANDLE)).map(({ name }) => name);

    expect(leaked).toEqual([]);
  });

  /**
   * weeb-3 is close to 4 MB of WebAssembly plus its glue, and only a build that selects it should ever
   * pay for that. It is reached through an `import()` inside a lazily called method, so the bundler splits
   * it into a chunk of its own that the entry merely names. A static import would move all of it into
   * the entry, and nothing else here would notice: the build succeeds, the tests pass, and every
   * viewer on the shipping gateway path silently downloads it.
   *
   * Measured when the split landed: the entry went 1,000.54 kB to 1,003.28 kB, and the 4,532.92 kB of
   * weeb-3 landed in `weeb_3-<hash>.js` and `weeb_3_bg-<hash>.wasm` beside it.
   *
   * Re-read on the 0.0.341001 bump: weeb-3 is 3,908.08 kB across those same two files, 624.84 kB
   * smaller, and the entry chunk did not move at all. The saving is all wasm, so it lands only on the
   * viewers who select this backend, which is the whole point of the assertion below.
   */
  it('keeps weeb-3 out of the entry chunk, so a gateway viewer never downloads it', () => {
    const entry = emitted.js.filter(({ name }) => name.startsWith('index-'));
    expect(entry.length).toBeGreaterThan(0);

    const carryingWeeb3 = entry.filter(({ source }) => source.includes(WASM_GLUE_MARKER)).map(({ name }) => name);

    expect(carryingWeeb3).toEqual([]);
  });

  /**
   * The control, and it is not decoration. Without it the case above passes just as well on a build
   * where weeb-3 was dropped altogether, which is a broken backend rather than a cheap one.
   */
  it('still emits weeb-3 as a chunk of its own, so the case above is not passing on its absence', () => {
    const carryingWeeb3 = emitted.js.filter(({ source }) => source.includes(WASM_GLUE_MARKER)).map(({ name }) => name);

    expect(carryingWeeb3.length).toBe(1);
    expect(carryingWeeb3[0].startsWith('index-')).toBe(false);
  });

  it('emits js that parses at the ecmascript version the target names', () => {
    const ecmaVersion = declaredEcmaVersion(DECLARED_TARGET);

    const unparseable = emitted.js.flatMap(({ name, source }) => {
      try {
        parse(source, { ecmaVersion, sourceType: 'module' });
        return [];
      } catch (error) {
        return [`${name}: ${(error as Error).message}`];
      }
    });

    expect(unparseable).toEqual([]);
  });

  /**
   * ⛔⛔⛔ The in-tab node lives in a SharedWorker from weeb-3 0.0.341001 on, and a SharedWorker script
   * has to be same-origin, so the built site is the only thing that can serve the package's runtime.
   * A site that does not carry it answers `/weeb-3/worker.js` with the app's own index and every
   * viewer gets "SharedWorker request timed out" and no node. That is what the stage did on
   * 2026-09-02, and nothing in the build reported it: the bundle is identical either way, because the
   * runtime is served beside it rather than imported into it.
   *
   * The chunk assertions above hold the copy that gets bundled for the page. These hold the copy that
   * gets served to the worker, and the last case holds the two together.
   */
  describe('and carries the runtime the shared worker loads', () => {
    const packageDir = weeb3PackageDir();
    const servedDir = () => join(outDir as string, SERVED_RUNTIME_DIR);
    const served = (file: string) => readFileSync(join(servedDir(), file));

    it('serves the worker script the package builds its SharedWorker from', () => {
      expect(filesUnder(servedDir())).toContain('worker.js');
    });

    it('serves the glue that worker imports and the wasm the glue fetches beside it', () => {
      expect(filesUnder(servedDir())).toEqual(expect.arrayContaining(['weeb_3.js', 'weeb_3_bg.wasm']));
    });

    /**
     * Compared as trees rather than as a list restated here, so a snippet the glue imports by
     * relative path cannot be dropped in transit without this failing. `public/` is copied verbatim,
     * so the built tree and the package's own runtime entries have to hold the same files.
     */
    it('carries every file of the runtime through, snippets included', () => {
      const fromPackage = WEEB3_RUNTIME_ENTRIES.flatMap((entry) => {
        const source = join(packageDir, entry);
        return statSync(source).isDirectory() ? filesUnder(source).map((file) => join(entry, file)) : [entry];
      }).sort();

      expect(filesUnder(servedDir())).toEqual(fromPackage);
    });

    it('serves the glue byte for byte, because the wasm beside it was built against exactly this one', () => {
      expect(served('weeb_3.js').equals(readFileSync(join(packageDir, 'weeb_3.js')))).toBe(true);
      // The control: byte-identity to the package says nothing if the package itself stopped being
      // wasm-bindgen glue, and this marker is the same one the chunk assertions above look for.
      expect(served('weeb_3.js').toString('utf8')).toContain(WASM_GLUE_MARKER);
    });

    /**
     * The page's glue and the worker's glue are two copies of one release, reached by two different
     * routes: the bundler inlines one into a chunk and nginx serves the other as a file. A bump that
     * updated `node_modules` while something stale sat in `public/` would leave a worker talking to a
     * different build of the wasm than the page expects, and every other assertion here would pass.
     *
     * Compared through the wasm rather than the glue because the bundler minifies the glue and copies
     * the wasm verbatim, so the wasm is the one artefact that is identical on both routes.
     */
    it('serves the same build of the wasm that the page chunk was emitted with', () => {
      const bundled = readdirSync(join(outDir as string, 'assets')).filter((name) => name.endsWith('.wasm'));

      expect(bundled).toHaveLength(1);
      expect(readFileSync(join(outDir as string, 'assets', bundled[0])).equals(served('weeb_3_bg.wasm'))).toBe(true);
    });
  });
});
