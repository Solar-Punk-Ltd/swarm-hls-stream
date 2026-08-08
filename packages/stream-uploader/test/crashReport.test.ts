import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { uncaughtExceptionLines, unhandledRejectionLines } from '../src/libs/crashReport.js';

const labels = (lines: { label: string }[]): string[] => lines.map((line) => line.label);

/**
 * What the process writes when it is handed something nothing caught, executed for the first time.
 *
 * These were the bodies of two `process.on` handlers in `index.ts`, which calls `start()` at module
 * scope, so nothing could ever run them.
 */
describe('reporting a crash nobody caught', () => {
  /**
   * ⛔ The defect running it found. The handler opened with `JSON.stringify(promise, null, 2)`, and a
   * Promise has no enumerable properties, so that argument rendered as `{}` on **every** unhandled
   * rejection this service has logged. An operator got a line whose only content was that a line
   * existed. It is the same failure `Logger`'s own tests were written for, one layer up.
   */
  it('says nothing about the promise, which had nothing to say', () => {
    const lines = unhandledRejectionLines(new Error('bee refused the chunk'));

    // The defect was a **pre-stringified** `{}` reaching the log as text. An Error passed through as a
    // value is fine and is the point: `Logger` renders one by its message, which is why the first
    // version of this assertion was wrong. JSON.stringify flattens an Error to `{}` as well, since its
    // message and stack are non-enumerable, so filtering on that caught the good line too.
    assert.deepEqual(
      lines.filter((line) => typeof line.value === 'string' && line.value.trim() === '{}'),
      [],
      'a line reached the log as the literal text "{}", which is the defect this replaced',
    );
  });

  it('leads with the reason, which is the part an operator can act on', () => {
    const lines = unhandledRejectionLines(new Error('bee refused the chunk'));

    assert.match(lines[0].label, /rejection/i);
    assert.equal((lines[0].value as Error).message, 'bee refused the chunk');
  });

  /**
   * The stack is asked for separately because `Logger` renders an `Error` by its message, on purpose,
   * so a stack that is not requested is a stack that is never written.
   */
  it('asks for the stack of a rejection that has one', () => {
    const lines = unhandledRejectionLines(new Error('bee refused the chunk'));

    assert.deepEqual(labels(lines), ['Unhandled rejection:', 'Rejection stack:']);
    assert.match(String(lines[1].value), /bee refused the chunk/);
  });

  it('does not invent a stack for a rejection thrown as a string', () => {
    const lines = unhandledRejectionLines('just a string');

    assert.equal(lines.length, 1);
    assert.equal(lines[0].value, 'just a string');
  });

  it('still reports a rejection of undefined, which is the hardest one to trace', () => {
    const lines = unhandledRejectionLines(undefined);

    assert.equal(lines.length, 1);
    assert.match(lines[0].label, /rejection/i);
  });

  it('reports an uncaught exception with its stack', () => {
    const lines = uncaughtExceptionLines(new Error('the socket closed under us'));

    assert.deepEqual(labels(lines), ['Uncaught exception:', 'Exception stack:']);
    assert.match(String(lines[1].value), /the socket closed under us/);
  });

  it('reports something thrown that was never an error', () => {
    const lines = uncaughtExceptionLines({ code: 'ENOTFOUND' });

    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].value, { code: 'ENOTFOUND' });
  });

  it('keeps the two kinds of crash apart in the log', () => {
    const rejection = unhandledRejectionLines(new Error('x'))[0].label;
    const exception = uncaughtExceptionLines(new Error('x'))[0].label;

    assert.notEqual(rejection, exception, 'the two handlers write the same label, so the log cannot tell them apart');
  });
});
