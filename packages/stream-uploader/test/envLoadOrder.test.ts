import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Local import specifiers in the order the ES module graph evaluates them, which is source order. */
function localImportsInOrder(file: string): string[] {
  const source = readFileSync(resolve(SRC, file), 'utf8');
  return [...source.matchAll(/^import\s+(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"];?$/gm)].map((match) => match[1]);
}

/**
 * `dotenv` has to run before anything reads `process.env`, and in an ES module graph that is decided
 * by import order rather than by anything visible at the call site.
 *
 * `Logger` reads `LOG_LEVEL` when its singleton is first constructed, which happens at module scope
 * inside `utils/common.js`, which `api/server.js` reaches. With `utils/env.js` imported below that,
 * `dotenv.config()` had not run yet, so `LOG_LEVEL` and `LOG_FORMAT` set in the root `.env` were
 * read as unset and silently ignored on every non-container path. Measured: the same value in the
 * real process environment was honoured, from `.env` it was not, and nothing reported the
 * difference.
 *
 * Asserted statically rather than by starting the service, because the only faithful functional test
 * would have to read the developer's own `.env` at the repository root. See TEST-37.
 */
describe('env is loaded before anything reads it (ARCH-4)', () => {
  it('imports utils/env.js ahead of every other local import in the entry point', () => {
    const imports = localImportsInOrder('index.ts');

    assert.ok(imports.length > 1, 'index.ts has no local imports, so this test is checking nothing');
    assert.equal(
      imports[0],
      './utils/env.js',
      `dotenv runs in utils/env.js, and ${imports[0]} is imported first, so anything it reaches ` +
        'that reads process.env at module scope sees the environment without the .env file applied',
    );
  });

  // The reason the ordering above matters at all. If Logger stopped reading the environment when it
  // is constructed, the constraint would be gone and the test above would be guarding nothing.
  it('still reads the environment when the logger singleton is built', () => {
    const logger = readFileSync(resolve(SRC, 'libs/Logger.ts'), 'utf8');

    assert.match(
      logger,
      /getInstance\(\)[\s\S]*?loggerOptionsFromEnv\(process\.env\)/,
      'the logger no longer snapshots process.env at construction',
    );
  });
});
