import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

import { FixtureRefusal } from './fixture.js';

const FIXTURE_ID = /^srs-continuation-20260920-[a-z0-9]{8,16}$/;

export interface FixtureOperationLeaseInput {
  fixtureId: string;
  outputRoot: string;
  operation: 'run' | 'cleanup';
}

export interface FixtureOperationLease {
  /** Marks a successful operation safe to release after all owned children have closed. */
  releaseWhenComplete(): void;
}

/** Holds one fixture-scoped lease across journal initialization, guarded mutations and media process reaping. */
export async function withFixtureOperationLease<T>(
  input: FixtureOperationLeaseInput,
  action: (lease: FixtureOperationLease) => Promise<T>,
): Promise<T> {
  if (
    !FIXTURE_ID.test(input.fixtureId) ||
    !isAbsolute(input.outputRoot) ||
    basename(input.outputRoot) !== input.fixtureId ||
    dirname(input.outputRoot) === input.outputRoot
  ) {
    throw new FixtureRefusal('fixture operation lease identity is malformed');
  }
  const path = `${input.outputRoot}.operation.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FixtureRefusal('fixture operation lease is already held and requires reconciliation');
    }
    throw new FixtureRefusal('fixture operation lease could not be created');
  }
  const identity = fstatSync(descriptor);
  writeFileSync(
    descriptor,
    `${JSON.stringify({
      schemaVersion: 1,
      fixtureId: input.fixtureId,
      operation: input.operation,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  fsyncSync(descriptor);
  let release = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = {
      ok: true,
      value: await action({
        releaseWhenComplete: () => {
          release = true;
        },
      }),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  closeSync(descriptor);
  if (release && outcome.ok) {
    const current = lstatSync(path);
    if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile() || current.isSymbolicLink()) {
      throw new FixtureRefusal('fixture operation lease identity changed during the operation');
    }
    unlinkSync(path);
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
