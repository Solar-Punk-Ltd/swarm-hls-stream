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
    await assert.rejects(() => gate.assertFunded(), { message: /refuses to run/ });
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
 * A gate that runs late is not a gate. Asserted against the source rather than by starting the
 * service, because `index.ts` calls `start()` at module scope, so importing it launches the uploader
 * and there is nothing left to assert on. `envLoadOrder.test.ts` guards the import order of the same
 * file the same way and for the same reason.
 */
describe('the entry point clears the gate before anything paid or stateful', () => {
  const ENTRY_POINT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
  const source = readFileSync(ENTRY_POINT, 'utf8');

  it('calls assertFunded at all, so the rule is a control rather than a docblock', () => {
    assert.match(source, /assertFunded\(/, 'index.ts never clears the chequebook gate');
  });

  for (const later of ['new RecoveryStore(', 'streamCatalog.init(', 'recoverStreams(', 'loadEngines(']) {
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
