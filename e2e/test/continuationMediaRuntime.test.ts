import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoundedCommand, CommandResult } from '../src/continuation/dockerCli.js';
import type { MediaScenarioProcessInvocation } from '../src/continuation/mediaScenario.js';
import {
  DockerMediaScenarioSpawn,
  type InteractiveProcessInput,
  type InteractiveProcessLauncher,
  LoopbackMediaScenarioFetch,
} from '../src/continuation/mediaRuntime.js';

const SECRET = 'synthetic-owner-cookie';

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
    assert.equal(new Headers(calls[0]?.init.headers).get('x-requested-with'), 'streaming-infra-manager');
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

  it('keeps publish secrets out of Docker argv and stops the exact sender container', async () => {
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
    const result = await process.wait();
    await process.stop();

    assert.equal(result.code, 0);
    const launched = launcher.inputs[0];
    assert.ok(launched);
    const argv = [launched.file, ...launched.args].join(' ');
    assert.doesNotMatch(argv, /synthetic-publish-secret|synthetic-srt-secret/);
    assert.match(launched.stdin, /synthetic-publish-secret/);
    assert.match(launched.stdin, /synthetic-srt-secret/);
    assert.deepEqual(command.calls, [['container', 'stop', '--time', '5', 'sender-container-id']]);
  });
});
