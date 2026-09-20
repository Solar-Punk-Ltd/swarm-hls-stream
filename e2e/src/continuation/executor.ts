import { FixtureRefusal } from './fixture.js';
import { withFixtureOperationLease } from './operationLease.js';

export interface ContinuationFixtureCommandInput {
  fixtureId: string;
  outputRoot: string;
}

export interface ContinuationFixtureRunSteps {
  preflight(): Promise<void>;
  initializeJournal(): Promise<void>;
  provisionPrivateChain(): Promise<void>;
  provisionApplications(): Promise<void>;
  resolveRuntime(): Promise<void>;
  provisionManagedStream(): Promise<void>;
  inspectReadiness(): Promise<void>;
  captureMeasurements(phase: 'before' | 'after'): Promise<void>;
  startMediaSender(): Promise<void>;
  runMediaScenario(): Promise<unknown>;
  writeEvidence(evidence: unknown): Promise<void>;
  settleOwnedProcesses(): Promise<boolean>;
}

/** Runs the public fixture path under one lease from the first preflight through child reaping. */
export async function runContinuationFixture(
  input: ContinuationFixtureCommandInput,
  steps: ContinuationFixtureRunSteps,
): Promise<void> {
  await withFixtureOperationLease({ ...input, operation: 'run' }, async (lease) => {
    await steps.preflight();
    await steps.initializeJournal();
    await steps.provisionPrivateChain();
    await steps.provisionApplications();
    await steps.resolveRuntime();
    await steps.provisionManagedStream();
    await steps.inspectReadiness();
    await steps.captureMeasurements('before');

    let senderMutationStarted = false;
    let evidence: unknown;
    let failure: unknown;
    let settled = false;
    try {
      senderMutationStarted = true;
      await steps.startMediaSender();
      evidence = await steps.runMediaScenario();
    } catch (error) {
      failure = error;
    } finally {
      if (senderMutationStarted) {
        try {
          await steps.captureMeasurements('after');
        } catch (error) {
          failure ??= error;
        }
        try {
          settled = await steps.settleOwnedProcesses();
        } catch (error) {
          failure ??= error;
        }
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
    if (!settled) {
      throw new FixtureRefusal('owned fixture processes remain unresolved and require reconciliation');
    }
    await steps.writeEvidence(evidence);
    lease.releaseWhenComplete();
  });
}

/** Runs exact-ID cleanup under the same fixture lease as the public run command. */
export async function cleanupContinuationFixture(
  input: ContinuationFixtureCommandInput,
  cleanup: () => Promise<void>,
): Promise<void> {
  await withFixtureOperationLease({ ...input, operation: 'cleanup' }, async (lease) => {
    await cleanup();
    lease.releaseWhenComplete();
  });
}
