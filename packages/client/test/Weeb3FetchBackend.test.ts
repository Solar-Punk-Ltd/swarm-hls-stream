import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import type { Weeb3Module, Weeb3Node } from '../src/components/SwarmHlsPlayer/Weeb3FetchBackend';
import { WEEB3_BOOT_MIN_PEERS, Weeb3FetchBackend } from '../src/components/SwarmHlsPlayer/Weeb3FetchBackend';

const REF = '9c4e1f60b8a2d357e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7';

interface FakeNodeOptions {
  readonly bytes?: Uint8Array;
  readonly retrieveRejects?: Error;
  readonly peersReached?: boolean;
}

/**
 * A stand-in for the wasm node, recording what the backend asked it to do.
 *
 * ⛔⛔⛔ **Ask what would still pass if weeb-3 did not exist: all of it.** Every test in this file
 * stubs the module loader, so what they hold is the wiring around the node — that it is booted once,
 * that a reference reaches it, that a failure is reported rather than swallowed. They cannot show that
 * `init`, `start`, `ready` or `retrieveBytes` do anything in a browser, and nothing that stubs the
 * package ever could. That is phase A2's job, against a real Chrome and recorded content, and it is
 * free. This project has shipped nine passing stubbed tests over a completely broken script once
 * already.
 */
function fakeNode(options: FakeNodeOptions = {}) {
  const calls = { started: 0, ready: [] as number[], retrieved: [] as string[] };
  const node: Weeb3Node = {
    start: () => {
      calls.started++;
    },
    ready: (minConnections: number) => {
      calls.ready.push(minConnections);
      return Promise.resolve(options.peersReached ?? true);
    },
    retrieveBytes: (address: string) => {
      calls.retrieved.push(address);
      return options.retrieveRejects
        ? Promise.reject(options.retrieveRejects)
        : Promise.resolve(options.bytes ?? new Uint8Array([1, 2, 3]));
    },
  };
  return { node, calls };
}

function fakeModule(node: Weeb3Node) {
  const initialised = { count: 0 };
  const module: Weeb3Module = {
    default: () => {
      initialised.count++;
      return Promise.resolve();
    },
    Weeb3No103: function Weeb3No103(this: unknown) {
      return node;
    } as unknown as Weeb3Module['Weeb3No103'],
  };
  return { module, initialised };
}

describe('Weeb3FetchBackend booting the node', () => {
  /**
   * ⛔⛔ ONE node per tab, measured: one weeb-3 node reaches ~200 peers, two reach 82 each, and three
   * reach zero and never re-dial without saying so. A player asks for a fragment every half second, so
   * a backend that booted per request would be the three-node case within two seconds of pressing
   * play.
   */
  it('boots one node however many segments are asked for', async () => {
    const { node, calls } = fakeNode();
    const { module, initialised } = fakeModule(node);
    const backend = new Weeb3FetchBackend(() => Promise.resolve(module));

    await Promise.all([backend.retrieveBytes(REF), backend.retrieveBytes(REF), backend.retrieveBytes(REF)]);

    assert.equal(initialised.count, 1, 'the wasm module was initialised more than once');
    assert.equal(calls.started, 1, 'more than one weeb-3 node was started in this tab');
    assert.equal(calls.retrieved.length, 3);
  });

  // The wasm has to be instantiated before the constructor exists to call, per the package's own README.
  it('initialises the wasm module before constructing a node', async () => {
    const order: string[] = [];
    const { node } = fakeNode();
    const module: Weeb3Module = {
      default: () => {
        order.push('init');
        return Promise.resolve();
      },
      Weeb3No103: function Weeb3No103(this: unknown) {
        order.push('construct');
        return node;
      } as unknown as Weeb3Module['Weeb3No103'],
    };

    await new Weeb3FetchBackend(() => Promise.resolve(module)).retrieveBytes(REF);

    assert.deepEqual(order, ['init', 'construct']);
  });

  /**
   * A node with no peers answers nothing, and `retrieveBytes` would fail in a way that names neither
   * the cause nor the count. Waiting here turns that into one message at boot.
   *
   * ⚠️ This is a readiness wait, not the refusal gate. Phase B's "refuse to measure under N peers" is
   * a different bar reached through the same call.
   */
  it('waits for the node to reach the network before the first retrieval', async () => {
    const { node, calls } = fakeNode();
    const { module } = fakeModule(node);

    await new Weeb3FetchBackend(() => Promise.resolve(module)).retrieveBytes(REF);

    assert.deepEqual(calls.ready, [WEEB3_BOOT_MIN_PEERS]);
  });

  it('fails the boot, naming peers, when the node never reaches the network', async () => {
    const { node } = fakeNode({ peersReached: false });
    const { module } = fakeModule(node);
    const backend = new Weeb3FetchBackend(() => Promise.resolve(module));

    await assert.rejects(backend.retrieveBytes(REF), /peer/i);
  });

  /**
   * ⛔ A boot that failed must not leave the player permanently dead.
   *
   * The node is memoised so it is built once, and memoising a rejection would mean a transient failure
   * at the moment the tab opened costs the whole broadcast. hls.js already bounds how often this is
   * retried, on its own fragment-retry cadence.
   */
  it('lets a later segment retry a boot that failed', async () => {
    const { node } = fakeNode();
    const { module } = fakeModule(node);
    let attempt = 0;
    const backend = new Weeb3FetchBackend(() => {
      attempt++;
      return attempt === 1 ? Promise.reject(new Error('module fetch failed')) : Promise.resolve(module);
    });

    await assert.rejects(backend.retrieveBytes(REF), /module fetch failed/);
    const bytes = await backend.retrieveBytes(REF);

    assert.equal(attempt, 2, 'the failed boot was remembered as permanent');
    assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
  });
});

describe('Weeb3FetchBackend retrieving a segment', () => {
  it('asks the node for the bare reference and hands back its bytes', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const { node, calls } = fakeNode({ bytes });
    const { module } = fakeModule(node);

    const got = await new Weeb3FetchBackend(() => Promise.resolve(module)).retrieveBytes(REF);

    assert.deepEqual(calls.retrieved, [REF]);
    assert.deepEqual(got, bytes);
  });

  // A retrieval that failed has to stay failed, because the loader above reports it to hls.js.
  it('reports a retrieval failure rather than answering with nothing', async () => {
    const { node } = fakeNode({ retrieveRejects: new Error('chunk not found') });
    const { module } = fakeModule(node);

    await assert.rejects(new Weeb3FetchBackend(() => Promise.resolve(module)).retrieveBytes(REF), /chunk not found/);
  });

  // The default loader is the dynamic import, and it must stay dynamic: see the module's own comment.
  it('does not touch the package until a segment is actually asked for', () => {
    const loadModule = vi.fn(() => Promise.resolve(fakeModule(fakeNode().node).module));

    new Weeb3FetchBackend(loadModule);

    assert.equal(loadModule.mock.calls.length, 0, 'constructing the backend already pulled in 4.5 MB of wasm');
  });
});

/**
 * ⛔⛔⛔ weeb-3 hands back the Swarm span, and the gateway does not.
 *
 * Measured in Chrome on 2026-08-13 against four references from the decay cohort that the gateway had
 * served the same day, at three different sizes:
 *
 * | reference | gateway | `retrieveBytes` | span at offset 0 |
 * | --- | ---: | ---: | ---: |
 * | `7773f81c` | 818,740 | 818,748 | 818,740 |
 * | `45b83ac1` | 819,116 | 819,124 | 819,116 |
 * | `9fdd4c63` | 844,872 | 844,880 | 844,872 |
 * | `9b6a51b8` | 820,808 | 820,816 | 820,808 |
 *
 * Eight bytes longer every time, and the leading uint64 little-endian is the gateway's own byte count
 * every time. The MPEG-TS sync byte `0x47` sits at offset 8 rather than 0, and the 188-byte packet
 * alignment holds from 8 and not from 0. So handing these bytes to hls.js unchanged puts eight bytes
 * of length header in front of the transport stream, and the demuxer never sees a valid first packet.
 *
 * ⭐ This is what a free real-browser run buys. Every stubbed test in this file passed while the
 * backend was going to feed hls.js a corrupt stream, because a stub returns whatever the stub says.
 */
describe('Weeb3FetchBackend handing back what a gateway would have', () => {
  const PAYLOAD = new Uint8Array([0x47, 0x40, 0x00, 0x10, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);

  function spanPrefixed(payload: Uint8Array, declaredLength = payload.byteLength): Uint8Array {
    const framed = new Uint8Array(8 + payload.byteLength);
    new DataView(framed.buffer).setBigUint64(0, BigInt(declaredLength), true);
    framed.set(payload, 8);
    return framed;
  }

  function backendReturning(bytes: Uint8Array) {
    const { node } = fakeNode({ bytes });
    const { module } = fakeModule(node);
    return new Weeb3FetchBackend(() => Promise.resolve(module));
  }

  it('strips the span, so the caller gets the same bytes the gateway serves', async () => {
    const got = await backendReturning(spanPrefixed(PAYLOAD)).retrieveBytes(REF);

    assert.deepEqual(got, PAYLOAD);
    assert.equal(got[0], 0x47, 'the transport stream does not start at the first byte');
  });

  /**
   * Forward compatibility, and the reason this reads the prefix rather than always dropping eight
   * bytes. A weeb-3 that stopped framing its answer would otherwise lose the first eight bytes of
   * every segment, which is the same corruption in the other direction.
   */
  it('leaves bytes alone when the prefix does not describe them', async () => {
    const notFramed = spanPrefixed(PAYLOAD, PAYLOAD.byteLength + 999);

    assert.deepEqual(await backendReturning(notFramed).retrieveBytes(REF), notFramed);
  });

  it('leaves an answer too short to carry a span alone', async () => {
    const tiny = new Uint8Array([1, 2, 3]);

    assert.deepEqual(await backendReturning(tiny).retrieveBytes(REF), tiny);
  });

  // An empty payload is still validly framed: the span says zero and zero is what follows.
  it('strips the span from an empty payload rather than calling it unframed', async () => {
    const empty = spanPrefixed(new Uint8Array(0));

    assert.deepEqual(await backendReturning(empty).retrieveBytes(REF), new Uint8Array(0));
  });
});
