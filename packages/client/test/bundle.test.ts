import { parse } from 'acorn';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PLAYER_HANDLE } from '../src/components/SwarmHlsPlayer/playerTestHandle';
import { GATEWAY_HANDLE } from '../src/providers/gatewayTestHandle';
import viteConfig from '../vite.config.js';

const CLIENT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD_TIMEOUT_MS = 180_000;

/**
 * Pinned as a literal, the same way the puller pins its abort default: the value that ships is the
 * one nothing else in the suite would notice changing. Every assertion below is only as meaningful as
 * this list, so raising the floor has to be a commit that says so, which is what `vite.config.js` asks
 * for in its own comment.
 */
const DECLARED_TARGET = ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'];

/** The prelude of every `@media` rule, which is where a range comparison would appear. */
const MEDIA_PRELUDE = /@media([^{]*)\{/g;

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
});
