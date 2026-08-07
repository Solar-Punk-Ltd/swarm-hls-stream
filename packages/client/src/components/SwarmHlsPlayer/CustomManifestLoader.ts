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

    // If the URL is a blob: or broken protocol, it means HLS.js resolved a relative path
    // against a blob manifest URL. Reresolve it using the actual path.
    if (url.startsWith('blob:') || !url.startsWith('http')) {
      const path = url.replace(/^blob:.*?\//, '/').replace(/^[^/]*/, '');
      const resolved = path.startsWith('/') ? path : `/${path}`;

      context.url = `${window.location.origin}${resolved}`;
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
