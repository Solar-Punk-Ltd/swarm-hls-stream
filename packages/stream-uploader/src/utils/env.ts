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

export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
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
