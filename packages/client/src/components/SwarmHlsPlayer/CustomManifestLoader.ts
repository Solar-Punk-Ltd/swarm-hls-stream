import type {
  FragmentLoaderContext,
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  PlaylistLoaderContext,
} from 'hls.js';
import Hls from 'hls.js';

import { RequestJitter, StaggeredTask } from '@/utils/requestJitter';

import { activeFetchBackend, FETCH_BACKEND_WEEB3, segmentRefFromUrl } from './fetchBackend';
import { ManifestFetcher } from './ManifestManagement';
import { weeb3FetchBackend } from './Weeb3FetchBackend';

export const manifestFetcher = new ManifestFetcher();

/**
 * The stagger every fragment request goes through, shared by every player on the page.
 *
 * A module singleton beside {@link manifestFetcher} and for the same reason: hls.js constructs
 * loaders itself, passing only its own config, so there is no constructor to inject through. Tests
 * reach it by spying on the instance.
 */
export const requestJitter = new RequestJitter();

const PlaylistLoader = Hls.DefaultConfig.loader as unknown as {
  new (config: HlsConfig): Loader<PlaylistLoaderContext>;
};

export class CustomManifestLoader extends PlaylistLoader {
  constructor(config: HlsConfig) {
    super(config);
  }

  load(context: PlaylistLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<PlaylistLoaderContext>) {
    if (['manifest', 'level'].includes(context.type)) {
      manifestFetcher
        .fetch(context.url)
        .then((manifest) => {
          callbacks.onSuccess({ url: context.url, data: manifest, code: 200 }, this.stats, context, undefined);
        })
        .catch((error) => {
          callbacks.onError?.({ code: 0, text: error.message }, context, undefined, this.stats);
        });
    } else {
      super.load(context, config, callbacks);
    }
  }
}

const FragmentLoader = Hls.DefaultConfig.loader as unknown as {
  new (config: HlsConfig): Loader<FragmentLoaderContext>;
};

export class CustomFragmentLoader extends FragmentLoader {
  /**
   * The stagger waiting to hand this fragment to the transport, if one is.
   *
   * ⛔ Held so {@link abort} and {@link destroy} can cancel it. hls.js abandons in-flight fragments
   * routinely, on a level switch, a seek and every teardown, and a stagger that fired anyway would
   * start a transfer for a fragment nobody is waiting for any more, against the loader hls.js has
   * already finished with. That is a request the gateway pays for and nothing consumes.
   */
  private pendingStagger: StaggeredTask | null = null;

  /**
   * Set once hls.js has abandoned this fragment, so a retrieval still in flight answers nobody.
   *
   * ⛔ Only the weeb-3 path needs this. The gateway path hands the transfer to hls.js's own loader,
   * which owns its cancellation, but `retrieveBytes` takes no abort signal and cannot be called off.
   * The most that can be done is to drop the answer, and dropping it is required: hls.js treats a
   * success on a fragment it has finished with as belonging to whatever it is loading now.
   */
  private abandoned = false;

  constructor(config: HlsConfig) {
    super(config);
  }

  load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    const url = context.url;
    this.abandoned = false;

    // Every playlist this client hands hls.js names its segments absolutely, so anything else here is
    // a bug upstream rather than a URL to repair, and it is not repairable anyway. A preview playlist
    // is a blob, and hls.js resolving `/bytes/<ref>` against `blob:http://viewer/<uuid>` returns
    // `blob:http:/bytes/<ref>`: the origin and the blob id are gone, so there is no gateway left to
    // resolve against.
    //
    // This used to rebuild the path against `window.location.origin`, which is the client. Its nginx
    // proxies `/bee/` and not `/bytes/`, so the fragment 404'd at a host that never had it and
    // nothing said the fallback was the reason. Failing here costs the same fragment and says why.
    //
    // Not optional-chained, unlike the manifest loader above. hls.js declares `onError` required, and
    // this is the one path that returns without reaching the transport: chaining it would turn a
    // missing callback into a fragment that never succeeds and never fails, which is the silent hang
    // this change exists to remove. A thrown TypeError is the louder answer and the correct one.
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      callbacks.onError(
        { code: 0, text: `fragment url is not absolute, so it names no gateway: ${url}` },
        context,
        undefined,
        this.stats,
      );
      return;
    }

    // Held back by a bounded random delay, because at the live edge every viewer of one broadcast is
    // chasing the same newest segment and asks for it as soon as their playlist reload lands. The
    // gateway is limited by how many ask in the same instant rather than by how many ask at all, so
    // this is the request most worth taking off the shared tick. A zero bound calls the transport
    // synchronously, exactly as it did before this existed.
    this.pendingStagger = requestJitter.stagger(() => {
      this.pendingStagger = null;

      // ⭐ Inside the stagger rather than in front of it, so the two backends are reached through
      // exactly the same path and differ in one thing: where the bytes come from. The stagger is
      // currently a synchronous no-op (`GATEWAY_REQUEST_JITTER_MS` is 0), so this costs nothing
      // today, and it keeps the arms comparable for an operator who turns it back on.
      //
      // ⛔ Read here rather than held from the constructor, so a switch mid-broadcast takes effect on
      // the next fragment. hls.js builds a loader per fragment, so a constructor read would look like
      // it worked and lag by one, and a loader already in flight would finish on the old backend
      // while the harness had moved on. That is the shape of an arm that measures the wrong thing.
      if (activeFetchBackend() === FETCH_BACKEND_WEEB3) {
        this.retrieveThroughWeeb3(context, callbacks);
        return;
      }

      super.load(context, config, {
        ...callbacks,
        // A segment that arrived is proof the gateway is answering, and the manifest side is the only
        // half that ever holds off on the belief that it is not. Its backoff doubles from the failure
        // that set it, so an outage of twenty seconds went unnoticed for thirty: the gateway was back
        // for ten of them and the one thing still talking to it was this. Reported here because the
        // player fetches segments anyway on hls.js's own retry cadence, so the signal is free.
        onSuccess: (response, stats, ctx, networkDetails) => {
          manifestFetcher.feedHealth.recordGatewayReachable();
          callbacks.onSuccess(response, stats, ctx, networkDetails);
        },
      });
    });
  }

  abort(): void {
    this.abandon();
    super.abort();
  }

  destroy(): void {
    this.abandon();
    super.destroy();
  }

  private abandon(): void {
    this.abandoned = true;
    this.pendingStagger?.cancel();
    this.pendingStagger = null;
  }

  /**
   * Fetch this segment from the Swarm node in this tab instead of from a gateway.
   *
   * ⛔⛔⛔ **The gateway's health is deliberately not reported here**, which is the one place the two
   * backends must not be symmetrical. A segment that arrived proves the gateway is answering only when
   * the gateway is what served it. These bytes came from a node in this tab, so calling
   * `recordGatewayReachable` would end the manifest side's backoff on evidence about something else,
   * and a viewer whose gateway had genuinely gone would keep asking it at full rate while believing it
   * was live. The feed and the manifest still travel through the gateway on this path.
   *
   * ⚠️ The stats below are the only timing a weeb-3 segment has. There is no network request for the
   * browser's request log or a performance entry to describe, so a harness comparing the two backends
   * reads this, and it has to be filled in rather than left at its zeroes.
   */
  private retrieveThroughWeeb3(context: FragmentLoaderContext, callbacks: LoaderCallbacks<LoaderContext>): void {
    const ref = segmentRefFromUrl(context.url);
    if (!ref) {
      callbacks.onError(
        { code: 0, text: `fragment url carries no Swarm reference: ${context.url}` },
        context,
        undefined,
        this.stats,
      );
      return;
    }

    const stats = this.stats;
    stats.loading.start = performance.now();

    weeb3FetchBackend.retrieveBytes(ref).then(
      (bytes) => {
        if (this.abandoned) {
          return;
        }
        stats.loading.first = performance.now();
        stats.loading.end = stats.loading.first;
        stats.loaded = bytes.byteLength;
        stats.total = bytes.byteLength;
        callbacks.onSuccess({ url: context.url, data: asArrayBuffer(bytes), code: 200 }, stats, context, undefined);
      },
      (error: unknown) => {
        if (this.abandoned) {
          return;
        }
        callbacks.onError(
          { code: 0, text: `weeb-3 could not retrieve ${ref}: ${errorText(error)}` },
          context,
          undefined,
          stats,
        );
      },
    );
  }
}

/**
 * hls.js demuxes an `ArrayBuffer`, and wasm hands back a view.
 *
 * Copied only when the view is a window onto something larger, because handing over the whole backing
 * buffer would give hls.js bytes either side of the segment.
 */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer as ArrayBuffer;
  if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return buffer;
  }
  return buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
