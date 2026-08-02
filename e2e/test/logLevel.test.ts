import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';
import {
  DEFAULT_LOG_LEVEL,
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

  /**
   * The bug this arm exists for, and it defeated the entire guard.
   *
   * `loggerOptionsFromEnv` normalizes with `.trim().toLowerCase()` BEFORE testing the value, so
   * `INFO` is a real level to the uploader. Comparing the raw string sent every differently-cased
   * spelling down the fallback and onto `debug`, the one answer for which `logLevelProblem` returns
   * null. So the guard reported "readable" for exactly the deployments it was written to catch, and
   * `SILENT` was the worst of them: nothing printed at all, guard green.
   */
  for (const [raw, expected] of [
    ['INFO', 'info'],
    ['Info', 'info'],
    ['iNfO', 'info'],
    [' info', 'info'],
    ['info ', 'info'],
    ['\tinfo\n', 'info'],
    ['WARN', 'warn'],
    ['ERROR', 'error'],
    ['SILENT', 'silent'],
    ['DEBUG', 'debug'],
  ] as const) {
    it(`normalizes ${JSON.stringify(raw)} to ${expected}, as the uploader does`, () => {
      assert.equal(effectiveLogLevel(raw), expected);
    });
  }

  // The consequence, asserted directly rather than left to be inferred from the mapping above.
  it('reports a problem for a quiet level however it was spelled', () => {
    for (const raw of ['INFO', ' info', 'SILENT', 'WARN']) {
      assert.notEqual(logLevelProblem(effectiveLogLevel(raw)), null, `${JSON.stringify(raw)} passed the guard`);
    }
  });

  // Both of these land on the uploader's own default, so treating either as a problem would fail
  // the guard against a deployment that prints everything the suite needs.
  it('falls back to the default when unset', () => {
    assert.equal(effectiveLogLevel(undefined), DEFAULT_LOG_LEVEL);
  });

  it('falls back to the default for a value that is not a level, as the uploader does', () => {
    assert.equal(effectiveLogLevel('verbose'), DEFAULT_LOG_LEVEL);
    assert.equal(effectiveLogLevel(''), DEFAULT_LOG_LEVEL);
  });

  /**
   * Read out of the uploader's source rather than compared against our own constant.
   *
   * The previous version asserted `effectiveLogLevel(undefined)` against `REQUIRED_LOG_LEVEL`, the
   * same value the implementation returns, so both sides moved together and changing the uploader's
   * `DEFAULT_LOG_LEVEL` to `info` left all 169 tests green. A deployment with no `LOG_LEVEL` set
   * would then really run at `info`, the per-segment lines would vanish, and the guard would still
   * say null.
   */
  it('mirrors the default the uploader actually falls back to', () => {
    const source = readFileSync(join(UPLOADER_SRC, 'libs', 'logLevels.ts'), 'utf8');
    const declared = source.match(/^export const DEFAULT_LOG_LEVEL: LogThreshold = LOG_LEVEL_([A-Z]+);/m);
    assert.ok(declared, 'could not find DEFAULT_LOG_LEVEL in the uploader source');
    assert.equal(DEFAULT_LOG_LEVEL, declared[1].toLowerCase(), 'the uploader default moved and this mirror did not');
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

  /**
   * This pins the e2e mirror, not the uploader.
   *
   * The uploader's own version had to stop using `in` for exactly this: `constructor` and
   * `__proto__` walk the prototype chain and passed, after which the service went silent at every
   * level including error. Reverting that fix upstream leaves this test green, because the body
   * only exercises `LOG_THRESHOLDS.includes`, which structurally cannot inherit. Kept because the
   * mirror could be rewritten into an object lookup and reintroduce the class here.
   */
  it('rejects inherited property names', () => {
    for (const value of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.equal(isLogThreshold(value), false, `${value} was accepted as a log level`);
    }
  });
});
