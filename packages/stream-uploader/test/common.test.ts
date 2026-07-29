import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  backoffDelayMs,
  getErrorMessage,
  isRetryableError,
  jitteredDelayMs,
  retryUntilDeadlineAsync,
} from '../src/utils/common.js';

describe('getErrorMessage', () => {
  it('returns the message of a real Error', () => {
    assert.equal(getErrorMessage(new Error('bee unreachable')), 'bee unreachable');
  });

  it('keeps the content of a thrown raw string instead of dropping it', () => {
    assert.equal(getErrorMessage('stamp exhausted'), 'stamp exhausted');
  });

  it('does not lose non-Error throws of other shapes', () => {
    assert.equal(getErrorMessage(404), '404');
    assert.equal(getErrorMessage(undefined), 'undefined');
  });

  it('prefers an own message field over [object Object]', () => {
    assert.equal(getErrorMessage({ message: 'batch not usable', status: 402 }), 'batch not usable');
    assert.equal(getErrorMessage({ code: 1 }), '[object Object]');
  });

  it('does not throw on a value String() cannot convert', () => {
    const noPrototype = Object.create(null);
    assert.throws(() => String(noPrototype), TypeError, 'precondition: String() rejects this value');
    assert.equal(getErrorMessage(noPrototype), '[object Object]');
  });
});

describe('isRetryableError', () => {
  it('retries transient HTTP statuses', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryableError(Object.assign(new Error('transient'), { status })), true);
    }
  });

  it('does not retry permanent HTTP statuses (402 stamp exhausted, other 4xx)', () => {
    for (const status of [400, 401, 402, 403, 404, 409]) {
      assert.equal(isRetryableError(Object.assign(new Error('permanent'), { status })), false);
    }
  });

  it('retries errors with no HTTP status (network/transport failures)', () => {
    assert.equal(isRetryableError(new Error('ECONNREFUSED')), true);
    assert.equal(isRetryableError('boom'), true);
  });
});

describe('backoffDelayMs', () => {
  it('doubles each attempt', () => {
    assert.equal(backoffDelayMs(0, 350, 2000), 350);
    assert.equal(backoffDelayMs(1, 350, 2000), 700);
    assert.equal(backoffDelayMs(2, 350, 2000), 1400);
  });

  it('never exceeds the cap', () => {
    assert.equal(backoffDelayMs(3, 350, 2000), 2000);
    assert.equal(backoffDelayMs(10, 350, 2000), 2000);
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.ok(backoffDelayMs(attempt, 350, 2000) <= 2000);
    }
  });
});

describe('jitteredDelayMs', () => {
  it('returns half the delay when random() is 0', () => {
    assert.equal(
      jitteredDelayMs(1000, () => 0),
      500,
    );
  });

  it('stays within [delay/2, delay) for any random() in [0, 1)', () => {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const d = jitteredDelayMs(1000, () => r);
      assert.ok(d >= 500 && d < 1000, `jitter ${d} out of range for r=${r}`);
    }
  });
});

describe('retryUntilDeadlineAsync', () => {
  it('returns the result on the first successful attempt', async () => {
    let calls = 0;
    const result = await retryUntilDeadlineAsync(async () => {
      calls++;
      return 'ok';
    }, 1000);

    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries on failure and returns once the function succeeds', async () => {
    let calls = 0;
    const result = await retryUntilDeadlineAsync(
      async () => {
        calls++;
        if (calls < 3) {
          throw new Error('transient');
        }
        return 'recovered';
      },
      5000,
      1,
      4,
    );

    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('retries at least once and then throws once the deadline passes', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retryUntilDeadlineAsync(
          async () => {
            calls++;
            throw new Error('always fails');
          },
          300,
          10,
          40,
        ),
      /always fails/,
    );

    assert.ok(calls >= 2, `expected at least one retry, got ${calls} call(s)`);
  });

  it('does not retry a permanent (non-retryable) error, even within the window', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retryUntilDeadlineAsync(
          async () => {
            calls++;
            throw Object.assign(new Error('payment required'), { status: 402 });
          },
          5000,
          1,
          4,
        ),
      /payment required/,
    );

    assert.equal(calls, 1);
  });
});
