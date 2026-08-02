export const LOG_LEVEL_DEBUG = 'debug' as const;
export const LOG_LEVEL_LOG = 'log' as const;
export const LOG_LEVEL_INFO = 'info' as const;
export const LOG_LEVEL_WARN = 'warn' as const;
export const LOG_LEVEL_ERROR = 'error' as const;
export const LOG_LEVEL_SILENT = 'silent' as const;

export type LogLevel =
  | typeof LOG_LEVEL_DEBUG
  | typeof LOG_LEVEL_LOG
  | typeof LOG_LEVEL_INFO
  | typeof LOG_LEVEL_WARN
  | typeof LOG_LEVEL_ERROR;

/** A threshold, which is every level plus the one that admits nothing. */
export type LogThreshold = LogLevel | typeof LOG_LEVEL_SILENT;

export const LOG_FORMAT_TEXT = 'text' as const;
export const LOG_FORMAT_JSON = 'json' as const;

export type LogFormat = typeof LOG_FORMAT_TEXT | typeof LOG_FORMAT_JSON;

/**
 * Rank, low to high, so a threshold admits everything at or above it.
 *
 * `log` sits between `debug` and `info` rather than alongside one of them, because that is how this
 * service already uses the two: `log` is per-segment ("Segment 41 uploaded"), `info` is per
 * lifecycle event. Ranking them apart is what lets `LOG_LEVEL=info` drop a line per segment for
 * every live stream while keeping the ones that say what the service did.
 */
const RANK: Record<LogThreshold, number> = {
  [LOG_LEVEL_DEBUG]: 10,
  [LOG_LEVEL_LOG]: 20,
  [LOG_LEVEL_INFO]: 30,
  [LOG_LEVEL_WARN]: 40,
  [LOG_LEVEL_ERROR]: 50,
  [LOG_LEVEL_SILENT]: Number.POSITIVE_INFINITY,
};

/**
 * The threshold when nothing sets one.
 *
 * `debug` rather than a quieter production default, so adding level control changes what a
 * deployment prints by exactly nothing. Turning the volume down is an operator's decision and
 * belongs in a change that says so.
 */
export const DEFAULT_LOG_LEVEL: LogThreshold = LOG_LEVEL_DEBUG;

/**
 * An own-property check rather than `in`, because `in` walks the prototype chain.
 *
 * `LOG_LEVEL=constructor` (or `__proto__`, `toString`, `valueOf`) passed the `in` test, `RANK[level]`
 * then compared a number against a function, and every comparison is false for `NaN`. So the service
 * went **completely silent, including at `error`**, and the "not a log level" message that would
 * have explained it was suppressed by the same fault. The failure concealed its own cause.
 *
 * `hasOwnProperty.call` rather than `Object.hasOwn`, which needs an ES2022 lib and this package
 * targets ES2020. Moving the target is a decision for a change that says so.
 */
export function isLogThreshold(value: string): value is LogThreshold {
  return Object.prototype.hasOwnProperty.call(RANK, value);
}

export function admits(threshold: LogThreshold, level: LogLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

/** Every threshold an operator may set, for the message that lists them when one is wrong. */
export function logThresholds(): LogThreshold[] {
  return Object.keys(RANK) as LogThreshold[];
}
