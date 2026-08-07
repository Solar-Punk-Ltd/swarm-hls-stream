import type { FragmentLoaderContext, HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { CustomFragmentLoader, manifestFetcher } from '../src/components/SwarmHlsPlayer/CustomManifestLoader';
import { FEED_STATE_LIVE, FEED_STATE_RECONNECTING } from '../src/components/SwarmHlsPlayer/feedState';

const TOPIC = 'a-topic-being-watched';
const FRAGMENT_URL = 'http://127.0.0.1:1633/bytes/0123456789abcdef';

/** hls.js's own loader, which `CustomFragmentLoader` extends and hands the transfer down to. */
const transport = Object.getPrototypeOf(CustomFragmentLoader.prototype) as {
  load: (context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) => void;
};

/**
 * Drive a fragment through the loader and hand back the callbacks it gave the transport, so a test
 * can answer as the network would. The transport itself is stubbed out: what is under test is the
 * wiring between a fragment arriving and the feed's health, not hls.js's XHR handling.
 */
function loadFragment(url = FRAGMENT_URL) {
  let handed: LoaderCallbacks<LoaderContext> | null = null;
  vi.spyOn(transport, 'load').mockImplementation((_context, _config, callbacks) => {
    handed = callbacks;
  });

  const loader = new CustomFragmentLoader({} as HlsConfig);
  const fromHls = {
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onTimeout: vi.fn(),
  } as unknown as LoaderCallbacks<LoaderContext>;

  loader.load({ url } as FragmentLoaderContext, {} as LoaderConfiguration, fromHls);

  assert.ok(handed, 'the loader never reached the transport');
  return { fromHls, transport: handed as LoaderCallbacks<LoaderContext> };
}

const arrived = () => ({ url: FRAGMENT_URL, data: new ArrayBuffer(8), code: 200 });

describe('CustomFragmentLoader reporting the gateway it just reached', () => {
  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manifestFetcher.feedHealth.clear();
  });

  /**
   * The whole of fix 0.8b. On 2026-08-06 a viewer's gateway was stopped for 20.5 seconds and the
   * feed was not asked for again until 30, because the manifest backoff doubles from the failure
   * that set it. Segments travel through the same gateway on hls.js's own retry cadence and started
   * arriving the moment it returned, so the client already knew and had nowhere to put it. Wiring
   * this costs no extra request: it reports something the player was fetching anyway.
   */
  it('ends a feed backoff when a segment arrives, without asking for anything extra', () => {
    manifestFetcher.feedHealth.recordGatewayFailure(TOPIC);
    assert.equal(manifestFetcher.feedHealth.state(TOPIC), FEED_STATE_RECONNECTING);

    const { transport: toTransport } = loadFragment();
    toTransport.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);

    assert.equal(manifestFetcher.feedHealth.backoffRemainingMs(TOPIC), 0);
    assert.equal(manifestFetcher.feedHealth.state(TOPIC), FEED_STATE_LIVE);
  });

  it('passes the segment on to hls.js untouched', () => {
    const { fromHls, transport: toTransport } = loadFragment();
    const response = arrived();
    const stats = { loaded: 8 } as never;
    const context = { url: FRAGMENT_URL } as LoaderContext;

    toTransport.onSuccess(response, stats, context, undefined);

    assert.deepEqual((fromHls.onSuccess as unknown as { mock: { calls: unknown[][] } }).mock.calls, [
      [response, stats, context, undefined],
    ]);
  });

  // A segment that failed is the outage still being on, and it must not shorten the wait.
  it('leaves the backoff alone when the segment does not arrive', () => {
    manifestFetcher.feedHealth.recordGatewayFailure(TOPIC);

    const { fromHls, transport: toTransport } = loadFragment();
    toTransport.onError?.({ code: 0, text: 'gateway unreachable' }, {} as LoaderContext, undefined, {} as never);

    assert.ok(
      manifestFetcher.feedHealth.backoffRemainingMs(TOPIC) > 0,
      'a segment that never arrived released the feed anyway',
    );
    assert.equal(manifestFetcher.feedHealth.state(TOPIC), FEED_STATE_RECONNECTING);
    assert.equal((fromHls.onError as unknown as { mock: { calls: unknown[][] } }).mock.calls.length, 1);
  });

  /**
   * The other branch through `load`, for a fragment hls.js resolved against the blob URL its
   * manifest was served from. It rewrites the url before delegating, so it has its own hand-off to
   * the transport and its own chance to drop the reporting.
   *
   * What that branch rewrites the url *to* is deliberately not asserted here: it is wrong, and
   * fixing it is not this change. See task #90.
   */
  it('reports the gateway on the blob-resolved path too', () => {
    vi.stubGlobal('window', { location: { origin: 'http://viewer.example' } });
    manifestFetcher.feedHealth.recordGatewayFailure(TOPIC);

    const { transport: toTransport } = loadFragment('blob:http://viewer.example/9f2c-1a/bytes/abc123');
    toTransport.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);

    assert.equal(manifestFetcher.feedHealth.state(TOPIC), FEED_STATE_LIVE);
  });
});
