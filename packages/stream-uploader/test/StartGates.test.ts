import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bzzToPlur, ChequebookGate, ChequebookNode } from '../src/libs/ChequebookGate.js';
import { PostageGate, StampedPublisher } from '../src/libs/PostageGate.js';
import {
  parseStartGateMode,
  runStartGates,
  START_GATE_REFUSE,
  START_GATE_WARN,
  StartGate,
} from '../src/libs/StartGates.js';

const FLOOR_PLUR = bzzToPlur(0.5);
const MIN_TTL_S = 12 * 3_600;
const MAX_UTILIZATION = 0.9;

/** The message the live host saw on 2026-09-16, which is the failure this whole file exists for. */
const TIMED_OUT = 'timeout of 4000ms exceeded';

function recordingLogger() {
  const warnings: string[] = [];
  const readings: string[] = [];
  return {
    warnings,
    readings,
    warn: (message: string) => warnings.push(message),
    info: (message: string) => readings.push(message),
  };
}

/** A node whose chequebook holds `availablePlur`, as bee-js reports one. */
function fundedNode(url: string, availablePlur: bigint): ChequebookNode {
  return {
    url,
    bee: { getChequebookBalance: async () => ({ availableBalance: { toPLURBigInt: () => availablePlur } }) },
  };
}

/** A node whose chequebook call never answers, which is the unreachable pool address of 2026-09-16. */
function silentNode(url: string): ChequebookNode {
  return {
    url,
    bee: {
      getChequebookBalance: () => Promise.reject(new Error(TIMED_OUT)),
    },
  };
}

/** A rung whose batch read fails, which is both an absent batch and a node that will not answer. */
function silentPublisher(rung: string, url: string): StampedPublisher {
  return {
    rung,
    url,
    stamp: 'a'.repeat(64),
    bee: { getPostageBatch: () => Promise.reject(new Error(TIMED_OUT)) },
  };
}

function chequebookGate(nodes: readonly ChequebookNode[], logger: { info: (message: string) => void }): StartGate {
  const gate = new ChequebookGate(nodes, FLOOR_PLUR, logger);
  return { name: 'ChequebookGate', run: () => gate.assertFunded() };
}

function postageGate(publishers: readonly StampedPublisher[], logger: { info: (message: string) => void }): StartGate {
  const gate = new PostageGate(publishers, MIN_TTL_S, MAX_UTILIZATION, logger);
  return { name: 'PostageGate', run: () => gate.assertUsable() };
}

/** A gate that does nothing but record that it was reached, for the ordering cases. */
function passingGate(name: string, reached: string[]): StartGate {
  return {
    name,
    run: async () => {
      reached.push(name);
    },
  };
}

function refusingGate(name: string, reason: string, reached: string[]): StartGate {
  return {
    name,
    run: async () => {
      reached.push(name);
      throw new Error(reason);
    },
  };
}

/**
 * ⛔⛔⛔ **A gate that stops the service starting decides more than it knows.**
 *
 * Both startup gates read a chequebook and a postage batch before the uploader does anything else,
 * and both refused the start on any answer they could not read. On 2026-09-16 an ABR uploader on the
 * live host was handed a pool address with no node behind it. `ChequebookGate` refused with "timeout
 * of 4000ms exceeded", docker restarted the container on that refusal every time, and the deploy was
 * refused. The reading was correct and the conclusion was not: nothing was wrong with the chequebook,
 * and the gate's refusal hid the address that was wrong.
 *
 * The owner ruled on 2026-09-17 that the uploader and the engine start whatever the chequebook says.
 * So the reading still happens, on every boot, and a gate that cannot clear its node now says so as a
 * warning carrying its whole refusal. `UPLOADER_START_GATES=refuse` is the deployment that wants the
 * old behaviour back, and nothing else changes: the same gates, the same readings, the same messages.
 */
describe('the start gates', () => {
  it('starts on a chequebook nothing can read, and carries the refusal into a warning', async () => {
    const logger = recordingLogger();

    await runStartGates([chequebookGate([silentNode('http://bee-a:1633')], logger)], START_GATE_WARN, logger);

    assert.equal(logger.warnings.length, 1, 'a gate that could not clear its node must leave exactly one warning');
    assert.match(logger.warnings[0], /ChequebookGate/);
    assert.match(logger.warnings[0], /http:\/\/bee-a:1633/);
    assert.match(logger.warnings[0], /absent or unreadable/);
    assert.match(logger.warnings[0], new RegExp(TIMED_OUT));
  });

  it('says in the warning which setting puts the refusal back', async () => {
    const logger = recordingLogger();

    await runStartGates([chequebookGate([silentNode('http://bee-a:1633')], logger)], START_GATE_WARN, logger);

    assert.match(logger.warnings[0], /UPLOADER_START_GATES/);
    assert.match(logger.warnings[0], /refuse/);
  });

  it('starts on a chequebook below the floor, with both numbers the gate read', async () => {
    const logger = recordingLogger();

    await runStartGates(
      [chequebookGate([fundedNode('http://bee-a:1633', bzzToPlur(0.1))], logger)],
      START_GATE_WARN,
      logger,
    );

    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /0\.1000 BZZ/);
    assert.match(logger.warnings[0], /0\.5000 BZZ/);
  });

  it('refuses the same chequebook under refuse, with the message the gate wrote', async () => {
    const logger = recordingLogger();

    await assert.rejects(
      () => runStartGates([chequebookGate([silentNode('http://bee-a:1633')], logger)], START_GATE_REFUSE, logger),
      { message: /absent or unreadable/ },
    );
    assert.deepEqual(logger.warnings, [], 'a refusal is thrown rather than logged, so nothing downgrades it');
  });

  it('leaves the funding reading in the log when the chequebook clears', async () => {
    const logger = recordingLogger();

    await runStartGates(
      [chequebookGate([fundedNode('http://bee-a:1633', bzzToPlur(2))], logger)],
      START_GATE_WARN,
      logger,
    );

    assert.deepEqual(logger.warnings, []);
    assert.equal(logger.readings.length, 1, 'warn mode must still read and record, or it is not a gate at all');
    assert.match(logger.readings[0], /2\.0000 BZZ/);
  });

  it('treats the postage gate exactly the same way', async () => {
    const logger = recordingLogger();

    await runStartGates([postageGate([silentPublisher('360p', 'http://bee-a:1633')], logger)], START_GATE_WARN, logger);

    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /PostageGate/);
    assert.match(logger.warnings[0], /360p/);
    assert.match(logger.warnings[0], /absent or unreadable/);
  });

  it('refuses on the postage gate under refuse', async () => {
    const logger = recordingLogger();

    await assert.rejects(
      () =>
        runStartGates([postageGate([silentPublisher('360p', 'http://bee-a:1633')], logger)], START_GATE_REFUSE, logger),
      { message: /absent or unreadable/ },
    );
  });

  // The postage batch is a separate question from the chequebook, and an operator fixing one wants
  // to have been told about the other in the same boot rather than one restart later.
  it('reads every gate under warn, even after one of them refused', async () => {
    const logger = recordingLogger();
    const reached: string[] = [];

    await runStartGates(
      [refusingGate('ChequebookGate', 'no chequebook here', reached), passingGate('PostageGate', reached)],
      START_GATE_WARN,
      logger,
    );

    assert.deepEqual(reached, ['ChequebookGate', 'PostageGate']);
    assert.equal(logger.warnings.length, 1);
  });

  it('stops at the first refusal under refuse, leaving the rest unread', async () => {
    const logger = recordingLogger();
    const reached: string[] = [];

    await assert.rejects(
      () =>
        runStartGates(
          [refusingGate('ChequebookGate', 'no chequebook here', reached), passingGate('PostageGate', reached)],
          START_GATE_REFUSE,
          logger,
        ),
      { message: /no chequebook here/ },
    );
    assert.deepEqual(reached, ['ChequebookGate']);
  });

  it('warns once per gate that refused, rather than once for the boot', async () => {
    const logger = recordingLogger();
    const reached: string[] = [];

    await runStartGates(
      [refusingGate('ChequebookGate', 'no chequebook here', reached), refusingGate('PostageGate', 'no batch', reached)],
      START_GATE_WARN,
      logger,
    );

    assert.equal(logger.warnings.length, 2);
    assert.match(logger.warnings[0], /no chequebook here/);
    assert.match(logger.warnings[1], /no batch/);
  });

  it('says nothing at all when every gate clears', async () => {
    const logger = recordingLogger();
    const reached: string[] = [];

    await runStartGates(
      [passingGate('ChequebookGate', reached), passingGate('PostageGate', reached)],
      START_GATE_WARN,
      logger,
    );

    assert.deepEqual(logger.warnings, []);
    assert.deepEqual(reached, ['ChequebookGate', 'PostageGate']);
  });
});

/**
 * A mistyped mode is refused rather than read as the default. The uploader starting whatever the
 * chequebook says is the owner's ruling, and a deployment that asked for `refuse` and mistyped it
 * would otherwise get the ruling instead of the thing it asked for, with nothing in the log saying
 * which of the two it was running.
 */
describe('the start gate mode a deployment asks for', () => {
  it('reads the two modes there are', () => {
    assert.equal(parseStartGateMode('warn'), START_GATE_WARN);
    assert.equal(parseStartGateMode('refuse'), START_GATE_REFUSE);
  });

  it('reads padding and capitals as the mode they spell', () => {
    assert.equal(parseStartGateMode('  REFUSE  '), START_GATE_REFUSE);
    assert.equal(parseStartGateMode('Warn'), START_GATE_WARN);
  });

  for (const written of ['on', 'off', 'true', 'strict', 'warn refuse', 'refuses']) {
    it(`refuses "${written}", naming the variable and both modes`, () => {
      assert.throws(() => parseStartGateMode(written), /UPLOADER_START_GATES/);
      assert.throws(() => parseStartGateMode(written), /warn/);
      assert.throws(() => parseStartGateMode(written), /refuse/);
    });
  }
});
