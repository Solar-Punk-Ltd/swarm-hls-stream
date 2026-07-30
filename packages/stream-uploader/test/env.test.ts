import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MAX_TIMER_DELAY_MS, optionalInt, required } from '../src/utils/env.js';

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
