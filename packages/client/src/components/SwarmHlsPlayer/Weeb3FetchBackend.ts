/** The part of weeb-3's `Weeb3No103` this client uses. Narrowed deliberately, see the class below. */
export interface Weeb3Node {
  start(options?: unknown): void;
  ready(minConnections: number, timeoutMs: number): Promise<boolean>;
  retrieveBytes(address: string): Promise<Uint8Array>;
}

export interface Weeb3Module {
  /** wasm-bindgen's initialiser. The package's own README calls it once before anything else. */
  default: () => Promise<unknown>;
  Weeb3No103: new () => Weeb3Node;
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
 * ⛔⛔ Dynamic, and it has to stay dynamic. The package is 4.5 MB of wasm plus 96 KB of glue, and a
 * static import would put all of it in the entry chunk of every viewer, including the overwhelming
 * majority who fetch through a gateway and never call this. As an `import()` inside a lazily reached
 * method it is a separate chunk that is only ever fetched by a build that selected this backend.
 */
const importWeeb3: Weeb3ModuleLoader = () => import('@lat-murmeldjur/weeb_3') as unknown as Promise<Weeb3Module>;

/**
 * A Swarm node running in this tab, serving segment bytes to our player.
 *
 * ## ⛔⛔⛔ One node per tab, and the failure is silent
 *
 * Measured 2026-08-11: one weeb-3 node in a tab reaches ~200 peers, two reach 82 each, and three reach
 * **zero, never re-dial, and report no error**. A player asks for a fragment every half second, so a
 * backend that booted a node per request would be well past the three-node case within two seconds of
 * pressing play, and would look like a network that simply had nothing to give. Hence one memoised
 * node, and hence the module singleton below rather than an instance per player.
 *
 * ## What this deliberately does not use
 *
 * `attachStream(media, owner, topic, start)` would hand weeb-3 the video element and let it run its
 * own hls.js. That measures weeb-3's player, not ours. It would also drag in the package's service
 * worker requirement: the wasm hardcodes a `/weeb-3/` scope and expects the packaged worker at
 * `/weeb-3/service.js`, which exists to intercept `/bzz/` fetches and answer them from the node.
 * `retrieveBytes` is a direct call that returns bytes, so it should need none of that.
 *
 * ⚠️ **"Should" is doing real work in that sentence.** It is what the package's code says, not
 * something this project has observed. Phase A2 runs it in a real Chrome on recorded content, for
 * free, and that is what settles whether a page outside `/weeb-3/` can boot this at all.
 */
export class Weeb3FetchBackend {
  private booting: Promise<Weeb3Node> | null = null;

  constructor(private readonly loadModule: Weeb3ModuleLoader = importWeeb3) {}

  async retrieveBytes(ref: string): Promise<Uint8Array> {
    const node = await this.node();
    return node.retrieveBytes(ref);
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

    const node = new module.Weeb3No103();
    node.start();

    if (!(await node.ready(WEEB3_BOOT_MIN_PEERS, WEEB3_BOOT_TIMEOUT_MS))) {
      throw new Error(
        `weeb-3 reached fewer than ${WEEB3_BOOT_MIN_PEERS} peers in ${WEEB3_BOOT_TIMEOUT_MS}ms, so it can serve no segments`,
      );
    }

    return node;
  }
}

/**
 * The one node this tab gets.
 *
 * A module singleton beside `manifestFetcher` and `requestJitter` in `CustomManifestLoader.ts`, and
 * for a stronger reason than either: hls.js constructs a loader per fragment, so anything owned by a
 * loader instance would be owned per request.
 */
export const weeb3FetchBackend = new Weeb3FetchBackend();
