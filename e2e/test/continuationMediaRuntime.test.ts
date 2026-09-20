import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoundedCommand, CommandResult } from '../src/continuation/dockerCli.js';
import {
  DockerMediaScenarioSpawn,
  type InteractiveProcessHandle,
  type InteractiveProcessInput,
  type InteractiveProcessLauncher,
  LoopbackMediaScenarioFetch,
  NodeInteractiveProcessLauncher,
} from '../src/continuation/mediaRuntime.js';
import type { MediaScenarioProcessInvocation } from '../src/continuation/mediaScenario.js';

const SECRET = 'synthetic-owner-cookie';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function successfulProcessResult(): CommandResult {
  return { stdout: '', stderr: '' };
}

function mediaProcessResult() {
  return { code: 0, signal: null, stdout: new Uint8Array(), stderr: '' } as const;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class ControlledHandle implements InteractiveProcessHandle {
  readonly completionResult = deferred<ReturnType<typeof mediaProcessResult>>();
  readonly completion = this.completionResult.promise;
  stopClientCalls = 0;

  constructor(private readonly stopGate: Promise<void> = Promise.resolve()) {}

  async stopClient(): Promise<void> {
    this.stopClientCalls += 1;
    await this.stopGate;
  }
}

class ControlledLauncher implements InteractiveProcessLauncher {
  readonly inputs: InteractiveProcessInput[] = [];
  private readonly handles: ControlledHandle[] = [];

  enqueue(handle: ControlledHandle): void {
    this.handles.push(handle);
  }

  async start(input: InteractiveProcessInput): Promise<InteractiveProcessHandle> {
    this.inputs.push(structuredClone(input));
    const handle = this.handles.shift();
    assert.ok(handle, 'a controlled process handle must be queued before spawn');
    return handle;
  }
}

class ControlledCommand implements BoundedCommand {
  readonly calls: string[][] = [];
  private readonly outcomes: Array<Promise<CommandResult>> = [];

  enqueue(outcome: Promise<CommandResult>): void {
    this.outcomes.push(outcome);
  }

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    assert.equal(file, 'docker');
    this.calls.push([...args]);
    return await (this.outcomes.shift() ?? Promise.resolve(successfulProcessResult()));
  }
}

class RecordingLauncher implements InteractiveProcessLauncher {
  readonly inputs: InteractiveProcessInput[] = [];

  async start(input: InteractiveProcessInput) {
    this.inputs.push(structuredClone(input));
    return {
      completion: Promise.resolve({ code: 0, signal: null, stdout: new Uint8Array([1, 2, 3]), stderr: 'bounded' }),
      stopClient: async () => {},
    };
  }
}

class RecordingCommand implements BoundedCommand {
  readonly calls: string[][] = [];

  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    assert.equal(file, 'docker');
    this.calls.push([...args]);
    return { stdout: '', stderr: '' };
  }
}

describe('continuation media runtime adapters', () => {
  it('retains an early child failure until wait without an unhandled rejection', async () => {
    const launcher = new NodeInteractiveProcessLauncher();
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', recordUnhandled);
    try {
      const handle = await launcher.start({
        file: process.execPath,
        args: ['-e', "process.stdout.write('overflow'); setInterval(() => {}, 1_000)"],
        stdin: '',
        timeoutMs: 5_000,
        maxOutputBytes: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.deepEqual(unhandled, []);
      await assert.rejects(handle.completion, /output byte bound/);
      await handle.stopClient();
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }
  });

  it('waits for the real child to close after stopping the client', async () => {
    const launcher = new NodeInteractiveProcessLauncher();
    const handle = await launcher.start({
      file: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      stdin: '',
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    });
    let settled = false;
    void handle.completion.then(() => {
      settled = true;
    });

    await handle.stopClient();

    assert.equal(settled, true);
    const result = await handle.completion;
    assert.equal(result.signal, 'SIGKILL');
  });

  it('routes owner auth in process memory and bounds the loopback response', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const subject = new LoopbackMediaScenarioFetch({
      secrets: new Map([['fixture-auth:owner', SECRET]]),
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: structuredClone(init ?? {}) });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const response = await subject.fetch({
      url: 'http://127.0.0.1:18080/api/streams/one',
      method: 'POST',
      authReference: 'fixture-auth:owner',
      body: { requestId: 'synthetic-request' },
      maxResponseBytes: 1024,
    });

    assert.deepEqual(response, { status: 200, body: { ok: true } });
    assert.equal(new Headers(calls[0]?.init.headers).get('cookie'), SECRET);
    assert.equal(new Headers(calls[0]?.init.headers).get('x-requested-with'), 'web2-admin');
    assert.equal(JSON.stringify(response).includes(SECRET), false);
    await assert.rejects(
      subject.fetch({
        url: 'http://admin-api:9877/api/streams/one',
        method: 'GET',
        authReference: 'fixture-auth:owner',
        maxResponseBytes: 1024,
      }),
      /loopback/i,
    );
  });

  it('keeps publish secrets out of Docker argv', async () => {
    const launcher = new RecordingLauncher();
    const command = new RecordingCommand();
    const subject = new DockerMediaScenarioSpawn({
      senderContainerId: 'sender-container-id',
      secrets: new Map([
        ['fixture-auth:publish-key', 'synthetic-publish-secret'],
        ['fixture-auth:srt-passphrase', 'synthetic-srt-secret'],
      ]),
      launcher,
      command,
    });
    const invocation: MediaScenarioProcessInvocation = {
      purpose: 'publish',
      file: '/usr/bin/ffmpeg',
      args: [
        '-re',
        {
          kind: 'secret-template',
          segments: [
            { kind: 'literal', value: 'srt://srs:10011?streamid=#!::r=video/topic?key=' },
            { kind: 'secret-reference', reference: 'fixture-auth:publish-key' },
            { kind: 'literal', value: ',m=publish&passphrase=' },
            { kind: 'secret-reference', reference: 'fixture-auth:srt-passphrase' },
          ],
        },
      ],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      markerId: 'B',
      protocol: 'srt',
    };

    const process = await subject.spawn(invocation);
    await process.wait();
    const launched = launcher.inputs[0];
    assert.ok(launched);
    const argv = [launched.file, ...launched.args].join(' ');
    assert.doesNotMatch(argv, /synthetic-publish-secret|synthetic-srt-secret/);
    assert.match(launched.stdin, /synthetic-publish-secret/);
    assert.match(launched.stdin, /synthetic-srt-secret/);
    assert.deepEqual(command.calls, []);
  });

  it('makes concurrent stops wait for the same remote and local teardown', async () => {
    const remoteStop = deferred<CommandResult>();
    const localStop = deferred<void>();
    const launcher = new ControlledLauncher();
    const handle = new ControlledHandle(localStop.promise);
    launcher.enqueue(handle);
    const command = new ControlledCommand();
    command.enqueue(remoteStop.promise);
    const subject = new DockerMediaScenarioSpawn({
      senderContainerId: 'sender-container-id',
      secrets: new Map(),
      launcher,
      command,
    });
    const process = await subject.spawn({
      purpose: 'decode-video',
      file: '/usr/bin/ffmpeg',
      args: ['-version'],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    });
    let firstSettled = false;
    let secondSettled = false;

    const first = process.stop().then(() => {
      firstSettled = true;
    });
    const second = process.stop().then(() => {
      secondSettled = true;
    });
    await nextTurn();

    assert.equal(firstSettled, false);
    assert.equal(secondSettled, false);
    assert.equal(command.calls.length, 1);

    remoteStop.resolve(successfulProcessResult());
    await nextTurn();
    assert.equal(firstSettled, false);
    assert.equal(secondSettled, false);
    assert.equal(handle.stopClientCalls, 1);

    localStop.resolve();
    await Promise.all([first, second]);
    assert.equal(firstSettled, true);
    assert.equal(secondSettled, true);
  });

  it('reaps the local client and blocks another invocation after remote stop fails', async () => {
    const launcher = new ControlledLauncher();
    const handle = new ControlledHandle();
    launcher.enqueue(handle);
    launcher.enqueue(new ControlledHandle());
    const command = new ControlledCommand();
    command.enqueue(Promise.reject(new Error('synthetic remote stop failure')));
    const subject = new DockerMediaScenarioSpawn({
      senderContainerId: 'sender-container-id',
      secrets: new Map(),
      launcher,
      command,
    });
    const invocation: MediaScenarioProcessInvocation = {
      purpose: 'decode-video',
      file: '/usr/bin/ffmpeg',
      args: ['-version'],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    };
    const process = await subject.spawn(invocation);

    await assert.rejects(process.stop(), /synthetic remote stop failure/);

    assert.equal(handle.stopClientCalls, 1);
    await assert.rejects(subject.spawn(invocation), /stop.*unresolved/i);
    assert.equal(launcher.inputs.length, 1);
  });

  it('restarts the exact sender before an invocation that follows a successful stop', async () => {
    const launcher = new ControlledLauncher();
    launcher.enqueue(new ControlledHandle());
    launcher.enqueue(new ControlledHandle());
    const command = new ControlledCommand();
    const subject = new DockerMediaScenarioSpawn({
      senderContainerId: 'sender-container-id',
      secrets: new Map(),
      launcher,
      command,
    });
    const invocation: MediaScenarioProcessInvocation = {
      purpose: 'decode-video',
      file: '/usr/bin/ffmpeg',
      args: ['-version'],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    };
    const first = await subject.spawn(invocation);

    await first.stop();
    await subject.spawn(invocation);

    assert.deepEqual(command.calls, [
      ['container', 'stop', '--time', '5', 'sender-container-id'],
      ['container', 'start', 'sender-container-id'],
    ]);
  });

  it('retains a failed encoder until remote stop and restart complete', async () => {
    const launcher = new ControlledLauncher();
    const firstHandle = new ControlledHandle();
    launcher.enqueue(firstHandle);
    launcher.enqueue(new ControlledHandle());
    const command = new ControlledCommand();
    const subject = new DockerMediaScenarioSpawn({
      senderContainerId: 'sender-container-id',
      secrets: new Map(),
      launcher,
      command,
    });
    const invocation: MediaScenarioProcessInvocation = {
      purpose: 'decode-video',
      file: '/usr/bin/ffmpeg',
      args: ['-version'],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    };
    const first = await subject.spawn(invocation);
    firstHandle.completionResult.reject(new Error('synthetic encoder failure'));

    await assert.rejects(first.wait(), /synthetic encoder failure/);
    await first.stop();
    await subject.spawn(invocation);

    assert.deepEqual(command.calls, [
      ['container', 'stop', '--time', '5', 'sender-container-id'],
      ['container', 'start', 'sender-container-id'],
    ]);
  });

  it('does not let a completed stale handle stop the current invocation', async () => {
    const launcher = new ControlledLauncher();
    const firstHandle = new ControlledHandle();
    const secondHandle = new ControlledHandle();
    launcher.enqueue(firstHandle);
    launcher.enqueue(secondHandle);
    const command = new ControlledCommand();
    const subject = new DockerMediaScenarioSpawn({
      senderContainerId: 'sender-container-id',
      secrets: new Map(),
      launcher,
      command,
    });
    const invocation: MediaScenarioProcessInvocation = {
      purpose: 'decode-video',
      file: '/usr/bin/ffmpeg',
      args: ['-version'],
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
    };
    const first = await subject.spawn(invocation);
    firstHandle.completionResult.resolve(mediaProcessResult());
    await first.wait();
    const second = await subject.spawn(invocation);

    await first.stop();

    assert.deepEqual(command.calls, []);
    assert.equal(firstHandle.stopClientCalls, 0);

    await second.stop();
    assert.deepEqual(command.calls, [['container', 'stop', '--time', '5', 'sender-container-id']]);
    assert.equal(secondHandle.stopClientCalls, 1);
  });
});
