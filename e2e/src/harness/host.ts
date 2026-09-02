import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// `import type` at statement level rather than an inline marker, because `config.ts` now imports
// DEFAULT_LOCAL_HOST_ADDRESS from here. Only this form is guaranteed to leave no runtime import
// behind, and `config.ts` applies the run profile at module scope, so a real cycle would decide when
// that happens by import order.
import type { E2EConfig } from '../config.js';

import type { PublisherRoute } from './publishers.js';
import { sleep, waitFor } from './wait.js';

const execFileAsync = promisify(execFile);

/**
 * A bee node's stamp `usable` flag lags for tens of seconds after a restart (batch re-sync).
 *
 * Exported because a refusal that says a node had no stamp has to say how long it was given, and the
 * stage gate in `stageStamps.ts` is the one composing that sentence.
 */
export const STAMP_READY_TIMEOUT_MS = 60_000;

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
  /** Why the status is what it is, as `deriveHealthStatus` named them. Empty on a healthy service. */
  reasons: string[];
  activeStreams: number;
  staleManifestStreams: number;
  queuePressure: string;
  quarantinedRecoveryEntries: number;
  engines: string[];
  /**
   * Which Bee node and postage batch each rung publishes through.
   *
   * Optional on this type and **not** because it is optional in practice. An uploader built before
   * the per-rung split answers without it, and a suite that treated the absence as "no publishers"
   * would report every deployment as identical, which is the exact blindness the field was added to
   * end. {@link nodesBehind} refuses an absent routing rather than reading it as an empty one.
   */
  publishers?: PublisherRoute[];
}

/**
 * The `E2E_SSH_TARGET` value meaning "this machine", so commands run through a shell rather than ssh.
 *
 * The bench has to publish and fetch from one machine, because that is what keeps the capture instant
 * and the fetch instant on one clock. Measured on 2026-08-03, publishing from a laptop to the
 * deployment cost about 15% of SRT packets, which lands almost entirely in the `segment` hop and made
 * the largest row in the report a property of the uplink. Running the whole bench on the deployment
 * host removes that path, and the host has no private key with which to ssh to itself.
 *
 * A distinct token rather than treating `localhost` this way, and the difference is not cosmetic.
 * `localhost` is the documented default of `E2E_SSH_TARGET`, so an operator who set nothing would go
 * from a failing `ssh localhost` to `docker stop` and `docker kill` running against whatever their own
 * machine happens to be running. This suite injects faults, so that default has to stay loud, and the
 * local transport has to be asked for.
 */
export const LOCAL_TARGET = 'local';

/**
 * Where the deployment's services are, seen from a container that shares the host's network.
 *
 * Which is what every bench and every viewer arm has been, so this was a literal until 2026-09-02.
 * A container given a network namespace of its own has nothing on its own loopback, and the
 * uploader, the four bee nodes and the client are then one hop away over the docker bridge. See
 * `E2E_LOCAL_HOST_ADDRESS` in `config.ts` and `--own-network` in `deploy/scripts/bench-on-host.sh`.
 */
export const DEFAULT_LOCAL_HOST_ADDRESS = 'localhost';

/**
 * Thin wrapper around a deployed host — the transport for attach-mode tests. Every method funnels
 * through `run`, which shells out to `ssh <target> <cmd>`, so it needs the target in ~/.ssh/config
 * (same as manual use). With `LOCAL_TARGET` it runs the same command line through `bash -c` instead.
 */
export class Host {
  constructor(
    private readonly sshTarget: string,
    private readonly connectTimeoutS: number = DEFAULT_CONNECT_TIMEOUT_S,
    private readonly localHostAddress: string = DEFAULT_LOCAL_HOST_ADDRESS,
  ) {}

  /**
   * Whether commands run in this process's own namespace. Paths valid over ssh (the deploy host's
   * filesystem) and paths valid here (this container's mounts) are different sets, and a caller
   * composing one for `run` has to know which set it is writing for.
   */
  get isLocal(): boolean {
    return this.sshTarget === LOCAL_TARGET;
  }

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
    if (this.sshTarget === LOCAL_TARGET) {
      // `bash -c` rather than a bare spawn, because every command built above is a shell line:
      // redirections, `||` fallbacks and `{{...}}` format strings all reach here unparsed. Not
      // retried either, since the retry above exists for a dropped ssh connection and there is no
      // connection to drop, so a non-zero exit here is the command's own and must surface at once.
      const { stdout, stderr } = await execFileAsync('bash', ['-c', remoteCommand], {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
      });
      return { stdout, stderr };
    }

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

  /**
   * docker logs bounded at both ends, which scopes an assertion to one fault rather than one run.
   *
   * ⛔ What {@link logsSince} cannot do. An arm that watches a viewer for six minutes reads six
   * minutes of uploader log, so anything the deployment does for its own reasons is counted against
   * the eight second fault the arm injected. Both bounds are RFC3339, so pass instants rather than
   * durations and derive them from the fault.
   */
  async logsBetween(container: string, sinceIso: string, untilIso: string): Promise<string> {
    const { stdout } = await this.run(`docker logs --since ${sinceIso} --until ${untilIso} ${container} 2>&1`);
    return stdout;
  }

  /** UTC instant from the host's own clock (avoids mac↔host skew when paired with logsSince). */
  async nowIso(): Promise<string> {
    const { stdout } = await this.run('date -u +%Y-%m-%dT%H:%M:%SZ');
    return stdout.trim();
  }

  /**
   * The authority a `local*` call dials, which is the host's own address as this process sees it.
   *
   * ⛔ Only the local transport gets the configured address. Over ssh the command runs ON the
   * deployment host, where the services genuinely are on loopback, so carrying a bridge address
   * across would name a machine that does not exist from there.
   */
  private get serviceAddress(): string {
    return this.isLocal ? this.localHostAddress : DEFAULT_LOCAL_HOST_ADDRESS;
  }

  /** curl a service port on the host and parse JSON (uploader /health, bee /stamps, …). */
  async localJson<T>(port: number, path: string, timeoutS: number = 5): Promise<T> {
    return this.curlJson<T>('GET', port, path, timeoutS);
  }

  /**
   * POST to a service port and parse the JSON reply. On-chain bee calls (e.g. chequebook deposit)
   * can take far longer than a read, hence the generous default timeout. Not idempotent: `run` may
   * retry the underlying ssh on a transport drop, so callers must tolerate at-least-once delivery.
   */
  async localPost<T>(port: number, path: string, timeoutS: number = 120): Promise<T> {
    return this.curlJson<T>('POST', port, path, timeoutS);
  }

  /**
   * curl a service port and hand back the body as it came.
   *
   * For the routes that answer something other than JSON. A rung's playlist comes back from
   * `GET /feeds/{owner}/{topic}` as the m3u8 text itself rather than wrapped in an envelope, so
   * {@link localJson} would throw on it.
   */
  async localText(port: number, path: string, timeoutS: number = 5): Promise<string> {
    const { stdout } = await this.curl('GET', port, path, timeoutS);
    return stdout;
  }

  private async curlJson<T>(method: 'GET' | 'POST', port: number, path: string, timeoutS: number): Promise<T> {
    const { stdout } = await this.curl(method, port, path, timeoutS);
    const text = stdout.trim();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`non-JSON from ${method} :${port}${path} → ${text.slice(0, 200)}`);
    }
  }

  private async curl(method: 'GET' | 'POST', port: number, path: string, timeoutS: number): Promise<RunResult> {
    const methodFlag = method === 'POST' ? '-X POST ' : '';
    // Keep the ssh run bound above curl's own deadline so --max-time is what fires first on a slow reply.
    const runTimeoutMs = Math.max(DEFAULT_RUN_TIMEOUT_MS, (timeoutS + 5) * 1_000);
    const url = `http://${this.serviceAddress}:${port}${path}`;
    return this.run(`curl -s ${methodFlag}--max-time ${timeoutS} ${url}`, runTimeoutMs);
  }
}

export function makeHost(cfg: E2EConfig): Host {
  return new Host(cfg.sshTarget, undefined, cfg.localHostAddress);
}

export function uploaderHealth(host: Host, cfg: E2EConfig): Promise<UploaderHealth> {
  return host.localJson<UploaderHealth>(cfg.ports.uploaderApi, '/health');
}

/** The best usable stamp one Bee node holds, or what that node last said instead of offering one. */
interface StampPoll {
  stamp: Stamp | null;
  /** The last thing the node answered before the poll gave up. Null once a stamp was found. */
  lastSeen: string | null;
}

/**
 * Poll one Bee node's `/stamps` until it offers a usable batch, preferring the most TTL headroom.
 *
 * Polls rather than failing on the first read, because a scenario that restarts a bee leaves its
 * stamp reporting `usable: false` for tens of seconds while the batch re-syncs, even though uploads
 * already work, and that must not poison the next test's discovery.
 *
 * Takes a port rather than the config, because a split deployment has one Bee node per rung and the
 * ports come off the routing the uploader reports. See {@link nodesBehind}.
 *
 * ⛔ Returns the failure rather than throwing it. `stageStamps.ts` reads every publisher node and has
 * to name all of the ones that cannot stamp, not stop at the first, so composing the message is the
 * caller's job.
 *
 * ⛔ This is the only stamp read left, and deliberately so. `discoverStamp` used to sit beside it and
 * ask the COORDINATOR alone, which on a stage with one Bee node per rung is an answer about one node
 * of four wearing a statement about the stage. Its last caller moved to `requireStageStamps` on
 * 2026-09-02 and it went with them, so nothing can reach for the single-node answer by accident.
 */
export async function pollUsableStamp(host: Host, port: number): Promise<StampPoll> {
  const deadline = Date.now() + STAMP_READY_TIMEOUT_MS;
  let lastSeen = 'no response';
  for (;;) {
    try {
      const body = await host.localJson<{ stamps: Stamp[] }>(port, '/stamps');
      const usable = (body.stamps ?? []).filter((s) => s.usable && s.exists);
      if (usable.length > 0) {
        return { stamp: usable.sort((a, b) => b.batchTTL - a.batchTTL)[0], lastSeen: null };
      }
      lastSeen = `${(body.stamps ?? []).length} stamp(s), none usable+exists yet`;
    } catch (error) {
      lastSeen = (error as Error).message;
    }
    if (Date.now() >= deadline) {
      return { stamp: null, lastSeen };
    }
    await sleep(3_000);
  }
}

/** bee's on-chain SWAP chequebook balances, as PLUR integer strings (1 BZZ = 1e16 PLUR). */
export interface ChequebookBalance {
  totalBalance: string;
  availableBalance: string;
}

/**
 * Read one bee node's SWAP chequebook balance (bandwidth funds, distinct from postage stamps).
 *
 * Takes a port rather than the config because a split deployment has one of these per rung, and the
 * ports come off the routing the uploader reports. See {@link nodesBehind}.
 */
export function chequebookBalance(host: Host, port: number): Promise<ChequebookBalance> {
  return host.localJson<ChequebookBalance>(port, '/chequebook/balance');
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
