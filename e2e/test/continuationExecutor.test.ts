import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  cleanupContinuationFixture,
  runContinuationFixture,
  type ContinuationFixtureRunSteps,
} from '../src/continuation/executor.js';
import { FixtureRefusal } from '../src/continuation/fixture.js';
import { withFixtureOperationLease } from '../src/continuation/operationLease.js';

const FIXTURE_ID = 'srs-continuation-20260920-a1b2c3d4';

function outputRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'continuation-executor-')), FIXTURE_ID);
}

function steps(events: string[], settle = true): ContinuationFixtureRunSteps {
  return {
    preflight: async () => { events.push('preflight'); },
    initializeJournal: async () => { events.push('initialize-journal'); },
    provisionPrivateChain: async () => { events.push('private-chain'); },
    provisionApplications: async () => { events.push('applications'); },
    resolveRuntime: async () => { events.push('runtime'); },
    provisionManagedStream: async () => { events.push('managed-stream'); },
    inspectReadiness: async () => { events.push('readiness'); },
    captureMeasurements: async (phase) => { events.push(`measure-${phase}`); },
    startMediaSender: async () => { events.push('start-sender'); },
    runMediaScenario: async () => {
      events.push('media');
      return { evidenceKind: 'synthetic-test-evidence' };
    },
    writeEvidence: async () => { events.push('evidence'); },
    settleOwnedProcesses: async () => {
      events.push('settle');
      return settle;
    },
  };
}

describe('callable continuation fixture executor', () => {
  it('holds one lease across provision, readiness, measurements, media and process settlement', async () => {
    const root = outputRoot();
    const events: string[] = [];
    const runSteps = steps(events);
    runSteps.preflight = async () => {
      events.push('preflight');
      await assert.rejects(
        withFixtureOperationLease({ fixtureId: FIXTURE_ID, outputRoot: root, operation: 'cleanup' }, async () => undefined),
        FixtureRefusal,
      );
    };

    await runContinuationFixture({ fixtureId: FIXTURE_ID, outputRoot: root }, runSteps);

    assert.deepEqual(events, [
      'preflight',
      'initialize-journal',
      'private-chain',
      'applications',
      'runtime',
      'managed-stream',
      'readiness',
      'measure-before',
      'start-sender',
      'media',
      'measure-after',
      'settle',
      'evidence',
    ]);
    assert.equal(existsSync(`${root}.operation.lock`), false);
  });

  it('retains the lease when an owned process cannot be proven settled', async () => {
    const root = outputRoot();

    await assert.rejects(
      runContinuationFixture({ fixtureId: FIXTURE_ID, outputRoot: root }, steps([], false)),
      /owned fixture processes remain unresolved/,
    );

    assert.equal(existsSync(`${root}.operation.lock`), true);
  });

  it('captures the after snapshot and reaps owned processes when media fails', async () => {
    const root = outputRoot();
    const events: string[] = [];
    const runSteps = steps(events);
    runSteps.runMediaScenario = async () => {
      events.push('media');
      throw new Error('synthetic media failure');
    };

    await assert.rejects(
      runContinuationFixture({ fixtureId: FIXTURE_ID, outputRoot: root }, runSteps),
      /synthetic media failure/,
    );

    assert.deepEqual(events.slice(-4), ['start-sender', 'media', 'measure-after', 'settle']);
    assert.equal(existsSync(`${root}.operation.lock`), true);
  });

  it('holds the same lease around exact-id cleanup and releases it only after success', async () => {
    const root = outputRoot();
    const events: string[] = [];

    await cleanupContinuationFixture({ fixtureId: FIXTURE_ID, outputRoot: root }, async () => {
      events.push('cleanup');
      await assert.rejects(
        withFixtureOperationLease({ fixtureId: FIXTURE_ID, outputRoot: root, operation: 'run' }, async () => undefined),
        FixtureRefusal,
      );
    });

    assert.deepEqual(events, ['cleanup']);
    assert.equal(existsSync(`${root}.operation.lock`), false);
  });
});
