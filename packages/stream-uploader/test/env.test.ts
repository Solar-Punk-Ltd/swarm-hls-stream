import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadEngineEnv, MAX_TIMER_DELAY_MS, optionalBool, optionalInt, required } from '../src/utils/env.js';

const VAR = 'TEST_REQUIRED_VAR';

describe('required', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[VAR];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[VAR];
    } else {
      process.env[VAR] = saved;
    }
  });

  it('returns the value when it is set', () => {
    process.env[VAR] = 'a-value';
    assert.equal(required(VAR), 'a-value');
  });

  it('reports an absent variable as missing', () => {
    delete process.env[VAR];
    assert.throws(() => required(VAR), { message: `Missing required env var: ${VAR}` });
  });

  // Compose supplies several required variables as `${VAR:-}`, so present-and-empty is the common
  // deployment failure and "missing" would send an operator looking for a key already in their
  // .env. The two messages have to differ for the failure to be diagnosable from container logs.
  it('reports a present but empty variable as empty rather than missing', () => {
    process.env[VAR] = '';
    assert.throws(() => required(VAR), { message: `Required env var is set but empty: ${VAR}` });
  });

  // `required` guards API_AUTH_TOKEN, SRS_WEBHOOK_TOKEN and OME_ADMISSION_SECRET, so a value that is
  // blank in every sense an operator means by blank has to be refused rather than returned. Quoting
  // in a `.env` and interpolating an unset compose variable both produce whitespace that survives
  // dotenv, and a service that starts on a one-space auth token looks configured from every angle
  // except the one that matters.
  for (const [name, value] of Object.entries({ space: ' ', tab: '\t', newline: '\n', mixed: ' \t ' })) {
    it(`reports a variable holding only ${name} as empty`, () => {
      process.env[VAR] = value;
      assert.throws(() => required(VAR), { message: `Required env var is set but empty: ${VAR}` });
    });
  }

  // Returned unchanged rather than trimmed: a secret's surrounding whitespace may be deliberate, and
  // silently altering one would fail authentication somewhere far from here.
  it('keeps surrounding whitespace on a value that is not blank', () => {
    process.env[VAR] = ' padded ';
    assert.equal(required(VAR), ' padded ');
  });
});

describe('optionalInt (OBS-12)', () => {
  const INT_VAR = 'TEST_OPTIONAL_INT_VAR';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[INT_VAR];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[INT_VAR];
    } else {
      process.env[INT_VAR] = saved;
    }
  });

  it('falls back when the variable is absent or empty', () => {
    delete process.env[INT_VAR];
    assert.equal(optionalInt(INT_VAR, 7), 7);
    process.env[INT_VAR] = '';
    assert.equal(optionalInt(INT_VAR, 7), 7);
  });

  it('returns a plain integer within range', () => {
    process.env[INT_VAR] = '2500';
    assert.equal(optionalInt(INT_VAR, 7, { min: 1 }), 2500);
  });

  // parseInt takes the longest numeric prefix and discards the rest, so each of these used to yield a
  // value the operator never wrote: 1e4 became 1, 10_000 became 10, and 10s became 10. Every one of
  // them is short enough as a timeout that nothing finishes downloading.
  for (const written of ['1e4', '10_000', '10s', '2.5', ' ', 'off', '0x10']) {
    it(`rejects ${JSON.stringify(written)} rather than reading a prefix of it`, () => {
      process.env[INT_VAR] = written;
      assert.throws(() => optionalInt(INT_VAR, 7), { message: /not a whole number/ });
    });
  }

  // Nothing strips the padding before this runs: compose keeps the spacing in `VAR: 30000 ` and a
  // shell `export VAR="30000 "` keeps it too, and both times 30000 is the number that was written.
  it('accepts a number written with whitespace around it', () => {
    process.env[INT_VAR] = ' 42 ';
    assert.equal(optionalInt(INT_VAR, 7), 42);
  });

  // The floor is the smallest legal setting rather than the first rejected one, and with no range
  // given the floor is zero, so "0" has to survive both the falsy-string check and the comparison.
  it('accepts a value sitting exactly on the floor, including the default floor of zero', () => {
    process.env[INT_VAR] = '0';
    assert.equal(optionalInt(INT_VAR, 7), 0);
    process.env[INT_VAR] = '1';
    assert.equal(optionalInt(INT_VAR, 7, { min: 1 }), 1);
  });

  it('rejects a value below the floor, including the zero that reads as "disabled"', () => {
    process.env[INT_VAR] = '0';
    assert.throws(() => optionalInt(INT_VAR, 7, { min: 1 }), { message: /at least 1/ });
    process.env[INT_VAR] = '-1';
    assert.throws(() => optionalInt(INT_VAR, 7, { min: 1 }), { message: /at least 1/ });
  });

  // setTimeout stores its delay in 32 bits, so anything past this wraps and fires at 1ms while the
  // error line still reports the multi-day window that was never applied.
  it('rejects a delay past the 32-bit timer ceiling instead of silently firing at 1ms', () => {
    process.env[INT_VAR] = String(MAX_TIMER_DELAY_MS + 1);
    assert.throws(() => optionalInt(INT_VAR, 7, { min: 1 }), { message: /at most 2147483647/ });
    process.env[INT_VAR] = String(MAX_TIMER_DELAY_MS);
    assert.equal(optionalInt(INT_VAR, 7, { min: 1 }), MAX_TIMER_DELAY_MS);
  });

  it('names the variable in every message, since the log line is all an operator gets', () => {
    process.env[INT_VAR] = 'nonsense';
    assert.throws(() => optionalInt(INT_VAR, 7), { message: new RegExp(INT_VAR) });
    process.env[INT_VAR] = '-5';
    assert.throws(() => optionalInt(INT_VAR, 7, { min: 0 }), { message: new RegExp(INT_VAR) });
  });
});

describe('optionalBool', () => {
  const BOOL_VAR = 'TEST_OPTIONAL_BOOL_VAR';
  let saved: string | undefined;
  let warnings: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    saved = process.env[BOOL_VAR];
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  });

  afterEach(() => {
    console.warn = originalWarn;
    if (saved === undefined) {
      delete process.env[BOOL_VAR];
    } else {
      process.env[BOOL_VAR] = saved;
    }
  });

  it('falls back without warning when the variable is absent or empty', () => {
    delete process.env[BOOL_VAR];
    assert.equal(optionalBool(BOOL_VAR, true), true);
    assert.equal(optionalBool(BOOL_VAR, false), false);
    process.env[BOOL_VAR] = '';
    assert.equal(optionalBool(BOOL_VAR, true), true);
    assert.deepEqual(warnings, [], 'an unset variable is the ordinary case, not a typo to report');
  });

  for (const written of ['true', '1']) {
    it(`reads ${JSON.stringify(written)} as true, against a false fallback`, () => {
      process.env[BOOL_VAR] = written;
      assert.equal(optionalBool(BOOL_VAR, false), true);
    });
  }

  for (const written of ['false', '0']) {
    it(`reads ${JSON.stringify(written)} as false, against a true fallback`, () => {
      process.env[BOOL_VAR] = written;
      assert.equal(optionalBool(BOOL_VAR, true), false);
    });
  }

  // The one caller, OME_ADMISSION_FAIL_OPEN, falls back to the safe direction, so a typo costs
  // rejected ingest during an outage rather than a service that will not start. That makes the
  // warning the only place the typo is visible, and it has to carry both the name and the value:
  // "invalid boolean" without them sends an operator through every variable they set.
  it('warns with the variable and the value it could not read, then falls back either way', () => {
    process.env[BOOL_VAR] = 'yes';

    assert.equal(optionalBool(BOOL_VAR, true), true);
    assert.equal(optionalBool(BOOL_VAR, false), false);

    assert.equal(warnings.length, 2);
    assert.match(warnings[0], new RegExp(BOOL_VAR));
    assert.match(warnings[0], /"yes"/);
  });
});

describe('loadEngineEnv', () => {
  const ENGINE_VAR = 'TEST_ENGINE_ENV_VAR';
  const engineName = `test-engine-${process.pid}`;
  const engineDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'engines', engineName);

  afterEach(() => {
    rmSync(engineDir, { recursive: true, force: true });
    delete process.env[ENGINE_VAR];
  });

  // An engine's settings live beside its compose file, outside the package, while the uploader is
  // started from whatever directory systemd or docker hands it. Anchoring the lookup anywhere other
  // than the repository root leaves the engine reading defaults with nothing reported.
  it('loads engines/<engine>/.env from the repository root', () => {
    delete process.env[ENGINE_VAR];
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(join(engineDir, '.env'), `${ENGINE_VAR}=from-the-engine-directory\n`);

    loadEngineEnv(engineName);

    assert.equal(process.env[ENGINE_VAR], 'from-the-engine-directory');
  });
});
