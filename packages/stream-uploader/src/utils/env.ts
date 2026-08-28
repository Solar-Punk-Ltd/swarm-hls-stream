import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '../../../..');
dotenv.config({ path: path.join(rootDir, '.env') });

/**
 * The selected engine's own `.env`, loaded here rather than later from `loadEngines()`.
 *
 * `config.ts` reads `process.env` once at import, so anything loaded after that is invisible to
 * it. The ABR ladder is configured on the engine and needed by the uploader, which puts it on the
 * wrong side of that line unless it lands before `config` is evaluated. `dotenv` never overrides
 * an already-set variable, so a value from the real environment still wins.
 */
export function loadEngineEnv(engineName: string): void {
  dotenv.config({ path: path.join(rootDir, 'engines', engineName, '.env') });
}

if (process.env.ENGINE) {
  loadEngineEnv(process.env.ENGINE);
}

/**
 * Value of a mandatory environment variable.
 *
 * Absent and present-but-empty are reported differently on purpose. Compose supplies several of
 * these as `${VAR:-}`, so the variable is present and empty far more often than it is missing, and
 * "missing" sends an operator looking for a key that is already in their `.env`.
 *
 * Whitespace counts as empty, because the callers are `API_AUTH_TOKEN`, `SRS_WEBHOOK_TOKEN` and
 * `OME_ADMISSION_SECRET` among others: a quoted `.env` value and an interpolated compose variable
 * both survive dotenv as whitespace, and a service that starts on a one-space auth token reports
 * itself configured while accepting a secret anyone would guess. The value itself is returned
 * unpadded rather than trimmed, since a secret's whitespace may be deliberate.
 */
export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  if (value.trim() === '') {
    throw new Error(`Required env var is set but empty: ${name}`);
  }
  return value;
}

export function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * `setTimeout` stores its delay in 32 bits. A larger one wraps and fires almost immediately, which is
 * indistinguishable from a correctly applied short delay everywhere except in the operator's intent.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Inclusive bounds, shared by `optionalInt` and `optionalNumber` because the pair is the same. */
export interface NumericRange {
  min?: number;
  max?: number;
}

/**
 * Value of an optional integer environment variable, rejected at startup rather than at first use.
 *
 * Strict about the whole string, because `parseInt` reads the longest numeric prefix and discards the
 * rest: `1e4` becomes 1, `10_000` becomes 10 and `10s` becomes 10, each a value the operator never
 * wrote and each short enough as a timeout to break the thing it configures. Range-checked for the
 * same reason, since a delay past `MAX_TIMER_DELAY_MS` fires at once and a zero-length abort window
 * cancels every request it is supposed to protect.
 *
 * Throwing beats falling back for an integer, because every one of them here is a size or a duration
 * and a wrong one disables the thing it configures rather than tuning it. `optionalBool` below still
 * warns and falls back, which is a deliberate difference rather than an oversight: its one caller,
 * `OME_ADMISSION_FAIL_OPEN`, falls back to the safe direction, and a typo there costs rejected ingest
 * during an outage rather than a service that will not start.
 */
export function optionalInt(name: string, fallback: number, range: NumericRange = {}): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error(`Env var ${name} is not a whole number: "${value}"`);
  }

  // Whatever got past the check above is digits padded with at most the whitespace `Number` already
  // skips, so this trim changes no result. It is here so both lines read the same value.
  const parsed = Number(value.trim());
  const min = range.min ?? 0;
  const max = range.max ?? MAX_TIMER_DELAY_MS;

  if (parsed < min) {
    throw new Error(`Env var ${name} must be at least ${min}, got ${parsed}`);
  }
  if (parsed > max) {
    throw new Error(`Env var ${name} must be at most ${max}, got ${parsed}`);
  }

  return parsed;
}

/**
 * Value of an optional environment variable that may carry decimals, rejected at startup.
 *
 * `optionalInt` next door covers every size and duration this service reads. This one exists for a
 * token amount, where the useful settings are fractions: the shipped chequebook floor is 0.5 BZZ and
 * `optionalInt` refuses that as not a whole number.
 *
 * Strict about the whole string for the same reason `optionalInt` is, and then stricter in two
 * places. `Number('')` and `Number(' ')` are both 0, so a coercion-only reader turns a blank setting
 * into the one value that disables the check it configures. Exponent and hex notation are refused
 * even though `Number` reads them, because the value is a quantity an operator reads back off a log
 * line and compares against a wallet, and `1e-2 BZZ` is not a reading anyone acts on.
 *
 * A `max` is not decoration here. The caller converts this into an integer count of base units by
 * multiplying, and a value large enough to overflow to `Infinity` crashes that conversion instead of
 * refusing the setting.
 */
export function optionalNumber(name: string, fallback: number, range: NumericRange = {}): number {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    return fallback;
  }

  const written = value.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(written)) {
    throw new Error(`Env var ${name} is not a number: "${value}"`);
  }

  const parsed = Number(written);
  const min = range.min ?? 0;
  const max = range.max ?? Number.MAX_SAFE_INTEGER;

  if (parsed < min) {
    throw new Error(`Env var ${name} must be at least ${min}, got ${parsed}`);
  }
  if (parsed > max) {
    throw new Error(`Env var ${name} must be at most ${max}, got ${parsed}`);
  }

  return parsed;
}

export function optionalBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  console.warn(`Invalid boolean for env var ${name}: "${value}", using fallback ${fallback}`);
  return fallback;
}
