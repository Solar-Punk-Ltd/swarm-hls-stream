import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CAPABILITIES = join(ROOT, 'deploy/capabilities.json');

/**
 * The deployment manager reads this one file, at this path from the stack root, to decide whether a
 * stack speaks the managed SRS lifecycle (`readsSrsLifecycleV1` in the manager's `stackContract.ts`).
 * It switches the feature on only for `schemaVersion` 1 with `capabilities.srsLifecycle` 1, and treats a
 * missing, malformed or newer document as a stack without the feature, with no error to say so. An edit
 * to the file therefore decides what every real server can run, and it has to change this test too.
 */
describe('deploy/capabilities.json, the stack evidence the manager reads', () => {
  it('declares the SRS lifecycle at version 1 under schema version 1 and nothing else', () => {
    const evidence = JSON.parse(readFileSync(CAPABILITIES, 'utf8'));

    assert.deepEqual(evidence, { schemaVersion: 1, capabilities: { srsLifecycle: 1 } });
  });
});
