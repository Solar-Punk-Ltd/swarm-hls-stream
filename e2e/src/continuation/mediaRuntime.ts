import { spawn } from 'node:child_process';

import type { BoundedCommand } from './dockerCli.js';
import { FixtureRefusal } from './fixture.js';
import type {
  MediaScenarioFetch,
  MediaScenarioFetchRequest,
  MediaScenarioFetchResponse,
  MediaScenarioProcess,
  MediaScenarioProcessInvocation,
  MediaScenarioProcessResult,
  MediaScenarioSpawn,
} from './mediaScenario.js';

const SAFE_CONTAINER_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LoopbackMediaScenarioFetchOptions {
  secrets: ReadonlyMap<string, string>;
  fetch?: Fetch;
}

/** Calls only loopback owner APIs and never returns the routed session credential. */
export class LoopbackMediaScenarioFetch implements MediaScenarioFetch {
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: LoopbackMediaScenarioFetchOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async fetch(request: MediaScenarioFetchRequest): Promise<MediaScenarioFetchResponse> {
    const url = loopbackUrl(request.url);
    const cookie = secret(this.options.secrets, request.authReference);
    if (!Number.isSafeInteger(request.maxResponseBytes) || request.maxResponseBytes < 1 || request.maxResponseBytes > MAX_REQUEST_BYTES) {
      throw new FixtureRefusal('media control response bound is invalid');
    }
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        throw new FixtureRefusal('media control request exceeded its byte bound');
      }
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: 'application/json',
          cookie,
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'x-requested-with': 'web2-admin',
              }),
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new FixtureRefusal('media control request failed without exposing request data');
    }
    const bytes = await boundedResponseBody(response, request.maxResponseBytes);
    let parsed: unknown;
    try {
      parsed = bytes.byteLength === 0 ? null : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new FixtureRefusal('media control response is not bounded JSON');
    }
    return { status: response.status, body: parsed };
  }
}

export interface InteractiveProcessInput {
  file: string;
  args: readonly string[];
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface InteractiveProcessHandle {
  completion: Promise<MediaScenarioProcessResult>;
  stopClient(): Promise<void>;
}

export interface InteractiveProcessLauncher {
  start(input: InteractiveProcessInput): Promise<InteractiveProcessHandle>;
}

export class NodeInteractiveProcessLauncher implements InteractiveProcessLauncher {
  async start(input: InteractiveProcessInput): Promise<InteractiveProcessHandle> {
    const child = spawn(input.file, [...input.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stopped = false;
    let exceeded = false;
    let timedOut = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > input.maxOutputBytes) {
        exceeded = true;
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => {});
    child.stdin.end(input.stdin);
    const closed = new Promise<void>((resolve) => {
      child.once('error', () => resolve());
      child.once('close', () => resolve());
    });
    const completion = new Promise<MediaScenarioProcessResult>((resolve, reject) => {
      child.on('error', () => reject(new FixtureRefusal('media process could not start')));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut || exceeded) {
          reject(new FixtureRefusal(timedOut ? 'media process timed out' : 'media process exceeded its output byte bound'));
          return;
        }
        resolve({
          code,
          signal,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
    void completion.catch(() => undefined);
    return {
      completion,
      stopClient: async () => {
        if (!stopped) {
          stopped = true;
          child.kill('SIGKILL');
        }
        await closed;
      },
    };
  }
}

export interface DockerMediaScenarioSpawnOptions {
  senderContainerId: string;
  secrets: ReadonlyMap<string, string>;
  command: BoundedCommand;
  launcher?: InteractiveProcessLauncher;
}

type OwnedInvocationStatus = 'launching' | 'running' | 'completed' | 'failed' | 'stopping' | 'stopped' | 'stop-failed';

interface OwnedInvocation {
  status: OwnedInvocationStatus;
  handle?: InteractiveProcessHandle;
  stopPromise?: Promise<void>;
}

/** Runs FFmpeg in the exact journal-owned sender and routes secret bytes only through stdin. */
export class DockerMediaScenarioSpawn implements MediaScenarioSpawn {
  private readonly launcher: InteractiveProcessLauncher;
  private activeInvocation?: OwnedInvocation;
  private restartRequired = false;

  constructor(private readonly options: DockerMediaScenarioSpawnOptions) {
    if (!SAFE_CONTAINER_ID.test(options.senderContainerId)) {
      throw new FixtureRefusal('media sender container identity is malformed');
    }
    this.launcher = options.launcher ?? new NodeInteractiveProcessLauncher();
  }

  async spawn(invocation: MediaScenarioProcessInvocation): Promise<MediaScenarioProcess> {
    if (
      invocation.file !== '/usr/bin/ffmpeg' ||
      !Number.isSafeInteger(invocation.timeoutMs) ||
      invocation.timeoutMs < 1 ||
      invocation.timeoutMs > 10 * 60_000 ||
      !Number.isSafeInteger(invocation.maxOutputBytes) ||
      invocation.maxOutputBytes < 1 ||
      invocation.maxOutputBytes > 1024 * 1024
    ) {
      throw new FixtureRefusal('media process invocation is outside its bounds');
    }
    const references: string[] = [];
    for (const argument of invocation.args) {
      if (typeof argument === 'string') {
        if (argument.length > 16 * 1024) {
          throw new FixtureRefusal('media process argument exceeds its byte bound');
        }
        continue;
      }
      for (const segment of argument.segments) {
        if (segment.kind === 'secret-reference' && !references.includes(segment.reference)) {
          references.push(segment.reference);
        }
      }
    }
    const secretValues = references.map((reference) => secret(this.options.secrets, reference));
    const script = ffmpegShellScript(invocation, references);
    this.assertAvailable();
    const owned: OwnedInvocation = { status: 'launching' };
    this.activeInvocation = owned;
    let handle: InteractiveProcessHandle;
    try {
      if (this.restartRequired) {
        await this.options.command.run('docker', ['container', 'start', this.options.senderContainerId]);
        this.restartRequired = false;
      }
      handle = await this.launcher.start({
        file: 'docker',
        args: ['exec', '-i', this.options.senderContainerId, '/bin/sh', '-c', script],
        stdin: secretValues.map((value) => `${value}\n`).join(''),
        timeoutMs: invocation.timeoutMs,
        maxOutputBytes: invocation.maxOutputBytes,
      });
    } catch (error) {
      if (this.activeInvocation === owned) {
        this.activeInvocation = undefined;
      }
      throw error;
    }
    owned.handle = handle;
    owned.status = 'running';
    void handle.completion.then(
      (result) => this.complete(owned, result.code === 0 && !result.signal),
      () => this.complete(owned, false),
    );
    return {
      wait: () => handle.completion,
      stop: () => this.stop(owned),
    };
  }

  assertIdle(): void {
    if (this.activeInvocation) {
      throw new FixtureRefusal('media sender is not idle');
    }
  }

  private assertAvailable(): void {
    if (this.activeInvocation?.status === 'stopping' || this.activeInvocation?.status === 'stop-failed') {
      throw new FixtureRefusal('media sender stop is unresolved');
    }
    if (this.activeInvocation) {
      throw new FixtureRefusal('media sender already owns an active invocation');
    }
  }

  private complete(owned: OwnedInvocation, successful: boolean): void {
    if (owned.status !== 'running') {
      return;
    }
    owned.status = successful ? 'completed' : 'failed';
    if (!successful) {
      return;
    }
    if (this.activeInvocation === owned) {
      this.activeInvocation = undefined;
    }
  }

  private stop(owned: OwnedInvocation): Promise<void> {
    if (owned.stopPromise) {
      return owned.stopPromise;
    }
    if (owned.status === 'completed' || owned.status === 'stopped') {
      return Promise.resolve();
    }
    if ((owned.status !== 'running' && owned.status !== 'failed') || !owned.handle) {
      return Promise.reject(new FixtureRefusal('media sender invocation cannot be stopped from its current state'));
    }
    owned.status = 'stopping';
    owned.stopPromise = this.stopOwnedInvocation(owned, owned.handle);
    return owned.stopPromise;
  }

  private async stopOwnedInvocation(owned: OwnedInvocation, handle: InteractiveProcessHandle): Promise<void> {
    let remoteError: unknown;
    try {
      await this.options.command.run('docker', ['container', 'stop', '--time', '5', this.options.senderContainerId]);
    } catch (error) {
      remoteError = error;
    }
    let clientError: unknown;
    try {
      await handle.stopClient();
    } catch (error) {
      clientError = error;
    }
    if (remoteError !== undefined || clientError !== undefined) {
      owned.status = 'stop-failed';
      if (remoteError !== undefined) {
        throw remoteError;
      }
      throw new FixtureRefusal('media process client did not close after sender stop');
    }
    owned.status = 'stopped';
    this.restartRequired = true;
    if (this.activeInvocation === owned) {
      this.activeInvocation = undefined;
    }
  }
}

function ffmpegShellScript(invocation: MediaScenarioProcessInvocation, references: readonly string[]): string {
  const reads = references.map((_, index) => `IFS= read -r secret_${index} || exit 90`).join('\n');
  const args = invocation.args.map((argument) => {
    if (typeof argument === 'string') {
      return shellQuoted(argument);
    }
    const value = argument.segments.map((segment) => {
      if (segment.kind === 'literal') {
        return doubleQuotedPart(segment.value);
      }
      const index = references.indexOf(segment.reference);
      if (index < 0) {
        throw new FixtureRefusal('media process secret reference is unresolved');
      }
      return `\${secret_${index}}`;
    }).join('');
    return `"${value}"`;
  }).join(' ');
  return `${reads}${reads === '' ? '' : '\n'}exec /usr/bin/ffmpeg ${args}`;
}

function secret(secrets: ReadonlyMap<string, string>, reference: string): string {
  const value = secrets.get(reference);
  if (
    value === undefined ||
    value.length < 1 ||
    Buffer.byteLength(value) > MAX_SECRET_BYTES ||
    /[\r\n\0]/.test(value)
  ) {
    throw new FixtureRefusal('fixture secret reference is missing or malformed');
  }
  return value;
}

function loopbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FixtureRefusal('media control URL is malformed');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new FixtureRefusal('media control URL must be an uncredentialed loopback endpoint');
  }
  return url;
}

async function boundedResponseBody(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    length += next.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new FixtureRefusal('media control response exceeded its byte bound');
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function doubleQuotedPart(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`');
}
