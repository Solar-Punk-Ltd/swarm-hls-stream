import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { withFixtureOperationLease } from '../src/continuation/operationLease.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';

describe('continuation fixture operation lease', () => {
  it('keeps a competing run and cleanup from mutating while media is active', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'continuation-lease-'));
    const outputRoot = join(parent, FIXTURE_ID);
    let allowFinish!: () => void;
    const held = new Promise<void>((resolve) => {
      allowFinish = resolve;
    });
    let mutations = 0;
    const active = withFixtureOperationLease({ fixtureId: FIXTURE_ID, outputRoot, operation: 'run' }, async (lease) => {
      mutations += 1;
      await held;
      lease.releaseWhenComplete();
    });
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
      withFixtureOperationLease({ fixtureId: FIXTURE_ID, outputRoot, operation: 'cleanup' }, async () => {
        mutations += 1;
      }),
      /operation lease/i,
    );
    assert.equal(mutations, 1);

    allowFinish();
    await active;
    await withFixtureOperationLease({ fixtureId: FIXTURE_ID, outputRoot, operation: 'cleanup' }, async (lease) => {
      lease.releaseWhenComplete();
    });
  });

  it('retains the lease when owned process reaping is unresolved', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'continuation-lease-'));
    const outputRoot = join(parent, FIXTURE_ID);

    await assert.rejects(
      withFixtureOperationLease({ fixtureId: FIXTURE_ID, outputRoot, operation: 'run' }, async () => {
        throw new Error('synthetic reaping refusal');
      }),
      /synthetic reaping refusal/,
    );

    assert.equal(existsSync(`${outputRoot}.operation.lock`), true);
    await assert.rejects(
      withFixtureOperationLease({ fixtureId: FIXTURE_ID, outputRoot, operation: 'cleanup' }, async () => {}),
      /operation lease/i,
    );
  });
});
