import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

import { parsePublishers } from './publishers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Monorepo root — two levels up from packages/cli/src/lib/ */
const ROOT_DIR = resolve(__dirname, '../../../..');
const DEPLOY_DIR = resolve(ROOT_DIR, 'deploy');
const CONFIG_PATH = resolve(DEPLOY_DIR, 'config.json');
const ENV_PATH = resolve(ROOT_DIR, '.env');

export const SVC_BEE_UPLOADER = 'bee-uploader';
export const SVC_BEE_GATEWAY = 'bee-gateway';

const DEFAULT_BEE_UPLOADER_PORT = 1633;
const DEFAULT_BEE_GATEWAY_PORT = 1733;

interface DeployConfig {
  services: Record<string, string | false>;
}

export interface BeeTarget {
  url: string;
  host: string;
  port: number;
}

export function loadEnv(): void {
  loadDotenv({ path: ENV_PATH });
}

export function getEnvPath(): string {
  return ENV_PATH;
}

function readConfig(): DeployConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as DeployConfig;
  } catch {
    return { services: {} };
  }
}

const IP_OR_FQDN = /^(\d+\.\d+\.\d+\.\d+|.*\..+)$/;

/**
 * Extract the real hostname/IP from a target.
 * Handles "user@host", plain IPs, and SSH Host aliases.
 */
function hostFromTarget(target: string): string {
  const host = target.includes('@') ? target.split('@')[1] : target;

  // IP or FQDN — use directly
  if (IP_OR_FQDN.test(host)) return host;

  // SSH alias — resolve via `ssh -G`
  try {
    const output = execSync(`ssh -G ${host}`, { encoding: 'utf-8', timeout: 3000 });
    const match = output.match(/^hostname\s+(.+)$/m);
    if (match) return match[1];
  } catch {
    // ssh -G failed — fall through
  }

  return host;
}

/**
 * Resolve a bee node target from config.json + .env.
 * Returns null if the service is explicitly disabled.
 */
function resolveBeeTarget(
  service: string,
  portEnvVar: string,
  defaultPort: number,
  fallbackUrlEnvVar?: string,
): BeeTarget | null {
  const config = readConfig();
  const target = config.services[service];
  const port = parseInt(process.env[portEnvVar] || '', 10) || defaultPort;

  if (target === false || target === 'false') {
    return null;
  }

  // Missing from config — try fallback env var, then localhost
  if (!target || target === 'disabled') {
    if (fallbackUrlEnvVar) {
      const fallbackUrl = process.env[fallbackUrlEnvVar];
      if (fallbackUrl) {
        const parsed = new URL(fallbackUrl);
        return {
          url: fallbackUrl,
          host: parsed.hostname,
          port: parseInt(parsed.port, 10) || port,
        };
      }
    }
    return { url: `http://localhost:${port}`, host: 'localhost', port };
  }

  if (target === 'localhost') {
    return { url: `http://localhost:${port}`, host: 'localhost', port };
  }

  const host = hostFromTarget(target);
  return { url: `http://${host}:${port}`, host, port };
}

/**
 * Resolve bee-uploader target. Falls back to BEE_URL env var, then localhost.
 */
export function resolveBeeUploaderTarget(): BeeTarget {
  return (
    resolveBeeTarget(SVC_BEE_UPLOADER, 'BEE_UPLOADER_API_PORT', DEFAULT_BEE_UPLOADER_PORT, 'BEE_URL') ?? {
      url: `http://localhost:${DEFAULT_BEE_UPLOADER_PORT}`,
      host: 'localhost',
      port: DEFAULT_BEE_UPLOADER_PORT,
    }
  );
}

/**
 * Resolve bee-gateway target. Returns null if disabled.
 */
export function resolveBeeGatewayTarget(): BeeTarget | null {
  return resolveBeeTarget(SVC_BEE_GATEWAY, 'BEE_GATEWAY_API_PORT', DEFAULT_BEE_GATEWAY_PORT);
}

/** A node to act on, with the rung and batch it is configured for when it has them. */
export interface NamedTarget {
  name: string;
  /** Null when the service is explicitly disabled, which is still worth reporting. */
  target: BeeTarget | null;
  /** The rung this node publishes. Absent on the gateway and on an unsplit deployment. */
  rung?: string;
  /** The batch id configured for this node, from BEE_PUBLISHERS or STAMP. */
  stamp?: string;
}

function targetFromUrl(url: string, defaultPort: number): BeeTarget {
  try {
    const parsed = new URL(url);
    return { url, host: parsed.hostname, port: parseInt(parsed.port, 10) || defaultPort };
  } catch {
    return { url, host: url, port: defaultPort };
  }
}

/**
 * The nodes that hold postage batches, and therefore the ones every stamp command acts on.
 *
 * With BEE_PUBLISHERS set that is one node per rung — acting on only one of them would hide three
 * quarters of the batch and funding state, which is the whole thing splitting them exists to make
 * visible. Unset, it is the single uploader node, exactly as before.
 *
 * The gateway is deliberately absent: it runs with swap disabled and buys nothing.
 */
export function resolvePublisherTargets(): NamedTarget[] {
  const publishers = parsePublishers(process.env.BEE_PUBLISHERS);

  if (publishers.length > 0) {
    return publishers.map((publisher) => ({
      name: `bee-publisher-${publisher.rung}`,
      rung: publisher.rung,
      stamp: publisher.stamp,
      target: targetFromUrl(publisher.url, DEFAULT_BEE_UPLOADER_PORT),
    }));
  }

  return [{ name: SVC_BEE_UPLOADER, stamp: process.env.STAMP, target: resolveBeeUploaderTarget() }];
}

/**
 * Every node worth inspecting: the publishers, plus the gateway.
 *
 * The gateway is listed even when disabled, with a null target, because "the gateway is off" is
 * information a reader of `node-status` wants rather than an absence they have to notice.
 */
export function resolveNodeTargets(): NamedTarget[] {
  return [...resolvePublisherTargets(), { name: SVC_BEE_GATEWAY, target: resolveBeeGatewayTarget() }];
}
