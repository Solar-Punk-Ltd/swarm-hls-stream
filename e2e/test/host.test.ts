import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_LOCAL_HOST_ADDRESS,
  Host,
  LOCAL_TARGET,
  pollConfiguredStamp,
  readConfiguredBatch,
  type Stamp,
} from '../src/harness/host.js';

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

/** A stub `curl` that prints the arguments it was handed, so a test can read the URL that was built. */
function stubCurl(): void {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-curl-'));
  sandboxes.push(dir);
  const path = join(dir, 'curl');
  writeFileSync(path, ['#!/bin/bash', 'printf \'%s\' "$*"'].join('\n'));
  chmodSync(path, 0o755);
  process.env.PATH = `${dir}:${REAL_PATH}`;
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
  /** Callers composing paths need to know which filesystem the command will see. */
  it("says whether commands run in this process's own namespace", () => {
    assert.equal(new Host(LOCAL_TARGET).isLocal, true);
    assert.equal(new Host('manager-host').isLocal, false);
  });

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

/**
 * Which address the local transport's curls dial.
 *
 * Loopback for as long as the container shared the host's network namespace, which every bench and
 * every viewer arm did. A container given a namespace of its own reaches nothing on its own
 * loopback: the uploader, the bee nodes and the client are all on the host, one hop away over the
 * bridge, and `deploy/scripts/bench-on-host.sh --own-network` names that hop
 * `host.docker.internal`. Every one of these calls is built into a shell line, so the address is
 * screened by `loadConfig` before it ever arrives here.
 */
describe('the address the local transport curls', () => {
  it('dials loopback when nothing said otherwise', async () => {
    stubCurl();

    const built = await new Host(LOCAL_TARGET).localText(10_074, '/health');

    assert.match(built, /http:\/\/localhost:10074\/health/);
    assert.equal(DEFAULT_LOCAL_HOST_ADDRESS, 'localhost');
  });

  it('dials the address it was given instead', async () => {
    stubCurl();

    const built = await new Host(LOCAL_TARGET, undefined, 'host.docker.internal').localText(10_074, '/health');

    assert.match(built, /http:\/\/host\.docker\.internal:10074\/health/);
    assert.doesNotMatch(built, /localhost/);
  });

  /**
   * The half that would break every attach-mode run. Over ssh the command runs ON the deployment
   * host, where the services genuinely are on loopback, so a bridge address carried across would
   * name a machine that does not exist from there.
   */
  it('keeps loopback for an ssh target whatever the local address is', async () => {
    const sandbox = stubSsh([0]);

    await new Host('stub-target', undefined, 'host.docker.internal').localText(10_074, '/health');

    assert.match(sandbox.invocations()[0], /http:\/\/localhost:10074\/health/);
  });
});

/**
 * ⛔⛔⛔ **Which batch a verdict about a rung is allowed to be about.** Until 2026-09-04 the stage
 * stamp gate read each node's BEST usable stamp, sorted by TTL, and never compared it with the batch
 * `BEE_PUBLISHERS` routes that rung to. A node holding one drained batch (the configured one) and one
 * fresh unused batch therefore passed the gate cleanly and then refused every upload the rung made.
 *
 * Which batch a node spends is decided in `BEE_PUBLISHERS` and reported on the uploader's `/health`,
 * so that id is the only thing that cannot drift. Selecting a batch by shape instead, the healthiest
 * or the longest-lived, is how a reading here came to be about a row no run ever wrote to.
 *
 * `/health` truncates the configured id to eight hex characters and an ellipsis, because a batch id is
 * the whole of what authorises spending on a rung, so the match is on that prefix.
 */
describe('readConfiguredBatch', () => {
  function stamp(over: Partial<Stamp> = {}): Stamp {
    return {
      batchID: '1'.repeat(64),
      utilization: 1,
      usable: true,
      depth: 24,
      amount: '100000000',
      bucketDepth: 16,
      immutableFlag: true,
      exists: true,
      batchTTL: 86_400,
      ...over,
    };
  }

  const CONFIGURED = '11111111…';
  const OTHER_BATCH = '9'.repeat(64);

  it('picks the configured batch even when another on the node has far more TTL', () => {
    const read = readConfiguredBatch(
      [stamp({ batchID: OTHER_BATCH, batchTTL: 9_000_000 }), stamp({ batchTTL: 3_600 })],
      CONFIGURED,
    );

    assert.equal(read.state, 'held');
    assert.equal(read.stamp?.batchTTL, 3_600);
  });

  /** The exact stage the drain test builds: the configured batch refused, a fresh one beside it. */
  it('reports the configured batch unusable while a fresh batch sits beside it', () => {
    const read = readConfiguredBatch(
      [stamp({ usable: false, utilization: 2, depth: 17 }), stamp({ batchID: OTHER_BATCH, batchTTL: 9_000_000 })],
      CONFIGURED,
    );

    assert.equal(read.state, 'unusable');
    assert.equal(read.stamp?.depth, 17, 'the reading has to be of the configured batch, fill included');
    assert.match(read.lastSeen ?? '', /usable=false/);
  });

  /** `exists: false` is bee saying the batch is gone on chain, which is not a batch to stamp with. */
  it('reports the configured batch unusable when bee says it no longer exists', () => {
    const read = readConfiguredBatch([stamp({ exists: false })], CONFIGURED);

    assert.equal(read.state, 'unusable');
    assert.match(read.lastSeen ?? '', /exists=false/);
  });

  it('reports a configured batch the node does not hold, and lists what it does hold', () => {
    const read = readConfiguredBatch([stamp({ batchID: OTHER_BATCH })], CONFIGURED);

    assert.equal(read.state, 'absent');
    assert.equal(read.stamp, null);
    assert.match(read.lastSeen ?? '', /99999999/);
  });

  it('reports a node that lists no batches at all as not holding the configured one', () => {
    const read = readConfiguredBatch([], CONFIGURED);

    assert.equal(read.state, 'absent');
    assert.match(read.lastSeen ?? '', /no batches at all/);
  });

  /**
   * ⛔ Two rows sharing the prefix is refused rather than guessed. Picking the usable one of a pair
   * would be selecting by shape again, which is the whole mistake this function exists to end.
   */
  it('refuses to choose between two batches sharing the configured prefix', () => {
    const read = readConfiguredBatch(
      [stamp({ batchID: `${'1'.repeat(63)}a`, usable: false }), stamp({ batchID: `${'1'.repeat(63)}b` })],
      CONFIGURED,
    );

    assert.equal(read.state, 'absent');
    assert.match(read.lastSeen ?? '', /2 of the batches this node lists start 11111111/);
  });

  /**
   * ⛔ A letter inside the eight characters that are actually compared, in a different case on each
   * side. Uppercase further along the id proves nothing: the comparison never reaches it, so a
   * fixture whose only letters sit past position eight passes with both lowercasings deleted.
   */
  it('matches whatever case either side reports the id in', () => {
    const read = readConfiguredBatch([stamp({ batchID: `aB${'1'.repeat(62)}` })], `Ab${'1'.repeat(6)}…`);

    assert.equal(read.state, 'held');
  });

  /**
   * ⛔ An unreadable prefix refuses instead of matching. `startsWith('')` is true of every batch a
   * node lists, so a routing this cannot read would have the gate pass on whichever row came first.
   */
  it('refuses a configured id it cannot read eight hex characters out of', () => {
    assert.throws(() => readConfiguredBatch([stamp()], '…'), /eight hex/);
    assert.throws(() => readConfiguredBatch([stamp()], '1111…'), /eight hex/);
  });
});

/**
 * ⛔⛔⛔ The two answers this poll must never confuse, and it confused them until 2026-09-05.
 *
 * `absent` says a node's batch list was read and the configured batch was not in it, which tells an
 * operator to point the rung at a batch it actually holds. `unread` says nothing about that node's
 * postage is known, which tells them to go and look at the node. A bee answering its own error
 * envelope is valid JSON with no `stamps` key in it, and a nullish default read that as a node
 * holding no batches at all, so the refusal named the wrong fix on the one reading it had.
 */
describe('pollConfiguredStamp', () => {
  const CONFIGURED = '11111111…';

  function stamp(over: Partial<Stamp> = {}): Stamp {
    return {
      batchID: '1'.repeat(64),
      utilization: 0,
      usable: true,
      depth: 17,
      amount: '100000000',
      bucketDepth: 16,
      immutableFlag: true,
      exists: true,
      batchTTL: 86_400,
      ...over,
    };
  }

  /** One answer per poll, the last of them repeating, which is what a node that stays broken does. */
  type Answer = { readonly body: unknown } | { readonly throws: string };

  function nodeAnswering(...answers: readonly Answer[]): Host {
    let asked = 0;
    return {
      localJson: async (): Promise<unknown> => {
        const answer = answers[Math.min(asked++, answers.length - 1)];
        if ('throws' in answer) {
          throw new Error(answer.throws);
        }
        return answer.body;
      },
    } as unknown as Host;
  }

  /** Drives the whole polling window in no real time, so the deadline is reached rather than waited. */
  function fakeClock(): { now: () => number; wait: (ms: number) => Promise<void> } {
    let atMs = 0;
    return {
      now: () => atMs,
      wait: async (ms: number) => {
        atMs += ms;
      },
    };
  }

  it('returns on the first poll that offers the configured batch usable', async () => {
    const read = await pollConfiguredStamp(nodeAnswering({ body: { stamps: [stamp()] } }), 11075, CONFIGURED, {
      now: () => 0,
      wait: async () => assert.fail('a held batch must not cost a second poll'),
    });

    assert.equal(read.state, 'held');
    assert.equal(read.stamp?.depth, 17);
  });

  /**
   * ⛔ The error envelope, which is the whole finding. It parses, it carries no list, and reading it
   * as an empty list tells an operator the node does not hold a batch it may well be holding.
   */
  it('answers unread for a body that carries no stamps list, never that the node holds none', async () => {
    const read = await pollConfiguredStamp(
      nodeAnswering({ body: { code: 500, message: 'cannot get batches' } }),
      11075,
      CONFIGURED,
      fakeClock(),
    );

    assert.equal(read.state, 'unread');
    assert.match(read.lastSeen ?? '', /cannot get batches/);
    assert.doesNotMatch(read.lastSeen ?? '', /no batches at all/);
  });

  it('answers unread when no poll ever reached the node', async () => {
    const read = await pollConfiguredStamp(nodeAnswering({ throws: 'curl exited 7' }), 11075, CONFIGURED, fakeClock());

    assert.equal(read.state, 'unread');
    assert.match(read.lastSeen ?? '', /curl exited 7/);
  });

  /**
   * ⛔ The reading wins over the transport failure that followed it. A node that answered `absent`
   * for most of the window and dropped one connection at the end of it is a node whose postage was
   * read, and reporting that as a transport failure sends the reader to the wrong machine.
   */
  it('keeps the batch list it did read when a later poll cannot read one at all', async () => {
    const read = await pollConfiguredStamp(
      nodeAnswering({ body: { stamps: [stamp({ batchID: '9'.repeat(64) })] } }, { throws: 'curl exited 7' }),
      11075,
      CONFIGURED,
      fakeClock(),
    );

    assert.equal(read.state, 'absent');
    assert.match(read.lastSeen ?? '', /99999999/);
    assert.match(read.lastSeen ?? '', /curl exited 7/);
  });
});
