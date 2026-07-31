import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { assertEnvKeyWritable, writeEnvKey } from '../src/lib/env-writer.js';

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-env-'));
  workspaces.push(dir);
  return dir;
}

after(() => {
  for (const dir of workspaces) {
    // Restore write permission first, or the read-only cases cannot be removed.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already writable, or already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeEnvKey', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = workspace();
    envPath = join(dir, '.env');
  });

  it('creates the file when it does not exist', () => {
    // OPS-1: a fresh clone has no .env, and this used to throw ENOENT *after* the batch was paid
    // for on chain, leaving the id in scrollback and nowhere else.
    assert.equal(existsSync(envPath), false);

    writeEnvKey(envPath, 'STAMP', 'abc123');

    assert.match(readFileSync(envPath, 'utf-8'), /^STAMP=abc123$/m);
  });

  it('replaces an existing key without disturbing its neighbours', () => {
    writeFileSync(envPath, 'STREAM_KEY=aaa\nSTAMP=old\nAPI_AUTH_TOKEN=bbb\n');

    writeEnvKey(envPath, 'STAMP', 'new');

    const content = readFileSync(envPath, 'utf-8');
    assert.match(content, /^STAMP=new$/m);
    assert.match(content, /^STREAM_KEY=aaa$/m);
    assert.match(content, /^API_AUTH_TOKEN=bbb$/m);
    assert.equal(content.match(/^STAMP=/gm)?.length, 1, 'the key must not be duplicated');
  });

  it('appends a missing key to an existing file', () => {
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');

    writeEnvKey(envPath, 'STAMP', 'abc123');

    const content = readFileSync(envPath, 'utf-8');
    assert.match(content, /^STREAM_KEY=aaa$/m);
    assert.match(content, /^STAMP=abc123$/m);
  });

  it('does not match a key that merely shares a prefix', () => {
    writeFileSync(envPath, 'STAMP_TTL=3600\n');

    writeEnvKey(envPath, 'STAMP', 'abc123');

    const content = readFileSync(envPath, 'utf-8');
    assert.match(content, /^STAMP_TTL=3600$/m, 'STAMP_TTL is a different variable');
    assert.match(content, /^STAMP=abc123$/m);
  });
});

describe('assertEnvKeyWritable', () => {
  it('accepts a directory where the file does not exist yet', () => {
    const dir = workspace();

    assert.doesNotThrow(() => assertEnvKeyWritable(join(dir, '.env')));
  });

  it('accepts an existing writable file', () => {
    const dir = workspace();
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');

    assert.doesNotThrow(() => assertEnvKeyWritable(envPath));
  });

  it('rejects a read-only file, naming the path', () => {
    // The point of the preflight: this has to be discovered before any money is spent.
    const dir = workspace();
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');
    chmodSync(envPath, 0o400);

    assert.throws(() => assertEnvKeyWritable(envPath), new RegExp(envPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('rejects a read-only directory when the file does not exist', () => {
    const dir = workspace();
    chmodSync(dir, 0o500);

    assert.throws(() => assertEnvKeyWritable(join(dir, '.env')), /is not writable/);
  });

  it('names a missing directory as missing rather than as unwritable', () => {
    // The two cases have different fixes, so the message has to tell them apart.
    assert.throws(() => assertEnvKeyWritable(join(workspace(), 'no-such-dir', '.env')), /does not exist/);
  });

  // Each of these passed the old check and then threw on the write. The preflight is only worth
  // having if it agrees with what the write actually does.
  it('rejects a file that is writable but not readable', () => {
    const dir = workspace();
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');
    chmodSync(envPath, 0o200);

    assert.throws(() => assertEnvKeyWritable(envPath), /readable and writable/);
  });

  it('rejects a directory sitting where the file should be', () => {
    const dir = workspace();
    const envPath = join(dir, '.env');
    mkdirSync(envPath);

    assert.throws(() => assertEnvKeyWritable(envPath), /not a regular file/);
  });

  it('rejects a read-only directory even when the file itself is writable', () => {
    // Replacing the file means creating and renaming a sibling, so the directory has to be
    // writable too. An in-place write did not need that, this one does.
    const dir = workspace();
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'STREAM_KEY=aaa\n');
    chmodSync(dir, 0o500);

    assert.throws(() => assertEnvKeyWritable(envPath), /is not writable/);
  });
});

describe('writeEnvKey durability', () => {
  it('leaves the original untouched when the replacement cannot be written', () => {
    // writeFileSync truncates before it writes, so a failure partway used to leave .env holding
    // whatever had made it to disk: STREAM_KEY, API_AUTH_TOKEN and the rest gone, with nothing in
    // the output saying so. Writing a sibling and renaming makes it all-or-nothing.
    const dir = workspace();
    const envPath = join(dir, '.env');
    const original = 'STREAM_KEY=secret-aaa\nAPI_AUTH_TOKEN=secret-bbb\nSTAMP=old\n';
    writeFileSync(envPath, original);
    chmodSync(dir, 0o500);

    assert.throws(() => writeEnvKey(envPath, 'STAMP', 'new'));
    assert.equal(readFileSync(envPath, 'utf-8'), original, 'a failed write must not damage the file');
  });

  it('leaves no temporary file behind when the replacement fails', () => {
    const dir = workspace();
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'STAMP=old\n');
    chmodSync(join(dir), 0o500);

    assert.throws(() => writeEnvKey(envPath, 'STAMP', 'new'));
    chmodSync(dir, 0o700);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name !== '.env'),
      [],
      'a half-written sibling must not survive',
    );
  });
});
