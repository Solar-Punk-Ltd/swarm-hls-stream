import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '../../../..');
dotenv.config({ path: path.join(rootDir, '.env') });

export function loadEngineEnv(engineName: string): void {
  dotenv.config({ path: path.join(rootDir, 'engines', engineName, '.env') });
}

/**
 * Value of a mandatory environment variable.
 *
 * Absent and present-but-empty are reported differently on purpose. Compose supplies several of
 * these as `${VAR:-}`, so the variable is present and empty far more often than it is missing, and
 * "missing" sends an operator looking for a key that is already in their `.env`.
 */
export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  if (value === '') {
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

export interface IntRange {
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
export function optionalInt(name: string, fallback: number, range: IntRange = {}): number {
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
