import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '../src/libs/Logger.js';

function capture(run: () => void): string[] {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    run();
    return lines;
  } finally {
    console.error = original;
  }
}

describe('Logger error rendering', () => {
  // An Error's message and stack are non-enumerable, so JSON.stringify renders one as {}. Every
  // handler in this service passes an error straight through, so the startup failure an operator
  // most needs to read was the one they could not.
  it('renders an error by its message rather than as an empty object', () => {
    const lines = capture(() =>
      Logger.getInstance().error('Failed to start:', new Error('Env var OME_FETCH_TIMEOUT_MS must be at least 1')),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0], /Env var OME_FETCH_TIMEOUT_MS must be at least 1/);
    assert.doesNotMatch(lines[0], /\{\}/, 'the empty object is what an operator used to get instead');
  });

  it('still renders a plain object as json and a string as itself', () => {
    const lines = capture(() => Logger.getInstance().error('state:', { a: 1 }, 'tail'));

    assert.match(lines[0], /\{"a":1\} tail/);
  });
});
