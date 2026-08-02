import {
  admits,
  DEFAULT_LOG_LEVEL,
  isLogThreshold,
  LOG_FORMAT_JSON,
  LOG_FORMAT_TEXT,
  LogFormat,
  LogLevel,
  LogThreshold,
  logThresholds,
} from './logLevels.js';

/**
 * An `Error`'s `message` and `stack` are non-enumerable, so `JSON.stringify` renders one as `{}` and
 * every handler that passes an error straight to the logger prints nothing an operator can act on.
 */
function renderArg(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }
  return typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg);
}

/** Where a formatted line goes. Replaceable so a test can read what was written without a spy on console. */
export type LogSink = (level: LogLevel, line: string) => void;

export interface LoggerOptions {
  level: LogThreshold;
  format: LogFormat;
  sink: LogSink;
}

const CONSOLE_SINK: LogSink = (level, line) => {
  console[level](line);
};

/**
 * Read the logger's configuration from the environment.
 *
 * An unusable `LOG_LEVEL` is reported and then ignored rather than thrown. The service is otherwise
 * fine, and refusing to start because the log volume was misspelled turns a typo into an outage.
 * The warning goes through the sink at `error`, which every threshold admits, so the one message
 * saying the setting was rejected cannot itself be suppressed by the setting.
 */
export function loggerOptionsFromEnv(env: NodeJS.ProcessEnv, sink: LogSink = CONSOLE_SINK): LoggerOptions {
  const format = env.LOG_FORMAT === LOG_FORMAT_JSON ? LOG_FORMAT_JSON : LOG_FORMAT_TEXT;
  const requested = env.LOG_LEVEL;

  if (requested === undefined || requested === '') {
    return { level: DEFAULT_LOG_LEVEL, format, sink };
  }

  const normalized = requested.trim().toLowerCase();
  if (!isLogThreshold(normalized)) {
    sink(
      'error',
      `[LOG_LEVEL] "${requested}" is not a log level, using "${DEFAULT_LOG_LEVEL}". ` +
        `Expected one of: ${logThresholds().join(', ')}`,
    );
    return { level: DEFAULT_LOG_LEVEL, format, sink };
  }

  return { level: normalized, format, sink };
}

export class Logger {
  private static instance: Logger;

  private options: LoggerOptions;

  private constructor(options: LoggerOptions) {
    this.options = options;
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(loggerOptionsFromEnv(process.env));
    }
    return Logger.instance;
  }

  /** Replace some or all of the configuration. Returns the previous options, so a test can restore them. */
  public configure(options: Partial<LoggerOptions>): LoggerOptions {
    const previous = this.options;
    this.options = { ...previous, ...options };
    return previous;
  }

  public getLevel(): LogThreshold {
    return this.options.level;
  }

  private formatMessage(level: LogLevel, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const message = args.map(renderArg).join(' ');

    if (this.options.format === LOG_FORMAT_JSON) {
      return JSON.stringify({ ts: timestamp, level, msg: message });
    }
    return `[${timestamp}] [${level.toUpperCase()}] - ${message}`;
  }

  private write(level: LogLevel, args: any[]): void {
    if (!admits(this.options.level, level)) {
      return;
    }
    this.options.sink(level, this.formatMessage(level, ...args));
  }

  log(...args: any[]): void {
    this.write('log', args);
  }

  info(...args: any[]): void {
    this.write('info', args);
  }

  warn(...args: any[]): void {
    this.write('warn', args);
  }

  error(...args: any[]): void {
    this.write('error', args);
  }

  debug(...args: any[]): void {
    this.write('debug', args);
  }
}
