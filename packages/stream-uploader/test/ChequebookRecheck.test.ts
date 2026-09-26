import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { bzzToPlur, ChequebookGate, ChequebookNode, PLUR_PER_BZZ } from '../src/libs/ChequebookGate.js';
import { ChequebookRecheck, StartGateWarningStore } from '../src/libs/ChequebookRecheck.js';
import { StartGate } from '../src/libs/StartGates.js';
import { HEALTH_OK, HEALTH_REASON_START_GATE_WARNED, StartGateWarning } from '../src/types.js';

import { ApiTestServer, startTestApi } from './helpers/apiTestServer.js';
import { FakeClock } from './helpers/fakeClock.js';
import { makeTestOrchestrator } from './helpers/fakes.js';

const FLOOR_PLUR = bzzToPlur(0.5);
const RECHECK_MS = 60_000;
const CHEQUEBOOK_GATE = 'ChequebookGate';
const POSTAGE_GATE = 'PostageGate';

const servers: ApiTestServer[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** A chequebook whose available balance a test sets, with every read of it counted. */
interface FakeChequebook {
  availablePlur: bigint;
  reads: number;
}

function chequebook(availableBzz: number): FakeChequebook {
  return { availablePlur: bzzToPlur(availableBzz), reads: 0 };
}

/** The body bee-js hands back, with a total well above the available balance as a live node has. */
function balanceBody(availablePlur: bigint) {
  return {
    totalBalance: { toPLURBigInt: () => availablePlur + 100n * PLUR_PER_BZZ },
    availableBalance: { toPLURBigInt: () => availablePlur },
  };
}

/** A rung's node whose chequebook answers what `book` holds at the moment of each read, and counts the reads. */
function node(url: string, rung: string, book: FakeChequebook): ChequebookNode {
  return {
    url,
    rung,
    bee: {
      getChequebookBalance: async () => {
        book.reads += 1;
        return balanceBody(book.availablePlur);
      },
    },
  };
}

/** The chequebook gate as `index.ts` hands it to the boot, over the given nodes. */
function chequebookGate(nodes: readonly ChequebookNode[]): StartGate {
  return {
    name: CHEQUEBOOK_GATE,
    refuses: 'none',
    run: (collect) => new ChequebookGate(nodes, FLOOR_PLUR, { info: () => {} }).assertFunded(collect),
  };
}

/** What `/health` holds, kept the way the orchestrator keeps it: replaced whole on every record. */
function warningStore(initial: readonly StartGateWarning[]): StartGateWarningStore {
  let held: readonly StartGateWarning[] = initial;
  return {
    getStartGateWarnings: () => held,
    recordStartGateWarnings: (warnings) => {
      held = [...warnings];
    },
  };
}

interface LogLine {
  level: 'info' | 'warn' | 'debug';
  message: string;
}

function recordingLogger() {
  const lines: LogLine[] = [];
  return {
    lines,
    info: (message: string) => lines.push({ level: 'info', message }),
    warn: (message: string) => lines.push({ level: 'warn', message }),
    debug: (message: string) => lines.push({ level: 'debug', message }),
  };
}

/**
 * Lets a read that was just answered finish what it does next. Its continuation is queued behind the
 * answer, so a clock advanced straight away would look for the next timer before it had been set.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

interface Setup {
  nodes: readonly ChequebookNode[];
  latched: readonly StartGateWarning[];
  gate?: StartGate;
}

function recheckOver({ nodes, latched, gate = chequebookGate(nodes) }: Setup) {
  const clock = new FakeClock();
  const store = warningStore(latched);
  const logger = recordingLogger();
  const recheck = new ChequebookRecheck({ gate, intervalMs: RECHECK_MS, store, logger, clock });
  return { clock, store, logger, recheck };
}

/**
 * ⛔⛔ **An uploader whose chequebook was empty at boot answered 503 until somebody restarted it.**
 *
 * The chequebook gate warns rather than refusing under the shipped `chequebook-warn`, and what it found
 * is latched onto `/health` as `start_gate_warned`. Nothing read the chequebook again after the boot, so
 * funding the node changed nothing an operator could see: the container stayed unhealthy for the life
 * of the process, and only a restart cleared it. Abel met exactly that on 2026-09-25 and reported the
 * uploader as stuck. So while that warning stands the chequebook is read again, on the same gate the
 * boot ran, and the warning goes the moment every node holds its floor.
 */
describe('the chequebook is read again while its warning stands', () => {
  it('clears the warning on the first read after the node is funded, and stops reading', async () => {
    const book = chequebook(0.1);
    const { clock, store, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS);
    assert.deepEqual(store.getStartGateWarnings(), [{ gate: CHEQUEBOOK_GATE, rung: '360p' }]);

    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [], 'a funded chequebook is still reported unfunded');
    assert.equal(book.reads, 2);
    assert.equal(clock.pendingCount(), 0, 'it went on reading a chequebook that had already cleared');
  });

  // The postage gate's findings are about a batch, and a batch that was refused at boot is not
  // something a later read of the chequebook can speak for.
  it('keeps every postage warning while it clears the chequebook ones', async () => {
    const book = chequebook(0.1);
    const { clock, store, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [
        { gate: CHEQUEBOOK_GATE, rung: '360p' },
        { gate: POSTAGE_GATE, rung: '720p' },
      ],
    });

    recheck.start();
    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [{ gate: POSTAGE_GATE, rung: '720p' }]);
  });

  // Which is also every deployment under `UPLOADER_START_GATES=refuse`, where a chequebook the gate
  // will not accept ends the boot and nothing is ever latched.
  it('reads nothing when the boot left no chequebook warning', async () => {
    const book = chequebook(0.1);
    const { clock, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: POSTAGE_GATE, rung: '720p' }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS * 3);

    assert.equal(book.reads, 0);
    assert.equal(clock.pendingCount(), 0);
  });

  it('waits the whole interval before each read', async () => {
    const book = chequebook(0.1);
    const { clock, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS - 1);
    assert.equal(book.reads, 0, 'read before the interval was up');
    await clock.advance(1);
    assert.equal(book.reads, 1);
    await clock.advance(RECHECK_MS - 1);
    assert.equal(book.reads, 1, 'the second read did not wait a whole interval after the first');
    await clock.advance(1);

    assert.equal(book.reads, 2);
  });

  // A chequebook read is answered off the chain and may take the whole gate timeout. Reads that
  // overlapped could land out of order, and an older answer landing last would put back a warning a
  // newer read had just cleared.
  it('starts the next wait only once the read before it has answered', async () => {
    let reads = 0;
    let answerFirstRead = () => {};
    const slow: ChequebookNode = {
      url: 'http://bee-360:1633',
      rung: '360p',
      bee: {
        getChequebookBalance: () => {
          reads += 1;
          if (reads > 1) {
            return Promise.resolve(balanceBody(bzzToPlur(0.1)));
          }
          return new Promise((resolve) => {
            answerFirstRead = () => resolve(balanceBody(bzzToPlur(0.1)));
          });
        },
      },
    };
    const { clock, recheck } = recheckOver({ nodes: [slow], latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }] });

    recheck.start();
    await clock.advance(RECHECK_MS * 3);
    assert.equal(reads, 1, 'a second read started while the first had not answered');

    answerFirstRead();
    await settled();
    await clock.advance(RECHECK_MS);

    assert.equal(reads, 2);
  });

  // While it reads anyway, it reads every node the boot did, so a rung that was funded at boot and
  // drained since is named rather than hidden behind the one that was already warned about.
  it('names a rung whose chequebook drained while the warning stood, and says so in the log', async () => {
    const low = chequebook(0.1);
    const drained = chequebook(3);
    const { clock, store, logger, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', low), node('http://bee-720:1633', '720p', drained)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    drained.availablePlur = bzzToPlur(0.01);
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [
      { gate: CHEQUEBOOK_GATE, rung: '360p' },
      { gate: CHEQUEBOOK_GATE, rung: '720p' },
    ]);
    const warned = logger.lines.filter((line) => line.level === 'warn').map((line) => line.message);
    assert.equal(warned.length, 1, `expected one warning, for the newly drained rung: ${JSON.stringify(warned)}`);
    assert.match(warned[0], /bee-720/);
  });

  // The boot already wrote the whole refusal to the log, and a minute later nothing about it is news.
  it('logs a chequebook that is still short at debug, not as a fresh warning every minute', async () => {
    const book = chequebook(0.1);
    const { clock, logger, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS * 3);

    assert.deepEqual(
      logger.lines.filter((line) => line.level === 'warn'),
      [],
      'an unchanged finding was warned about again',
    );
    assert.ok(
      logger.lines.some((line) => line.level === 'debug'),
      'three reads left no trace at all',
    );
  });

  it('says in the log when the warning clears', async () => {
    const book = chequebook(0.1);
    const { clock, logger, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);

    const cleared = logger.lines.filter((line) => line.level === 'info' && line.message.includes('/health'));
    assert.equal(cleared.length, 1, `no line said the warning left /health: ${JSON.stringify(logger.lines)}`);
  });

  // A single-node deployment routes everything through one publisher whose rung is a placeholder, and
  // the boot latches its warning with no rung. A read that filed it under the placeholder would leave
  // /health naming a rung nobody configured.
  it('files a single-node warning the way the boot did, with no rung', async () => {
    const book = chequebook(0.1);
    const { clock, store, recheck } = recheckOver({
      nodes: [node('http://bee:1633', SINGLE_PUBLISHER, book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: undefined }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [{ gate: CHEQUEBOOK_GATE, rung: undefined }]);
  });

  // The boot latches a gate that threw rather than collecting, an empty node set for instance, as a
  // warning with no rung. Nothing about that clears by waiting, so it stays, and so does the reading.
  it('keeps a gate that could not be read at all warned, and reads it again', async () => {
    const { clock, store, logger, recheck } = recheckOver({
      nodes: [],
      latched: [{ gate: CHEQUEBOOK_GATE }],
    });

    recheck.start();
    await clock.advance(RECHECK_MS);

    assert.deepEqual(store.getStartGateWarnings(), [{ gate: CHEQUEBOOK_GATE }]);
    assert.equal(clock.pendingCount(), 1, 'it gave up on a gate that may still come good');
    assert.ok(
      logger.lines.some((line) => /no Bee node at all/.test(line.message)),
      'the failure left no trace',
    );
  });

  it('stops when it is told to', async () => {
    const book = chequebook(0.1);
    const { clock, recheck } = recheckOver({
      nodes: [node('http://bee-360:1633', '360p', book)],
      latched: [{ gate: CHEQUEBOOK_GATE, rung: '360p' }],
    });

    recheck.start();
    recheck.stop();
    await clock.advance(RECHECK_MS * 2);

    assert.equal(book.reads, 0);
    assert.equal(clock.pendingCount(), 0);
  });
});

describe('/health after the chequebook is funded', () => {
  it('goes back to 200 without a restart', async () => {
    const orchestrator = makeTestOrchestrator();
    orchestrator.recordStartGateWarnings([{ gate: CHEQUEBOOK_GATE, rung: '360p' }]);
    const api = await startTestApi(orchestrator);
    servers.push(api);
    const book = chequebook(0.1);
    const clock = new FakeClock();
    const recheck = new ChequebookRecheck({
      gate: chequebookGate([node('http://bee-360:1633', '360p', book)]),
      intervalMs: RECHECK_MS,
      store: orchestrator,
      logger: recordingLogger(),
      clock,
    });

    recheck.start();
    const before = await api.request('/health');
    assert.equal(before.status, 503);
    assert.ok(((before.body as Record<string, unknown>).reasons as string[]).includes(HEALTH_REASON_START_GATE_WARNED));

    book.availablePlur = bzzToPlur(2);
    await clock.advance(RECHECK_MS);
    const { status, body } = await api.request('/health');

    assert.equal(status, 200, `a funded uploader still answers ${status}: ${JSON.stringify(body)}`);
    assert.equal((body as Record<string, unknown>).status, HEALTH_OK);
  });
});
