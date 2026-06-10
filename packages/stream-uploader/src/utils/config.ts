import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// In local dev, load .env from monorepo root.
// In Docker, env vars are injected directly (no .env file needed).
const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '../../../..');
dotenv.config({ path: path.join(rootDir, '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value ? value === 'true' || value === '1' : fallback;
}

export const config = {
  beeUrl: required('BEE_URL'),
  stamp: required('STAMP'),
  streamKey: required('STREAM_KEY'),
  streamListTopic: required('STREAM_LIST_TOPIC'),
  manifestAccessUrl: optional('MANIFEST_ACCESS_URL', ''),
  apiPort: optionalInt('API_PORT', 3000),
  stateDir: optional('STATE_DIR', './state'),
  maxQueueSize: optionalInt('MAX_QUEUE_SIZE', 100),
  recoveryTimeout: optionalInt('RECOVERY_TIMEOUT', 60000),
  engine: optional('ENGINE', ''),
  mediaPath: optional('MEDIA_PATH', './media'),
  omeHlsUrl: optional('OME_HLS_URL', 'http://ome:8081'),
  omeHlsPollIntervalMs: optionalInt('OME_HLS_POLL_INTERVAL_MS', 500),
  omeAdmissionSecret: optional('OME_ADMISSION_SECRET', ''),
  omeAdmissionFailOpen: optionalBool('OME_ADMISSION_FAIL_OPEN', false),
};
