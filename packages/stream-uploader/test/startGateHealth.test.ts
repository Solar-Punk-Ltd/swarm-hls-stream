import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { runStartGates, StartGate } from '../src/libs/StartGates.js';
import { HEALTH_REASON_START_GATE_WARNED, HEALTH_WAITING_FOR_NODE, StartGateWarning } from '../src/types.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { makeTestOrchestrator } from './helpers/fakes.js';

const servers: ApiTestServer[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** A gate that refuses the rungs it is given, the way both real ones do under a collector. */
function refusingGate(name: string, rungs: readonly (string | undefined)[], refuses = false): StartGate {
  return {
    name,
    refuses,
    run: async (collect) => {
      if (collect === undefined) {
        throw new Error(`${name} refused`);
      }
      for (const rung of rungs) {
        collect({ rung, url: 'http://bee-uploader:1633', message: `${name} refused ${rung ?? 'the node'}` });
      }
    },
  };
}

function passingGate(name: string): StartGate {
  return { name, refuses: false, run: async () => {} };
}

function collectedWarnings(gates: readonly StartGate[]): Promise<StartGateWarning[]> {
  const silent = { warn: () => {} };
  return new Promise((resolve, reject) => {
    runStartGates(gates, silent, (warnings) => resolve([...warnings])).catch(reject);
  });
}

/**
 * ⛔⛔⛔ **A warning nobody can find is the same as no warning at all.**
 *
 * The owner ruled on 2026-09-17 that a gate which cannot clear its node warns and the uploader starts.
 * What that left, found in review of this branch: a pool-backed ABR deployment has no refusal anywhere
 * in the stack, because the manager's own start gate returns early for a profile that owns no Bee node
 * of its own. The whole record of an unfunded chequebook or an exhausted batch was then one line at
 * boot, in a service that logs at debug, and within minutes it had scrolled out of the two hundred
 * lines a person is shown. `/health` said `ok`, docker said healthy, and the deploy said fine.
 *
 * So the outcome of the gate pass is latched into the health report, the way a refused postage batch
 * already is. From boot on, `/health` answers 503 with `start_gate_warned` and names which gate and
 * which rung, which makes the container's healthcheck report unhealthy and `assert-started.sh` say so
 * for free.
 *
 * ⛔ The gate's own message is deliberately not published. `/health` takes no credential and is bound
 * on every interface the deployment exposes, and those messages carry node URLs and batch ids.
 */
describe('a gate that warned reaches /health', () => {
  it('latches what the pass warned about, gate by gate and rung by rung', async () => {
    const warnings = await collectedWarnings([refusingGate('PostageGate', ['360p', '1080p'])]);

    assert.deepEqual(warnings, [
      { gate: 'PostageGate', rung: '360p' },
      { gate: 'PostageGate', rung: '1080p' },
    ]);
  });

  it('carries no url and no message into what it latches', async () => {
    const warnings = await collectedWarnings([refusingGate('ChequebookGate', ['360p'])]);

    assert.deepEqual(Object.keys(warnings[0]).sort(), ['gate', 'rung']);
  });

  it('reports nothing at all for a pass that cleared every gate', async () => {
    const cleared = await collectedWarnings([passingGate('ChequebookGate'), passingGate('PostageGate')]);

    assert.deepEqual(cleared, []);
  });

  // The gates are read again on every attempt of a node wait, so accumulating would report a rung
  // that was down for one attempt and fine for the next. Only the last pass describes the service,
  // which takes two passes to show: a clearing pass on its own proves nothing about what it replaced.
  it('replaces what the pass before it left, rather than adding to it', () => {
    const orchestrator = makeTestOrchestrator();

    orchestrator.recordStartGateWarnings([
      { gate: 'ChequebookGate', rung: '360p' },
      { gate: 'PostageGate', rung: '360p' },
    ]);
    orchestrator.recordStartGateWarnings([{ gate: 'PostageGate', rung: '1080p' }]);

    assert.deepEqual(orchestrator.getHealthSignals().startGateWarnings, [{ gate: 'PostageGate', rung: '1080p' }]);
  });

  it('is emptied by a later pass that found nothing, which is a node that came back', () => {
    const orchestrator = makeTestOrchestrator();
    orchestrator.recordStartGateWarnings([{ gate: 'ChequebookGate', rung: '360p' }]);

    orchestrator.recordStartGateWarnings([]);

    assert.deepEqual(orchestrator.getHealthSignals().startGateWarnings, []);
  });

  it('latches nothing for a gate that refuses, where a failure ends the boot instead', async () => {
    await assert.rejects(() => collectedWarnings([refusingGate('ChequebookGate', ['360p'], true)]));
  });

  it('reaches the health signals through the orchestrator', () => {
    const orchestrator = makeTestOrchestrator();

    orchestrator.recordStartGateWarnings([{ gate: 'ChequebookGate', rung: '480p' }]);

    assert.deepEqual(orchestrator.getHealthSignals().startGateWarnings, [{ gate: 'ChequebookGate', rung: '480p' }]);
  });

  it('turns the service degraded over HTTP, with the reason and the names', async () => {
    const orchestrator = makeTestOrchestrator();
    orchestrator.recordStartGateWarnings([{ gate: 'PostageGate', rung: '720p' }]);
    const api = await startTestApi(orchestrator);
    servers.push(api);

    const { status, body } = await api.request('/health');
    const health = body as Record<string, unknown>;

    assert.equal(status, 503, 'a container healthcheck has to be able to see this');
    assert.ok(
      (health.reasons as string[]).includes(HEALTH_REASON_START_GATE_WARNED),
      `reasons did not name the warned gate: ${JSON.stringify(health.reasons)}`,
    );
    assert.deepEqual(health.startGateWarnings, [{ gate: 'PostageGate', rung: '720p' }]);
  });

  it('publishes no node url on that payload, which takes no credential to read', async () => {
    const orchestrator = makeTestOrchestrator();
    orchestrator.recordStartGateWarnings([{ gate: 'ChequebookGate', rung: '360p' }]);
    const api = await startTestApi(orchestrator);
    servers.push(api);

    const { body } = await api.request('/health');

    assert.doesNotMatch(
      JSON.stringify((body as Record<string, unknown>).startGateWarnings),
      /http|:\d{4}|[0-9a-f]{16}/,
      'a warned gate may name itself and its rung on /health, and nothing else',
    );
  });

  // A boot that has not finished says so and nothing else. The gates of a pass that is still being
  // retried describe an attempt rather than the service, and `waiting_for_node` is the state to act on.
  it('does not compete with the waiting state while the boot is still waiting', async () => {
    const orchestrator = makeTestOrchestrator();
    orchestrator.recordStartGateWarnings([{ gate: 'ChequebookGate', rung: '360p' }]);
    const api = await startTestApi(orchestrator, [], undefined, () => ({
      url: 'http://bee-uploader:1633',
      waitingSince: '2026-09-17T09:00:00.000Z',
      attempts: 2,
    }));
    servers.push(api);

    const { body } = await api.request('/health');

    assert.equal((body as Record<string, unknown>).status, HEALTH_WAITING_FOR_NODE);
    assert.deepEqual((body as Record<string, unknown>).reasons, ['node_unavailable']);
  });
});
