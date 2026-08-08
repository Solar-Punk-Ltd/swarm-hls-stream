import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type ApiServerHandle } from '../src/api/server.js';
import { ServiceLifecycle, type StreamCleanup } from '../src/libs/ServiceLifecycle.js';

interface Recorded {
  said: string[];
  exits: number[];
  order: string[];
}

/** A lifecycle wired to recorders instead of to the process, and the log it wrote. */
function lifecycleUnderTest(): { lifecycle: ServiceLifecycle; recorded: Recorded } {
  const recorded: Recorded = { said: [], exits: [], order: [] };
  const note =
    (level: string) =>
    (...args: unknown[]): void =>
      void recorded.said.push(`${level} ${args.map(String).join(' ')}`);
  const logger = { info: note('info'), warn: note('warn'), error: note('error') };

  return {
    // Cast because the real Logger carries configuration this has no business knowing about, and
    // shutdown only ever writes three levels of line.
    lifecycle: new ServiceLifecycle((code) => void recorded.exits.push(code), logger as never),
    recorded,
  };
}

const orchestratorThat = (cleanup: () => Promise<void>): StreamCleanup => ({ cleanup });
const apiServerThat = (close: () => Promise<void>): ApiServerHandle => ({ close });

/**
 * The half of the entry point that runs on every deploy, executed for the first time.
 *
 * `index.ts` calls `start()` at module scope, so importing it launches the service and nothing could
 * ever run this: 62 mutants, 62 survivors, **0.00%**, of which 18 were the shutdown. It decides
 * whether a broadcast's last segments are flushed when the uploader is stopped.
 */
describe('ServiceLifecycle', () => {
  it('stops the streams before it stops accepting more of them', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();
    lifecycle.trackOrchestrator(orchestratorThat(async () => void recorded.order.push('streams stopped')));
    lifecycle.trackApiServer(apiServerThat(async () => void recorded.order.push('api closed')));

    await lifecycle.shutdown('SIGTERM');

    assert.deepEqual(
      recorded.order,
      ['streams stopped', 'api closed'],
      'the api server closed first, so a segment could arrive with nothing left to write it',
    );
    assert.deepEqual(recorded.exits, [0]);
    assert.match(recorded.said.join(' '), /All streams stopped/, 'nothing said the streams had been stopped');
  });

  it('names the signal it is acting on', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();

    await lifecycle.shutdown('SIGINT');

    assert.match(recorded.said.join(' '), /SIGINT/);
  });

  /**
   * ⭐ The guard, and the reason it is not decoration. A supervisor that sends SIGTERM and then SIGINT
   * a moment later would otherwise start a second cleanup over the top of a first one still awaiting
   * its uploads, and both would then race to `process.exit`.
   */
  it('refuses a second signal while the first shutdown is still running', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();
    let cleanups = 0;
    let release = (): void => {};
    lifecycle.trackOrchestrator(
      orchestratorThat(async () => {
        cleanups += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }),
    );

    const first = lifecycle.shutdown('SIGTERM');
    await lifecycle.shutdown('SIGINT');

    assert.equal(cleanups, 1, 'a second signal started a second cleanup over the top of the first');
    assert.deepEqual(recorded.exits, [], 'the second signal exited the process while the first was mid-flight');
    assert.match(recorded.said.join(' '), /already in progress/i);

    release();
    await first;
    assert.deepEqual(recorded.exits, [0]);
  });

  it('refuses a second signal after the first has finished too', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();
    await lifecycle.shutdown('SIGTERM');

    await lifecycle.shutdown('SIGTERM');

    assert.deepEqual(recorded.exits, [0], 'the process was exited twice');
  });

  /**
   * ⛔ An orchestrator that could not flush is not a clean stop, and the exit code is the only thing
   * the supervisor reads. Reporting zero here tells it the uploads landed when they did not.
   */
  it('exits non-zero when stopping the streams failed', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();
    lifecycle.trackOrchestrator(
      orchestratorThat(async () => {
        throw new Error('an upload was still in flight');
      }),
    );

    await lifecycle.shutdown('SIGTERM');

    assert.deepEqual(recorded.exits, [1]);
    assert.match(recorded.said.join(' '), /an upload was still in flight/);
    assert.match(
      recorded.said.join(' '),
      /error during graceful shutdown/i,
      'the failure reached the log without saying it happened during shutdown',
    );
  });

  it('exits non-zero when closing the api server failed', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();
    lifecycle.trackApiServer(
      apiServerThat(async () => {
        throw new Error('the socket would not close');
      }),
    );

    await lifecycle.shutdown('SIGTERM');

    assert.deepEqual(recorded.exits, [1]);
  });

  it('does not report the streams stopped when there were none to stop', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();

    await lifecycle.shutdown('SIGTERM');

    assert.doesNotMatch(recorded.said.join(' '), /All streams stopped/);
    assert.deepEqual(recorded.exits, [0], 'a service that failed before start() should still stop cleanly');
  });

  /**
   * A signal can arrive between the handlers being registered and `start` finishing, which is a real
   * window on a slow chain: `streamCatalog.init` reaches the network before either handle exists.
   */
  it('shuts down cleanly when a signal arrives before anything has been built', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();

    await lifecycle.shutdown('SIGTERM');

    assert.deepEqual(recorded.exits, [0]);
    assert.match(recorded.said.join(' '), /completed/i);
  });

  it('closes an api server that was handed over after the orchestrator', async () => {
    const { lifecycle, recorded } = lifecycleUnderTest();
    lifecycle.trackOrchestrator(orchestratorThat(async () => {}));
    lifecycle.trackApiServer(apiServerThat(async () => void recorded.order.push('api closed')));

    await lifecycle.shutdown('SIGTERM');

    assert.deepEqual(recorded.order, ['api closed']);
  });
});
