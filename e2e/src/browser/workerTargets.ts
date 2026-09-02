/**
 * Attaching to the worker targets Chrome makes for our page, because that is where the node lives.
 *
 * ## ⛔⛔⛔ Why a page session reaches neither the cap nor the recorder any more
 *
 * Since weeb-3 0.0.341001 the in-tab Swarm node runs entirely inside a **SharedWorker** that the
 * client loads from `/weeb-3/worker.js`. Its WebSockets therefore belong to the worker target, and a
 * page's own debug session cannot see them and cannot cap them. Two of this harness's instruments
 * were built before that and both went silently wrong on 2026-09-02:
 *
 * - `throttle.ts` applied `Network.emulateNetworkConditions` on the PAGE session, so the cap never
 *   reached the node. Under a "2800 kbps cap", which carries 350,000 bytes/s, the arm 3 probe pulled
 *   a 225 KB segment in 0.1 s and a 1.2 MB one in 0.3 to 0.4 s. The physical floors at that cap are
 *   0.64 s and 3.3 s, so the link was never held down at all.
 * - `webSocketTraffic.ts` listens on Playwright's `page.on('websocket')`, which is also page scoped.
 *   Every byte column of that report reads **0** while 1.2 MB retrievals were succeeding, and the H0
 *   check then read the zero as healthy and printed "H0 holds".
 *
 * ⛔ Both are our harness's faults. weeb-3 is not to be changed and no change to it may be proposed.
 *
 * ## ⭐ Both halves measured against a real Chrome, 2026-09-02
 *
 * A page creating a SharedWorker that fetches 1,000,000 bytes, under a 2800 kbps cap whose physical
 * floor is 2857 ms. Uncapped the worker's fetch took 7 ms. **Under the page session alone it took
 * 2 ms**, so that cap reached nothing at all, which is the arm 3 defect reproduced. With the worker
 * session capped as well the same fetch took 2866 ms, 1.003x its floor. A 60,000 byte binary frame
 * over the worker's own socket was counted as 60,000 bytes, so {@link cdpFrameBytes} decodes rather
 * than counting the 80,000 base64 characters. ⛔ The middle row is the half that makes this evidence:
 * a guard that cannot fail is not one, and `viewer.ts` records two in this harness that could not.
 *
 * ## ⛔ Why a raw CDP connection rather than Playwright's own
 *
 * `page.context().newCDPSession(page)` attaches to pages and frames only. Reaching a worker target
 * means `Target.setAutoAttach` with `flatten: true`, and a flattened child session is addressed by
 * putting its `sessionId` on every message. Verified against the pinned playwright-core 1.61.1:
 * `CDPSession.send(method, params)` takes no third argument and exposes no `sessionId`, so a child
 * session cannot be driven through it. Hence a second, raw client to Chrome's own debugging
 * endpoint, which also keeps our auto-attach state separate from Playwright's own.
 *
 * ## ⭐ Who records what, so nothing is counted twice
 *
 * Playwright keeps the PAGE's sockets, through {@link recordWebSocketTraffic}. This module keeps the
 * WORKER targets' sockets and appends them into the same {@link WebSocketTraffic}, so every existing
 * reader of that shape sums both without knowing this exists. `Network.enable` is sent only on
 * worker-type sessions for exactly that reason: a page session enabled here would double every byte
 * Playwright had already counted.
 *
 * A page session is still attached, and its only job is to carry `Target.setAutoAttach` down to the
 * page's own dedicated workers, which are children of the page rather than of the browser.
 */

import { type WebSocketConnection, type WebSocketTraffic } from './webSocketTraffic.js';

/** How long to wait for Chrome's debugging endpoint to answer before giving up on it. */
const ENDPOINT_TIMEOUT_MS = 10_000;

/** How often the endpoint is retried while Chrome is still opening its socket. */
const ENDPOINT_POLL_MS = 200;

/**
 * What CDP reports a text frame's opcode as, and what it reports a binary one as.
 *
 * ⛔⛔ The branch below is load-bearing and not defensive coding. CDP hands a binary frame's payload
 * over **base64 encoded**, so counting its characters overstates the frame by exactly a third, and a
 * text frame's payload arrives as the string itself, so base64-decoding it understates by a quarter.
 * yamux frames are binary, which is every byte an in-tab node moves.
 */
const OPCODE_TEXT = 1;
const OPCODE_BINARY = 2;

/**
 * The target types the node's transports can live on.
 *
 * `shared_worker` is where weeb-3 runs today. The other two are here because a target type is not
 * something this harness gets to choose: a future client that moved the node into a dedicated worker
 * or served its sockets from a service worker would otherwise go dark again, in silence, which is
 * exactly the failure this module exists to close.
 */
export const WORKER_TARGET_TYPES: readonly string[] = ['shared_worker', 'worker', 'service_worker'];

/** Target types attached only so `Target.setAutoAttach` can be carried down to their own children. */
const CARRIER_TARGET_TYPES: readonly string[] = ['page', 'iframe'];

/** One message this client sends to Chrome. `sessionId` is what addresses a flattened child session. */
export interface CdpOutbound {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** One message Chrome sent back, either a reply to an `id` or an event with a `method`. */
export interface CdpInbound {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/**
 * The pipe, with no protocol knowledge in it at all.
 *
 * ⭐ Deliberately dumb, so `test/workerTargets.test.ts` can drive every branch below off a fake that
 * is a list and a callback. The correlation of replies to requests lives in {@link watchWorkerTargets}
 * rather than here, which is what makes it testable: a run where Chrome refuses
 * `Network.emulateNetworkConditions` on a worker has to be visible, and a fire-and-forget pipe cannot
 * show it.
 */
export interface CdpTransport {
  send: (message: CdpOutbound) => void;
  onMessage: (listener: (message: CdpInbound) => void) => void;
  close: () => Promise<void>;
}

/** One target this client attached to, kept whether it is still alive or not. */
export interface AttachedTarget {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  attachedAtMs: number;
  /** Null while the target is still attached, which is the state most of them end a run in. */
  detachedAtMs: number | null;
  /** Whether `Network.enable` was sent here, which is true for worker types and false for carriers. */
  recorded: boolean;
}

/**
 * What a run does with the worker targets: read them, cap them, lift the cap, close.
 *
 * ⛔ The cap is applied through the handle rather than by a free function, for the reason
 * {@link ThrottleHandle} is: a release that could be called against something the caller never
 * squeezed would report a clean recovery from nothing.
 */
export interface WorkerTargetWatch {
  /** Every target attached so far, in attach order. */
  targets: () => readonly AttachedTarget[];
  /**
   * Hold every recorded session at a cap, and hold every session attached AFTER this one too.
   *
   * ⛔⛔ The second half is the point. A SharedWorker can be respawned mid-run, and a cap applied
   * only to the sessions that existed when the squeeze started would quietly stop applying to the
   * node the moment that happened.
   */
  squeeze: (bytesPerSecond: number) => Promise<void>;
  /** Lift it everywhere, and stop applying it to targets that attach later. */
  release: () => Promise<void>;
  /**
   * Every command Chrome refused, in the order it refused them.
   *
   * ⭐ Collected rather than thrown. A session that died between attaching and being configured is
   * ordinary, and killing a sitting over it would cost a measurement to tidiness. What decides
   * whether the cap actually landed is the proof by effect in `capProof.ts`, never this list.
   */
  failures: () => readonly string[];
  close: () => Promise<void>;
}

/**
 * What one WebSocket frame weighed on the wire, from the two ways CDP can hand its payload over.
 *
 * ⛔ A frame whose opcode is neither is a control frame (close, ping, pong), whose payload is either
 * empty or a short reason string. Counted as text, which is right for a reason string and identical
 * to every other reading for an empty one.
 */
export function cdpFrameBytes(opcode: number, payloadData: string): number {
  if (opcode === OPCODE_BINARY) {
    return Buffer.from(payloadData, 'base64').length;
  }
  return Buffer.byteLength(payloadData);
}

/** Whether this target's own sockets are ones the node could be moving bytes over. */
export function isWorkerTarget(type: string): boolean {
  return WORKER_TARGET_TYPES.includes(type);
}

/** What CDP takes to mean "do not cap this direction", which is what a release restores. */
const UNTHROTTLED = -1;

/**
 * The latency the emulation adds on top of the throughput cap.
 *
 * Zero, matching `throttle.ts` exactly. A round trip penalty here and not there would degrade the
 * worker's link in a dimension the page's is not, and the two halves of one cap have to be one cap.
 */
const LATENCY_MS = 0;

function emulationParams(bytesPerSecond: number): Record<string, unknown> {
  return {
    offline: false,
    latency: LATENCY_MS,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: UNTHROTTLED,
  };
}

/**
 * The filter `Target.setAutoAttach` is given, which decides what this client ever sees.
 *
 * ⛔ The trailing exclude is not optional. CDP walks the list and the first entry that matches
 * decides, so without a catch-all exclusion at the end every remaining target type is attached,
 * including the browser and tab targets Playwright is already driving.
 */
export function autoAttachFilter(): readonly Record<string, unknown>[] {
  return [
    ...WORKER_TARGET_TYPES.map((type) => ({ type })),
    ...CARRIER_TARGET_TYPES.map((type) => ({ type })),
    { exclude: true },
  ];
}

interface TargetInfoShape {
  targetId?: unknown;
  type?: unknown;
  url?: unknown;
}

function readTargetInfo(params: Record<string, unknown> | undefined): {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
} | null {
  const sessionId = params?.sessionId;
  const info = params?.targetInfo as TargetInfoShape | undefined;
  if (typeof sessionId !== 'string' || info === undefined) {
    return null;
  }
  return {
    sessionId,
    targetId: typeof info.targetId === 'string' ? info.targetId : '',
    type: typeof info.type === 'string' ? info.type : '',
    url: typeof info.url === 'string' ? info.url : '',
  };
}

function readFrame(params: Record<string, unknown> | undefined): { requestId: string; bytes: number } | null {
  const requestId = params?.requestId;
  const response = params?.response as { opcode?: unknown; payloadData?: unknown } | undefined;
  if (typeof requestId !== 'string' || response === undefined) {
    return null;
  }
  const opcode = typeof response.opcode === 'number' ? response.opcode : OPCODE_TEXT;
  const payloadData = typeof response.payloadData === 'string' ? response.payloadData : '';
  return { requestId, bytes: cdpFrameBytes(opcode, payloadData) };
}

/**
 * Attach to every worker target this browser makes, and record and cap what they do.
 *
 * ⛔⛔ Frames are stamped with the harness's own `Date.now()` and never with CDP's `timestamp`. That
 * field is a `Network.MonotonicTime`, seconds since an arbitrary epoch, and every window in this
 * harness is cut on wall clock. Stamped from CDP, every frame would fall outside every window and
 * read as **zero inbound bytes**, which is the exact reading this module was written to stop
 * producing. `recordWebSocketTraffic` stamps the same way, so the two recorders' frames interleave
 * on one clock.
 *
 * @param into The same traffic object the page recorder appends to, so one reader sums both.
 */
export async function watchWorkerTargets(transport: CdpTransport, into: WebSocketTraffic): Promise<WorkerTargetWatch> {
  const attached = new Map<string, AttachedTarget>();
  const order: AttachedTarget[] = [];
  const openSockets = new Map<string, WebSocketConnection>();
  const pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (why: Error) => void }
  >();
  const failures: string[] = [];
  let nextId = 0;
  let activeCapBytesPerSecond: number | null = null;

  const call = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>> => {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      transport.send(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId });
    });
  };

  const record = async (
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string,
  ): Promise<void> => {
    try {
      await call(method, params, sessionId);
    } catch (error: unknown) {
      failures.push(`${method} on session ${sessionId}: ${String(error)}`);
    }
  };

  const onAttached = (params: Record<string, unknown> | undefined): void => {
    const info = readTargetInfo(params);
    if (info === null) {
      return;
    }
    const worker = isWorkerTarget(info.type);
    const target: AttachedTarget = { ...info, attachedAtMs: Date.now(), detachedAtMs: null, recorded: worker };
    attached.set(info.sessionId, target);
    order.push(target);

    if (!worker) {
      // ⛔ A carrier is attached for one reason and gets one command: pass the auto-attach down to
      // its own dedicated workers, which are children of the page rather than of the browser.
      // Enabling Network here would double every byte Playwright's page recorder already has.
      void record('Target.setAutoAttach', autoAttach(), info.sessionId);
      return;
    }
    // ⛔ No auto-attach on a worker session. A shared worker has no child targets to reach, so the
    // command is at best a no-op and at worst a refusal, and a `failures` list that fills up on
    // every healthy run is one nobody reads when it matters.
    void record('Network.enable', undefined, info.sessionId);
    if (activeCapBytesPerSecond !== null) {
      void record('Network.emulateNetworkConditions', emulationParams(activeCapBytesPerSecond), info.sessionId);
    }
  };

  const onDetached = (params: Record<string, unknown> | undefined): void => {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== 'string') {
      return;
    }
    const target = attached.get(sessionId);
    if (target !== undefined) {
      target.detachedAtMs = Date.now();
    }
    attached.delete(sessionId);
  };

  const onWebSocketEvent = (method: string, params: Record<string, unknown> | undefined): void => {
    if (method === 'Network.webSocketCreated') {
      const requestId = params?.requestId;
      if (typeof requestId !== 'string') {
        return;
      }
      const connection: WebSocketConnection = {
        url: typeof params?.url === 'string' ? params.url : '',
        openedAtMs: Date.now(),
        closedAtMs: null,
      };
      openSockets.set(requestId, connection);
      into.connections.push(connection);
      return;
    }
    if (method === 'Network.webSocketClosed') {
      const requestId = params?.requestId;
      const connection = typeof requestId === 'string' ? openSockets.get(requestId) : undefined;
      if (connection !== undefined) {
        connection.closedAtMs = Date.now();
        openSockets.delete(requestId as string);
      }
      return;
    }
    const frame = readFrame(params);
    if (frame === null) {
      return;
    }
    into.frames.push({
      atMs: Date.now(),
      direction: method === 'Network.webSocketFrameReceived' ? 'in' : 'out',
      bytes: frame.bytes,
    });
  };

  const WS_EVENTS = new Set([
    'Network.webSocketCreated',
    'Network.webSocketClosed',
    'Network.webSocketFrameReceived',
    'Network.webSocketFrameSent',
  ]);

  transport.onMessage((message) => {
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (waiting === undefined) {
        return;
      }
      if (message.error !== undefined) {
        waiting.reject(new Error(message.error.message ?? 'the browser refused the command'));
        return;
      }
      waiting.resolve(message.result ?? {});
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      onAttached(message.params);
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      onDetached(message.params);
      return;
    }
    // ⛔ Only a session this client attached to and enabled Network on. An event carrying a session
    // id we never recorded is one Playwright's own auto-attach produced, and counting it would put
    // the page's bytes in the worker's column.
    if (message.method !== undefined && WS_EVENTS.has(message.method)) {
      const target = message.sessionId === undefined ? undefined : attached.get(message.sessionId);
      if (target?.recorded === true) {
        onWebSocketEvent(message.method, message.params);
      }
    }
  });

  await call('Target.setAutoAttach', autoAttach());

  const applyToRecorded = async (params: Record<string, unknown>): Promise<void> => {
    await Promise.all(
      [...attached.values()]
        .filter((target) => target.recorded)
        .map((target) => record('Network.emulateNetworkConditions', params, target.sessionId)),
    );
  };

  return {
    targets: () => order,
    failures: () => failures,
    squeeze: async (bytesPerSecond: number): Promise<void> => {
      activeCapBytesPerSecond = bytesPerSecond;
      await applyToRecorded(emulationParams(bytesPerSecond));
    },
    release: async (): Promise<void> => {
      activeCapBytesPerSecond = null;
      await applyToRecorded(emulationParams(UNTHROTTLED));
    },
    close: async (): Promise<void> => {
      for (const waiting of pending.values()) {
        waiting.reject(new Error('the CDP connection closed before this command was answered'));
      }
      pending.clear();
      await transport.close();
    },
  };
}

/** The auto-attach arguments, in one place so the browser call and every carrier call agree. */
function autoAttach(): Record<string, unknown> {
  return { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: autoAttachFilter() };
}

/**
 * Chrome's browser-level debugging socket, once it is answering.
 *
 * Polled rather than read once. `--remote-debugging-port` is bound as Chrome starts up, and
 * Playwright's launch resolves on its own handshake rather than on that listener being ready.
 */
async function browserWebSocketUrl(port: number): Promise<string> {
  const deadline = Date.now() + ENDPOINT_TIMEOUT_MS;
  let lastError = 'it never answered';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
      if (typeof body.webSocketDebuggerUrl === 'string') {
        return body.webSocketDebuggerUrl;
      }
      lastError = 'it answered without a webSocketDebuggerUrl';
    } catch (error: unknown) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, ENDPOINT_POLL_MS));
  }

  throw new Error(
    `Chrome's debugging endpoint on port ${port} could not be read within ${ENDPOINT_TIMEOUT_MS}ms: ` +
      `${lastError}. Without it the cap reaches the page only and the node's own sockets are ` +
      'unrecorded, which is the arm 3 probe of 2026-09-02 and every figure in it was void.',
  );
}

/**
 * Open the raw client to Chrome, awaiting the handshake so a caller never sends into a closed socket.
 *
 * Node's own `WebSocket` rather than a dependency: the runtime has had one since 22 and this is the
 * only place in the harness that speaks a socket directly.
 */
export async function openBrowserCdp(port: number): Promise<CdpTransport> {
  const url = await browserWebSocketUrl(port);
  const socket = new WebSocket(url);
  const listeners: ((message: CdpInbound) => void)[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') {
      return;
    }
    let message: CdpInbound;
    try {
      message = JSON.parse(event.data) as CdpInbound;
    } catch {
      return;
    }
    listeners.forEach((listener) => listener(message));
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`could not open Chrome's debugging socket at ${url}`)), {
      once: true,
    });
  });

  return {
    send: (message: CdpOutbound): void => socket.send(JSON.stringify(message)),
    onMessage: (listener: (message: CdpInbound) => void): void => {
      listeners.push(listener);
    },
    close: async (): Promise<void> => {
      socket.close();
    },
  };
}
