import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';
import {
  droppedParsedLines,
  effectiveLogLevel,
  isLogThreshold,
  LOG_THRESHOLDS,
  logLevelProblem,
  PARSED_LINES,
  REQUIRED_LOG_LEVEL,
} from '../src/logLevel.js';

/**
 * The suite reads the uploader's log, which makes the deployment's `LOG_LEVEL` a precondition of
 * every upload-side assertion. `.env.sample` recommends `info` to drop the per-segment line, and at
 * `info` the segment counter never moves: each scenario spends its full timeout and then fails with
 * a label blaming the publisher. This guard turns that into one sentence naming the level.
 *
 * The table it works from mirrors the uploader's call sites, so these tests read those call sites
 * out of the uploader source. A level changed there fails here, rather than during a live run.
 */

const UPLOADER_SRC = join(ROOT_DIR, 'packages', 'stream-uploader', 'src');

/**
 * The logger method emitting `fragment`: the nearest `logger.<method>(` before it.
 *
 * Backwards from the fragment rather than on its own line, because several of these calls span
 * lines with the message in a template literal under the call.
 */
function loggerMethodEmitting(source: string, fragment: string): string | null {
  const at = source.indexOf(fragment);
  if (at === -1) {
    return null;
  }
  const calls = [...source.slice(0, at).matchAll(/logger\.(debug|log|info|warn|error)\(/g)];
  return calls.at(-1)?.[1] ?? null;
}

describe('the parsed-line table still matches the uploader', () => {
  for (const line of PARSED_LINES) {
    it(`${line.what} is still emitted at ${line.level}`, () => {
      const source = readFileSync(join(UPLOADER_SRC, line.emittedBy.file), 'utf8');
      const method = loggerMethodEmitting(source, line.emittedBy.fragment);

      assert.notEqual(
        method,
        null,
        `${line.emittedBy.file} no longer contains ${JSON.stringify(line.emittedBy.fragment)} — ` +
          'the harness parses a line the uploader does not print any more',
      );
      assert.equal(
        method,
        line.level,
        `the uploader emits this at ${method}, the table says ${line.level}; ` +
          `at LOG_LEVEL=${REQUIRED_LOG_LEVEL} that is still printed, but the guard now reports the wrong level`,
      );
    });
  }

  // A level added or renamed upstream would leave the ranking here answering about a ladder that no
  // longer exists.
  it('knows the same levels the uploader defines', () => {
    const source = readFileSync(join(UPLOADER_SRC, 'libs', 'logLevels.ts'), 'utf8');
    const declared = [...source.matchAll(/^export const LOG_LEVEL_[A-Z]+ = '([a-z]+)'/gm)].map((m) => m[1]);
    assert.deepEqual([...LOG_THRESHOLDS], declared, 'the level ladder drifted from the uploader');
  });
});

describe('logLevelProblem', () => {
  it('passes the level the suite needs', () => {
    assert.equal(logLevelProblem(REQUIRED_LOG_LEVEL), null);
  });

  // Every other level drops something, which is why the requirement is the bottom of the ladder
  // rather than a threshold in the middle.
  for (const threshold of LOG_THRESHOLDS.filter((level) => level !== REQUIRED_LOG_LEVEL)) {
    it(`reports a problem at ${threshold}`, () => {
      const problem = logLevelProblem(threshold);
      assert.notEqual(problem, null, `${threshold} drops uploader lines the suite reads`);
      assert.match(problem!, new RegExp(`LOG_LEVEL=${threshold}`), 'the message must name the level in effect');
      assert.match(problem!, /LOG_LEVEL=debug/, 'and the level to redeploy with');
    });
  }

  // The message exists to replace a timeout that pointed at ffmpeg, so it has to name the tests
  // that will fail and not merely say a level is wrong.
  it('names what stops working', () => {
    assert.match(logLevelProblem('log')!, /catalog-via-gateway/);
    assert.match(logLevelProblem('info')!, /counts segments/);
  });
});

describe('effectiveLogLevel', () => {
  it('takes a level the operator set', () => {
    assert.equal(effectiveLogLevel('warn'), 'warn');
  });

  // Both of these land on the uploader's own default, so treating either as a problem would fail
  // the guard against a deployment that prints everything the suite needs.
  it('falls back to the default when unset', () => {
    assert.equal(effectiveLogLevel(undefined), REQUIRED_LOG_LEVEL);
  });

  it('falls back to the default for a value that is not a level, as the uploader does', () => {
    assert.equal(effectiveLogLevel('verbose'), REQUIRED_LOG_LEVEL);
    assert.equal(effectiveLogLevel(''), REQUIRED_LOG_LEVEL);
  });
});

describe('droppedParsedLines', () => {
  it('drops nothing at debug', () => {
    assert.deepEqual(droppedParsedLines('debug'), []);
  });

  // `log` is one notch up and costs exactly the catalog feed location, which is what stops scenario
  // F and the gateway catalog check from starting at all.
  it('drops only the debug-level line at log', () => {
    const dropped = droppedParsedLines('log');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].level, 'debug');
  });

  it('drops every line at silent', () => {
    assert.equal(droppedParsedLines('silent').length, PARSED_LINES.length);
  });

  it('drops more as the level rises', () => {
    const counts = LOG_THRESHOLDS.map((threshold) => droppedParsedLines(threshold).length);
    const sorted = [...counts].sort((a, b) => a - b);
    assert.deepEqual(counts, sorted, `dropping is not monotonic in the level: ${counts.join(',')}`);
  });
});

describe('isLogThreshold', () => {
  it('accepts every level an operator may set', () => {
    for (const threshold of LOG_THRESHOLDS) {
      assert.equal(isLogThreshold(threshold), true);
    }
  });

  it('rejects anything else', () => {
    for (const value of ['verbose', 'trace', '', 'DEBUG']) {
      assert.equal(isLogThreshold(value), false);
    }
  });

  // The uploader's own version had to stop using `in` for this: `constructor` and `__proto__` walk
  // the prototype chain and passed, after which the service went silent at every level including
  // error. A membership test on a literal list cannot inherit that, and this pins it.
  it('rejects inherited property names', () => {
    for (const value of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.equal(isLogThreshold(value), false, `${value} was accepted as a log level`);
    }
  });
});
