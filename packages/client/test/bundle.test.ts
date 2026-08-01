import { parse } from 'acorn';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  let outDir: string;
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
    rmSync(outDir, { recursive: true, force: true });
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
