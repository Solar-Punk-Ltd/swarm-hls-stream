import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { required } from '../src/utils/env.js';

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
