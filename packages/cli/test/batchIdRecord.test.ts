import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { recordBatchId } from '../src/lib/batch-id-record.js';

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'batch-id-record-'));
  workspaces.push(dir);
  return dir;
}

after(() => {
  for (const dir of workspaces) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Drive `recordBatchId` down its recovery-file fallback. The env write is what normally succeeds, so
 * making `envPath` a directory forces `writeEnvKey` to throw when it reads it, without relying on
 * permission bits, which root ignores on the verification box. The fallback then builds a file name
 * from the batch id, which is the path this fix is about.
 */
function recordAgainstUnwritableEnv(id: string): { work: string; envDir: string; record: ReturnType<typeof recordBatchId> } {
  const work = workspace();
  const envDir = join(work, 'env');
  mkdirSync(envDir);
  const envPath = join(envDir, '.env');
  mkdirSync(envPath);

  return { work, envDir, record: recordBatchId(envPath, id) };
}

describe('a malformed batch id cannot escape the recovery directory', () => {
  // The whole first 16 characters go into the file name, so `..` segments in them let `path.join`
  // walk out of the env directory. This id is 64 characters and not hex, and its first 16 climb two
  // levels: on the old code the recovery file lands in the env directory's parent.
  it('does not place the recovery file outside the env directory', () => {
    const { envDir, record } = recordAgainstUnwritableEnv(`a/../../escape00${'a'.repeat(48)}`);

    assert.ok(record.writtenTo.length > 0, 'a paid-for id must still be recorded somewhere');
    for (const written of record.writtenTo) {
      assert.equal(dirname(written), envDir, `recovery file escaped the env directory: ${written}`);
    }
  });

  // The contract the docstring leads with: losing the id means paying for a batch nobody can address,
  // so no input may make this throw.
  it('never throws, whatever the id looks like', () => {
    assert.doesNotThrow(() => recordAgainstUnwritableEnv('../../../../etc/passwd'));
    assert.doesNotThrow(() => recordAgainstUnwritableEnv(''));
  });

  // A well-formed id keeps its informative recovery name, so the guard does not flatten the good path.
  it('keeps the informative name for a well-formed batch id', () => {
    const id = 'ab'.repeat(32);
    const { envDir, record } = recordAgainstUnwritableEnv(id);

    assert.equal(record.writtenTo.length, 1);
    assert.equal(dirname(record.writtenTo[0]), envDir);
    assert.equal(basename(record.writtenTo[0]), `stamp-batch-${id.slice(0, 16)}.txt`);
  });
});
