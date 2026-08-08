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
    if (!['manifest', 'level'].includes(context.type)) {
      super.load(context, config, callbacks);
      return;
    }

    // `manifest` is the top-level request, and for a ladder it has to be answered with the
    // multivariant playlist; `level` is one rung, and is a feed like any other. A single-rendition
    // stream registers no ladder, so its `manifest` request falls through to the same feed read it
    // has always been.
    const source = context.type === 'manifest' ? manifestFetcher.masterFor(context.url) : null;
    const manifest = source !== null ? Promise.resolve(source) : manifestFetcher.fetch(context.url);

    manifest
      .then((data) => {
        callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, undefined);
      })
      .catch((error) => {
        callbacks.onError?.({ code: 0, text: error.message }, context, undefined, this.stats);
      });
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

    super.load(context, config, callbacks);
  }
}
