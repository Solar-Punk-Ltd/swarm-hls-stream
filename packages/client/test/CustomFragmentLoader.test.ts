import type { FragmentLoaderContext, HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  CustomFragmentLoader,
  manifestFetcher,
  requestJitter,
} from '../src/components/SwarmHlsPlayer/CustomManifestLoader';
import { FEED_STATE_LIVE, FEED_STATE_RECONNECTING } from '../src/components/SwarmHlsPlayer/feedState';
import {
  FETCH_BACKEND_GATEWAY,
  FETCH_BACKEND_WEEB3,
  selectFetchBackend,
} from '../src/components/SwarmHlsPlayer/fetchBackend';
import { weeb3FetchBackend } from '../src/components/SwarmHlsPlayer/Weeb3FetchBackend';

const TOPIC = 'a-topic-being-watched';
const FRAGMENT_URL = 'http://127.0.0.1:1633/bytes/0123456789abcdef';
const REF = '9c4e1f60b8a2d357e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7';
const WEEB3_FRAGMENT_URL = `http://127.0.0.1:1633/bytes/${REF}`;

/** hls.js's own loader, which `CustomFragmentLoader` extends and hands the transfer down to. */
const transport = Object.getPrototypeOf(CustomFragmentLoader.prototype) as {
  load: (context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) => void;
  abort: () => void;
  destroy: () => void;
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

/**
 * Take the stagger out of the way for the blocks that are about what the loader hands the transport
 * rather than about when it hands it over. Every one of them reads synchronously, and a real stagger
 * would make them all sleep. The stagger has its own block, which does not call this.
 */
function runStaggerInline(): void {
  vi.spyOn(requestJitter, 'stagger').mockImplementation((task) => {
    task();
    return { cancel: () => {} };
  });
}

const arrived = () => ({ url: FRAGMENT_URL, data: new ArrayBuffer(8), code: 200 });

describe('CustomFragmentLoader reporting the gateway it just reached', () => {
  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
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
});

/**
 * The other branch through `load`, for a url hls.js could not resolve to a gateway.
 *
 * `blob:http:/bytes/abc123` is not a hand-written example. It is what hls.js 1.6.15's own resolver
 * returns for the media line `/bytes/abc123` against the blob base a preview playlist is served
 * from, measured on 2026-08-07: the page origin and the blob id are both consumed, leaving a url
 * that names no host at all.
 *
 * This used to be rebuilt against `window.location.origin` and handed to the transport. That is the
 * client, whose nginx proxies `/bee/` and not `/bytes/`, so the fragment 404'd at a host that never
 * held it and no message connected the failure to the fallback. See task #90.
 */
describe('CustomFragmentLoader meeting a url that names no gateway', () => {
  const UNRESOLVABLE = 'blob:http:/bytes/abc123';

  /** Drive one url through the loader, and report both what the transport saw and what hls.js was told. */
  function offer(url: string) {
    const reachedTransport = vi.spyOn(transport, 'load').mockImplementation(() => {});
    const loader = new CustomFragmentLoader({} as HlsConfig);
    const fromHls = {
      onSuccess: vi.fn(),
      onError: vi.fn(),
      onTimeout: vi.fn(),
    } as unknown as LoaderCallbacks<LoaderContext>;

    loader.load({ url } as FragmentLoaderContext, {} as LoaderConfiguration, fromHls);

    const errors = (fromHls.onError as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return {
      transportCalls: reachedTransport.mock.calls.length,
      errors: errors.map((call) => call[0] as { code: number; text: string }),
    };
  }

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manifestFetcher.feedHealth.clear();
  });

  it('refuses it instead of fetching an origin that never held the segment', () => {
    const { transportCalls, errors } = offer(UNRESOLVABLE);

    assert.equal(transportCalls, 0, 'an unresolvable url was still sent to the network');
    assert.equal(errors.length, 1);
    assert.match(errors[0].text, /not absolute/);
  });

  // The url is the whole of what a reader has to go on, so it has to survive into the message.
  it('names the url it refused', () => {
    assert.match(offer(UNRESOLVABLE).errors[0].text, /blob:http:\/bytes\/abc123/);
  });

  // A refusal must not read as the gateway answering, which is the one thing this loader reports.
  it('leaves the feed backoff alone, since nothing was fetched from anywhere', () => {
    manifestFetcher.feedHealth.recordGatewayFailure(TOPIC);

    offer(UNRESOLVABLE);

    assert.ok(manifestFetcher.feedHealth.backoffRemainingMs(TOPIC) > 0);
    assert.equal(manifestFetcher.feedHealth.state(TOPIC), FEED_STATE_RECONNECTING);
  });

  // The control. Without it the block above passes on a loader that refuses everything.
  it('lets an absolute gateway url through to the transport', () => {
    const { transport: toTransport } = loadFragment();
    toTransport.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);

    assert.equal(manifestFetcher.feedHealth.state(TOPIC), FEED_STATE_LIVE);
  });
});

/**
 * ⛔ The block that does NOT call {@link runStaggerInline}, because the stagger is what it is about.
 *
 * hls.js abandons fragments as a matter of course: on a level switch, on a seek, and on every
 * teardown. Before the stagger existed the transport had already been handed the fragment by the
 * time any of that happened, and hls.js's own loader owned the cancellation. Holding the request
 * back opens a window where it has not, and a stagger that fired anyway would start a transfer for a
 * fragment nobody is waiting for, on a loader hls.js has finished with. The gateway pays for that
 * request and nothing consumes it, which is the shape of every leak this project has found.
 */
describe('CustomFragmentLoader holding a fragment back', () => {
  let staggered: (() => void)[] = [];
  let cancelled = 0;

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    staggered = [];
    cancelled = 0;
    vi.spyOn(requestJitter, 'stagger').mockImplementation((task) => {
      staggered.push(task);
      return {
        cancel: () => {
          cancelled++;
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manifestFetcher.feedHealth.clear();
  });

  /** Stubs the transport and the two teardown paths, none of which survive outside a browser. */
  function stubbedLoader() {
    const reachedTransport = vi.spyOn(transport, 'load').mockImplementation(() => {});
    vi.spyOn(transport, 'abort').mockImplementation(() => {});
    vi.spyOn(transport, 'destroy').mockImplementation(() => {});

    const loader = new CustomFragmentLoader({} as HlsConfig);
    loader.load(
      { url: FRAGMENT_URL } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      {
        onSuccess: vi.fn(),
        onError: vi.fn(),
        onTimeout: vi.fn(),
      } as unknown as LoaderCallbacks<LoaderContext>,
    );

    return { loader, reachedTransport };
  }

  it('does not reach the transport until the stagger is up', () => {
    const { reachedTransport } = stubbedLoader();

    assert.equal(reachedTransport.mock.calls.length, 0, 'the fragment went straight out, unstaggered');
    assert.equal(staggered.length, 1, 'the fragment was never staggered');

    staggered[0]();
    assert.equal(reachedTransport.mock.calls.length, 1);
  });

  it('cancels a fragment that hls.js aborted before the stagger was up', () => {
    const { loader, reachedTransport } = stubbedLoader();

    loader.abort();

    assert.equal(cancelled, 1, 'aborting left the stagger armed');
    assert.equal(reachedTransport.mock.calls.length, 0, 'an aborted fragment still reached the network');
  });

  it('cancels a fragment that hls.js destroyed before the stagger was up', () => {
    const { loader, reachedTransport } = stubbedLoader();

    loader.destroy();

    assert.equal(cancelled, 1, 'destroying left the stagger armed');
    assert.equal(reachedTransport.mock.calls.length, 0, 'a destroyed fragment still reached the network');
  });

  /**
   * The counterpart, and the reason cancelling is not just "always cancel". A loader that cancelled a
   * stagger it no longer owned would be reaching for a timer some later fragment had armed.
   */
  it('has nothing left to cancel once the fragment is away', () => {
    const { loader } = stubbedLoader();
    staggered[0]();

    loader.abort();

    assert.equal(cancelled, 0, 'a fragment already handed over was cancelled anyway');
  });

  // Without this the block above passes on a loader that refuses every url before staggering at all.
  it('never staggers a url it is going to refuse, since nothing would be fetched', () => {
    vi.spyOn(transport, 'load').mockImplementation(() => {});

    const loader = new CustomFragmentLoader({} as HlsConfig);
    loader.load(
      { url: '/bytes/0123456789abcdef' } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      {
        onSuccess: vi.fn(),
        onError: vi.fn(),
        onTimeout: vi.fn(),
      } as unknown as LoaderCallbacks<LoaderContext>,
    );

    assert.equal(staggered.length, 0, 'a url that names no gateway was queued for a stagger anyway');
  });
});

/**
 * The other byte source: a Swarm node inside the tab, selected at build time.
 *
 * ⚠️ These hold the wiring only. Whether weeb-3 boots and retrieves anything in a browser is phase
 * A2's question, run against a real Chrome on recorded content, and nothing that stubs the backend
 * can answer it.
 */
describe('CustomFragmentLoader fetching through weeb-3 instead of a gateway', () => {
  /** Drive one fragment through a loader built while the weeb-3 backend was selected. */
  function loadThroughWeeb3(url = WEEB3_FRAGMENT_URL) {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', FETCH_BACKEND_WEEB3);
    const reachedGateway = vi.spyOn(transport, 'load').mockImplementation(() => {});
    vi.spyOn(transport, 'abort').mockImplementation(() => {});

    const loader = new CustomFragmentLoader({} as HlsConfig);
    const fromHls = {
      onSuccess: vi.fn(),
      onError: vi.fn(),
      onTimeout: vi.fn(),
    } as unknown as LoaderCallbacks<LoaderContext>;

    loader.load({ url } as FragmentLoaderContext, {} as LoaderConfiguration, fromHls);

    const calls = (fn: unknown) => (fn as { mock: { calls: unknown[][] } }).mock.calls;
    return {
      loader,
      reachedGateway,
      successes: () => calls(fromHls.onSuccess),
      errors: () => calls(fromHls.onError).map((call) => call[0] as { code: number; text: string }),
    };
  }

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    manifestFetcher.feedHealth.clear();
  });

  it('asks the node for the reference and never touches the gateway', async () => {
    const retrieve = vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    const { reachedGateway, successes } = loadThroughWeeb3();
    await vi.waitFor(() => assert.equal(successes().length, 1));

    assert.deepEqual(
      retrieve.mock.calls.map((call) => call[0]),
      [REF],
    );
    assert.equal(reachedGateway.mock.calls.length, 0, 'a weeb-3 fragment was fetched from the gateway as well');
  });

  it('hands hls.js the bytes the node returned', async () => {
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockResolvedValue(new Uint8Array([9, 8, 7, 6]));

    const { successes } = loadThroughWeeb3();
    await vi.waitFor(() => assert.equal(successes().length, 1));

    const response = successes()[0][0] as { data: ArrayBuffer; code: number };
    assert.equal(response.code, 200);
    assert.deepEqual(new Uint8Array(response.data), new Uint8Array([9, 8, 7, 6]));
  });

  // Without timing here a weeb-3 arm has none at all: there is no request for the browser to log.
  it('records how long the retrieval took, since nothing else can', async () => {
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockResolvedValue(new Uint8Array(2048));

    const { successes } = loadThroughWeeb3();
    await vi.waitFor(() => assert.equal(successes().length, 1));

    const stats = successes()[0][1] as { loaded: number; total: number; loading: { start: number; end: number } };
    assert.equal(stats.loaded, 2048);
    assert.equal(stats.total, 2048);
    assert.ok(stats.loading.start > 0, 'the retrieval has no start time');
    assert.ok(stats.loading.end >= stats.loading.start, 'the retrieval ended before it began');
  });

  /**
   * ⛔⛔⛔ The one asymmetry that matters. These bytes came from a node in this tab, so they are no
   * evidence at all about the gateway. Reporting them as such would end the manifest backoff during a
   * real gateway outage, and the viewer would keep asking a dead host at full rate while the overlay
   * said live.
   */
  it('does not report the gateway as reachable, because the gateway served nothing', async () => {
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockResolvedValue(new Uint8Array([1]));
    manifestFetcher.feedHealth.recordGatewayFailure(TOPIC);

    const { successes } = loadThroughWeeb3();
    await vi.waitFor(() => assert.equal(successes().length, 1));

    assert.ok(
      manifestFetcher.feedHealth.backoffRemainingMs(TOPIC) > 0,
      'a segment from the tab’s own node was treated as proof the gateway is answering',
    );
    assert.equal(manifestFetcher.feedHealth.state(TOPIC), FEED_STATE_RECONNECTING);
  });

  // The control for the block above. Without it, that test passes on a loader that never reports at all.
  it('still reports the gateway as reachable when the gateway is what served it', () => {
    manifestFetcher.feedHealth.recordGatewayFailure(TOPIC);

    const { transport: toTransport } = loadFragment();
    toTransport.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);

    assert.equal(manifestFetcher.feedHealth.state(TOPIC), FEED_STATE_LIVE);
  });

  it('reports a failed retrieval to hls.js, naming the reference', async () => {
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockRejectedValue(new Error('no peer had the chunk'));

    const { errors } = loadThroughWeeb3();
    await vi.waitFor(() => assert.equal(errors().length, 1));

    assert.match(errors()[0].text, /no peer had the chunk/);
    assert.match(errors()[0].text, new RegExp(REF));
  });

  /**
   * `retrieveBytes` takes no abort signal, so an abandoned fragment cannot be called off and the
   * answer has to be dropped instead. hls.js reuses nothing here, but it does treat a success as
   * belonging to whatever the loader is loading now.
   */
  it('says nothing about a fragment hls.js already abandoned', async () => {
    let deliver = (_bytes: Uint8Array) => {};
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        deliver = resolve;
      }),
    );

    const { loader, successes, errors } = loadThroughWeeb3();
    loader.abort();
    deliver(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(successes().length, 0, 'an abandoned fragment was still handed to hls.js');
    assert.equal(errors().length, 0);
  });

  it('refuses a url carrying no reference without waking the node', () => {
    const retrieve = vi.spyOn(weeb3FetchBackend, 'retrieveBytes');

    const { errors } = loadThroughWeeb3('http://127.0.0.1:1633/bytes/not-a-reference');

    assert.equal(retrieve.mock.calls.length, 0, 'a malformed reference was sent into the wasm anyway');
    assert.equal(errors().length, 1);
    assert.match(errors()[0].text, /no Swarm reference/);
  });
});

/**
 * What hls.js's ABR actually reads out of those stats, replayed here rather than described.
 *
 * ⛔⛔⛔ **A weeb-3 fragment has no network request behind it, so the four numbers the loader writes
 * are the only evidence hls.js has about this viewer's connection.** It does not read them the
 * obvious way. It excludes time-to-first-byte from throughput on purpose, because waiting is not
 * bandwidth, and a loader that stamps the arrival as the first byte tells it the download itself took
 * no time at all.
 *
 * Both formulas below are transcribed from hls.js 1.6.15 `dist/hls.js`: `AbrController.onFragLoaded`
 * (`sampleTTFB(stats.loading.first - stats.loading.start)`, line 4319) and
 * `AbrController.onFragBuffered` (line 4371). They are modelled rather than driven because hls.js
 * stamps `parsing.end` itself, after demuxing, which nothing here can produce. An upgrade that moves
 * either formula should break these rather than quietly change what a viewer is told they can afford.
 */
describe('CustomFragmentLoader telling hls.js what the connection carried', () => {
  interface RetrievalStats {
    loaded: number;
    total: number;
    loading: { start: number; first: number; end: number };
  }

  /** How long hls.js spends demuxing a segment before it stamps `parsing.end`. Milliseconds. */
  const DEMUX_MS = 3;

  /**
   * `EwmaBandWidthEstimator.minDelayMs_`, the floor hls.js puts under every bandwidth sample.
   *
   * ⭐ It is what bounds the absurd reading rather than making it absurd. A demux measured in single
   * milliseconds would otherwise divide out to tens of gigabits, and this holds it at the 80 Mbps that
   * matches what the live arms actually reported.
   */
  const MIN_SAMPLE_MS = 50;

  /** The lowest value `sampleTTFB` will record, whatever it is handed. */
  const TTFB_SAMPLE_FLOOR_MS = 5;

  /** The ladder this project publishes, in kbps. See `ABR_LADDER`. */
  const RUNG_1080P_KBPS = 5000;
  const RUNG_720P_KBPS = 2800;

  /** `AbrController.onFragLoaded`: what hls.js folds into its running time-to-first-byte estimate. */
  function ttfbSampleMs(stats: RetrievalStats): number {
    return stats.loading.first - stats.loading.start;
  }

  /**
   * The time-to-first-byte hls.js settles on, after a run of fragments that all looked like this one.
   *
   * ⛔ **Not a number a case may choose.** The estimate is driven by the samples the loader itself
   * feeds, so passing one in lets a test assume the very thing it is meant to be checking, and the
   * first version of these did exactly that: handing in a zero made the broken loader pass. hls.js
   * smooths with an EWMA (`EwmaBandWidthEstimator.sampleTTFB`), and over a run of identical samples
   * any EWMA converges on the sample, which is what a viewer watching a broadcast is.
   */
  function settledTtfbEstimateMs(stats: RetrievalStats): number {
    return Math.max(ttfbSampleMs(stats), TTFB_SAMPLE_FLOOR_MS);
  }

  /** `AbrController.onFragBuffered`: the span hls.js divides the byte count by, as kbps. */
  function throughputKbps(stats: RetrievalStats, parsingEndMs: number): number {
    const discounted = Math.min(ttfbSampleMs(stats), settledTtfbEstimateMs(stats));
    const processingMs = parsingEndMs - stats.loading.start - discounted;
    return (stats.loaded * 8) / Math.max(processingMs, MIN_SAMPLE_MS);
  }

  /**
   * Fix the clock to two readings, since the honest answer is a ratio of a byte count to a duration
   * and a real clock leaves the test asserting only that a number is plausible.
   *
   * Clamped at the last reading rather than throwing past it, so an extra call from anything else in
   * the path cannot turn a wrong duration into a crash that reads as an unrelated failure.
   */
  function stubClock(readings: readonly number[]): void {
    let next = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => readings[Math.min(next++, readings.length - 1)]);
  }

  async function retrieve(bytes: number, tookMs: number): Promise<RetrievalStats> {
    const START_MS = 1_000;
    stubClock([START_MS, START_MS + tookMs]);
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockResolvedValue(new Uint8Array(bytes));
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', FETCH_BACKEND_WEEB3);
    vi.spyOn(transport, 'load').mockImplementation(() => {});

    const onSuccess = vi.fn();
    const loader = new CustomFragmentLoader({} as HlsConfig);
    loader.load(
      { url: WEEB3_FRAGMENT_URL } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      {
        onSuccess,
        onError: vi.fn(),
        onTimeout: vi.fn(),
      } as unknown as LoaderCallbacks<LoaderContext>,
    );

    await vi.waitFor(() => assert.equal(onSuccess.mock.calls.length, 1));
    return onSuccess.mock.calls[0][1] as RetrievalStats;
  }

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    manifestFetcher.feedHealth.clear();
  });

  it('claims no time to first byte, because a retrieval has no observable one', async () => {
    const stats = await retrieve(500_000, 500);

    assert.equal(ttfbSampleMs(stats), 0, 'hls.js was handed a wait to discount from a path that cannot measure one');
  });

  it('gives hls.js a throughput within a few percent of the retrieval it just did', async () => {
    const SEGMENT_BYTES = 500_000;
    const RETRIEVAL_MS = 500;
    const TRUE_KBPS = (SEGMENT_BYTES * 8) / RETRIEVAL_MS;

    const stats = await retrieve(SEGMENT_BYTES, RETRIEVAL_MS);
    const believed = throughputKbps(stats, stats.loading.end + DEMUX_MS);

    assert.ok(
      believed <= TRUE_KBPS,
      `hls.js was told ${believed.toFixed(0)} kbps for a retrieval that carried ${TRUE_KBPS.toFixed(0)}`,
    );
    assert.ok(
      believed > TRUE_KBPS * 0.95,
      `hls.js was told ${believed.toFixed(0)} kbps, which is under-stating ${TRUE_KBPS.toFixed(
        0,
      )} by more than the demux`,
    );
  });

  /**
   * ⭐⭐⭐ The live reading this fix exists for, reproduced from the shape the loader used to write.
   *
   * Without this the model above is unfalsifiable: it would agree with any loader. Stamping `first` at
   * arrival is what an in-tab viewer did on 2026-08-30, and hls.js answered 74 to 109 Mbps on a link
   * capped at 2800 kbps. See `docs/bench/abr-at-a-viewer-2026-08-30.md`.
   */
  it('reproduces the absurd estimate when the arrival is stamped as the first byte', () => {
    const SEGMENT_BYTES = 500_000;
    const RETRIEVAL_MS = 500;
    const arrivalStampedAsFirstByte: RetrievalStats = {
      loaded: SEGMENT_BYTES,
      total: SEGMENT_BYTES,
      loading: { start: 1_000, first: 1_000 + RETRIEVAL_MS, end: 1_000 + RETRIEVAL_MS },
    };

    const believed = throughputKbps(arrivalStampedAsFirstByte, arrivalStampedAsFirstByte.loading.end + DEMUX_MS);

    // The band the three in-tab arms reported: 74221, 97751 and 108794 kbps, plus 82900 and 107981
    // from the two arms that were squeezed. A model that lands outside it is not this defect.
    assert.ok(
      believed > 70_000 && believed < 120_000,
      `the old shape read as 74 to 109 Mbps live, and the model says ${believed.toFixed(0)} kbps`,
    );
  });

  /**
   * The product statement. A ladder is four times the publishing cost for one quality unless a viewer
   * whose link cannot carry the top rung is told so.
   */
  it('puts 1080p out of reach for a viewer whose link only carries 720p', async () => {
    const SEGMENT_S = 2;
    const CARRIED_KBPS = RUNG_720P_KBPS;
    const segmentBytes = (CARRIED_KBPS * 1_000 * SEGMENT_S) / 8;

    const stats = await retrieve(segmentBytes, SEGMENT_S * 1_000);
    const believed = throughputKbps(stats, stats.loading.end + DEMUX_MS);

    assert.ok(
      believed < RUNG_1080P_KBPS,
      `hls.js was told ${believed.toFixed(0)} kbps, so 1080p still looks affordable`,
    );
  });
});

/**
 * ⛔⛔ The switch has to bite on the NEXT fragment, not the next player.
 *
 * hls.js constructs a loader per fragment, so reading the backend at construction would look correct
 * and lag by one: a harness that switched between arms would score the first fragment of arm two on
 * arm one's backend. Over an arm of a few hundred fragments that is invisible in a summary and wrong
 * in exactly the direction that hides a difference.
 */
describe('CustomFragmentLoader honouring a backend switched at runtime', () => {
  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
  });

  afterEach(() => {
    selectFetchBackend(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    manifestFetcher.feedHealth.clear();
  });

  /** One fragment through a loader built BEFORE the switch was moved. */
  function loadAfterSwitchingTo(backend: 'gateway' | 'weeb3') {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', '');
    const reachedGateway = vi.spyOn(transport, 'load').mockImplementation(() => {});
    const retrieve = vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockResolvedValue(new Uint8Array([1]));

    const loader = new CustomFragmentLoader({} as HlsConfig);
    selectFetchBackend(backend);

    loader.load(
      { url: WEEB3_FRAGMENT_URL } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() } as unknown as LoaderCallbacks<LoaderContext>,
    );

    return { gatewayCalls: reachedGateway.mock.calls.length, weeb3Calls: retrieve.mock.calls.length };
  }

  it('sends the next fragment to weeb-3 when the switch moved after construction', () => {
    const { gatewayCalls, weeb3Calls } = loadAfterSwitchingTo(FETCH_BACKEND_WEEB3);

    assert.equal(weeb3Calls, 1, 'the switch did not reach the fragment that followed it');
    assert.equal(gatewayCalls, 0, 'the fragment went to the gateway despite the switch');
  });

  // The control. Without it the case above passes on a loader that always uses weeb-3.
  it('still sends it to the gateway when the switch says gateway', () => {
    const { gatewayCalls, weeb3Calls } = loadAfterSwitchingTo(FETCH_BACKEND_GATEWAY);

    assert.equal(gatewayCalls, 1);
    assert.equal(weeb3Calls, 0, 'a gateway fragment woke the in-tab node');
  });
});
