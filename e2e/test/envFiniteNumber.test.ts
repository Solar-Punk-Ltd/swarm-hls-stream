import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { envFiniteNumber, envNumber } from '../src/browser/runFiles.js';

/**
 * That a setting whose range includes zero can actually be set to zero.
 *
 * ⛔⛔⛔ `WEEB3_NATIVE_START_S` documents "negative counts back from the end, 0 is the start" and was
 * read with {@link envNumber}, which throws on anything at or below zero. Two thirds of the
 * documented range were unreachable: the default could not be written down and the negative form had
 * never once been run. It surfaced on 2026-08-16 when the first arm of a sweep passed `0` explicitly
 * and the driver refused to start, and the same defect would have silently limited any future arm
 * that wanted to seek relative to the end.
 *
 * ⭐ The fix is a second reader rather than a looser one. Durations elsewhere in the harness are
 * right to refuse zero, and relaxing the shared check to fix one offset would have taken that
 * refusal off all of them.
 */
describe('reading a setting whose range includes zero', () => {
  const NAME = 'TEST_FINITE_NUMBER';

  afterEach(() => {
    delete process.env[NAME];
  });

  it('accepts zero, which is the value the offset documents as its default', () => {
    process.env[NAME] = '0';

    assert.equal(envFiniteNumber(NAME, 99), 0);
  });

  it('accepts a negative offset, which is the documented seek-from-the-end form', () => {
    process.env[NAME] = '-30';

    assert.equal(envFiniteNumber(NAME, 99), -30);
  });

  it('still refuses a value that is not a number', () => {
    process.env[NAME] = 'soon';

    assert.throws(() => envFiniteNumber(NAME, 99), /must be a finite number/);
  });

  it('falls back when unset and when empty, so an unset variable is not read as zero', () => {
    assert.equal(envFiniteNumber(NAME, 99), 99);

    process.env[NAME] = '';

    assert.equal(envFiniteNumber(NAME, 99), 99);
  });

  it('leaves the positive-only reader refusing zero, which durations depend on', () => {
    process.env[NAME] = '0';

    assert.throws(() => envNumber(NAME, 99), /must be a positive number/);
  });
});
