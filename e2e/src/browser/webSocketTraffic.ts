/**
 * Every WebSocket frame the tab sent and received, and the sums a run reads out of them.
 *
 * ## Why the browser's socket layer is the only place to watch an in-tab node
 *
 * weeb-3 exposes no retrieval telemetry. Its `logs()` drains a channel only `lib.rs` writes to and
 * `progressSnapshot()` reports uploads, so attempts and bytes cannot be counted from inside the
 * wasm. WebSockets are the one transport that node has (`websocket_websys`), which makes this layer
 * the only vantage point outside it. What is visible here is frames and bytes, never peers and never
 * attempts: yamux multiplexes many streams onto one socket, so a frame count is not an attempt count
 * and nothing here pretends otherwise.
 *
 * ## ⭐ Collection and arithmetic are separated deliberately
 *
 * {@link recordWebSocketTraffic} is a listener that appends and sums nothing. Every figure comes out
 * of the pure functions below, which `test/webSocketTraffic.test.ts` exercises on hand-built frames.
 * `deploy/scripts/in-browser-concurrency-sweep.js` records why: every in-browser throughput figure
 * this project retracted before 2026-08-11 was retracted for the arithmetic applied afterwards
 * rather than for a mistimed fetch.
 */

import { type Page } from 'playwright-core';

/** Milliseconds in the second the per-second series buckets by. */
const MS_PER_SECOND = 1_000;

export type FrameDirection = 'in' | 'out';

export interface WebSocketFrame {
  atMs: number;
  direction: FrameDirection;
  bytes: number;
}

export interface WebSocketConnection {
  url: string;
  openedAtMs: number;
  /** Null while the connection is still open, which is the state most of them end a run in. */
  closedAtMs: number | null;
}

/** One second of a window, including the seconds nothing happened in. */
export interface PerSecondSample {
  secondIndex: number;
  inBytes: number;
  outBytes: number;
  inFrames: number;
  outFrames: number;
}

/** Everything a run's listener collected, in the order it arrived. */
export interface WebSocketTraffic {
  connections: WebSocketConnection[];
  frames: WebSocketFrame[];
}

/**
 * What one frame weighed on the wire.
 *
 * ⛔ `Buffer.byteLength` rather than `payload.length`, because on a string the second counts
 * characters. Playwright hands binary frames over as Buffers and text frames as strings, so the two
 * cases arrive through the same field and only one of them would be wrong.
 */
export function frameBytes(payload: string | Buffer): number {
  return Buffer.byteLength(payload);
}

/**
 * Attach the recorder to a page, before it navigates.
 *
 * A listener added after the navigation misses the sockets the node opened while the harness was
 * still opening the page, and those are the ones the join is made of.
 */
export function recordWebSocketTraffic(page: Page, into: WebSocketTraffic): void {
  page.on('websocket', (socket) => {
    const connection: WebSocketConnection = { url: socket.url(), openedAtMs: Date.now(), closedAtMs: null };
    into.connections.push(connection);

    socket.on('framereceived', ({ payload }) => {
      into.frames.push({ atMs: Date.now(), direction: 'in', bytes: frameBytes(payload) });
    });
    socket.on('framesent', ({ payload }) => {
      into.frames.push({ atMs: Date.now(), direction: 'out', bytes: frameBytes(payload) });
    });
    socket.on('close', () => {
      connection.closedAtMs = Date.now();
    });
  });
}

/**
 * Whether a frame belongs to `[fromMs, toMs)`.
 *
 * ⛔ Half open, so windows laid end to end count every frame exactly once. Part A runs three idle
 * windows back to back and Part B measures a retrieval and then the ten seconds after it settled, so
 * a frame counted in both halves of a boundary would inflate one of the ratios H1 is judged on.
 */
function inWindow(frame: WebSocketFrame, fromMs: number, toMs: number): boolean {
  return frame.atMs >= fromMs && frame.atMs < toMs;
}

export function bytesBetween(
  frames: readonly WebSocketFrame[],
  fromMs: number,
  toMs: number,
  direction: FrameDirection,
): number {
  return frames.reduce(
    (total, frame) => (frame.direction === direction && inWindow(frame, fromMs, toMs) ? total + frame.bytes : total),
    0,
  );
}

export function framesBetween(
  frames: readonly WebSocketFrame[],
  fromMs: number,
  toMs: number,
  direction: FrameDirection,
): number {
  return frames.reduce(
    (total, frame) => (frame.direction === direction && inWindow(frame, fromMs, toMs) ? total + 1 : total),
    0,
  );
}

/**
 * A window second by second, with the quiet seconds present and reading zero.
 *
 * ⛔ A quiet second is a measurement. H2 asks what share of a capped link the node's own background
 * chatter takes, and a series holding only the busy seconds would divide by a smaller denominator
 * and answer a question nobody asked.
 *
 * A part second at the end gets a bucket of its own rather than being dropped, so a window is always
 * fully covered by the series that describes it.
 */
export function perSecondSeries(frames: readonly WebSocketFrame[], fromMs: number, toMs: number): PerSecondSample[] {
  const seconds = Math.max(0, Math.ceil((toMs - fromMs) / MS_PER_SECOND));
  const series: PerSecondSample[] = Array.from({ length: seconds }, (_unused, secondIndex) => ({
    secondIndex,
    inBytes: 0,
    outBytes: 0,
    inFrames: 0,
    outFrames: 0,
  }));

  for (const frame of frames) {
    if (!inWindow(frame, fromMs, toMs)) {
      continue;
    }
    const sample = series[Math.floor((frame.atMs - fromMs) / MS_PER_SECOND)];
    if (sample === undefined) {
      continue;
    }
    if (frame.direction === 'in') {
      sample.inBytes += frame.bytes;
      sample.inFrames += 1;
    } else {
      sample.outBytes += frame.bytes;
      sample.outFrames += 1;
    }
  }

  return series;
}

/** How many sockets were open at an instant, counting from the open and stopping at the close. */
export function openConnectionsAt(connections: readonly WebSocketConnection[], atMs: number): number {
  return connections.reduce(
    (total, connection) =>
      connection.openedAtMs <= atMs && (connection.closedAtMs === null || connection.closedAtMs > atMs)
        ? total + 1
        : total,
    0,
  );
}

/**
 * Inbound bytes per byte of payload the retrieval returned, or null when it returned none.
 *
 * ⛔⛔ Null rather than Infinity or zero. A retrieval that came back empty has not shown an infinite
 * amplification, it has shown a row that cannot answer H1, and in a table of ratios the two read
 * completely differently.
 */
export function amplification(inboundBytes: number, payloadBytes: number): number | null {
  return payloadBytes === 0 ? null : inboundBytes / payloadBytes;
}
