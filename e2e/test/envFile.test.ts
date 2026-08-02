import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { layerEnv, parseEnvText, processEnv, readEnvFile } from '../src/envFile.js';

import { readVars } from './helpers/shell.js';

/**
 * `parseEnvText` reproduces `load_env_file` from `deploy/scripts/_lib.sh`, and these tests settle
 * every rule against that function rather than against a reading of it. That is not ceremony: the
 * first version of the parser disagreed on one case (a line with no `=` at all), which the shell
 * exports as its own value and the parser silently dropped. Nothing but running both would have
 * said so.
 */

const sandboxes: string[] = [];

after(() => {
  for (const dir of sandboxes) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-env-'));
  sandboxes.push(dir);
  const path = join(dir, 'fixture.env');
  writeFileSync(path, text);
  return path;
}

/** What the real `load_env_file` leaves in the shell for `names`, given a fixture file. */
function shellEnv(text: string, names: readonly string[]): Record<string, string | null> {
  const vars = readVars('load_env_file "$2"', names, fixtureFile(text));
  return Object.fromEntries(names.map((name) => [name, vars[name].isSet ? vars[name].value : null]));
}

function parsedEnv(text: string, names: readonly string[]): Record<string, string | null> {
  const parsed = parseEnvText(text);
  return Object.fromEntries(names.map((name) => [name, name in parsed ? parsed[name] : null]));
}

/**
 * Values chosen for what they do to a parser rather than for looking plausible in a `.env`: quoting
 * that stops early, comment markers with and without the leading whitespace the shell requires, and
 * whitespace in the three positions that are trimmed differently.
 *
 * Key names avoid everything `_lib.sh` declares up front. That is not cosmetic — the shell skips a
 * key it can already see, arrays included, so a fixture named `REST_ARGS` would be dropped for a
 * reason that has nothing to do with parsing.
 */
const FIXTURES: ReadonlyArray<{ readonly name: string; readonly text: string; readonly keys: readonly string[] }> = [
  { name: 'a plain assignment', text: 'API_PORT=3000\n', keys: ['API_PORT'] },
  { name: 'an empty value', text: 'STAMP=\n', keys: ['STAMP'] },
  { name: 'a value of only whitespace', text: 'STAMP=   \n', keys: ['STAMP'] },
  { name: 'a double-quoted value', text: 'STAMP="abc"\n', keys: ['STAMP'] },
  { name: 'a single-quoted value', text: "STAMP='abc'\n", keys: ['STAMP'] },
  { name: 'a quote that closes early', text: 'STAMP="a"b"c\n', keys: ['STAMP'] },
  { name: 'an unterminated quote', text: 'STAMP="abc\n', keys: ['STAMP'] },
  { name: 'an inline comment', text: 'STAMP=abc #note\n', keys: ['STAMP'] },
  { name: 'two inline comment markers', text: 'STAMP=a #b #c\n', keys: ['STAMP'] },
  { name: 'a hash with no leading space', text: 'STAMP=a#b\n', keys: ['STAMP'] },
  { name: 'trailing whitespace', text: 'STAMP=abc   \n', keys: ['STAMP'] },
  { name: 'leading whitespace before a quote', text: 'STAMP= "abc"\n', keys: ['STAMP'] },
  { name: 'a full-line comment', text: '#STAMP=abc\n', keys: ['STAMP'] },
  { name: 'an indented comment', text: '  # STAMP=abc\n', keys: ['STAMP'] },
  { name: 'a key with a space in it', text: 'BAD KEY=abc\n', keys: ['BAD'] },
  { name: 'a key that is not an identifier', text: '1STAMP=abc\n', keys: ['1STAMP'] },
  // The one the first parser got wrong. Both of the shell's expansions leave a line with no `=`
  // whole, so it is exported as its own value rather than skipped.
  { name: 'a bare word with no equals', text: 'STAMP\n', keys: ['STAMP'] },
  { name: 'a duplicate key', text: 'STAMP=first\nSTAMP=second\n', keys: ['STAMP'] },
  { name: 'a value containing an equals sign', text: 'STAMP=a=b=c\n', keys: ['STAMP'] },
  { name: 'a value that looks like a substitution', text: 'STAMP=$HOME\n', keys: ['STAMP'] },
  { name: 'a value that looks like a command', text: 'STAMP=$(id -u)\n', keys: ['STAMP'] },
  { name: 'a value with a backtick', text: 'STAMP=`id -u`\n', keys: ['STAMP'] },
  { name: 'a value with a bang', text: 'STAMP=a!b\n', keys: ['STAMP'] },
  { name: 'no trailing newline', text: 'STAMP=abc', keys: ['STAMP'] },
  { name: 'blank lines between entries', text: 'STAMP=a\n\n\nSTREAM_KEY=b\n', keys: ['STAMP', 'STREAM_KEY'] },
  { name: 'CRLF line endings', text: 'STAMP=abc\r\nSTREAM_KEY=def\r\n', keys: ['STAMP', 'STREAM_KEY'] },
];

describe('parseEnvText agrees with load_env_file', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      assert.deepEqual(parsedEnv(fixture.text, fixture.keys), shellEnv(fixture.text, fixture.keys));
    });
  }
});

describe('parseEnvText does not evaluate values', () => {
  // The reason values are taken literally. A stamp or a token may hold any of these, and a parser
  // that expanded them would produce a different secret rather than an obvious failure.
  for (const value of ['$HOME', '$(id -u)', '`id -u`', '${PATH}', 'a!b', 'a b c']) {
    it(`keeps ${JSON.stringify(value)} byte for byte`, () => {
      assert.equal(parseEnvText(`STAMP=${value}\n`).STAMP, value);
    });
  }
});

describe('readEnvFile', () => {
  it('reads a file that is there', () => {
    assert.deepEqual(readEnvFile(fixtureFile('STAMP=abc\n')), { STAMP: 'abc' });
  });

  // A profile that never wrote an engine env is normal, not an error: the suite falls back to the
  // built-in defaults for it. Throwing here would make an ordinary deployment unrunnable.
  it('returns an empty bag for a file that is not there', () => {
    assert.deepEqual(readEnvFile(join(tmpdir(), 'e2e-does-not-exist-4f1a', '.env')), {});
  });
});

describe('layerEnv', () => {
  // The shell's precedence is "already set wins", which reads as first-bag-wins here. Callers pass
  // the process environment first, so an exported value beats both files.
  it('lets the first bag holding a key decide it', () => {
    assert.deepEqual(layerEnv({ A: 'shell' }, { A: 'root', B: 'root' }, { B: 'engine', C: 'engine' }), {
      A: 'shell',
      B: 'root',
      C: 'engine',
    });
  });

  it('is unaffected by an empty bag', () => {
    assert.deepEqual(layerEnv({}, { A: '1' }, {}), { A: '1' });
  });

  // An empty string is a value the shell can hold, so it must shadow a later bag rather than fall
  // through to it. `resolvePort` is what decides an empty port means "unset", and only for ports.
  it('treats an empty string as a value that shadows later bags', () => {
    assert.deepEqual(layerEnv({ A: '' }, { A: 'root' }), { A: '' });
  });

  it('does not mutate its inputs', () => {
    const first = { A: '1' };
    const second = { B: '2' };
    layerEnv(first, second);
    assert.deepEqual(first, { A: '1' });
    assert.deepEqual(second, { B: '2' });
  });
});

describe('processEnv', () => {
  it('drops the keys Node reports as undefined', () => {
    assert.deepEqual(processEnv({ A: '1', B: undefined, C: '' }), { A: '1', C: '' });
  });
});
