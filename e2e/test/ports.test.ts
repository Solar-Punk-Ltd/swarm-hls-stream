import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_PORT,
  MAX_PORT_SLOT,
  OME_PORT_DEFAULTS,
  PORT_DEFAULTS,
  type PortVar,
  requireValidPortSlot,
  resolvePort,
} from '../src/ports.js';

import { exportLines, readVars } from './helpers/shell.js';

/**
 * `resolvePort` is a mirror of `apply_port_slot`, and a mirror is only worth having if something
 * proves it still reflects. These tests run the REAL `_lib.sh` function over the same inputs and
 * compare, so a port rule that changes in the deploy fails here rather than surfacing as a live run
 * that times out against a port nothing is listening on.
 */

const PORT_NAMES = Object.keys(PORT_DEFAULTS) as PortVar[];

/** Resolve every port through the real shell function. */
function shellPorts(slot: number, env: Readonly<Record<string, string>> = {}): Record<string, string> {
  const vars = readVars([exportLines(env), `PORT_SLOT=${slot}`, 'apply_port_slot'].join('\n'), PORT_NAMES);
  return Object.fromEntries(PORT_NAMES.map((name) => [name, vars[name].isSet ? vars[name].value : '<unset>']));
}

function mirrorPorts(slot: number, env: Readonly<Record<string, string>> = {}): Record<string, string> {
  return Object.fromEntries(PORT_NAMES.map((name) => [name, String(resolvePort(name, slot, env))]));
}

describe('resolvePort mirrors apply_port_slot', () => {
  // Slot 0 is the default a plain `deploy.sh` runs under, so this is the case the suite hits most.
  it('fills unset ports with their defaults at slot 0', () => {
    assert.deepEqual(mirrorPorts(0), shellPorts(0));
  });

  // The half that inverts between slot 0 and slot N. Reading it backwards is not a visible error,
  // it is a suite polling the wrong deployment's ports.
  it('lets env values win at slot 0', () => {
    const env = { API_PORT: '3000', BEE_UPLOADER_API_PORT: '1633', BEE_GATEWAY_API_PORT: '1733' };
    assert.deepEqual(mirrorPorts(0, env), shellPorts(0, env));
    assert.equal(mirrorPorts(0, env).API_PORT, '3000', 'the env value must survive at slot 0');
  });

  // An empty value is not a value. The shell tests with `-n`, so an empty `API_PORT=` in a `.env`
  // takes the default rather than resolving to port 0 or NaN.
  it('treats a set-but-empty port as unset at slot 0', () => {
    const env = { API_PORT: '' };
    assert.deepEqual(mirrorPorts(0, env), shellPorts(0, env));
    assert.equal(mirrorPorts(0, env).API_PORT, String(PORT_DEFAULTS.API_PORT));
  });

  for (const slot of [1, 2, 7, 999]) {
    it(`shifts every default by slot*10 at slot ${slot}`, () => {
      assert.deepEqual(mirrorPorts(slot), shellPorts(slot));
    });
  }

  // A slot is authoritative on purpose, so a hand-edited port cannot silently survive a slot deploy.
  it('ignores env values at a non-zero slot', () => {
    const env = { API_PORT: '3000', CLIENT_PORT: '5173' };
    assert.deepEqual(mirrorPorts(4, env), shellPorts(4, env));
    assert.equal(mirrorPorts(4, env).API_PORT, String(PORT_DEFAULTS.API_PORT + 40), 'the slot must win over env');
  });

  // Each service holds a unique last digit so bands of ten cannot collide. If two services ever
  // share one, two slots overlap and the collision is silent at deploy time.
  it('gives every port a distinct last digit, which is what makes the bands disjoint', () => {
    const lastDigits = Object.values(PORT_DEFAULTS).map((port) => port % 10);
    assert.equal(new Set(lastDigits).size, lastDigits.length, `last digits collide: ${lastDigits.join(',')}`);
  });
});

describe('OME ports stay outside the slot arithmetic', () => {
  // `engines/ome/.env.sample` says these are not shifted, and `apply_port_slot` leaves them alone
  // because they are not in PORT_VARS. Deriving them from the slot instead — which a sibling repo's
  // copy of this harness did — points the publisher at a port OME is not bound to.
  it('is not touched by apply_port_slot at any slot', () => {
    for (const slot of [0, 3, 999]) {
      const vars = readVars(`PORT_SLOT=${slot}\napply_port_slot`, Object.keys(OME_PORT_DEFAULTS));
      for (const name of Object.keys(OME_PORT_DEFAULTS)) {
        assert.equal(vars[name].isSet, false, `apply_port_slot set ${name} at slot ${slot}, so it is slot-shifted now`);
      }
    }
  });
});

describe('port slot validation', () => {
  for (const raw of ['0', '1', '999']) {
    it(`accepts ${raw}`, () => {
      assert.equal(requireValidPortSlot(raw), Number(raw));
    });
  }

  for (const raw of ['1000', '-1', '1.5', '', 'abc', ' 2']) {
    it(`refuses ${JSON.stringify(raw)}`, () => {
      assert.throws(() => requireValidPortSlot(raw), /E2E_PORT_SLOT/);
    });
  }
});

describe('resolvePort refuses what the deploy would pass through', () => {
  /**
   * A deliberate divergence, not a mirror failure. At slot 0 with a value set, `apply_port_slot`
   * takes the env value and `continue`s BEFORE its own range check, so the deploy hands a nonsense
   * port straight to compose. Refusing here costs nothing the deploy relies on and turns a
   * connection that silently never happens into a message naming the variable.
   */
  for (const [value, why] of [
    ['abc', 'not a number'],
    ['70000', `above ${MAX_PORT}`],
    ['0', 'not a usable port'],
  ] as const) {
    it(`refuses API_PORT=${value} (${why}) even though slot 0 in the shell does not`, () => {
      assert.throws(() => resolvePort('API_PORT', 0, { API_PORT: value }), /API_PORT/);
    });
  }

  /**
   * No valid slot can overflow, which is why neither this mirror nor `apply_port_slot` can reach
   * its own range check from the slot path: the highest reachable port is 10008 + 999*10 = 19998.
   * Asserted as a property rather than left implicit, because it is what makes raising
   * MAX_PORT_SLOT a breaking change rather than a bigger number.
   */
  it('cannot overflow from any valid slot, so the range check guards only env values', () => {
    for (const slot of [0, 1, 500, MAX_PORT_SLOT]) {
      for (const name of PORT_NAMES) {
        const port = resolvePort(name, slot, {});
        assert.ok(port <= MAX_PORT, `${name} at slot ${slot} resolved to ${port}, past ${MAX_PORT}`);
      }
    }
  });
});
