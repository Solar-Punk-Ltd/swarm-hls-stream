import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger, LoggerOptions, loggerOptionsFromEnv } from '../src/libs/Logger.js';
import {
  admits,
  DEFAULT_LOG_LEVEL,
  LOG_FORMAT_JSON,
  LOG_FORMAT_TEXT,
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_ERROR,
  LOG_LEVEL_INFO,
  LOG_LEVEL_LOG,
  LOG_LEVEL_SILENT,
  LOG_LEVEL_WARN,
  LogLevel,
} from '../src/libs/logLevels.js';

const EVERY_LEVEL: LogLevel[] = [LOG_LEVEL_DEBUG, LOG_LEVEL_LOG, LOG_LEVEL_INFO, LOG_LEVEL_WARN, LOG_LEVEL_ERROR];

/** Run against the shared logger with a captured sink, restoring whatever was configured before. */
function withLogger(options: Partial<LoggerOptions>, run: (lines: string[], levels: LogLevel[]) => void): void {
  const lines: string[] = [];
  const levels: LogLevel[] = [];
  const logger = Logger.getInstance();
  const previous = logger.configure({
    ...options,
    sink: (level, line) => {
      levels.push(level);
      lines.push(line);
    },
  });
  try {
    run(lines, levels);
  } finally {
    logger.configure(previous);
  }
}

describe('log level thresholds (ARCH-4)', () => {
  it('admits everything at or above the threshold', () => {
    assert.deepEqual(
      EVERY_LEVEL.filter((level) => admits(LOG_LEVEL_WARN, level)),
      [LOG_LEVEL_WARN, LOG_LEVEL_ERROR],
    );
  });

  it('admits every level at debug', () => {
    assert.deepEqual(
      EVERY_LEVEL.filter((level) => admits(LOG_LEVEL_DEBUG, level)),
      EVERY_LEVEL,
    );
  });

  it('admits nothing at silent', () => {
    assert.deepEqual(
      EVERY_LEVEL.filter((level) => admits(LOG_LEVEL_SILENT, level)),
      [],
    );
  });

  // `log` is per-segment and `info` is per lifecycle event, so ranking them apart is what makes
  // LOG_LEVEL=info drop a line per segment for every live stream while keeping the ones that say
  // what the service did.
  it('ranks log below info, so info suppresses per-segment lines', () => {
    assert.equal(admits(LOG_LEVEL_INFO, LOG_LEVEL_LOG), false);
    assert.equal(admits(LOG_LEVEL_INFO, LOG_LEVEL_INFO), true);
  });
});

describe('LOG_LEVEL suppression (ARCH-4)', () => {
  it('LOG_LEVEL=warn suppresses info and debug and keeps warn and error', () => {
    withLogger({ level: LOG_LEVEL_WARN }, (_lines, levels) => {
      const logger = Logger.getInstance();
      logger.debug('d');
      logger.log('l');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      assert.deepEqual(levels, [LOG_LEVEL_WARN, LOG_LEVEL_ERROR]);
    });
  });

  it('prints every level at the default', () => {
    withLogger({ level: DEFAULT_LOG_LEVEL }, (_lines, levels) => {
      const logger = Logger.getInstance();
      logger.debug('x');
      logger.log('x');
      logger.info('x');
      logger.warn('x');
      logger.error('x');

      assert.deepEqual(levels, EVERY_LEVEL);
    });
  });

  // The suppressed call must not reach the formatter either, or a level nobody prints still costs a
  // timestamp and a JSON.stringify per segment.
  it('does not format a line it is going to drop', () => {
    withLogger({ level: LOG_LEVEL_ERROR }, (lines) => {
      Logger.getInstance().info('expensive', { a: 1 });

      assert.deepEqual(lines, []);
    });
  });
});

describe('structured output (ARCH-4)', () => {
  it('writes one json object per line carrying the level and the message', () => {
    withLogger({ level: LOG_LEVEL_DEBUG, format: LOG_FORMAT_JSON }, (lines) => {
      Logger.getInstance().warn('stream stalled:', { streamId: 'live/a' });

      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.level, LOG_LEVEL_WARN);
      assert.equal(parsed.msg, 'stream stalled: {"streamId":"live/a"}');
      assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('renders an error by its message in json too, not as an empty object', () => {
    withLogger({ level: LOG_LEVEL_DEBUG, format: LOG_FORMAT_JSON }, (lines) => {
      Logger.getInstance().error('failed:', new Error('bee unreachable'));

      assert.match(JSON.parse(lines[0]).msg, /bee unreachable/);
    });
  });

  it('keeps the bracketed text format when json is not asked for', () => {
    withLogger({ level: LOG_LEVEL_DEBUG, format: LOG_FORMAT_TEXT }, (lines) => {
      Logger.getInstance().info('hello');

      assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[INFO\] - hello$/);
    });
  });
});

describe('logger configuration from the environment (ARCH-4)', () => {
  const sink: LogLevel[] = [];
  const noop = () => undefined;

  it('defaults to printing everything, so adding levels changes no deployment', () => {
    assert.equal(loggerOptionsFromEnv({}, noop).level, DEFAULT_LOG_LEVEL);
    assert.equal(admits(loggerOptionsFromEnv({}, noop).level, LOG_LEVEL_DEBUG), true);
  });

  it('reads a level an operator set', () => {
    assert.equal(loggerOptionsFromEnv({ LOG_LEVEL: 'warn' }, noop).level, LOG_LEVEL_WARN);
  });

  it('accepts surrounding whitespace and any casing, which is how env files arrive', () => {
    assert.equal(loggerOptionsFromEnv({ LOG_LEVEL: '  WARN ' }, noop).level, LOG_LEVEL_WARN);
  });

  it('treats an empty LOG_LEVEL as unset, since compose supplies several vars as ${VAR:-}', () => {
    assert.equal(loggerOptionsFromEnv({ LOG_LEVEL: '' }, noop).level, DEFAULT_LOG_LEVEL);
  });

  it('selects json only for the exact value, so a typo does not silently change the format', () => {
    assert.equal(loggerOptionsFromEnv({ LOG_FORMAT: 'json' }, noop).format, LOG_FORMAT_JSON);
    assert.equal(loggerOptionsFromEnv({ LOG_FORMAT: 'JSON' }, noop).format, LOG_FORMAT_TEXT);
    assert.equal(loggerOptionsFromEnv({}, noop).format, LOG_FORMAT_TEXT);
  });

  // Refusing to start because the log volume was misspelled turns a typo into an outage, so the
  // value is reported and ignored. Silently ignoring it would leave an operator believing they had
  // turned the volume down.
  it('falls back to the default on an unusable level rather than throwing', () => {
    assert.equal(loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' }, noop).level, DEFAULT_LOG_LEVEL);
  });

  it('says which value it rejected and what it accepts instead', () => {
    const lines: string[] = [];
    loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' }, (_level, line) => lines.push(line));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /"verbose" is not a log level/);
    assert.match(lines[0], /silent/, 'the message must list the levels that would have worked');
  });

  // At `error`, and not at the level being configured: the one message saying the setting was
  // rejected must not be suppressible by the setting that was rejected.
  it('reports the rejection at a level every threshold admits', () => {
    sink.length = 0;
    loggerOptionsFromEnv({ LOG_LEVEL: 'verbose' }, (level) => sink.push(level));

    assert.deepEqual(sink, [LOG_LEVEL_ERROR]);
  });

  it('says nothing when the level is usable', () => {
    const lines: string[] = [];
    loggerOptionsFromEnv({ LOG_LEVEL: 'warn' }, (_level, line) => lines.push(line));

    assert.deepEqual(lines, []);
  });
});
