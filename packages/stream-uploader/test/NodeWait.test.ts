import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isNodeUnavailable,
  NODE_WAIT_FIRST_DELAY_MS,
  NODE_WAIT_MAX_DELAY_MS,
  waitForNode,
} from '../src/libs/NodeWait.js';
import { NodeWaitReport } from '../src/types.js';

const NODE_URL = 'http://bee-uploader:1633';
const WAITING_SINCE = '2026-09-17T09:00:00.000Z';

/**
 * A gate's refusal with the cause inside the sentence, at today's gate budget.
 *
 * The live host saw this shape on 2026-09-16 with 4000ms in it, which is what the gates were bounded
 * by before START_GATE_TIMEOUT_MS existed. What matters to the classifier is the wrapping, not the
 * number.
 */
function wrappedTimeout(): Error {
  return new Error(
    `[ChequebookGate] ${NODE_URL} chequebook is absent or unreadable: timeout of 20000ms exceeded. ` +
      'The uploader refuses to run without a funding reading.',
  );
}

function withCode(code: string): Error {
  const error = new Error(`connect ${code} 10.0.0.9:1633`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function withStatus(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { status });
}

function watcher() {
  const slept: number[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const reports: NodeWaitReport[] = [];

  return {
    slept,
    warnings,
    notices,
    reports,
    options: {
      url: NODE_URL,
      logger: {
        info: (message: string) => notices.push(message),
        warn: (message: string) => warnings.push(message),
      },
      onReport: (report: NodeWaitReport) => reports.push(report),
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      now: () => new Date(WAITING_SINCE),
    },
  };
}

/** An init that fails `failures` times with `error`, then answers. Counts its own calls. */
function failingInit(failures: number, error: () => Error, answer = 'ready') {
  let calls = 0;
  return {
    calls: () => calls,
    run: async () => {
      calls += 1;
      if (calls <= failures) {
        throw error();
      }
      return answer;
    },
  };
}

/**
 * ⛔⛔⛔ **A node that is not there yet is not a reason to refuse to start.**
 *
 * Every node-dependent step of the boot used to be a one-shot: the two start gates, the catalog feed
 * lookup, and the recovery pass ran in turn, and the first one that could not reach its node threw
 * out of `start()`, which logged "Failed to start" and exited 1. Docker restarted the container, the
 * next boot met the same node and did the same thing, and the deploy guard read the rising restart
 * count as a service falling over and refused the deploy. Nothing in that chain was wrong about the
 * node. It simply was not answering yet, which is what a bee node that is still opening its database
 * looks like, and what a rung whose container starts a second later looks like.
 *
 * The owner ruled on 2026-09-17: "we should be able to start the uploader but maybe say its node not
 * available, try to reconnect or something". So the node-dependent half of the boot runs in here
 * instead, and a failure that says the node is not answering costs a log line and a wait rather than
 * the process. A failure that says something else, a malformed feed or a key this deployment cannot
 * sign with, still ends the boot, because retrying it would loop for ever on something no amount of
 * waiting repairs.
 */
describe('waiting for the node', () => {
  it('runs the initialisation once and hands back its answer when the node is there', async () => {
    const seen = watcher();
    const init = failingInit(0, wrappedTimeout);

    const answer = await waitForNode(init.run, seen.options);

    assert.equal(answer, 'ready');
    assert.equal(init.calls(), 1);
    assert.deepEqual(seen.slept, [], 'a node that answered must cost no wait at all');
    assert.deepEqual(seen.warnings, []);
  });

  it('says the node answered, and after how many attempts', async () => {
    const seen = watcher();

    await waitForNode(failingInit(2, wrappedTimeout).run, seen.options);

    assert.equal(seen.notices.length, 1);
    assert.match(seen.notices[0], new RegExp(NODE_URL));
    assert.match(seen.notices[0], /3 attempt/);
  });

  it('waits and tries again for as long as the node is not answering', async () => {
    const seen = watcher();
    const init = failingInit(2, wrappedTimeout);

    const answer = await waitForNode(init.run, seen.options);

    assert.equal(answer, 'ready');
    assert.equal(init.calls(), 3);
    assert.deepEqual(seen.slept, [1_000, 2_000]);
  });

  it('writes one line per failed attempt, naming the node and the next wait', async () => {
    const seen = watcher();

    await waitForNode(failingInit(2, wrappedTimeout).run, seen.options);

    assert.equal(seen.warnings.length, 2);
    assert.match(seen.warnings[0], new RegExp(`node not available at ${NODE_URL}`));
    assert.match(seen.warnings[0], /retrying in 1s/);
    assert.match(seen.warnings[0], /timeout of 20000ms exceeded/);
    assert.match(seen.warnings[1], /retrying in 2s/);
  });

  // Doubling without a ceiling reaches hours, and an operator who has just fixed the node would
  // then watch a service that could start sit there not starting.
  it('doubles the wait and then holds it at the ceiling', async () => {
    const seen = watcher();

    await waitForNode(failingInit(8, wrappedTimeout).run, seen.options);

    assert.deepEqual(seen.slept, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('ships the delays it documents', () => {
    assert.equal(NODE_WAIT_FIRST_DELAY_MS, 1_000);
    assert.equal(NODE_WAIT_MAX_DELAY_MS, 30_000);
  });

  it('reports that it is waiting before it has tried anything', async () => {
    const seen = watcher();

    await waitForNode(failingInit(0, wrappedTimeout).run, seen.options);

    assert.equal(
      seen.reports.length,
      1,
      '/health has to say waiting from the first second, not from the first failure',
    );
    assert.equal(seen.reports[0].url, NODE_URL);
    assert.equal(seen.reports[0].waitingSince, WAITING_SINCE);
    assert.equal(seen.reports[0].attempts, 0);
    assert.equal(seen.reports[0].lastError, undefined);
  });

  it('carries the attempt count and the last error into each later report', async () => {
    const seen = watcher();

    await waitForNode(failingInit(2, wrappedTimeout).run, seen.options);

    assert.equal(seen.reports.length, 3);
    assert.equal(seen.reports[1].attempts, 1);
    assert.match(String(seen.reports[1].lastError), /timeout of 20000ms exceeded/);
    assert.equal(seen.reports[2].attempts, 2);
    // One waiting_since for the whole wait, or a page watching it can never say how long it has been.
    assert.deepEqual(
      seen.reports.map((report) => report.waitingSince),
      [WAITING_SINCE, WAITING_SINCE, WAITING_SINCE],
    );
  });

  // The other half of the rule, and the more important one: waiting on a fault that waiting cannot
  // fix is a service that never starts and never says why it will not.
  it('rethrows a failure that is not the node being unreachable, without waiting once', async () => {
    const seen = watcher();
    const init = failingInit(1, () => new Error('the configured STREAM_KEY is not a valid private key'));

    await assert.rejects(() => waitForNode(init.run, seen.options), /not a valid private key/);
    assert.deepEqual(seen.slept, []);
    assert.deepEqual(seen.warnings, []);
    assert.equal(init.calls(), 1);
  });
});

/**
 * What counts as "the node is not answering", read off the error rather than assumed.
 *
 * ⚠️ The message matters as much as the code, because the two gates in front of this do not rethrow
 * what bee-js threw: they wrap the cause in a sentence of their own. An error whose `code` is gone
 * and whose text ends in "timeout of 20000ms exceeded" is that shape at today's budget, and the live
 * failure of 2026-09-16 was the same sentence saying 4000ms.
 */
describe('an error that says the node is not there', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
    it(`reads ${code} as the node not being there`, () => {
      assert.equal(isNodeUnavailable(withCode(code)), true);
    });
  }

  for (const [name, error] of Object.entries({
    'a gate quoting a timeout it hit': wrappedTimeout(),
    'a connection that was refused, said in words': new Error('connect ECONNREFUSED 127.0.0.1:1633'),
    'a name that does not resolve': new Error('getaddrinfo ENOTFOUND bee-uploader'),
    'a socket that hung up': new Error('socket hang up'),
    'a fetch that never landed': new Error('fetch failed'),
  })) {
    it(`reads ${name} as the node not being there`, () => {
      assert.equal(isNodeUnavailable(error), true);
    });
  }

  // A node answering 5xx is a node that is up and cannot serve the request yet, which is the same
  // wait with a different cause: a bee still opening its database answers exactly this.
  for (const status of [500, 502, 503, 504]) {
    it(`reads a ${status} from the node as the node not being ready`, () => {
      assert.equal(isNodeUnavailable(withStatus(status)), true);
    });
  }

  for (const [name, error] of Object.entries({
    'a key this deployment cannot sign with': new Error('the configured STREAM_KEY is not a valid private key'),
    'a feed whose payload made no sense': new Error('invalid feed payload: unexpected end of JSON input'),
    'a batch the node does not hold': withStatus(404),
    'a request the node refused to read': withStatus(400),
    'a chequebook below the floor': new Error(
      `[ChequebookGate] ${NODE_URL} has 0.1000 BZZ available in its chequebook and the floor is 0.5000 BZZ.`,
    ),
  })) {
    it(`does not read ${name} as the node not being there`, () => {
      assert.equal(isNodeUnavailable(error), false);
    });
  }
});
