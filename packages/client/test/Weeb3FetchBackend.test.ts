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
