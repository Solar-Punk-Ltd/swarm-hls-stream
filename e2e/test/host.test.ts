import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { Host, LOCAL_TARGET } from '../src/harness/host.js';

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
function stubSsh(exitCodes: readonly number[], stdout?: string): Sandbox {
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
    stdout === undefined
      ? '[ "$code" -eq 0 ] && printf \'%s\' "${*: -1}"'
      : `[ "$code" -eq 0 ] && printf '%s' ${JSON.stringify(stdout)}`,
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
    // Without ControlPath the default is `none` and ControlMaster=auto is inert, so leaving this
    // unasserted let the whole multiplexing claim be deleted with the suite still green.
    assert.match(argv, /ControlPath=\S+/, 'ControlMaster=auto does nothing without a ControlPath');
    // Not /tmp, and keyed per connection. A world-writable, guessable socket path can be squatted by
    // another local user, who is then dialed before the host is even resolved and supplies the
    // stdout, stderr and exit status of every command the suite runs.
    assert.doesNotMatch(argv, /ControlPath=\/tmp\//, 'the control socket must not sit in a world-writable directory');
    assert.match(argv, /ControlPath=[^ ]*%C/, 'the socket name must distinguish user, host and port');
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
  /**
   * Both answers have to be reachable, which they were not.
   *
   * The stub used to echo its own last argument, so `isRunning`'s stdout was always the `docker
   * inspect` command string and could never equal `true`. `false` was the only outcome the test
   * could see, and replacing the whole method body with `return false` left the suite green. That
   * matters in one direction: `uploader-crash-recovery` waits on `!isRunning(uploader)` before it
   * believes it crashed the container, and a method stuck on false satisfies that instantly, so the
   * scenario proceeds against an uploader that never went down.
   */
  it('reports a running container as running', async () => {
    stubSsh([0], 'true');
    assert.equal(await new Host('stub-target').isRunning('c1'), true);
  });

  // `docker inspect` on an absent container is answered by the `|| echo missing` fallback, and the
  // crash scenario polls this while the container is genuinely gone, between the kill and the start.
  it('reports a missing container as not running', async () => {
    stubSsh([0], 'missing');
    assert.equal(await new Host('stub-target').isRunning('nope'), false);
  });

  // Anything that is not exactly `true` means not running, including an empty or truncated read.
  it('does not read a partial answer as running', async () => {
    for (const answer of ['', 'tru', 'TRUE', 'false']) {
      stubSsh([0], answer);
      assert.equal(await new Host('stub-target').isRunning('c1'), false, `"${answer}" read as running`);
    }
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

/**
 * The local transport, which exists so the bench can run on the deployment host itself.
 *
 * A bench that publishes from one machine and fetches from another cannot share a clock, so it runs
 * whole on the host, and the host has no private key with which to ssh to itself. Measured on
 * 2026-08-03, publishing from a laptop instead cost ~15% of SRT packets and put that loss inside the
 * largest hop in the report.
 *
 * These run real commands through a real shell. There is no host and no ssh in any of them, which is
 * the property under test.
 */
describe('the local transport', () => {
  it('runs the command through a shell instead of ssh', async () => {
    const host = new Host(LOCAL_TARGET);

    const { stdout } = await host.run('echo hello-from-shell');

    assert.equal(stdout.trim(), 'hello-from-shell');
  });

  /**
   * Every command the harness builds is a shell line: `2>&1`, `||` fallbacks and `{{...}}` format
   * strings all arrive unparsed. A bare spawn would pass them to the program as literal arguments and
   * `isRunning` would report every container missing.
   */
  it('interprets the shell syntax the harness builds', async () => {
    const host = new Host(LOCAL_TARGET);

    const { stdout } = await host.run('(exit 3) 2>/dev/null || echo fallback-taken');

    assert.equal(stdout.trim(), 'fallback-taken');
  });

  /** A failing command is the command's own failure, so it surfaces rather than being retried away. */
  it('surfaces a non-zero exit', async () => {
    const host = new Host(LOCAL_TARGET);

    await assert.rejects(
      () => host.run('exit 7'),
      (error: { code?: number }) => error.code === 7,
    );
  });

  /**
   * The degenerate case, and the reason the sentinel is not `localhost`. `localhost` is the documented
   * default of `E2E_SSH_TARGET`, so treating it as local would turn a failed `ssh localhost` into
   * `docker stop` against whatever the operator's own machine is running, and this suite injects
   * faults. Anything but the sentinel has to still reach for ssh.
   */
  it('leaves every other target on ssh, localhost included', async () => {
    stubSsh([0], 'ssh-was-used');
    const host = new Host('localhost');

    const { stdout } = await host.run('echo hello-from-shell');

    assert.equal(stdout.trim(), 'ssh-was-used');
  });
});
