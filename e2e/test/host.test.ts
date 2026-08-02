import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { Host } from '../src/harness/host.js';

/**
 * `Host.run` retries, and what it retries is the whole point. ssh answers 255 for its own transport
 * failures and otherwise passes the remote command's exit code through, so retrying on 255 survives
 * a dropped poll while retrying on anything else would run a `docker kill` twice.
 *
 * These tests put a stub ssh ahead of the real one on PATH. Nothing here can reach a host.
 */

const sandboxes: string[] = [];
const REAL_PATH = process.env.PATH ?? '';

after(() => {
  process.env.PATH = REAL_PATH;
  for (const dir of sandboxes) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Sandbox {
  /** One line per invocation, holding the arguments that invocation received. */
  invocations(): string[];
}

/**
 * A stub `ssh` that exits with `exitCodes[n]` on its n-th call (the last repeating), records its
 * own argv, and prints the remote command it was handed.
 */
function stubSsh(exitCodes: readonly number[]): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-ssh-'));
  sandboxes.push(dir);
  const journal = join(dir, 'invocations');
  const counter = join(dir, 'count');
  writeFileSync(journal, '');
  writeFileSync(counter, '0');

  const stub = [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(journal)}`,
    `n=$(cat ${JSON.stringify(counter)})`,
    `printf '%s' "$((n + 1))" > ${JSON.stringify(counter)}`,
    `codes=(${exitCodes.join(' ')})`,
    'index=$n',
    '[ "$index" -ge "${#codes[@]}" ] && index=$(( ${#codes[@]} - 1 ))',
    'code="${codes[$index]}"',
    '[ "$code" -eq 0 ] && printf \'%s\' "${*: -1}"',
    'exit "$code"',
  ].join('\n');

  const path = join(dir, 'ssh');
  writeFileSync(path, stub);
  chmodSync(path, 0o755);
  process.env.PATH = `${dir}:${REAL_PATH}`;

  return {
    invocations: () =>
      readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0),
  };
}

beforeEach(() => {
  process.env.PATH = REAL_PATH;
});

describe('Host.run retries transport failures', () => {
  it('retries once after ssh answers 255 and returns the second result', async () => {
    const sandbox = stubSsh([255, 0]);
    const result = await new Host('stub-target').run('echo hello');

    assert.equal(result.stdout, 'echo hello');
    assert.equal(sandbox.invocations().length, 2, 'a transport failure must be retried exactly once');
  });

  /**
   * The half that matters for safety. Every fault-injection call goes through `run`, so retrying a
   * remote command that genuinely failed would issue a second `docker kill` or `docker start`
   * against a container whose state the first call already changed.
   */
  it('does not retry a remote command that exited non-zero', async () => {
    const sandbox = stubSsh([1, 0]);
    await assert.rejects(new Host('stub-target').run('docker kill missing'));
    assert.equal(sandbox.invocations().length, 1, 'a remote failure was retried, so the command ran twice');
  });

  it('gives up after the second transport failure rather than looping', async () => {
    const sandbox = stubSsh([255]);
    await assert.rejects(new Host('stub-target').run('echo hello'));
    assert.equal(sandbox.invocations().length, 2);
  });

  it('does not retry a call that succeeded', async () => {
    const sandbox = stubSsh([0]);
    await new Host('stub-target').run('echo hello');
    assert.equal(sandbox.invocations().length, 1);
  });
});

describe('Host.run ssh arguments', () => {
  it('multiplexes over one shared connection and carries the command last', async () => {
    const sandbox = stubSsh([0]);
    await new Host('stub-target').run('docker ps');

    const argv = sandbox.invocations()[0];
    assert.match(argv, /ControlMaster=auto/, 'poll loops would otherwise open a handshake each time');
    assert.match(argv, /ControlPersist=30s/);
    assert.match(argv, /ConnectTimeout=10/);
    assert.match(argv, /stub-target docker ps$/, 'the target must precede the remote command');
  });

  it('honours a custom connect timeout', async () => {
    const sandbox = stubSsh([0]);
    await new Host('stub-target', 3).run('true');
    assert.match(sandbox.invocations()[0], /ConnectTimeout=3/);
  });
});

describe('Host container controls', () => {
  // `isRunning` has to answer false rather than throw for a container that is not there: the crash
  // scenario polls it while the container is genuinely absent, between the kill and the start.
  it('reports a missing container as not running', async () => {
    stubSsh([0]);
    assert.equal(await new Host('stub-target').isRunning('nope'), false);
  });

  for (const [method, expected] of [
    ['stop', 'docker stop c1'],
    ['start', 'docker start c1'],
    ['kill', 'docker kill c1'],
    ['pause', 'docker pause c1'],
    ['unpause', 'docker unpause c1'],
    ['restart', 'docker restart c1'],
  ] as const) {
    it(`${method} issues ${expected}`, async () => {
      const sandbox = stubSsh([0]);
      await new Host('stub-target')[method]('c1');
      assert.match(sandbox.invocations()[0], new RegExp(`${expected}$`));
    });
  }
});
