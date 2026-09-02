import { type Page } from 'playwright-core';

import { counterbalancedOrder } from './gatewaySweep.js';

/**
 * Where the client publishes its byte-source switch when built with `VITE_EXPOSE_PLAYER`.
 *
 * Mirrored rather than imported, exactly as `GATEWAY_HANDLE` is: `e2e` does not depend on `client`,
 * and this is the string the browser sees rather than a value either side computes.
 * `packages/client/test/bundle.test.ts` holds the other end and proves it reaches no shipping build.
 */
const FETCH_BACKEND_HANDLE = '__swarmFetchBackendSwitch';

/** The two conditions, spelled the way the client spells them. */
export const GATEWAY_BYTES = 'gateway';
export const WEEB3_BYTES = 'weeb3';
export type ByteSource = typeof GATEWAY_BYTES | typeof WEEB3_BYTES;

export interface ByteSourceSetup {
  /** What the client reports as its byte source once set, which is **not** assumed to be what was asked. */
  byteSource: string | null;
  failure: string | null;
}

/**
 * Ask the running client where its segment bytes come from, and optionally move it first.
 *
 * The readback exists for the reason the gateway one does: a switch that silently did nothing would
 * put both arms on one condition, every metric would agree, and the sitting would report that an
 * in-tab node performs exactly like a gateway. `selectFetchBackend` throws on a value it does not
 * recognise, and that throw is caught here and returned as a named failure rather than a stack trace,
 * because a typo in a driver should fail one arm legibly rather than crash the harness.
 */
async function askTheClient(page: Page, target: ByteSource | null): Promise<ByteSourceSetup> {
  return page.evaluate(
    ({ handle, moveTo }: { handle: string; moveTo: string | null }) => {
      const backendSwitch = (globalThis as unknown as Record<string, unknown>)[handle] as
        | { current: () => string; select: (backend: string) => void }
        | undefined;

      if (!backendSwitch) {
        return {
          byteSource: null,
          failure:
            `no byte-source switch at globalThis.${handle}. The client must be built with ` +
            `VITE_EXPOSE_PLAYER for a sitting to move it between byte sources.`,
        };
      }

      try {
        if (moveTo !== null) {
          backendSwitch.select(moveTo);
        }
        return { byteSource: backendSwitch.current(), failure: null };
      } catch (error: unknown) {
        return {
          byteSource: null,
          failure: `the client refused the byte source ${JSON.stringify(moveTo)}: ${String(error)}`,
        };
      }
    },
    { handle: FETCH_BACKEND_HANDLE, moveTo: target },
  );
}

/** Point the running viewer's fragment loader at a byte source, and read back what it actually did. */
export async function selectByteSource(page: Page, source: ByteSource): Promise<ByteSourceSetup> {
  return askTheClient(page, source);
}

/** Where the client says its segment bytes are coming from, without moving it. */
export async function readByteSource(page: Page): Promise<ByteSourceSetup> {
  return askTheClient(page, null);
}

/**
 * Boot the in-tab node and reach the network, without switching anything to it yet.
 *
 * ⛔ The join is 4.5 MB of wasm and several seconds of dialling, and A2 measured a first retrieval
 * straight after `ready(1)` at 9,423-10,466ms against 3,185-4,003ms warm. An arm that switched and
 * immediately started counting would be measuring the join, once, at the start of its window, and on
 * a **live** edge that is the difference between joining behind and stalling.
 */
export async function prewarmByteSource(page: Page): Promise<string | null> {
  return page.evaluate(
    async ({ handle }: { handle: string }) => {
      const backendSwitch = (globalThis as unknown as Record<string, unknown>)[handle] as
        | { prewarm: () => Promise<void> }
        | undefined;

      if (!backendSwitch) {
        return `no byte-source switch at globalThis.${handle}, so the in-tab node cannot be booted`;
      }
      try {
        await backendSwitch.prewarm();
        return null;
      } catch (error: unknown) {
        return `the in-tab node did not reach the network: ${String(error)}`;
      }
    },
    { handle: FETCH_BACKEND_HANDLE },
  );
}

/** What one retrieval through the in-tab node came back with, or why it did not. */
export interface InTabRetrieval {
  byteLength: number | null;
  /** The client's own measurement of the retrieval, which is the one inside the product path. */
  elapsedMs: number | null;
  failure: string | null;
}

/**
 * Pull one reference through the client's real in-tab retrieval path, span stripped.
 *
 * ## ⛔ Why every failure comes back as a sentence
 *
 * A probe that meets a client built before this call existed should lose one row legibly rather than
 * die part way through a sitting with its artifact already half written. So a missing switch, a
 * switch without the call on it, and a node that refused are all named failures, and none of them
 * throws.
 *
 * ## ⛔⛔ The caller races this against a budget, and the page keeps going
 *
 * There is no cancel to offer. weeb-3 holds a cancel token internally and the exported call takes
 * none, and an attempt that outlives ten seconds is detached rather than cancelled so the peer is
 * still paid when its chunk arrives. So a harness that stops waiting has stopped waiting and nothing
 * more: the retrieval runs on, and its late bytes are what the tail window after a row exists to
 * count. A caller that abandons one must keep a rejection handler on the promise it walked away
 * from, because closing the page rejects the outstanding `evaluate`.
 */
export async function retrieveThroughInTabNode(page: Page, ref: string): Promise<InTabRetrieval> {
  return page.evaluate(
    async ({ handle, reference }: { handle: string; reference: string }) => {
      const backendSwitch = (globalThis as unknown as Record<string, unknown>)[handle] as
        | { retrieveBytes?: (ref: string) => Promise<{ byteLength: number; elapsedMs: number }> }
        | undefined;

      if (!backendSwitch) {
        return {
          byteLength: null,
          elapsedMs: null,
          failure:
            `no byte-source switch at globalThis.${handle}. The client must be built with ` +
            `VITE_EXPOSE_PLAYER for a probe to drive its in-tab retrieval path.`,
        };
      }
      if (typeof backendSwitch.retrieveBytes !== 'function') {
        return {
          byteLength: null,
          elapsedMs: null,
          failure:
            `the switch at globalThis.${handle} publishes no retrieveBytes, so this deployed client ` +
            'predates the call this probe drives and no row here would be the in-tab path.',
        };
      }

      try {
        const retrieved = await backendSwitch.retrieveBytes(reference);
        return { byteLength: retrieved.byteLength, elapsedMs: retrieved.elapsedMs, failure: null };
      } catch (error: unknown) {
        return { byteLength: null, elapsedMs: null, failure: String(error) };
      }
    },
    { handle: FETCH_BACKEND_HANDLE, reference: ref },
  );
}

/**
 * Why this arm cannot be read against the others, or null when it can.
 *
 * ⛔ An arm that did not land on the byte source it asked for is not a weaker arm, it is an arm of
 * the wrong condition, and counting it would put a gateway's numbers in the node's column.
 */
export function byteSourceArmIsComparable(setup: ByteSourceSetup, requested: ByteSource): string | null {
  if (setup.failure !== null) {
    return setup.failure;
  }
  if (setup.byteSource === null) {
    return 'the client reported no byte source at all after the switch';
  }
  if (setup.byteSource !== requested) {
    return `asked for ${requested} and the client reports ${setup.byteSource}, so this arm is the wrong condition`;
  }
  return null;
}

/**
 * The byte source a driver asked for, or null when this run is not an arm of such a sitting.
 *
 * ⛔ Throws rather than falling back. A typo in a driver that quietly became "the gateway" would run
 * a whole sitting on one condition and file half of it under the other name.
 */
export function byteSourceFromEnv(value: string | undefined): ByteSource | null {
  if (value === undefined || value === '') {
    return null;
  }
  if (value !== GATEWAY_BYTES && value !== WEEB3_BYTES) {
    throw new Error(
      `BROWSER_FETCH_BACKEND=${JSON.stringify(value)} is not a byte source, expected ` +
        `${GATEWAY_BYTES} or ${WEEB3_BYTES}`,
    );
  }
  return value;
}

export interface ByteSourceArm {
  requested: ByteSource;
  reported: string;
  settledForMs: number;
  /** Requests before this instant are excluded from {@link armBytesCameFromItsSource}. */
  windowStartedAtMs: number;
}

/**
 * Put an arm on its byte source, then hold it there until its measurement window should open.
 *
 * ## ⛔⛔ Why an arm is switched here rather than seeded before navigation
 *
 * A gateway arm is seeded into localStorage before the page runs, because joining is the expensive
 * part and an arm that switched afterwards would have bought its join from the wrong node.
 *
 * The byte source is the opposite case. Booting the in-tab node is 4.5 MB of wasm and several seconds
 * of dialling, and a seeded weeb-3 arm would make the player's **first** fragment request wait for
 * all of it. On a live edge that arm starts already behind, and hls.js raises its latency target on
 * every stall and never lowers it, so the join would be baked into every number the arm went on to
 * produce. `prewarm` exists precisely so the join happens outside the window that is counted.
 *
 * ## ⭐ Why both arms settle for the same wall clock
 *
 * The settle is measured from **playback starting**, not from the switch, so both conditions open
 * their window with a player of the same age. A weeb-3 arm spends part of that period booting its
 * node and reading through the gateway meanwhile, which is exactly why the window start is recorded
 * and the request log is only judged from it onwards.
 *
 * ⛔ An arm whose setup overran the settle is refused rather than shortened. Shortening it would
 * leave the two conditions holding players of different ages, which is a difference in how far
 * hls.js had already drifted, dressed up as a difference in byte source.
 */
export async function openByteSourceArm({
  page,
  source,
  playbackStartedAtMs,
  settleMs,
}: {
  page: Page;
  source: ByteSource;
  playbackStartedAtMs: number;
  settleMs: number;
}): Promise<ByteSourceArm> {
  if (source === WEEB3_BYTES) {
    const failure = await prewarmByteSource(page);
    if (failure !== null) {
      throw new Error(`arm ${source} could not boot the node it is meant to read through: ${failure}`);
    }
  }

  const setup = await selectByteSource(page, source);
  const notComparable = byteSourceArmIsComparable(setup, source);
  if (notComparable !== null) {
    throw new Error(`arm ${source} is not the condition it claims: ${notComparable}`);
  }

  const remainingMs = playbackStartedAtMs + settleMs - Date.now();
  if (remainingMs < 0) {
    throw new Error(
      `arm ${source} took ${((settleMs - remainingMs) / 1000).toFixed(1)}s to reach its byte source, past ` +
        `its ${(settleMs / 1000).toFixed(0)}s settle, so its player is older than the other condition's`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, remainingMs));

  const windowStartedAtMs = Date.now();
  return {
    requested: source,
    reported: setup.byteSource as string,
    settledForMs: windowStartedAtMs - playbackStartedAtMs,
    windowStartedAtMs,
  };
}

/** Only these two fields are read, so any request record a run collected can be handed straight in. */
export interface TimedRequest {
  url: string;
  startedAtMs: number;
}

/** Segment bodies come from the gateway's `/bytes/` route. Feed and manifest reads do not, and in a
 * weeb-3 arm they still go through the gateway by design: PR #183 moved segment bytes and nothing else. */
const SEGMENT_ROUTE = '/bytes/';

/**
 * The wasm the in-tab node runs.
 *
 * Matched on the package name plus the extension rather than on the emitted filename, which carries a
 * per-build content hash: A2 saw `weeb_3_bg-CGW4ecJL.wasm`. A future build that renames the chunk
 * fails this closed, refusing arms rather than passing them, which is the direction a gate should err.
 */
const WEEB3_WASM = /weeb_3[^/]*\.wasm(?:\?|$)/;

/**
 * Why this arm cannot be read against the others, judged on where its bytes CAME FROM, or null.
 *
 * ## ⛔⛔⛔ Why this exists as well as the readback
 *
 * {@link byteSourceArmIsComparable} asks the client what it believes. On 2026-08-13 both arms of a
 * paid gateway smoke answered honestly and correctly while fetching every one of their 253 segments
 * from one node, because the segments came from a playlist cached against the previous gateway. **A
 * readback proves what the app BELIEVES. The request log is what the network DID.**
 *
 * ## ⭐ Why the zero needs a witness
 *
 * A weeb-3 arm's headline is that it made **no** `/bytes/` requests. That is also precisely what an
 * arm that fetched nothing at all produces, and a broken arm and a perfect arm would file the same
 * number. `#41` cost this project the same confusion in another module: "I could not find X" and
 * "there is no X" are the same return value. So a zero is only accepted alongside evidence that the
 * node loaded at all, which is the wasm chunk.
 *
 * ## ⭐ What this deliberately does NOT refuse
 *
 * A weeb-3 arm that stalls from end to end passes this gate. That is not an oversight. This decides
 * whether an arm **is the condition it is filed under**, never whether its result is good: an in-tab
 * node that cannot hold a live edge is the answer the sitting was booked to find, and a gate that
 * refused it would quietly discard every negative result and report only the successes.
 *
 * @param windowStartedAtMs Requests before this are excluded. A weeb-3 arm legitimately reads through
 * the gateway while its node boots, so the log is only decisive over the window that was counted.
 */
export function armBytesCameFromItsSource(
  requests: readonly TimedRequest[],
  source: ByteSource,
  windowStartedAtMs: number,
): string | null {
  const counted = requests.filter((request) => request.startedAtMs >= windowStartedAtMs);
  const segments = counted.filter((request) => request.url.includes(SEGMENT_ROUTE));

  if (source === GATEWAY_BYTES) {
    if (segments.length === 0) {
      return (
        `this arm is filed as ${GATEWAY_BYTES} and made no ${SEGMENT_ROUTE} request at all inside its ` +
        `measured window, so nothing about it is a reading of a gateway serving a viewer`
      );
    }
    return null;
  }

  if (segments.length > 0) {
    return (
      `this arm is filed as ${WEEB3_BYTES} and made ${segments.length} ${SEGMENT_ROUTE} request(s) to ` +
      `the gateway inside its measured window, so its video did not all come from the node in the tab`
    );
  }
  if (!requests.some((request) => WEEB3_WASM.test(request.url))) {
    return (
      `this arm is filed as ${WEEB3_BYTES} and never fetched the weeb-3 wasm, so no node ever loaded ` +
      `in the tab and its zero ${SEGMENT_ROUTE} requests mean it fetched no video at all`
    );
  }
  return null;
}

/**
 * The arms of a gateway-versus-in-tab-node sitting, in the order they run.
 *
 * ⛔ The ordering rule lives in `counterbalancedOrder` and is not re-derived here. A second copy of a
 * rule is how the burn rate came to hold four different values in three scripts, and this particular
 * rule is one already got wrong once from a slogan rather than from its arithmetic.
 */
export function byteSourceArmOrder(rounds: number): ByteSource[] {
  return counterbalancedOrder([GATEWAY_BYTES, WEEB3_BYTES] as const, rounds);
}
