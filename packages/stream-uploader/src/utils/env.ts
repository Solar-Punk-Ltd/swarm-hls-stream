import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '../../../..');
dotenv.config({ path: path.join(rootDir, '.env') });

export function loadEngineEnv(engineName: string): void {
  dotenv.config({ path: path.join(rootDir, 'engines', engineName, '.env') });
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
