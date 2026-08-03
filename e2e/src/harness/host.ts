import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { containerName, type E2EConfig } from '../config.js';

import { sleep, waitFor } from './wait.js';

const execFileAsync = promisify(execFile);

/** A bee node's stamp `usable` flag lags for tens of seconds after a restart (batch re-sync). */
const STAMP_READY_TIMEOUT_MS = 60_000;

const DEFAULT_CONNECT_TIMEOUT_S = 10;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** ssh transport failure (couldn't connect / connection dropped) — distinct from a remote command's own exit code. */
const SSH_TRANSPORT_EXIT = 255;

/**
 * Where the shared ssh master socket lives.
 *
 * Under `~/.ssh` rather than `/tmp`, and keyed with `%C` rather than `%h-%p`, both for the reason
 * `ssh_config(5)` gives: a control path should be in a directory no other user can write to, and
 * should distinguish the remote user as well as the host and port.
 *
 * `/tmp/e2e-cm-%h-%p` was neither. `/tmp` is world-writable and the name was guessable from a
 * documented default, so any local user with a different uid could pre-create a listening socket
 * there and be dialed first: the client tries an existing master at that path before it even
 * resolves the target host, and performs no ownership check on the socket it connects to. The
 * squatter then supplies stdout, stderr and the exit status of every command, so the whole
 * fault-injection suite reports green with no container ever stopped, and the chequebook preflight
 * can be made to report a deposit that never happened. Demonstrated end to end against this code by
 * the security lens with a responder speaking the ssh multiplexing protocol.
 */
const CONTROL_PATH = '~/.ssh/e2e-cm-%C';

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Subset of the bee `/stamps` entry shape the harness relies on. */
export interface Stamp {
  batchID: string;
  utilization: number;
  usable: boolean;
  depth: number;
  amount: string;
  bucketDepth: number;
  immutableFlag: boolean;
  exists: boolean;
  batchTTL: number;
}

export interface UploaderHealth {
  status: string;
  activeStreams: number;
  staleManifestStreams: number;
  queuePressure: string;
  engines: string[];
}

/**
 * Thin ssh wrapper around a deployed host — the transport for attach-mode tests. Every method
 * shells out to `ssh <target> <cmd>`, so it needs the target in ~/.ssh/config (same as manual use).
 */
export class Host {
  constructor(
    private readonly sshTarget: string,
    private readonly connectTimeoutS: number = DEFAULT_CONNECT_TIMEOUT_S,
  ) {}

  private sshArgs(remoteCommand: string): string[] {
    // Multiplex every call over one shared master connection: rapid poll loops would otherwise open
    // dozens of fresh handshakes, and a single refused handshake mid-test would fail a poll.
    return [
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${CONTROL_PATH}`,
      '-o',
      'ControlPersist=30s',
      '-o',
      `ConnectTimeout=${this.connectTimeoutS}`,
      this.sshTarget,
      remoteCommand,
    ];
  }

  async run(remoteCommand: string, timeoutMs: number = DEFAULT_RUN_TIMEOUT_MS): Promise<RunResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout, stderr } = await execFileAsync('ssh', this.sshArgs(remoteCommand), {
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
        });
        return { stdout, stderr };
      } catch (error) {
        lastError = error;
        // Retry only transport failures — a remote command's own non-zero exit must surface as-is.
        if ((error as { code?: number }).code !== SSH_TRANSPORT_EXIT) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw lastError;
  }

  stop(container: string): Promise<RunResult> {
    return this.run(`docker stop ${container}`);
  }

  start(container: string): Promise<RunResult> {
    return this.run(`docker start ${container}`);
  }

  /** Immediate SIGKILL — closer to a hard crash than the graceful `stop`. */
  kill(container: string): Promise<RunResult> {
    return this.run(`docker kill ${container}`);
  }

  pause(container: string): Promise<RunResult> {
    return this.run(`docker pause ${container}`);
  }

  unpause(container: string): Promise<RunResult> {
    return this.run(`docker unpause ${container}`);
  }

  restart(container: string): Promise<RunResult> {
    return this.run(`docker restart ${container}`);
  }

  async isRunning(container: string): Promise<boolean> {
    const { stdout } = await this.run(
      `docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null || echo missing`,
    );
    return stdout.trim() === 'true';
  }

  /**
   * A container's environment as docker reports it.
   *
   * The suite reads the deployment's `LOG_LEVEL` from here rather than from the env files it
   * resolved, because a container keeps the environment it was started with: an env file edited
   * after the last deploy describes an intention, and what the log actually contains is decided by
   * the running process.
   */
  async containerEnv(container: string): Promise<Record<string, string>> {
    const { stdout } = await this.run(`docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${container}`);
    const env: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) {
        env[line.slice(0, separator)] = line.slice(separator + 1);
      }
    }
    return env;
  }

  async logs(container: string, tail: number = 200): Promise<string> {
    const { stdout } = await this.run(`docker logs --tail ${tail} ${container} 2>&1`);
    return stdout;
  }

  /** docker logs since an RFC3339 instant — scopes assertions to a single test's stream session. */
  async logsSince(container: string, sinceIso: string): Promise<string> {
    const { stdout } = await this.run(`docker logs --since ${sinceIso} ${container} 2>&1`);
    return stdout;
  }

  /** UTC instant from the host's own clock (avoids mac↔host skew when paired with logsSince). */
  async nowIso(): Promise<string> {
    const { stdout } = await this.run('date -u +%Y-%m-%dT%H:%M:%SZ');
    return stdout.trim();
  }

  /** curl a localhost port on the host and parse JSON (uploader /health, bee /stamps, …). */
  async localJson<T>(port: number, path: string, timeoutS: number = 5): Promise<T> {
    return this.curlJson<T>('GET', port, path, timeoutS);
  }

  /**
   * POST to a localhost port and parse the JSON reply. On-chain bee calls (e.g. chequebook deposit)
   * can take far longer than a read, hence the generous default timeout. Not idempotent: `run` may
   * retry the underlying ssh on a transport drop, so callers must tolerate at-least-once delivery.
   */
  async localPost<T>(port: number, path: string, timeoutS: number = 120): Promise<T> {
    return this.curlJson<T>('POST', port, path, timeoutS);
  }

  private async curlJson<T>(method: 'GET' | 'POST', port: number, path: string, timeoutS: number): Promise<T> {
    const methodFlag = method === 'POST' ? '-X POST ' : '';
    // Keep the ssh run bound above curl's own deadline so --max-time is what fires first on a slow reply.
    const runTimeoutMs = Math.max(DEFAULT_RUN_TIMEOUT_MS, (timeoutS + 5) * 1_000);
    const { stdout } = await this.run(
      `curl -s ${methodFlag}--max-time ${timeoutS} http://localhost:${port}${path}`,
      runTimeoutMs,
    );
    const text = stdout.trim();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`non-JSON from ${method} :${port}${path} → ${text.slice(0, 200)}`);
    }
  }
}

export function makeHost(cfg: E2EConfig): Host {
  return new Host(cfg.sshTarget);
}

export function uploaderHealth(host: Host, cfg: E2EConfig): Promise<UploaderHealth> {
  return host.localJson<UploaderHealth>(cfg.ports.uploaderApi, '/health');
}

/** Discover the live upload stamp on the profile's bee-uploader, preferring the most TTL headroom. */
export async function discoverStamp(host: Host, cfg: E2EConfig): Promise<Stamp> {
  // Poll rather than fail on the first read: a scenario that restarts bee-uploader leaves its stamp
  // reporting usable=false for tens of seconds (batch re-sync) even though uploads already work, and
  // that must not poison the next test's discovery.
  const deadline = Date.now() + STAMP_READY_TIMEOUT_MS;
  let lastSeen = 'no response';
  for (;;) {
    try {
      const body = await host.localJson<{ stamps: Stamp[] }>(cfg.ports.beeUploaderApi, '/stamps');
      const usable = (body.stamps ?? []).filter((s) => s.usable && s.exists);
      if (usable.length > 0) {
        return usable.sort((a, b) => b.batchTTL - a.batchTTL)[0];
      }
      lastSeen = `${(body.stamps ?? []).length} stamp(s), none usable+exists yet`;
    } catch (error) {
      lastSeen = (error as Error).message;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `no usable stamp on ${containerName(cfg, 'bee-uploader')} (:${cfg.ports.beeUploaderApi}) ` +
          `after ${STAMP_READY_TIMEOUT_MS}ms — last: ${lastSeen}`,
      );
    }
    await sleep(3_000);
  }
}

/** bee's on-chain SWAP chequebook balances, as PLUR integer strings (1 BZZ = 1e16 PLUR). */
export interface ChequebookBalance {
  totalBalance: string;
  availableBalance: string;
}

/** Read the bee-uploader node's SWAP chequebook balance (bandwidth funds, distinct from postage stamps). */
export function chequebookBalance(host: Host, cfg: E2EConfig): Promise<ChequebookBalance> {
  return host.localJson<ChequebookBalance>(cfg.ports.beeUploaderApi, '/chequebook/balance');
}

/**
 * Block until the uploader reports no active streams. The scenarios share one live path on one
 * profile and must run serially (--test-concurrency=1); this guards each test's start against the
 * previous test's stream still draining, which would otherwise be rejected as "already active".
 */
export async function waitForIdle(host: Host, cfg: E2EConfig, timeoutMs: number = 90_000): Promise<void> {
  await waitFor(async () => (await uploaderHealth(host, cfg)).activeStreams === 0, {
    timeoutMs,
    intervalMs: 2_000,
    label: 'uploader idle (activeStreams=0) before starting a new stream',
  });
}
