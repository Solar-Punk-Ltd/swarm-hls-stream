/**
 * Host port resolution, mirroring `apply_port_slot` in `deploy/scripts/_lib.sh`.
 *
 * The deploy scripts decide which host ports the stack listens on, and the suite has to reach the
 * same numbers or every check dials something that is not there. `test/ports.test.ts` runs the real
 * shell function over the same inputs and compares, so a change to the deploy fails a unit test
 * here rather than surfacing as an unexplained timeout during a live run.
 */

import type { EnvBag } from './envFile.js';

/**
 * `PORT_VARS` from `_lib.sh`, both numbers.
 *
 * `stock` is what a plain deploy falls back to when the variable is unset, matching the
 * `${NAME:-NNNN}` fallback in the compose file that publishes it. `base` is the origin of the
 * `base + slot*10` arithmetic, where each service holds a unique last digit (0-8) so slots cannot
 * collide. They were one number until OPS-27, which is why a stock deploy bound SRS's RTMP listener
 * on 10002 while the compose file documented 1935.
 */
export const PORT_DEFAULTS = {
  API_PORT: { stock: 3000, base: 10000 },
  SRS_SRT_PORT: { stock: 10080, base: 10001 },
  SRS_RTMP_PORT: { stock: 1935, base: 10002 },
  SRS_HTTP_PORT: { stock: 8080, base: 10003 },
  CLIENT_PORT: { stock: 5173, base: 10004 },
  BEE_UPLOADER_API_PORT: { stock: 1633, base: 10005 },
  BEE_UPLOADER_P2P_PORT: { stock: 1634, base: 10006 },
  BEE_GATEWAY_API_PORT: { stock: 1733, base: 10007 },
  BEE_GATEWAY_P2P_PORT: { stock: 1734, base: 10008 },
} as const satisfies Record<string, { stock: number; base: number }>;

export type PortVar = keyof typeof PORT_DEFAULTS;

export const PORT_SLOT_STRIDE = 10;

/**
 * The highest slot `--portSlot` will create, and the ceiling is the second port block rather than
 * the TCP range. The per-rung bee nodes take six ports out of 1100x on the same arithmetic, so slot
 * 100 would put the first block at 11000 and on top of slot 0's own bee nodes. `_lib.sh` refuses
 * anything above this, and so does this file, or the harness would aim at a deployment the deploy
 * scripts cannot create.
 */
export const MAX_PORT_SLOT = 99;
export const MAX_PORT = 65535;

/**
 * OME's host ports, which `apply_port_slot` deliberately leaves alone — they are not in `PORT_VARS`,
 * and `engines/ome/.env.sample` says so in as many words. They come from the engine env file and
 * are overridden per profile by hand when several OME instances share a host. Deriving them from
 * the slot, the way a sibling repo's copy of this harness did, points the publisher at a port OME
 * is not bound to.
 */
export const OME_PORT_DEFAULTS = {
  OME_SRT_PORT: 10081,
  OME_HLS_PORT: 8081,
} as const;

export type OmePortVar = keyof typeof OME_PORT_DEFAULTS;

/**
 * Resolve one slot-aware host port exactly as `apply_port_slot` does.
 *
 * Slot 0 does not mean "the zeroth slot", it means "no slot": the env value decides and the default
 * only fills a gap. Slots 1-999 are authoritative in the other direction, and an env value is
 * ignored on purpose so a hand-edited port cannot silently survive a slot deploy. Reading that rule
 * backwards is not a visible error, it is a suite that polls the default deployment's ports while
 * the stack under test listens on the slot's.
 *
 * An env value that is set but empty counts as unset, matching the shell's `-n` test.
 */
export function resolvePort(name: PortVar, slot: number, env: EnvBag): number {
  if (slot !== 0) {
    return requireUsablePort(name, PORT_DEFAULTS[name].base + slot * PORT_SLOT_STRIDE);
  }
  const configured = env[name];
  if (configured === undefined || configured === '') {
    return requireUsablePort(name, PORT_DEFAULTS[name].stock);
  }
  return requireUsablePort(name, Number(configured));
}

/** Resolve an OME host port, which is env-or-default with no slot arithmetic anywhere in it. */
export function resolveOmePort(name: OmePortVar, env: EnvBag): number {
  const configured = env[name];
  if (configured === undefined || configured === '') {
    return OME_PORT_DEFAULTS[name];
  }
  return requireUsablePort(name, Number(configured));
}

export function requireValidPortSlot(raw: string): number {
  if (!/^[0-9]{1,2}$/.test(raw)) {
    throw new Error(`Invalid E2E_PORT_SLOT "${raw}"; expected an integer 0-${MAX_PORT_SLOT}, as --portSlot takes`);
  }
  return Number(raw);
}

function requireUsablePort(name: string, port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`Resolved ${name}=${port}, which is not a usable port (expected 1-${MAX_PORT})`);
  }
  return port;
}
