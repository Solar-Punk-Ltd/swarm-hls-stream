import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bzzToPlur,
  ChequebookClient,
  ChequebookGate,
  ChequebookNode,
  FundingLogger,
  PLUR_PER_BZZ,
} from '../src/libs/ChequebookGate.js';
import { GateRefusalError } from '../src/libs/GateRefusalError.js';
import { GateRefusal } from '../src/libs/StartGates.js';

const FLOOR_PLUR = bzzToPlur(0.5);

/** A balance field as bee-js hands it over: a `BZZ`, whose only method this reads is the PLUR one. */
const balance = (plur: bigint) => ({ toPLURBigInt: () => plur });

interface Reads {
  /** One entry per call, so a node checked twice is visible rather than merely suspected. */
  urls: string[];
}

function reader(): Reads {
  return { urls: [] };
}

/** A bee whose chequebook call answers with `body`, recording that it was asked. */
function answering(url: string, body: unknown, reads: Reads): ChequebookClient {
  return {
    getChequebookBalance: async () => {
      reads.urls.push(url);
      return body;
    },
  };
}

/** A node whose chequebook answers with `availablePlur`, and a `totalBalance` well above it. */
function node(url: string, availablePlur: bigint, reads: Reads): ChequebookNode {
  const body = {
    totalBalance: balance(availablePlur + 100n * PLUR_PER_BZZ),
    availableBalance: balance(availablePlur),
  };
  return { url, bee: answering(url, body, reads) };
}

/** A node whose chequebook call rejects, which is what a SWAP-disabled bee does. */
function refusingNode(url: string, reason: string, reads: Reads): ChequebookNode {
  return {
    url,
    bee: {
      getChequebookBalance: async () => {
        reads.urls.push(url);
        throw new Error(reason);
      },
    },
  };
}

/** A node that answers, but with a body the gate cannot read an available balance out of. */
function shapelessNode(url: string, body: unknown, reads: Reads): ChequebookNode {
  return { url, bee: answering(url, body, reads) };
}

function recordingLogger(): FundingLogger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (message: string) => lines.push(message) };
}

describe('bzzToPlur', () => {
  it('converts the shipped floor to the integer base unit bee reports balances in', () => {
    assert.equal(bzzToPlur(0.5), 5_000_000_000_000_000n);
    assert.equal(bzzToPlur(1), PLUR_PER_BZZ);
    assert.equal(bzzToPlur(0), 0n);
  });
});

describe('the chequebook gate', () => {
  it('refuses a node below the floor, naming it and both numbers', async () => {
    const reads = reader();
    const gate = new ChequebookGate([node('http://bee-a:1633', bzzToPlur(0.1), reads)], FLOOR_PLUR, recordingLogger());

    await assert.rejects(() => gate.assertFunded(), {
      message: /http:\/\/bee-a:1633/,
    });
    await assert.rejects(() => gate.assertFunded(), { message: /0\.1000 BZZ/ });
    await assert.rejects(() => gate.assertFunded(), { message: /0\.5000 BZZ/ });
    await assert.rejects(() => gate.assertFunded(), { message: /every paid push behind it stalls/ });
    await assert.rejects(() => gate.assertFunded(), { message: /chequebook deposit/ });
  });

  // The floor is the lowest funding that still runs, not the first one refused. A node sitting on it
  // exactly is the boundary an operator hits after depositing precisely the shortfall.
  it('passes a node sitting exactly on the floor', async () => {
    const reads = reader();
    const logger = recordingLogger();
    const gate = new ChequebookGate([node('http://bee-a:1633', FLOOR_PLUR, reads)], FLOOR_PLUR, logger);

    await gate.assertFunded();

    assert.deepEqual(reads.urls, ['http://bee-a:1633']);
  });

  // The whole point of reading availableBalance rather than totalBalance: total counts value already
  // promised in uncashed cheques, so a node with nothing left to spend still reports a healthy total.
  it('reads availableBalance, so a drained node with a large total still refuses', async () => {
    const reads = reader();
    const drained: ChequebookNode = {
      url: 'http://bee-a:1633',
      bee: {
        getChequebookBalance: async () => {
          reads.urls.push('http://bee-a:1633');
          return { totalBalance: balance(bzzToPlur(50)), availableBalance: balance(bzzToPlur(0.01)) };
        },
      },
    };

    await assert.rejects(() => new ChequebookGate([drained], FLOOR_PLUR, recordingLogger()).assertFunded(), {
      message: /0\.0100 BZZ/,
    });
  });

  it('logs one reading per node when every node clears the floor', async () => {
    const reads = reader();
    const logger = recordingLogger();
    const gate = new ChequebookGate(
      [node('http://bee-a:1633', bzzToPlur(2), reads), node('http://bee-b:1633', bzzToPlur(0.75), reads)],
      FLOOR_PLUR,
      logger,
    );

    await gate.assertFunded();

    assert.equal(logger.lines.length, 2, 'every boot must leave a funding reading per node in the log');
    assert.match(logger.lines[0], /http:\/\/bee-a:1633/);
    assert.match(logger.lines[0], /2\.0000 BZZ/);
    assert.match(logger.lines[1], /http:\/\/bee-b:1633/);
    assert.match(logger.lines[1], /0\.7500 BZZ/);
  });

  // A bee running with SWAP off has no chequebook at all, and its endpoint rejects rather than
  // answering zero. "Cannot be read" and "is empty" are different facts and neither one is filled.
  it('refuses a node whose chequebook call rejects, saying it is absent or unreadable', async () => {
    const reads = reader();
    const gate = new ChequebookGate(
      [refusingNode('http://bee-a:1633', 'chequebook disabled', reads)],
      FLOOR_PLUR,
      recordingLogger(),
    );

    await assert.rejects(() => gate.assertFunded(), { message: /absent or unreadable/ });
    await assert.rejects(() => gate.assertFunded(), { message: /http:\/\/bee-a:1633/ });
    await assert.rejects(() => gate.assertFunded(), { message: /chequebook disabled/ });
  });

  for (const [name, body] of Object.entries({
    null: null,
    undefined: undefined,
    'an empty object': {},
    'a total with no available': { totalBalance: balance(bzzToPlur(9)) },
    'an available that is not an amount': { availableBalance: '5000000000000000' },
  })) {
    it(`refuses a chequebook response that is ${name}`, async () => {
      const reads = reader();
      const gate = new ChequebookGate([shapelessNode('http://bee-a:1633', body, reads)], FLOOR_PLUR, recordingLogger());

      await assert.rejects(() => gate.assertFunded(), { message: /absent or unreadable/ });
    });
  }

  it('refuses when reading the amount itself throws', async () => {
    const reads = reader();
    const exploding = shapelessNode(
      'http://bee-a:1633',
      {
        availableBalance: {
          toPLURBigInt: () => {
            throw new Error('bad fixed point state');
          },
        },
      },
      reads,
    );

    await assert.rejects(() => new ChequebookGate([exploding], FLOOR_PLUR, recordingLogger()).assertFunded(), {
      message: /absent or unreadable/,
    });
  });

  it('checks every node in the ladder, and each distinct url exactly once', async () => {
    const reads = reader();
    const gate = new ChequebookGate(
      [
        node('http://bee-360:1633', bzzToPlur(1), reads),
        node('http://bee-480:1643', bzzToPlur(1), reads),
        // Two rungs behind one node is a legal deployment, and its chequebook is still one chequebook.
        node('http://bee-360:1633', bzzToPlur(1), reads),
        node('http://bee-1080:1663', bzzToPlur(1), reads),
      ],
      FLOOR_PLUR,
      recordingLogger(),
    );

    await gate.assertFunded();

    assert.deepEqual(reads.urls, ['http://bee-360:1633', 'http://bee-480:1643', 'http://bee-1080:1663']);
  });

  it('names the first node that fails, and stops there rather than reporting the last', async () => {
    const reads = reader();
    const gate = new ChequebookGate(
      [
        node('http://bee-360:1633', bzzToPlur(1), reads),
        node('http://bee-480:1643', bzzToPlur(0.2), reads),
        node('http://bee-1080:1663', bzzToPlur(0.01), reads),
      ],
      FLOOR_PLUR,
      recordingLogger(),
    );

    await assert.rejects(() => gate.assertFunded(), { message: /http:\/\/bee-480:1643/ });
    assert.deepEqual(reads.urls, ['http://bee-360:1633', 'http://bee-480:1643']);
  });

  // A gate over nothing must not report success it never established. Unreachable through
  // `BeePublisherPool`, which always holds at least one node, so this asserts the shape rather than
  // a path: a future caller handing over an empty list is a bug, not a deployment with no bee.
  it('refuses an empty node set rather than passing vacuously', async () => {
    await assert.rejects(() => new ChequebookGate([], FLOOR_PLUR, recordingLogger()).assertFunded(), {
      message: /no Bee node/,
    });
  });

  // A floor of zero is the deliberate opt-out, and it still has to read every chequebook: an absent
  // one is not a balance of zero, and a node with SWAP off cannot publish whatever the floor says.
  it('still refuses an unreadable chequebook when the floor is zero', async () => {
    const reads = reader();
    const zeroFloor = new ChequebookGate([node('http://bee-a:1633', 0n, reads)], 0n, recordingLogger());
    await zeroFloor.assertFunded();

    const absent = new ChequebookGate(
      [refusingNode('http://bee-a:1633', 'no chequebook', reads)],
      0n,
      recordingLogger(),
    );
    await assert.rejects(() => absent.assertFunded(), { message: /absent or unreadable/ });
  });
});

/**
 * ⛔ **A refusal is read by more people than the request that caused it.**
 *
 * bee accepts basic auth in the URL's userinfo, so a `BEE_PUBLISHERS` entry can carry a credential,
 * and these messages travel further than a log file: under `warn` they reach `/health` through a
 * latch, and they are quoted into deploy output and pasted into reports. `BeePublisherPool.routing`
 * already answers with the same URLs stripped, for exactly this reason, and this uses the same helper
 * so the two cannot drift.
 */
describe('what a refusal says about the node url', () => {
  it('strips a credential out of a refusal', async () => {
    const reads = reader();
    const gate = new ChequebookGate(
      [refusingNode('http://operator:hunter2@bee-a:1633', 'chequebook disabled', reads)],
      FLOOR_PLUR,
      recordingLogger(),
    );

    await assert.rejects(() => gate.assertFunded(), /bee-a:1633/);
    await assert.rejects(
      () => gate.assertFunded(),
      (error: Error) => {
        assert.doesNotMatch(error.message, /hunter2/, 'a credential in BEE_PUBLISHERS must not reach a message');
        assert.doesNotMatch(error.message, /operator/);
        return true;
      },
    );
  });

  it('strips one out of the reading it logs when the node clears', async () => {
    const reads = reader();
    const logger = recordingLogger();

    await new ChequebookGate(
      [{ ...node('http://operator:hunter2@bee-a:1633', bzzToPlur(2), reads) }],
      FLOOR_PLUR,
      logger,
    ).assertFunded();

    assert.doesNotMatch(logger.lines[0], /hunter2/);
    assert.match(logger.lines[0], /bee-a:1633/);
  });

  // What `waitForNode` reads to say which node the boot is waiting for. A pool of four has three
  // others, and a refusal reported against the wrong one sends an operator to a node that is working.
  it('names the node it refused on the error itself, not only in the sentence', async () => {
    const reads = reader();
    const gate = new ChequebookGate(
      [node('http://operator:hunter2@bee-1080:1663', bzzToPlur(0.1), reads)],
      FLOOR_PLUR,
      recordingLogger(),
    );

    await assert.rejects(
      () => gate.assertFunded(),
      (error: unknown) => {
        assert.ok(error instanceof GateRefusalError);
        // Normalised, since safeUrl rebuilds a url it had to take a credential out of. See its doc.
        assert.equal(error.nodeUrl, 'http://bee-1080:1663/');
        return true;
      },
    );
  });

  it('leaves a url with nothing to hide exactly as the operator wrote it', async () => {
    const reads = reader();
    const gate = new ChequebookGate([node('http://bee-a:1633', bzzToPlur(0.1), reads)], FLOOR_PLUR, recordingLogger());

    await assert.rejects(() => gate.assertFunded(), /http:\/\/bee-a:1633 has/);
  });
});

/**
 * ⛔ **Under `warn` the first bad node used to be the only one an operator heard about.**
 *
 * The loop above throws at the first refusal, which is right when the refusal stops the boot: there
 * is nothing to learn from the second node when the service is not going to start. Since the owner's
 * ruling of 2026-09-17 the service does start, so that same throw meant a four rung stage reported
 * one rung per boot and an operator fixed them one restart at a time.
 *
 * Handing the gate somewhere to put a refusal changes that and nothing else. Every node is read, each
 * one that cannot be cleared is handed over with the message it would have thrown, and the caller
 * decides what that costs. The runner always hands one over, and under `refuse` that collector throws
 * at the first refusal, so the no-collector path below is a direct caller's rather than a mode's.
 */
describe('the chequebook gate with somewhere to put a refusal', () => {
  it('reads every node rather than stopping at the first that fails', async () => {
    const reads = reader();
    const collected: GateRefusal[] = [];
    const gate = new ChequebookGate(
      [
        node('http://bee-360:1633', bzzToPlur(0.1), reads),
        node('http://bee-480:1643', bzzToPlur(2), reads),
        refusingNode('http://bee-720:1653', 'chequebook disabled', reads),
      ],
      FLOOR_PLUR,
      recordingLogger(),
    );

    await gate.assertFunded((refusal) => collected.push(refusal));

    assert.deepEqual(reads.urls, ['http://bee-360:1633', 'http://bee-480:1643', 'http://bee-720:1653']);
    assert.deepEqual(
      collected.map((refusal) => refusal.url),
      ['http://bee-360:1633', 'http://bee-720:1653'],
    );
    assert.match(collected[0].message, /0\.1000 BZZ/);
    assert.match(collected[1].message, /chequebook disabled/);
  });

  it('logs a reading for the nodes that did clear, in the same pass', async () => {
    const reads = reader();
    const logger = recordingLogger();

    await new ChequebookGate(
      [node('http://bee-360:1633', bzzToPlur(0.1), reads), node('http://bee-480:1643', bzzToPlur(2), reads)],
      FLOOR_PLUR,
      logger,
    ).assertFunded(() => {});

    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0], /http:\/\/bee-480:1643/);
  });

  // The rung is what /health may publish about a warned gate. The url is not, so the gate hands both
  // over and the caller picks: the log gets the url, the health payload gets the rung.
  it('names the rung when the caller gave its nodes one', async () => {
    const reads = reader();
    const collected: GateRefusal[] = [];
    const rungNode = { ...node('http://bee-360:1633', bzzToPlur(0.1), reads), rung: '360p' };

    await new ChequebookGate([rungNode], FLOOR_PLUR, recordingLogger()).assertFunded((refusal) =>
      collected.push(refusal),
    );

    assert.equal(collected[0].rung, '360p');
  });

  it('leaves the rung out when the caller had none, rather than inventing one', async () => {
    const reads = reader();
    const collected: GateRefusal[] = [];

    await new ChequebookGate(
      [node('http://bee-a:1633', bzzToPlur(0.1), reads)],
      FLOOR_PLUR,
      recordingLogger(),
    ).assertFunded((refusal) => collected.push(refusal));

    assert.equal(collected[0].rung, undefined);
  });

  // An empty set is a caller bug rather than a node that could not be read, so it stays a throw the
  // collector never sees. Nothing may report a gate as cleared when it read nothing at all.
  it('still refuses an empty node set while collecting', async () => {
    await assert.rejects(() => new ChequebookGate([], FLOOR_PLUR, recordingLogger()).assertFunded(() => {}), {
      message: /no Bee node/,
    });
  });
});

/**
 * A gate that runs late is not a gate. Asserted against the source rather than by starting the
 * service, because `index.ts` calls `start()` at module scope, so importing it launches the uploader
 * and there is nothing left to assert on. `envLoadOrder.test.ts` guards the import order of the same
 * file the same way and for the same reason.
 *
 * ⚠️ Two of the four steps this used to sort against moved ahead of the gate on 2026-09-17, and that
 * is decision D16 rather than a regression. `new RecoveryStore(` reads the state directory and
 * `loadEngines(` imports a module, so neither asks a node anything, and both are now built before the
 * API server listens, which is what lets `/health` answer while the node-dependent half of the boot
 * waits for a node that is not there yet. What still has to come after the gate is every step that
 * reads or writes through one. What keeps a stream away from an orchestrator whose catalog has not
 * been read is `refuseWhileWaiting`, asserted in `waitingForNode.test.ts`, rather than this ordering.
 */
describe('the entry point clears the gate before anything paid or stateful', () => {
  const ENTRY_POINT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
  const source = readFileSync(ENTRY_POINT, 'utf8');

  it('calls assertFunded at all, so the rule is a control rather than a docblock', () => {
    assert.match(source, /assertFunded\(/, 'index.ts never clears the chequebook gate');
  });

  for (const later of ['streamCatalog.init(', 'recoverStreams(']) {
    it(`clears it before ${later}`, () => {
      const gateAt = source.indexOf('assertFunded(');
      const laterAt = source.indexOf(later);

      assert.ok(laterAt > -1, `index.ts no longer calls ${later}, so this ordering assertion checks nothing`);
      assert.ok(
        gateAt > -1 && gateAt < laterAt,
        `${later} runs ahead of the chequebook gate, so the uploader reaches it on a node that cannot pay`,
      );
    });
  }
});

/**
 * ⛔ **The same split the postage gate makes, because this gate's refusals have the same two kinds.**
 *
 * A balance under the floor is the node answering with a number. A read that threw may be either: a
 * 4xx is the node refusing the request, and anything else, a timeout, a 5xx or no status at all, is
 * no reading arriving. A body with no readable `availableBalance` in it is no reading either. This
 * gate warns under the shipped mode whichever it is, so what the reading changes today is only what
 * `refuse` and a future policy see. It is recorded because the fact belongs to the gate that
 * established it, and `runStartGates` is the one place that decides what a boot does about it.
 */
describe('which reading a chequebook refusal carries', () => {
  async function readingOf(nodes: readonly ChequebookNode[]): Promise<string | undefined> {
    const collected: GateRefusal[] = [];
    await new ChequebookGate(nodes, FLOOR_PLUR, recordingLogger()).assertFunded((refusal) => collected.push(refusal));
    assert.equal(collected.length, 1, 'exactly one refusal was expected');
    return collected[0].reading;
  }

  /** A node whose chequebook read rejects with `failure` rather than with a bare message. */
  function throwingNode(url: string, failure: unknown): ChequebookNode {
    return {
      url,
      bee: {
        getChequebookBalance: async () => {
          throw failure;
        },
      },
    };
  }

  it('reads a balance under the floor as the node answering with a number', async () => {
    const reads = reader();

    assert.equal(await readingOf([node('http://bee-a:1633', bzzToPlur(0.1), reads)]), 'answered');
  });

  it('reads a 4xx as the node answering the request', async () => {
    const notFound = Object.assign(new Error('chequebook disabled'), { name: 'BeeResponseError', status: 404 });

    assert.equal(await readingOf([throwingNode('http://bee-a:1633', notFound)]), 'answered');
  });

  it('reads a 5xx as no reading at all', async () => {
    const unready = Object.assign(new Error('bad gateway'), { name: 'BeeResponseError', status: 502 });

    assert.equal(await readingOf([throwingNode('http://bee-a:1633', unready)]), 'unreadable');
  });

  it('reads the timeout that ended the boot on 2026-09-16 as no reading at all', async () => {
    assert.equal(
      await readingOf([throwingNode('http://bee-a:1633', new Error('timeout of 4000ms exceeded'))]),
      'unreadable',
    );
  });

  it('reads a body with no available balance in it as no reading at all', async () => {
    const reads = reader();

    assert.equal(
      await readingOf([shapelessNode('http://bee-a:1633', { totalBalance: balance(9n) }, reads)]),
      'unreadable',
    );
  });
});
