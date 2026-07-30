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

export function optionalInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`Invalid integer for env var ${name}: "${value}", using fallback ${fallback}`);
    return fallback;
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
