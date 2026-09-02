import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type WebSocketTraffic } from '../src/browser/webSocketTraffic.js';
import {
  type AttachedTarget,
  autoAttachFilter,
  cdpFrameBytes,
  type CdpInbound,
  type CdpOutbound,
  type CdpTransport,
  isWorkerTarget,
  watchWorkerTargets,
  WORKER_TARGET_TYPES,
} from '../src/browser/workerTargets.js';

/**
 * The worker-target CDP client, driven off a fake pipe.
 *
 * ⛔ Chrome cannot run here, so these tests carry the logic that a live run can only confirm. What
 * they hold is the three things the arm 3 probe of 2026-09-02 got wrong and could not have noticed:
 * that a worker session is attached and enabled at all, that its frames are counted in the units
 * they arrive in rather than the units they are encoded in, and that a cap applies to a session that
 * attached AFTER the squeeze started, which is what a respawned SharedWorker produces.
 */

/** A binary payload CDP would hand over base64 encoded, with its decoded length beside it. */
const BINARY_PAYLOAD = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString('base64');
const BINARY_BYTES = 9;

const CAP_BYTES_PER_SECOND = 350_000;

/**
 * A pipe that records what was sent and acknowledges every command.
 *
 * ⭐ The acknowledgement is the point rather than a convenience. The watch correlates replies to ids
 * so that a command Chrome refuses becomes visible, and a fake that never answered would leave every
 * one of those promises pending and prove nothing about the correlation.
 */
function fakeTransport(): CdpTransport & {
  sent: CdpOutbound[];
  emit: (message: CdpInbound) => void;
  closed: () => boolean;
  refuse: (method: string, why: string) => void;
} {
  const sent: CdpOutbound[] = [];
  const listeners: ((message: CdpInbound) => void)[] = [];
  const refusals = new Map<string, string>();
  let closed = false;

  const emit = (message: CdpInbound): void => {
    listeners.forEach((listener) => listener(message));
  };

  return {
    sent,
    emit,
    closed: () => closed,
    refuse: (method, why) => refusals.set(method, why),
    send: (message: CdpOutbound): void => {
      sent.push(message);
      const why = refusals.get(message.method);
      emit(why === undefined ? { id: message.id, result: {} } : { id: message.id, error: { message: why } });
    },
    onMessage: (listener: (message: CdpInbound) => void): void => {
      listeners.push(listener);
    },
    close: async (): Promise<void> => {
      closed = true;
    },
  };
}

function attachedToTarget(sessionId: string, type: string, url = 'https://example.test/worker.js'): CdpInbound {
  return {
    method: 'Target.attachedToTarget',
    params: { sessionId, targetInfo: { targetId: `target-${sessionId}`, type, url }, waitingForDebugger: false },
  };
}

function frameReceived(sessionId: string, opcode: number, payloadData: string): CdpInbound {
  return {
    method: 'Network.webSocketFrameReceived',
    sessionId,
    params: { requestId: `req-${sessionId}`, timestamp: 1, response: { opcode, mask: false, payloadData } },
  };
}

function emptyTraffic(): WebSocketTraffic {
  return { connections: [], frames: [] };
}

/** What was sent on a given session, which is how each assertion below names its subject. */
function sentOn(sent: readonly CdpOutbound[], sessionId: string | undefined, method: string): CdpOutbound[] {
  return sent.filter((message) => message.sessionId === sessionId && message.method === method);
}

function emulationOn(sent: readonly CdpOutbound[], sessionId: string): CdpOutbound[] {
  return sentOn(sent, sessionId, 'Network.emulateNetworkConditions');
}

function downloadThroughputOf(message: CdpOutbound): unknown {
  return (message.params as Record<string, unknown> | undefined)?.downloadThroughput;
}

function targetOf(targets: readonly AttachedTarget[], sessionId: string): AttachedTarget {
  const found = targets.find((target) => target.sessionId === sessionId);
  assert.ok(found !== undefined, `no target attached on session ${sessionId}`);
  return found;
}

describe('cdpFrameBytes', () => {
  it('decodes a binary frame rather than counting its base64 characters', () => {
    // ⛔ The failure this guards is silent and one-directional: base64 is 4 characters per 3 bytes,
    // so counting characters overstates every yamux frame an in-tab node moves by a third.
    assert.equal(cdpFrameBytes(2, BINARY_PAYLOAD), BINARY_BYTES);
    assert.ok(BINARY_PAYLOAD.length > BINARY_BYTES);
  });

  it('counts a text frame in utf-8 bytes rather than characters', () => {
    assert.equal(cdpFrameBytes(1, 'hello'), 5);
    // Two characters, four bytes. `payload.length` would say two.
    assert.equal(cdpFrameBytes(1, '€€'), 6);
  });

  it('reads a control frame as text, which is right for a reason string and empty either way', () => {
    assert.equal(cdpFrameBytes(8, ''), 0);
    assert.equal(cdpFrameBytes(8, 'going away'), 10);
  });
});

describe('autoAttachFilter', () => {
  it('ends with a catch-all exclusion, without which every other target type attaches', () => {
    const filter = autoAttachFilter();
    assert.deepEqual(filter[filter.length - 1], { exclude: true });
  });

  it('names every worker type it is meant to reach', () => {
    const types = autoAttachFilter().map((entry) => entry.type);
    WORKER_TARGET_TYPES.forEach((type) => assert.ok(types.includes(type), `${type} is not in the filter`));
  });
});

describe('isWorkerTarget', () => {
  it('holds the shared worker weeb-3 runs in, plus the two a future client could move it to', () => {
    assert.equal(isWorkerTarget('shared_worker'), true);
    assert.equal(isWorkerTarget('worker'), true);
    assert.equal(isWorkerTarget('service_worker'), true);
  });

  it('leaves a page to the recorder that already keeps it, so no byte is counted twice', () => {
    assert.equal(isWorkerTarget('page'), false);
    assert.equal(isWorkerTarget('browser'), false);
  });
});

describe('watchWorkerTargets, attaching', () => {
  it('asks the browser to auto-attach, flattened, before anything else', async () => {
    const transport = fakeTransport();
    await watchWorkerTargets(transport, emptyTraffic());

    const [first] = transport.sent;
    assert.equal(first.method, 'Target.setAutoAttach');
    assert.equal(first.sessionId, undefined);
    assert.equal(first.params?.flatten, true);
    assert.equal(first.params?.autoAttach, true);
    assert.equal(first.params?.waitForDebuggerOnStart, false);
  });

  it('enables Network on a shared worker session, which is where the node lives', async () => {
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));

    assert.equal(sentOn(transport.sent, 'worker-1', 'Network.enable').length, 1);
    assert.equal(targetOf(watch.targets(), 'worker-1').recorded, true);
  });

  it('carries the auto-attach down to a page but never enables Network on it', async () => {
    // ⛔ A page enabled here would double every byte Playwright's own page recorder already has, and
    // the auto-attach is still needed so the page's own dedicated workers are reached.
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    transport.emit(attachedToTarget('page-1', 'page', 'https://example.test/'));

    assert.equal(sentOn(transport.sent, 'page-1', 'Target.setAutoAttach').length, 1);
    assert.equal(sentOn(transport.sent, 'page-1', 'Network.enable').length, 0);
    assert.equal(targetOf(watch.targets(), 'page-1').recorded, false);
  });

  it('keeps a detached target in the record with the instant it went away', async () => {
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    transport.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'worker-1' } });

    const target = targetOf(watch.targets(), 'worker-1');
    assert.notEqual(target.detachedAtMs, null);
  });

  it('records a command the browser refused rather than throwing the run away over it', async () => {
    const transport = fakeTransport();
    transport.refuse('Network.enable', 'Network is not available on this target');
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    await Promise.resolve();

    assert.equal(watch.failures().length, 1);
    assert.match(watch.failures()[0], /Network\.enable on session worker-1/);
  });
});

describe('watchWorkerTargets, counting frames', () => {
  it('sums a worker session frame into the traffic every existing reader already sums', async () => {
    const traffic = emptyTraffic();
    const transport = fakeTransport();
    await watchWorkerTargets(transport, traffic);
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    transport.emit(frameReceived('worker-1', 2, BINARY_PAYLOAD));

    assert.equal(traffic.frames.length, 1);
    assert.equal(traffic.frames[0].direction, 'in');
    assert.equal(traffic.frames[0].bytes, BINARY_BYTES);
  });

  it('counts an outbound frame in its own direction', async () => {
    const traffic = emptyTraffic();
    const transport = fakeTransport();
    await watchWorkerTargets(transport, traffic);
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    transport.emit({
      method: 'Network.webSocketFrameSent',
      sessionId: 'worker-1',
      params: { requestId: 'req-1', timestamp: 1, response: { opcode: 2, mask: true, payloadData: BINARY_PAYLOAD } },
    });

    assert.equal(traffic.frames[0].direction, 'out');
    assert.equal(traffic.frames[0].bytes, BINARY_BYTES);
  });

  it('stamps a frame on the wall clock the windows are cut on, not on the CDP timestamp', async () => {
    // ⛔⛔ CDP's `timestamp` is a monotonic time in seconds since an arbitrary epoch. Stamped from
    // it, every frame would fall outside every window this harness cuts and read as zero inbound,
    // which is the exact reading being fixed.
    const traffic = emptyTraffic();
    const transport = fakeTransport();
    const before = Date.now();
    await watchWorkerTargets(transport, traffic);
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    transport.emit(frameReceived('worker-1', 1, 'hello'));

    assert.ok(traffic.frames[0].atMs >= before);
    assert.ok(traffic.frames[0].atMs <= Date.now());
  });

  it('opens and closes a connection, so a zero byte count can be read beside a socket count', async () => {
    const traffic = emptyTraffic();
    const transport = fakeTransport();
    await watchWorkerTargets(transport, traffic);
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    transport.emit({
      method: 'Network.webSocketCreated',
      sessionId: 'worker-1',
      params: { requestId: 'req-1', url: 'wss://peer.test/ws' },
    });
    assert.equal(traffic.connections.length, 1);
    assert.equal(traffic.connections[0].url, 'wss://peer.test/ws');
    assert.equal(traffic.connections[0].closedAtMs, null);

    transport.emit({
      method: 'Network.webSocketClosed',
      sessionId: 'worker-1',
      params: { requestId: 'req-1', timestamp: 2 },
    });
    assert.notEqual(traffic.connections[0].closedAtMs, null);
  });

  it('ignores a frame on a session it never enabled Network on', async () => {
    // A page session's frames belong to Playwright's recorder. Counted here as well they would be
    // counted twice, and a doubled inbound total is how an amplification ratio comes out wrong.
    const traffic = emptyTraffic();
    const transport = fakeTransport();
    await watchWorkerTargets(transport, traffic);
    transport.emit(attachedToTarget('page-1', 'page', 'https://example.test/'));
    transport.emit(frameReceived('page-1', 2, BINARY_PAYLOAD));

    assert.equal(traffic.frames.length, 0);
  });

  it('ignores a frame carrying a session id nothing here ever attached', async () => {
    const traffic = emptyTraffic();
    const transport = fakeTransport();
    await watchWorkerTargets(transport, traffic);
    transport.emit(frameReceived('someone-elses-session', 2, BINARY_PAYLOAD));

    assert.equal(traffic.frames.length, 0);
  });
});

describe('watchWorkerTargets, applying the cap', () => {
  it('caps every worker session that is already attached', async () => {
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    transport.emit(attachedToTarget('worker-2', 'worker'));

    await watch.squeeze(CAP_BYTES_PER_SECOND);

    assert.equal(downloadThroughputOf(emulationOn(transport.sent, 'worker-1')[0]), CAP_BYTES_PER_SECOND);
    assert.equal(downloadThroughputOf(emulationOn(transport.sent, 'worker-2')[0]), CAP_BYTES_PER_SECOND);
  });

  it('caps a session that attached AFTER the squeeze started, which is a respawned worker', async () => {
    // ⛔⛔ The half that a cap applied once, to the sessions that happened to exist, would miss. A
    // SharedWorker can be respawned mid-run, and the run would then carry a cap that had quietly
    // stopped applying to the node while still calling every row capped.
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    await watch.squeeze(CAP_BYTES_PER_SECOND);
    transport.emit(attachedToTarget('worker-late', 'shared_worker'));
    await Promise.resolve();

    assert.equal(downloadThroughputOf(emulationOn(transport.sent, 'worker-late')[0]), CAP_BYTES_PER_SECOND);
  });

  it('does not cap a page session, which the page throttle already holds', async () => {
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    transport.emit(attachedToTarget('page-1', 'page', 'https://example.test/'));
    await watch.squeeze(CAP_BYTES_PER_SECOND);

    assert.equal(emulationOn(transport.sent, 'page-1').length, 0);
  });

  it('lifts the cap everywhere, and stops applying it to a session that attaches later', async () => {
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    await watch.squeeze(CAP_BYTES_PER_SECOND);
    await watch.release();

    const lifted = emulationOn(transport.sent, 'worker-1');
    assert.equal(downloadThroughputOf(lifted[lifted.length - 1]), -1);

    transport.emit(attachedToTarget('worker-after-release', 'shared_worker'));
    await Promise.resolve();
    assert.equal(emulationOn(transport.sent, 'worker-after-release').length, 0);
  });

  it('leaves the upload direction alone, because a viewer sends nothing', async () => {
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    transport.emit(attachedToTarget('worker-1', 'shared_worker'));
    await watch.squeeze(CAP_BYTES_PER_SECOND);

    const [applied] = emulationOn(transport.sent, 'worker-1');
    assert.equal((applied.params as Record<string, unknown>).uploadThroughput, -1);
    assert.equal((applied.params as Record<string, unknown>).latency, 0);
    assert.equal((applied.params as Record<string, unknown>).offline, false);
  });

  it('closes the pipe and rejects a command nothing answered', async () => {
    const transport = fakeTransport();
    const watch = await watchWorkerTargets(transport, emptyTraffic());
    await watch.close();

    assert.equal(transport.closed(), true);
  });
});
