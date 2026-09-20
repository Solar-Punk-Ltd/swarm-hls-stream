import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ManagedStateLock,
  ManagedStateLockFileOps,
} from '../src/libs/ManagedStateLock.js';

const HOLDER_READY_TIMEOUT_MS = 5_000;

async function waitForHolderReady(holder: ReturnType<typeof spawn>): Promise<void> {
  let stderr = '';
  holder.stderr?.setEncoding('utf8');
  holder.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`lock holder did not become ready: ${stderr}`)), HOLDER_READY_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      holder.off('error', failed);
      holder.off('exit', exited);
      holder.stdout?.off('data', ready);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`lock holder exited before ready (${code ?? signal}): ${stderr}`));
    };
    const ready = (chunk: Buffer) => {
      if (!chunk.toString('utf8').includes('ready\n')) {
        return;
      }
      cleanup();
      resolve();
    };
    holder.once('error', failed);
    holder.once('exit', exited);
    holder.stdout?.on('data', ready);
  });
}

describe('ManagedStateLock', () => {
  it('retains the locked descriptor until release', () => {
    const closed: number[] = [];
    const fileOps: ManagedStateLockFileOps = {
      mkdirSync: () => {},
      openSync: () => 17,
      closeSync: (fd) => void closed.push(fd),
    };
    const lock = ManagedStateLock.acquire('/state', () => ({ status: 0 }), fileOps);

    assert.deepEqual(closed, []);
    lock.release();
    lock.release();
    assert.deepEqual(closed, [17]);
  });

  it('fails closed and releases the descriptor when flock is missing', () => {
    const closed: number[] = [];
    const fileOps: ManagedStateLockFileOps = {
      mkdirSync: () => {},
      openSync: () => 19,
      closeSync: (fd) => void closed.push(fd),
    };

    assert.throws(
      () => ManagedStateLock.acquire('/state', () => ({ status: null, error: new Error('spawn flock ENOENT') }), fileOps),
      /spawn flock ENOENT/,
    );
    assert.deepEqual(closed, [19]);
  });

  it('excludes competing processes and releases the kernel lock after process death', {
    skip: process.platform !== 'linux' ? 'requires Linux flock semantics' : false,
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-state-lock-'));
    const lockPath = path.join(root, '.stream-uploader.lock');
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      const first = ManagedStateLock.acquire(root);
      assert.equal(spawnSync('flock', ['-n', '-E', '73', lockPath, 'true']).status, 73);
      first.release();
      assert.equal(spawnSync('flock', ['-n', '-E', '73', lockPath, 'true']).status, 0);

      holder = spawn(
        process.execPath,
        [...process.execArgv, fileURLToPath(new URL('./fixtures/managed-state-lock-holder.ts', import.meta.url)), root],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await waitForHolderReady(holder);
      assert.equal(spawnSync('flock', ['-n', '-E', '73', lockPath, 'true']).status, 73);
      holder.kill('SIGKILL');
      await once(holder, 'exit');

      const restarted = ManagedStateLock.acquire(root);
      restarted.release();
    } finally {
      if (holder && holder.exitCode === null && holder.signalCode === null) {
        holder.kill('SIGKILL');
        await once(holder, 'exit');
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
