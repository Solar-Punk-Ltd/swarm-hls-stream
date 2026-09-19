import { Router } from 'express';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EnginePlugin } from '../src/engines/types.js';
import { waitForNode } from '../src/libs/NodeWait.js';
import {
  HEALTH_OK,
  HEALTH_REASON_NODE_UNAVAILABLE,
  HEALTH_WAITING_FOR_NODE,
  MEDIA_TYPE_VIDEO,
  NodeWaitReport,
} from '../src/types.js';

import { ApiTestServer, NO_AUTH_HEADER, startTestApi } from './helpers/apiTestServer.js';
import { makeFakeOrchestrator, makeTestOrchestrator } from './helpers/fakes.js';

const NODE_URL = 'http://bee-uploader:1633';
const STREAM_ID = 'live/one';

const WAITING: NodeWaitReport = {
  url: NODE_URL,
  waitingSince: '2026-09-17T09:00:00.000Z',
  attempts: 3,
  lastError: 'timeout of 20000ms exceeded',
};

/**
 * ⛔⛔⛔ **`/health` takes no credential and is bound on every interface the deployment exposes.**
 *
 * A node URL may carry basic auth in its userinfo, because bee accepts it there and
 * `BeePublisherPool.parseEntry` keeps what the operator configured. The report the wait publishes is
 * built by `waitForNode`, which strips it, and these two cases drive the real composition: a report
 * made the way production makes one, through the route and the middleware that print it.
 */
const CREDENTIALLED_NODE = 'http://operator:hunter2@bee-a:1633';

/** A report as `waitForNode` produces one, rather than a literal a test wrote by hand. */
async function reportFor(url: string): Promise<NodeWaitReport> {
  const reports: NodeWaitReport[] = [];
  await waitForNode(async () => undefined, {
    url,
    logger: { info: () => {}, warn: () => {} },
    onReport: (report) => reports.push(report),
    now: () => new Date('2026-09-17T09:00:00.000Z'),
  });
  return reports[0];
}

const servers: ApiTestServer[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function startApi(
  orchestrator = makeTestOrchestrator(),
  waiting: NodeWaitReport | null = WAITING,
  engines: EnginePlugin[] = [],
): Promise<ApiTestServer> {
  const api = await startTestApi(orchestrator, engines, undefined, () => waiting);
  servers.push(api);
  return api;
}

/** An engine as the app mounts one, recording every request that reached its router. */
function fakeEngine(reached: string[]): EnginePlugin {
  return {
    name: 'fake',
    prefix: '/fake',
    createRouter: () => {
      const router = Router();
      router.post('/on_publish', (_req, res) => {
        reached.push('on_publish');
        res.json({ ok: true });
      });
      return router;
    },
  };
}

function startStream(api: ApiTestServer): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return api.request('/stream/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streamId: STREAM_ID, mediatype: MEDIA_TYPE_VIDEO }),
  });
}

/**
 * ⛔⛔⛔ **Nothing answered at all while the node was down, and that is what made the deploy fail.**
 *
 * The API server was the last thing `start()` built, behind the start gates, the catalog feed lookup
 * and the recovery pass. Every one of those talks to a Bee node, so a node that was not answering
 * meant no listener, no `/health`, and a container that exited and was restarted into the same wall.
 * A deploy watching for a service to come up saw a restart count climbing and refused, correctly by
 * its own rule and about the wrong thing: the uploader was fine and its node was not there yet.
 *
 * Since the owner's ruling of 2026-09-17 the listener comes first. `/health` answers from the first
 * second, saying `waiting_for_node` with the node it is waiting for and since when, which is what a
 * deploy page can show a person. The routes that need the node behind them refuse cleanly with 503
 * instead of reaching an orchestrator whose catalog has never been read.
 */
describe('the uploader while it is waiting for its node', () => {
  it('answers /health at all, which is the whole point of listening first', async () => {
    const api = await startApi();

    const { status } = await api.request('/health');

    assert.equal(status, 503, 'waiting is not healthy, and a probe has to be able to tell');
  });

  it('says what it is waiting for, and since when', async () => {
    const api = await startApi();

    const { body } = await api.request('/health');
    const health = body as Record<string, unknown>;

    assert.equal(health.status, HEALTH_WAITING_FOR_NODE);
    assert.deepEqual(health.reasons, [HEALTH_REASON_NODE_UNAVAILABLE]);
    assert.equal(health.waitingSince, WAITING.waitingSince);
    assert.deepEqual(health.node, { url: NODE_URL, attempts: 3, lastError: 'timeout of 20000ms exceeded' });
  });

  it('goes back to reporting on itself once the node has answered', async () => {
    const api = await startApi(makeTestOrchestrator(), null);

    const { status, body } = await api.request('/health');

    assert.equal(status, 200);
    assert.equal((body as Record<string, unknown>).status, HEALTH_OK);
    assert.equal((body as Record<string, unknown>).node, undefined, 'a service that is not waiting names no node');
  });

  // The failure this refusal replaces is not a 500. It is `startStream` reaching an orchestrator
  // whose catalog has never been read, which publishes a broadcast nothing can announce.
  it('refuses a stream an engine tries to register, and never reaches the orchestrator', async () => {
    const started: string[] = [];
    const api = await startApi(makeFakeOrchestrator({ startStream: (id: string) => started.push(id) > 0 }));

    const { status, body, headers } = await startStream(api);

    assert.equal(status, 503);
    assert.deepEqual(started, [], 'the orchestrator must not see a stream before its catalog has been read');
    assert.equal((body as Record<string, unknown>).ok, false);
    assert.match(String((body as Record<string, unknown>).error), new RegExp(NODE_URL));
    assert.equal(headers['retry-after'], '5', 'an engine that retries needs to be told when, not left to guess');
  });

  it('refuses an engine webhook the same way, before the engine router runs', async () => {
    const reached: string[] = [];
    const api = await startApi(makeTestOrchestrator(), WAITING, [fakeEngine(reached)]);

    const { status } = await api.request('/fake/on_publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'live', stream: 'one' }),
    });

    assert.equal(status, 503);
    assert.deepEqual(reached, []);
  });

  it('publishes no credential from the node url on /health', async () => {
    const api = await startApi(makeTestOrchestrator(), await reportFor(CREDENTIALLED_NODE));

    const { body } = await api.request('/health');

    assert.doesNotMatch(JSON.stringify(body), /hunter2/, 'a credential in BEE_URL reached an unauthenticated reader');
    assert.match(JSON.stringify(body), /bee-a:1633/, 'the node still has to be nameable');
  });

  it('puts no credential into the 503 an engine is told and logs', async () => {
    const api = await startApi(makeFakeOrchestrator(), await reportFor(CREDENTIALLED_NODE));

    const { body } = await startStream(api);

    assert.doesNotMatch(String((body as Record<string, unknown>).error), /hunter2/);
    assert.match(String((body as Record<string, unknown>).error), /bee-a:1633/);
  });

  // The credential gate stays in front, so waiting does not become a way to learn the service exists
  // without holding its token.
  it('still refuses an unauthenticated caller as unauthenticated', async () => {
    const api = await startApi();

    const { status } = await api.request('/stream/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...NO_AUTH_HEADER },
      body: JSON.stringify({ streamId: STREAM_ID, mediatype: MEDIA_TYPE_VIDEO }),
    });

    assert.equal(status, 401);
  });

  // Counters are a fact about this process rather than about the node, and a scraper that loses them
  // exactly while something is wrong has lost them when they were most worth having.
  it('keeps serving /metrics, which needs no node behind it', async () => {
    const api = await startApi();

    const { status } = await api.request('/metrics');

    assert.equal(status, 200);
  });

  it('serves the stream routes normally once the node has answered', async () => {
    const started: string[] = [];
    const api = await startApi(makeFakeOrchestrator({ startStream: (id: string) => started.push(id) > 0 }), null);

    const { status, body } = await startStream(api);

    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(started, [STREAM_ID]);
  });
});

/**
 * The order that makes all of the above reachable, read off the source.
 *
 * Asserted as text rather than by booting the service, for the reason `ChequebookGate.test.ts` gives
 * about the same file: `index.ts` calls `start()` at module scope, so importing it launches the
 * uploader. Nothing else holds this order, and every case above is vacuous without it. A listener
 * built after the wait answers nothing while the wait is on, which is exactly the state the service
 * was in until 2026-09-17.
 */
describe('the entry point listens before it reads a node', () => {
  const ENTRY_POINT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
  const source = readFileSync(ENTRY_POINT, 'utf8');

  const at = (needle: string): number => {
    const index = source.indexOf(needle);
    assert.ok(index > -1, `index.ts no longer contains ${needle}, so this ordering assertion checks nothing`);
    return index;
  };

  it('starts the API server before the wait for the node begins', () => {
    assert.ok(
      at('startApiServer(') < at('waitForNode('),
      'the listener must exist before the wait, or /health cannot report the wait at all',
    );
  });

  /**
   * ⛔ The probe reads through the gates' own clients, not the upload loop's.
   *
   * `buildPublishers` is called twice, once at BEE_REQUEST_TIMEOUT_MS for the upload loop and once at
   * START_GATE_TIMEOUT_MS for the gates. A probe through the first would give a node four seconds to
   * answer a liveness check where the gates behind it would have waited twenty, so a node that is
   * merely slow to answer would be waited for forever by a boot whose gates could have cleared it.
   */
  it('probes through the gate pool, so the budget is the one the gates read on', () => {
    assert.match(
      source,
      /assertNodeReachable\(gatePublishers\.coordinator\(\)\)/,
      'the probe must use the pool built at the gate timeout',
    );
    assert.doesNotMatch(
      source,
      /assertNodeReachable\(publishers\.coordinator\(\)\)/,
      'the upload loop pool carries a four second deadline, which is not what the gates read on',
    );
    assert.ok(
      at('const gatePublishers = buildPublishers(config.startGateTimeoutMs)') < at('assertNodeReachable('),
      'the gate pool has to exist before the probe reads through it',
    );
  });

  // The cheapest question first. A node that is not there answers a gate with a timeout it spends a
  // whole budget on, and answers the catalog with a status that has to be interpreted. See NodeWait.
  it('asks whether the node is there before it spends a gate budget on it', () => {
    assert.ok(
      at('assertNodeReachable(') < at('runStartGates('),
      'the probe must run first, or a dead four node pool costs 160 seconds an attempt to learn nothing',
    );
    assert.ok(at('assertNodeReachable(') > at('waitForNode('), 'the probe belongs inside the wait, not in front of it');
  });

  for (const step of ['assertFunded(', 'assertUsable(', 'streamCatalog.init(', 'recoverStreams(']) {
    it(`runs ${step} inside the wait, so a node that is not there is waited for rather than fatal`, () => {
      assert.ok(at('waitForNode(') < at(step), `${step} runs outside the wait and would end the boot again`);
    });
  }

  it('builds the first report through safeUrl, since the wait has not started yet', () => {
    assert.match(
      source,
      /const coordinatorUrl = safeUrl\(/,
      'index.ts must strip the coordinator url once and use that, or the first seconds of /health leak it',
    );
    assert.doesNotMatch(
      source,
      /url: publishers\.coordinator\(\)\.url/,
      'the raw configured url must not reach a report or the wait',
    );
  });

  it('hands the API a reader of the wait rather than a copy of it', () => {
    assert.match(
      source,
      /waitingForNode: \(\) =>/,
      'passing the value rather than a reader freezes /health at whatever the first second held',
    );
  });
});
