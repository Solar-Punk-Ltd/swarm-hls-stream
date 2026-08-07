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

import { ManifestFetcher } from './ManifestManagement';

export const manifestFetcher = new ManifestFetcher();

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
  constructor(config: HlsConfig) {
    super(config);
  }

  load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    const url = context.url;

    // Every playlist this client hands hls.js names its segments absolutely, so anything else here is
    // a bug upstream rather than a URL to repair, and it is not repairable anyway. A preview playlist
    // is a blob, and hls.js resolving `/bytes/<ref>` against `blob:http://viewer/<uuid>` returns
    // `blob:http:/bytes/<ref>`: the origin and the blob id are gone, so there is no gateway left to
    // resolve against.
    //
    // This used to rebuild the path against `window.location.origin`, which is the client. Its nginx
    // proxies `/bee/` and not `/bytes/`, so the fragment 404'd at a host that never had it and
    // nothing said the fallback was the reason. Failing here costs the same fragment and says why.
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      callbacks.onError?.(
        { code: 0, text: `fragment url is not absolute, so it names no gateway: ${url}` },
        context,
        undefined,
        this.stats,
      );
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
  }
}
