import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SINGLE_PUBLISHER } from '../src/libs/BeePublisherPool.js';
import { bzzToPlur, ChequebookGate, ChequebookNode } from '../src/libs/ChequebookGate.js';
import { PostageGate, StampedPublisher } from '../src/libs/PostageGate.js';
import {
  gatePolicyFor,
  parseStartGateMode,
  runStartGates,
  START_GATE_CHEQUEBOOK_WARN,
  START_GATE_REFUSE,
  START_GATE_WARN,
  StartGate,
  StartGateMode,
} from '../src/libs/StartGates.js';
import { StartGateWarning } from '../src/types.js';

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

function chequebookGate(
  nodes: readonly ChequebookNode[],
  logger: { info: (message: string) => void },
  refuses = false,
): StartGate {
  const gate = new ChequebookGate(nodes, FLOOR_PLUR, logger);
  return { name: 'ChequebookGate', refuses, run: (collect) => gate.assertFunded(collect) };
}

function postageGate(
  publishers: readonly StampedPublisher[],
  logger: { info: (message: string) => void },
  refuses = false,
): StartGate {
  const gate = new PostageGate(publishers, MIN_TTL_S, MAX_UTILIZATION, logger);
  return { name: 'PostageGate', refuses, run: (collect) => gate.assertUsable(collect) };
}

/** A gate that does nothing but record that it was reached, for the ordering cases. */
function passingGate(name: string, reached: string[], refuses = false): StartGate {
  return {
    name,
    refuses,
    run: async () => {
      reached.push(name);
    },
  };
}

function refusingGate(name: string, reason: string, reached: string[], refuses = false): StartGate {
  return {
    name,
    refuses,
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

    await runStartGates([chequebookGate([silentNode('http://bee-a:1633')], logger)], logger);

    assert.equal(logger.warnings.length, 1, 'a gate that could not clear its node must leave exactly one warning');
    assert.match(logger.warnings[0], /ChequebookGate/);
    assert.match(logger.warnings[0], /http:\/\/bee-a:1633/);
    assert.match(logger.warnings[0], /absent or unreadable/);
    assert.match(logger.warnings[0], new RegExp(TIMED_OUT));
  });

  it('says in the warning which setting puts the refusal back', async () => {
    const logger = recordingLogger();

    await runStartGates([chequebookGate([silentNode('http://bee-a:1633')], logger)], logger);

    assert.match(logger.warnings[0], /UPLOADER_START_GATES/);
    assert.match(logger.warnings[0], /refuse/);
  });

  it('starts on a chequebook below the floor, with both numbers the gate read', async () => {
    const logger = recordingLogger();

    await runStartGates([chequebookGate([fundedNode('http://bee-a:1633', bzzToPlur(0.1))], logger)], logger);

    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /0\.1000 BZZ/);
    assert.match(logger.warnings[0], /0\.5000 BZZ/);
  });

  it('refuses the same chequebook under refuse, with the message the gate wrote', async () => {
    const logger = recordingLogger();

    await assert.rejects(
      () => runStartGates([chequebookGate([silentNode('http://bee-a:1633')], logger, true)], logger),
      { message: /absent or unreadable/ },
    );
    assert.deepEqual(logger.warnings, [], 'a refusal is thrown rather than logged, so nothing downgrades it');
  });

  it('leaves the funding reading in the log when the chequebook clears', async () => {
    const logger = recordingLogger();

    await runStartGates([chequebookGate([fundedNode('http://bee-a:1633', bzzToPlur(2))], logger)], logger);

    assert.deepEqual(logger.warnings, []);
    assert.equal(logger.readings.length, 1, 'warn mode must still read and record, or it is not a gate at all');
    assert.match(logger.readings[0], /2\.0000 BZZ/);
  });

  it('treats the postage gate exactly the same way', async () => {
    const logger = recordingLogger();

    await runStartGates([postageGate([silentPublisher('360p', 'http://bee-a:1633')], logger)], logger);

    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /PostageGate/);
    assert.match(logger.warnings[0], /360p/);
    assert.match(logger.warnings[0], /absent or unreadable/);
  });

  it('refuses on the postage gate under refuse', async () => {
    const logger = recordingLogger();

    await assert.rejects(
      () => runStartGates([postageGate([silentPublisher('360p', 'http://bee-a:1633')], logger, true)], logger),
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
          [
            refusingGate('ChequebookGate', 'no chequebook here', reached, true),
            passingGate('PostageGate', reached, true),
          ],
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
      logger,
    );

    assert.equal(logger.warnings.length, 2);
    assert.match(logger.warnings[0], /no chequebook here/);
    assert.match(logger.warnings[1], /no batch/);
  });

  it('says nothing at all when every gate clears', async () => {
    const logger = recordingLogger();
    const reached: string[] = [];

    await runStartGates([passingGate('ChequebookGate', reached), passingGate('PostageGate', reached)], logger);

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

/**
 * Whether a gate is asked to establish everything it can, or to stop at the first thing it cannot.
 *
 * Both are right, in their own mode. Under `refuse` the first refusal ends the boot, so reading the
 * second node buys nothing and delays the answer. Under `warn` the service runs, so every node that
 * cannot be cleared is one an operator has to learn about now rather than at the next restart, which
 * is what a four rung stage turns into when it reports one rung per boot.
 */
describe('how much a gate is asked to read', () => {
  /** A gate that refuses `count` nodes when it is given somewhere to put them, and throws otherwise. */
  function manyBadNodes(name: string, count: number, refuses = false): StartGate & { collected: boolean } {
    const gate = {
      name,
      refuses,
      collected: false,
      run: async (collect?: (refusal: { rung?: string; url: string; message: string }) => void) => {
        if (!collect) {
          throw new Error(`${name} refused http://bee-1:1633`);
        }
        gate.collected = true;
        for (let index = 1; index <= count; index += 1) {
          collect({ rung: `rung-${index}`, url: `http://bee-${index}:1633`, message: `${name} refused rung-${index}` });
        }
      },
    };
    return gate;
  }

  it('warns once per node a gate could not clear, not once per gate', async () => {
    const logger = recordingLogger();

    await runStartGates([manyBadNodes('PostageGate', 3)], logger);

    assert.equal(logger.warnings.length, 3);
    assert.match(logger.warnings[0], /rung-1/);
    assert.match(logger.warnings[2], /rung-3/);
  });

  it('names the rung in the warning when the gate knew one', async () => {
    const logger = recordingLogger();

    await runStartGates([manyBadNodes('PostageGate', 1)], logger);

    assert.match(logger.warnings[0], /PostageGate/);
    assert.match(logger.warnings[0], /rung-1/);
    assert.match(logger.warnings[0], /UPLOADER_START_GATES/);
  });

  it('gives a gate nowhere to put a refusal when it refuses, so the first one still ends the boot', async () => {
    const gate = manyBadNodes('ChequebookGate', 3, true);

    await assert.rejects(() => runStartGates([gate], recordingLogger()), /refused http/);
    assert.equal(gate.collected, false, 'refuse mode must not ask a gate to carry on past a refusal');
  });

  // A gate that throws under warn is still warned about: an empty node set and an unexpected error
  // both arrive that way, and neither may pass silently.
  it('still warns about a gate that threw rather than collected', async () => {
    const logger = recordingLogger();
    const reached: string[] = [];

    await runStartGates([refusingGate('ChequebookGate', 'asked to clear no Bee node at all', reached)], logger);

    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /no Bee node/);
  });
});

/**
 * The rung a single-node deployment has is the placeholder `all`, which `BeePublisherPool` gives the
 * one publisher that carries everything. It is a routing label rather than a rung anybody configured,
 * and reading "ChequebookGate on all did not clear" back off a live boot is what showed that naming
 * it helps nobody. `StartGateWarning.rung` already said it is absent on a single-node deployment, so
 * this is the code agreeing with the contract rather than a new rule.
 */
describe('a deployment with one node for everything', () => {
  function refusingOn(rung: string): StartGate {
    return {
      name: 'ChequebookGate',
      refuses: false,
      run: async (collect) => collect?.({ rung, url: 'http://bee-a:1633', message: 'nothing answered' }),
    };
  }

  it('leaves the placeholder rung out of the warning it writes', async () => {
    const logger = recordingLogger();

    await runStartGates([refusingOn(SINGLE_PUBLISHER)], logger);

    assert.match(logger.warnings[0], /ChequebookGate did not clear/);
    assert.doesNotMatch(logger.warnings[0], /on all/);
  });

  it('leaves it out of what /health latches too', async () => {
    const latched: StartGateWarning[] = [];

    await runStartGates([refusingOn(SINGLE_PUBLISHER)], recordingLogger(), (warnings) => latched.push(...warnings));

    assert.deepEqual(latched, [{ gate: 'ChequebookGate', rung: undefined }]);
  });

  it('still names a real rung, which is the whole point of carrying one', async () => {
    const logger = recordingLogger();

    await runStartGates([refusingOn('1080p')], logger);

    assert.match(logger.warnings[0], /ChequebookGate on 1080p did not clear/);
  });
});

/**
 * ⛔⛔⛔ **The two gates are not the same risk, and the owner ruled them apart on 2026-09-17.**
 *
 * A chequebook under its floor is a node that will publish slowly and noisily, and the ruling that
 * opened this branch was that it must not stop a start. A postage batch that is full or expired is
 * different in kind: every write against it fails while the broadcast looks live to the room, the
 * viewer and the catalog, and the recording it was meant to keep is never bought. So the default
 * configuration is the chequebook gate warning and the postage gate refusing.
 *
 * One setting still carries it, with three values that each say what they do rather than one value
 * meaning two things: `chequebook-warn` is the default, `warn` is both warning, `refuse` is both
 * refusing. A node that never answers is waited for under every one of them, which is `waitForNode`'s
 * decision rather than this one.
 */
describe('which gates refuse under which mode', () => {
  const policyOf = (mode: StartGateMode) => gatePolicyFor(mode);

  it('warns on the chequebook and refuses on postage by default', () => {
    assert.deepEqual(policyOf(START_GATE_CHEQUEBOOK_WARN), { chequebookRefuses: false, postageRefuses: true });
  });

  it('warns on both under warn', () => {
    assert.deepEqual(policyOf(START_GATE_WARN), { chequebookRefuses: false, postageRefuses: false });
  });

  it('refuses on both under refuse', () => {
    assert.deepEqual(policyOf(START_GATE_REFUSE), { chequebookRefuses: true, postageRefuses: true });
  });

  it('reads all three modes, and nothing else', () => {
    assert.equal(parseStartGateMode('chequebook-warn'), START_GATE_CHEQUEBOOK_WARN);
    assert.equal(parseStartGateMode(' Warn '), START_GATE_WARN);
    assert.equal(parseStartGateMode('REFUSE'), START_GATE_REFUSE);
    assert.throws(() => parseStartGateMode('postage-warn'), /UPLOADER_START_GATES/);
  });

  // A variable set to nothing is a variable nobody set, which is what `optional` already decides for
  // an empty string and what `required` decides for whitespace. Throwing there happens during import,
  // before the crash handlers are registered, so it is the one refusal with no readable report.
  it('reads a blank setting as the default rather than refusing during import', () => {
    assert.equal(parseStartGateMode('   '), START_GATE_CHEQUEBOOK_WARN);
    assert.equal(parseStartGateMode(''), START_GATE_CHEQUEBOOK_WARN);
  });
});

/** The runner asks each gate whether it refuses, rather than being told once for all of them. */
describe('a pass with one gate warning and one refusing', () => {
  function gateThatRefuses(name: string, refuses: boolean): StartGate {
    return {
      name,
      refuses,
      run: async (collect) => {
        if (collect === undefined) {
          throw new Error(`${name} refused`);
        }
        collect({ rung: '360p', url: 'http://bee-a:1633', message: `${name} refused` });
      },
    };
  }

  it('warns about the one that warns and stops on the one that refuses', async () => {
    const logger = recordingLogger();

    await assert.rejects(
      () => runStartGates([gateThatRefuses('ChequebookGate', false), gateThatRefuses('PostageGate', true)], logger),
      /PostageGate refused/,
    );
    assert.equal(logger.warnings.length, 1, 'the chequebook still warns before the postage gate ends the boot');
    assert.match(logger.warnings[0], /ChequebookGate/);
  });

  it('latches what warned before the refusal, so /health has it if the process survives', async () => {
    const latched: StartGateWarning[] = [];

    await assert.rejects(
      () =>
        runStartGates(
          [gateThatRefuses('ChequebookGate', false), gateThatRefuses('PostageGate', true)],
          recordingLogger(),
          (warnings) => latched.push(...warnings),
        ),
      /PostageGate refused/,
    );
    assert.deepEqual(latched, [], 'a pass that ended has nothing to report, since the process is going down');
  });
});
