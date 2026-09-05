import type { Weeb3No103 } from '@lat-murmeldjur/weeb_3';

/**
 * The same members, with every method restated as a function-typed property.
 *
 * TypeScript compares method parameters bivariantly however strict the project is, and it decides
 * that from the target's own declaration, so nothing compared against a class's methods is compared
 * strictly. Rebuilt as plain function types the signatures lose that origin, which is the only reason
 * the interface below can refuse a parameter we declare narrower than the one weeb-3 accepts.
 */
type WithoutMethodBivariance<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : T[K];
};

/**
 * The part of weeb-3's `Weeb3No103` this client uses. Narrowed deliberately, see the class below.
 *
 * ⛔ **The `extends` is the drift gate, not decoration.** Three signatures copied out of a package we
 * pin are three signatures that go stale silently. Restating them over the package's own class turns
 * a bump that renames one of them, drops one, or changes what one takes or returns into a compile
 * error that names the member, and a key the class no longer has fails on the `Pick` itself.
 *
 * The opposite mistake, a member invented here that weeb-3 never had, is caught where the real module
 * is loaded. See {@link Weeb3Module}, and read its note before reaching for a cast there.
 *
 * ⛔ **Function-typed properties rather than method signatures, and that is load-bearing too**, for
 * the same reason {@link WithoutMethodBivariance} exists. Written as `start(options?: unknown): void`
 * these are methods, the loader's check against them is the loose one, and a release that narrowed a
 * parameter this client passes would satisfy the interface in silence.
 */
export interface Weeb3Node extends WithoutMethodBivariance<Pick<Weeb3No103, 'start' | 'ready' | 'retrieveBytes'>> {
  start: (options?: unknown) => void;
  ready: (minConnections: number, timeoutMs: number) => Promise<boolean>;
  retrieveBytes: (address: string) => Promise<Uint8Array>;
}

/**
 * As much of the package's module surface as this client touches.
 *
 * ⛔ **Nothing here is checked unless {@link importWeeb3} stays uncast.** That assignment is the only
 * place the real module meets this shape. It read `as unknown as Promise<Weeb3Module>` until
 * 2026-09-05, and under that cast a made-up method was added to {@link Weeb3Node} on 2026-09-02 and
 * `pnpm typecheck` passed with no output at all.
 */
export interface Weeb3Module {
  /** wasm-bindgen's initialiser. The package's own README calls it once before anything else. */
  default: () => Promise<unknown>;
  Weeb3No103: new (sharedWorkerUrl?: string | null) => Weeb3Node;
}

export type Weeb3ModuleLoader = () => Promise<Weeb3Module>;

/**
 * How many peers the node must reach before the first segment is asked for.
 *
 * ⚠️ A readiness wait, not a quality bar. A node with no peers answers nothing, and `retrieveBytes`
 * would then fail in a way that names neither the cause nor the count, once per fragment. Phase B's
 * "refuse to measure below N peers" is a different threshold reached through this same call.
 */
export const WEEB3_BOOT_MIN_PEERS = 1;

/** Measured 2026-08-11: a browser node reaches its first peers in seconds and ~200 within a minute. */
export const WEEB3_BOOT_TIMEOUT_MS = 30_000;

/**
 * Where this origin serves weeb-3's SharedWorker runtime.
 *
 * The same path the package would default to, and it is the one thing standing between a viewer and
 * a node, so it is stated here rather than inherited from a release. `scripts/copy-weeb3-runtime.mjs`
 * fills the directory and `deploy/client-nginx.conf.template` serves it.
 *
 * ⚠️ Origin-absolute on purpose. nginx answers any unrecognised path with the app's own index, so a
 * viewer who reached a deep URL would resolve a relative worker path against that path instead and
 * get a 404. The cost is that a deployment under a sub-path would have to serve `/weeb-3/` at the
 * domain root as well.
 */
const WEEB3_WORKER_PATH = '/weeb-3/worker.js';

/**
 * The page the shared worker URL is resolved against.
 *
 * Read here rather than at the call site because this class is exercised outside a browser, where
 * touching `document` is a `ReferenceError` rather than `undefined`. A SharedWorker cannot exist
 * without a document, so the fallback can never reach a viewer.
 */
function pageBaseUrl(): string {
  return typeof document === 'undefined' ? 'http://localhost' : document.baseURI;
}

/**
 * ⛔⛔ Dynamic, and it has to stay dynamic. The pinned 0.0.341001 is 3.87 MB of wasm plus 96 KB of
 * glue, and a static import would put all of it in the entry chunk of every viewer, including the
 * overwhelming majority who fetch through a gateway and never call this. As an `import()` inside a
 * lazily reached method it is a separate chunk that is only ever fetched by a build that selected
 * this backend.
 *
 * ⛔⛔ **Uncast on purpose, and it needs no cast.** The package's declarations satisfy
 * {@link Weeb3Module} as written, so this one assignment is what holds every member we named against
 * the release we pin. A cast here, of any shape, switches the whole comparison off.
 */
const importWeeb3: Weeb3ModuleLoader = () => import('@lat-murmeldjur/weeb_3');

/**
 * A Swarm node running in this tab, serving segment bytes to our player.
 *
 * ## One node per tab, and the numbers that justified it were wrong
 *
 * ⛔ **The 200 / 82 / 0 figures below are refuted for separate processes.** They were measured on
 * 2026-08-11 and read as a per-machine limit. On 2026-08-15 six separate Chrome processes on one
 * laptop each reached 200, then twelve did, then twelve penned pens each held all 40 nodes they were
 * given with flat per-pen cost. See `deploy/scripts/cdp.mjs` for the likely cause, a slow first
 * contact on a machine's first node combined with a peer floor on a short timeout.
 *
 * ⚠️ **What is still untested is the case this file actually cares about**: several weeb-3 nodes
 * inside ONE tab. Every arm that refuted the per-machine claim ran one node per tab, so none of them
 * touched this. Treat it as unmeasured rather than as either proven or refuted.
 *
 * The singleton below stands on its own reasoning regardless. A player asks for a fragment every half
 * second and each node costs megabytes of wasm plus seconds of dialling, so booting one per request
 * would be wasteful whatever the peer tables did.
 *
 * ## ⛔⛔⛔ The node is not in this tab, and 0.0.341001 left no way to put it there
 *
 * `Weeb3No103` owns no node. It is a window-side facade, and every call including `retrieveBytes` is
 * correlated over one SharedWorker that the package builds from {@link WEEB3_WORKER_PATH}. A
 * SharedWorker script has to be same-origin, so this client serves weeb-3's own runtime:
 * `packages/client/scripts/copy-weeb3-runtime.mjs` copies the worker, its glue, the wasm and the
 * snippets into `public/weeb-3/`, and `deploy/client-nginx.conf.template` answers that prefix off
 * the filesystem.
 *
 * Read from the package rather than assumed, and then measured: on 2026-09-02 the stage served the
 * app's index under that prefix and every viewer got `SharedWorker request timed out` and no node.
 * There is no in-page mode to fall back to, so a page that does not host these files has no in-tab
 * Swarm at all.
 *
 * ## What this deliberately does not use
 *
 * `attachStream(media, owner, topic, start)` would hand weeb-3 the video element and let it run its
 * own hls.js. That measures weeb-3's player, not ours. It also wants a service worker at
 * `/weeb-3/service.js` to intercept `/bzz/` fetches and answer them from the node, which is why that
 * one file of the package's runtime is not among the ones we serve.
 */
export class Weeb3FetchBackend {
  private booting: Promise<Weeb3Node> | null = null;

  constructor(private readonly loadModule: Weeb3ModuleLoader = importWeeb3) {}

  /**
   * Boot the node and reach the network without fetching anything.
   *
   * ⛔ The join is megabytes of wasm and several seconds of dialling, and it happens once per tab.
   * Measured in A2: a first retrieval right after `ready(1)` took 9,423-10,466ms against 3,185-4,003ms
   * warm. An arm that switches to this backend and immediately starts scoring is measuring the join
   * rather than the backend, so a harness calls this before the arm it wants to count.
   */
  async prewarm(): Promise<void> {
    await this.node();
  }

  /** The segment, as the gateway would have served it. See {@link withoutSwarmSpan}. */
  async retrieveBytes(ref: string): Promise<Uint8Array> {
    const node = await this.node();
    return withoutSwarmSpan(await node.retrieveBytes(ref));
  }

  private node(): Promise<Weeb3Node> {
    // ⛔ The rejection is cleared rather than remembered. Memoising a failure would mean a node that
    // could not start in the second the tab opened costs the entire broadcast, with no path back.
    // hls.js already bounds how often this is retried, on its own fragment-retry cadence.
    this.booting ??= this.boot().catch((error: unknown) => {
      this.booting = null;
      throw error;
    });

    return this.booting;
  }

  private async boot(): Promise<Weeb3Node> {
    const module = await this.loadModule();
    await module.default();

    const node = new module.Weeb3No103(new URL(WEEB3_WORKER_PATH, pageBaseUrl()).href);
    node.start();

    if (!(await node.ready(WEEB3_BOOT_MIN_PEERS, WEEB3_BOOT_TIMEOUT_MS))) {
      throw new Error(
        `weeb-3 reached fewer than ${WEEB3_BOOT_MIN_PEERS} peers in ${WEEB3_BOOT_TIMEOUT_MS}ms, so it can serve no segments`,
      );
    }

    return node;
  }
}

/** Swarm frames a reference's content with its length as a little-endian uint64. */
const SWARM_SPAN_BYTES = 8;

/**
 * The payload without the Swarm span weeb-3 leaves on the front of it.
 *
 * ## ⛔⛔⛔ The gateway does not do this, and the difference corrupts the stream
 *
 * Measured in Chrome on 2026-08-13, against four references the gateway had served the same day:
 * `retrieveBytes` returned **exactly eight bytes more every time**, and the leading uint64
 * little-endian was **exactly the gateway's own byte count every time** (818,740 / 819,116 / 844,872 /
 * 820,808, at three different segment sizes). The MPEG-TS sync byte `0x47` sat at offset 8 rather than
 * 0, and the 188-byte packet alignment held from 8 and not from 0.
 *
 * So this is not a tidy-up. Handing hls.js the framed answer puts eight bytes of length header in
 * front of the transport stream and the demuxer never finds a valid first packet.
 *
 * ⭐ Read rather than assumed, and that is deliberate in both directions. Dropping eight bytes
 * unconditionally would corrupt every segment just as badly the day a weeb-3 release stops framing its
 * answer. The prefix is self-describing, so it can simply be checked: strip it when it accounts for
 * exactly what follows, and otherwise leave the bytes alone.
 */
function withoutSwarmSpan(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < SWARM_SPAN_BYTES) {
    return bytes;
  }

  const span = new DataView(bytes.buffer, bytes.byteOffset, SWARM_SPAN_BYTES).getBigUint64(0, true);
  const framed = span === BigInt(bytes.byteLength - SWARM_SPAN_BYTES);

  return framed ? bytes.subarray(SWARM_SPAN_BYTES) : bytes;
}

/**
 * The one node this tab gets.
 *
 * A module singleton beside `manifestFetcher` and `requestJitter` in `CustomManifestLoader.ts`, and
 * for a stronger reason than either: hls.js constructs a loader per fragment, so anything owned by a
 * loader instance would be owned per request.
 */
export const weeb3FetchBackend = new Weeb3FetchBackend();
