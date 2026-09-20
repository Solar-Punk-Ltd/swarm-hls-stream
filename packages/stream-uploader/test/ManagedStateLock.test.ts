import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ManagedStateLock,
  ManagedStateLockFileOps,
} from '../src/libs/ManagedStateLock.js';

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
    try {
      const first = ManagedStateLock.acquire(root);
      assert.equal(spawnSync('flock', ['-n', '-E', '73', lockPath, 'true']).status, 73);
      first.release();
      assert.equal(spawnSync('flock', ['-n', '-E', '73', lockPath, 'true']).status, 0);

      const holder = spawn('flock', [lockPath, process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnSync('flock', ['-n', '-E', '73', lockPath, 'true']).status === 73) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(spawnSync('flock', ['-n', '-E', '73', lockPath, 'true']).status, 73);
      holder.kill('SIGKILL');
      await once(holder, 'exit');

      const restarted = ManagedStateLock.acquire(root);
      restarted.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
