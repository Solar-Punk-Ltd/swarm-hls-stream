import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ROOT_DIR } from '../src/config.js';

const HEALTHCHECK = join(ROOT_DIR, 'engines', 'srs', 'healthcheck.sh');

/** The inode `/proc/net/udp` reports for a socket, which is the only thing tying it to an owner. */
const SRS_SOCKET_INODE = '3744450441';
const STRANGER_SOCKET_INODE = '9999999999';

/**
 * One `/proc/net/udp` line, in the kernel's column order.
 *
 * Copied from the real file on the deployment host rather than invented, because the whole check is
 * an offset into these columns and a fixture with the wrong shape would pass against a script that
 * reads the wrong one.
 */
function udpLine(hexPort: string, inode: string): string {
  return (
    `41469: 00000000:${hexPort} 00000000:0000 07 00000000:00000000 00:00000000 00000000` +
    `     0        0 ${inode} 2 0000000000000000 0`
  );
}

function udp6Line(hexPort: string, inode: string): string {
  return (
    `  1: 00000000000000000000000000000000:${hexPort} 00000000000000000000000000000000:0000 07 ` +
    `00000000:00000000 00:00000000 00000000     0        0 ${inode} 2 0000000000000000 0`
  );
}

const UDP_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops';

interface FakeProc {
  /** What the script is given as its `/proc`. */
  root: string;
}

/**
 * A `/proc` the script can be pointed at, holding the two facts it reads: what the kernel says is
 * bound, and which sockets the container's own processes hold.
 *
 * Built as real files and real symlinks rather than stubbed at a seam inside the script, so what the
 * test drives is the same `readlink` and the same `awk` a container runs.
 */
function fakeProc(options: { udp?: string[]; udp6?: string[]; ownedInodes?: string[] }): FakeProc {
  const root = mkdtempSync(join(tmpdir(), 'srs-healthcheck-'));
  mkdirSync(join(root, 'net'), { recursive: true });
  writeFileSync(join(root, 'net', 'udp'), [UDP_HEADER, ...(options.udp ?? [])].join('\n') + '\n');
  writeFileSync(join(root, 'net', 'udp6'), [UDP_HEADER, ...(options.udp6 ?? [])].join('\n') + '\n');

  const fdDir = join(root, '1', 'fd');
  mkdirSync(fdDir, { recursive: true });
  (options.ownedInodes ?? []).forEach((inode, index) => {
    symlinkSync(`socket:[${inode}]`, join(fdDir, String(index + 8)));
  });
  return { root };
}

interface Outcome {
  status: number;
  output: string;
}

function runHealthcheck(port: string, proc: FakeProc): Outcome {
  try {
    const output = execFileSync('bash', [HEALTHCHECK, port, proc.root], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const created: FakeProc[] = [];

function procFor(options: Parameters<typeof fakeProc>[0]): FakeProc {
  const proc = fakeProc(options);
  created.push(proc);
  return proc;
}

/**
 * OBS-20: a stack can be Up, healthy and unable to receive a broadcast.
 *
 * On 2026-08-03 `latbench-srs-1` ran 44 minutes with its SRT listener dead. It had failed to bind
 * with `errno=98` because another container still held the port under host networking, and every
 * signal the deployment had reported on a process that was running rather than on a socket that was
 * listening. The bind error itself was not written to the log until the container was stopped.
 *
 * **The port being bound is not the question**, and a check that asked only that would have passed
 * throughout the outage: the port was bound, by the wrong process. What separates the two states is
 * ownership, so the check has to tie the listening socket back to a process in this container, which
 * is what the inode in `/proc/net/udp` is for.
 */
describe('the SRS ingest healthcheck', () => {
  after(() => {
    for (const proc of created) {
      rmSync(proc.root, { recursive: true, force: true });
    }
  });

  it('passes when SRS itself holds the SRT port', () => {
    const proc = procFor({ udp: [udpLine('2757', SRS_SOCKET_INODE)], ownedInodes: [SRS_SOCKET_INODE] });

    assert.equal(runHealthcheck('10071', proc).status, 0);
  });

  /**
   * The outage, reproduced. The port is bound and no process in this container holds it, which is
   * exactly what `docker ps`, the uploader's `/health` and the old process-liveness healthcheck all
   * reported as fine.
   */
  it('fails when the port is bound by a process outside this container', () => {
    const proc = procFor({ udp: [udpLine('2757', STRANGER_SOCKET_INODE)], ownedInodes: [SRS_SOCKET_INODE] });

    const outcome = runHealthcheck('10071', proc);

    assert.notEqual(outcome.status, 0);
    assert.match(outcome.output, /bound by a process outside this container/);
  });

  it('fails, differently, when nothing is bound to the port at all', () => {
    const proc = procFor({ udp: [], ownedInodes: [SRS_SOCKET_INODE] });

    const outcome = runHealthcheck('10071', proc);

    assert.notEqual(outcome.status, 0);
    assert.match(outcome.output, /nothing is listening/);
  });

  it('accepts a listener bound on IPv6 rather than IPv4', () => {
    const proc = procFor({ udp6: [udp6Line('2757', SRS_SOCKET_INODE)], ownedInodes: [SRS_SOCKET_INODE] });

    assert.equal(runHealthcheck('10071', proc).status, 0);
  });

  /**
   * A port whose hex spelling is a suffix of another's. 10071 is `2757` and 4439 is `1157`, so a
   * match anchored anywhere but the end of the address field would confuse `:1157` for `:2757`
   * whenever one contains the other. Guarded because the failure would be a healthcheck that passes
   * off an unrelated listener, which is the same shape of blindness OBS-20 already is.
   */
  it('does not accept a listener on a different port whose hex looks similar', () => {
    const proc = procFor({
      udp: [udpLine('12757', SRS_SOCKET_INODE), udpLine('275', SRS_SOCKET_INODE)],
      ownedInodes: [SRS_SOCKET_INODE],
    });

    assert.notEqual(runHealthcheck('10071', proc).status, 0);
  });

  it('refuses a port that is not a number, rather than probing for hex garbage', () => {
    const proc = procFor({ udp: [udpLine('2757', SRS_SOCKET_INODE)], ownedInodes: [SRS_SOCKET_INODE] });

    const outcome = runHealthcheck('not-a-port', proc);

    assert.notEqual(outcome.status, 0);
    assert.match(outcome.output, /must be a port number/);
  });
});

/** Guards that the script the container mounts is the script these tests drove. */
describe('the healthcheck is wired into the engine', () => {
  let compose = '';

  before(() => {
    compose = execFileSync('cat', [join(ROOT_DIR, 'engines', 'srs', 'docker-compose.yml')], { encoding: 'utf8' });
  });

  it('mounts the script and runs it as the container healthcheck', () => {
    assert.match(compose, /healthcheck\.sh:\/usr\/local\/srs\/conf\/healthcheck\.sh:ro/);
    assert.match(compose, /healthcheck:/);
    assert.match(compose, /\/usr\/local\/srs\/conf\/healthcheck\.sh/);
  });
});
