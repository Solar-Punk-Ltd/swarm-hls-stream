import { CLIENT_LOG_UNKNOWN, fragmentRequestedPattern, fragmentSettledPattern } from '@swarm-hls-stream/shared';
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
   * Fix the clock to a fixed run of readings, since the honest answer is a ratio of a byte count to a
   * duration and a real clock leaves the test asserting only that a number is plausible.
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
    // Three reads, in order: the settle instrument stamping the attempt, `loading.start` as the
    // retrieval begins, and `loading.end` as it answers. The settle's own read past those is clamped.
    stubClock([START_MS, START_MS, START_MS + tookMs]);
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
 * The one place a viewer's own choice of LEVEL is observable, which nothing else in this project can
 * see.
 *
 * ⛔ An instrument. It records and refuses nothing, and no branch of the loader reads it. What it
 * exists for is a reading V2 could not take: a player riding a rung its link cannot carry and a player
 * asking for a cheaper rung that something upstream answers with the expensive one look identical in
 * the overlay, in the decoded resolution and in `nextAutoLevel`. They differ here.
 */
describe('CustomFragmentLoader announcing which level hls.js asked for', () => {
  const RUNG = 'swarm://0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09/9c4e1f60b8a2d357e0f1a2b3c4d5e6f7';

  /** As much of an hls.js `Fragment` as this line reads: its level, its number and its playlist. */
  const fragmentOf = (level: number, sn: number | string, baseurl = RUNG) =>
    ({ level, sn, baseurl } as FragmentLoaderContext['frag']);

  let announced: string[];

  /** Drive one fragment through the loader and hand back every fragment request line it wrote. */
  function requestsWrittenFor(context: Partial<FragmentLoaderContext>): (readonly string[])[] {
    vi.spyOn(transport, 'load').mockImplementation(() => {});

    const loader = new CustomFragmentLoader({} as HlsConfig);
    loader.load(
      { url: FRAGMENT_URL, ...context } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      {
        onSuccess: vi.fn(),
        onError: vi.fn(),
        onTimeout: vi.fn(),
      } as unknown as LoaderCallbacks<LoaderContext>,
    );

    return announced
      .map((line) => fragmentRequestedPattern().exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match.slice(1, 4));
  }

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
    announced = [];
    vi.spyOn(console, 'debug').mockImplementation((line: unknown) => {
      announced.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    manifestFetcher.feedHealth.clear();
  });

  it('writes one line per fragment, carrying the level, the number and the rung playlist', () => {
    assert.deepEqual(requestsWrittenFor({ frag: fragmentOf(3, 412) }), [['3', '412', RUNG]]);
  });

  /**
   * ⛔ Above the byte-source split, so the two arms of the matrix record identically. A line written
   * inside one branch would make the other read as a viewer that asked for nothing.
   */
  it('writes it on the in-tab path as well as the gateway one', async () => {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', FETCH_BACKEND_WEEB3);
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockResolvedValue(new Uint8Array([1]));

    assert.deepEqual(requestsWrittenFor({ url: WEEB3_FRAGMENT_URL, frag: fragmentOf(0, 7) }), [['0', '7', RUNG]]);
  });

  /**
   * ⛔ Above the url check too. hls.js asked for this fragment, and a refusal that went unrecorded
   * would leave the phase count short at exactly the moment worth reading.
   */
  it('writes it for a url the loader is about to refuse', () => {
    assert.deepEqual(requestsWrittenFor({ url: 'blob:http:/bytes/abc123', frag: fragmentOf(2, 9) }), [
      ['2', '9', RUNG],
    ]);
  });

  it('carries an initialisation segment, whose number hls.js writes as a word', () => {
    assert.deepEqual(requestsWrittenFor({ frag: fragmentOf(1, 'initSegment') }), [['1', 'initSegment', RUNG]]);
  });

  /**
   * A logging line must never cost a fragment. `frag` is required by hls.js's own types and is absent
   * from every other case in this file, which is a shape a future hls.js could arrive in as well.
   */
  it('says so rather than throwing when the fragment carries nothing to read', () => {
    assert.deepEqual(requestsWrittenFor({}), [[CLIENT_LOG_UNKNOWN, CLIENT_LOG_UNKNOWN, CLIENT_LOG_UNKNOWN]]);
  });

  /**
   * ⛔ The rung is guarded on its own. `baseurl` is a getter over a field hls.js sets, so it is the one
   * part of the line that can throw, and losing the level index with it would silence the reading.
   */
  it('keeps the level when the rung playlist cannot be read', () => {
    const frag = {
      level: 3,
      sn: 5,
      get baseurl(): string {
        throw new Error('no base');
      },
    } as FragmentLoaderContext['frag'];

    assert.deepEqual(requestsWrittenFor({ frag }), [['3', '5', CLIENT_LOG_UNKNOWN]]);
  });

  // The line is an observation, so it must not be able to stop a fragment however badly it goes.
  it('still fetches the fragment when the console itself throws', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {
      throw new Error('the console is gone');
    });
    const reachedTransport = vi.spyOn(transport, 'load').mockImplementation(() => {});

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

    assert.equal(reachedTransport.mock.calls.length, 1, 'a logging failure cost the viewer their fragment');
  });
});

/**
 * The other half of that instrument: what became of each attempt, and how long it took.
 *
 * ⛔ Also an instrument, and nothing below the loader reads it. What it exists for is a reading the
 * request line cannot give. Six requests at one level is six fragments if they arrived and ONE fragment
 * asked for six times if they did not, and those are opposite findings: the first is a player stepping
 * down and being served, the second is a player stepping down and getting nothing. A squeeze arm on
 * 2026-09-01 produced exactly that shape with no way to tell which.
 *
 * ⭐ Both byte sources are driven here, because an ending recorded on one and not the other would make
 * the arms unreadable against each other, which is the whole basis of this project's viewer matrix.
 */
describe('CustomFragmentLoader announcing how each attempt ended', () => {
  const RUNG = 'swarm://0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09/9c4e1f60b8a2d357e0f1a2b3c4d5e6f7';

  const fragmentOf = (level: number, sn: number | string) =>
    ({ level, sn, baseurl: RUNG } as FragmentLoaderContext['frag']);

  let announced: string[];

  /** Every settle line written so far, as level, segment number, outcome and elapsed. */
  const settles = (): string[][] =>
    announced
      .map((line) => fragmentSettledPattern().exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match.slice(1, 5));

  /**
   * Drive one fragment through the loader, and hand back the loader plus both sets of callbacks: the
   * ones hls.js gave it, and the ones it gave the transport. The second is how a test answers as the
   * network would, including with the endings hls.js's own loader would produce.
   *
   * `destroysOnError` replays what hls.js does inside its own `onError`: `FragmentLoader.resetLoader`
   * (1.6.15) destroys the loader there and then, re-entrantly, while `load` is still on the stack. Only
   * the cases about that re-entrancy ask for it, so the rest stay about one thing each.
   */
  function drive(context: Partial<FragmentLoaderContext> = {}, { destroysOnError = false } = {}) {
    let handed: LoaderCallbacks<LoaderContext> | null = null;
    vi.spyOn(transport, 'load').mockImplementation((_context, _config, callbacks) => {
      handed = callbacks;
    });
    vi.spyOn(transport, 'abort').mockImplementation(() => {});
    vi.spyOn(transport, 'destroy').mockImplementation(() => {});

    const loader = new CustomFragmentLoader({} as HlsConfig);
    const fromHls = {
      onSuccess: vi.fn(),
      onError: vi.fn(() => {
        if (destroysOnError) {
          loader.destroy();
        }
      }),
      onTimeout: vi.fn(),
    } as unknown as LoaderCallbacks<LoaderContext>;

    loader.load(
      { url: FRAGMENT_URL, frag: fragmentOf(3, 412), ...context } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      fromHls,
    );

    const calls = (fn: unknown) => (fn as { mock: { calls: unknown[][] } }).mock.calls;
    return {
      loader,
      fromHls,
      transport: handed as LoaderCallbacks<LoaderContext> | null,
      successes: () => calls(fromHls.onSuccess),
      errors: () => calls(fromHls.onError),
    };
  }

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
    announced = [];
    vi.spyOn(console, 'debug').mockImplementation((line: unknown) => {
      announced.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    manifestFetcher.feedHealth.clear();
  });

  it('says a gateway segment loaded, naming the level and the segment number', () => {
    const { transport: toTransport } = drive();

    toTransport?.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);

    assert.deepEqual(
      settles().map((settle) => settle.slice(0, 3)),
      [['3', '412', 'loaded']],
    );
  });

  it('says a gateway segment errored', () => {
    const { transport: toTransport } = drive();

    toTransport?.onError({ code: 0, text: 'gateway unreachable' }, {} as LoaderContext, undefined, {} as never);

    assert.deepEqual(settles()[0].slice(0, 3), ['3', '412', 'errored']);
  });

  /** ⛔ Its own word, not folded into `errored`. A gateway that answers slowly and one that refuses are
   * different faults, and this is the only path with a clock to tell them apart. */
  it('says a gateway segment timed out, rather than calling it an error', () => {
    const { transport: toTransport } = drive();

    toTransport?.onTimeout({} as never, {} as LoaderContext, undefined);

    assert.deepEqual(settles()[0].slice(0, 3), ['3', '412', 'timeout']);
  });

  /**
   * hls.js abandons fragments as a matter of course, on a level switch, a seek and every teardown. An
   * abandoned attempt that went unrecorded would leave the level's request count with no ending, which
   * reads as a fragment still in flight at the end of the run.
   */
  it('says a gateway segment was aborted', () => {
    const { transport: toTransport } = drive();

    toTransport?.onAbort?.({} as never, {} as LoaderContext, undefined);

    assert.deepEqual(settles()[0].slice(0, 3), ['3', '412', 'aborted']);
  });

  /** hls.js declares `onAbort` optional and this loader supplies one regardless, so a caller that had
   * none must not be handed anything. */
  it('reports an abort without inventing a callback hls.js never gave it', () => {
    const { transport: toTransport, fromHls } = drive();

    assert.doesNotThrow(() => toTransport?.onAbort?.({} as never, {} as LoaderContext, undefined));
    assert.equal(fromHls.onAbort, undefined, 'the loader handed hls.js a callback it never asked for');
  });

  /**
   * ⛔⛔ One attempt, one ending. hls.js destroys a loader it has already finished with, and a second
   * line naming the same level and segment number would be counted twice by anything pairing the two
   * halves of this instrument.
   */
  it('writes one settle per attempt, however many times hls.js tears the loader down', () => {
    const { loader, transport: toTransport } = drive();

    toTransport?.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);
    loader.abort();
    loader.destroy();
    toTransport?.onError({ code: 0, text: 'late' }, {} as LoaderContext, undefined, {} as never);

    assert.equal(settles().length, 1, 'one attempt produced more than one ending');
  });

  /** ⛔ The request line is written above the url check, so the refusal has to be settled too or that
   * request would be the one with no ending. */
  it('settles a url it refuses, since it announced the request for it', () => {
    drive({ url: 'blob:http:/bytes/abc123', frag: fragmentOf(2, 9) });

    assert.deepEqual(settles()[0].slice(0, 3), ['2', '9', 'errored']);
  });

  /**
   * ⛔⛔ The ORDER at that refusal, which is load-bearing and was not pinned by anything until this.
   * hls.js destroys the loader from inside the `onError` it is handed, re-entrantly, before `load` has
   * returned. The settle is written first, so the refusal reads as the error it is and the teardown that
   * follows finds nothing left to record. Move it after the callback and this same attempt lands in the
   * artifact as `aborted`, with no error anywhere and no test to say so.
   */
  it('reports the refusal as an error even though hls.js tears the loader down inside the callback', () => {
    const { fromHls } = drive({ url: 'blob:http:/bytes/abc123', frag: fragmentOf(2, 9) }, { destroysOnError: true });

    assert.equal((fromHls.onError as unknown as { mock: { calls: unknown[][] } }).mock.calls.length, 1);
    assert.equal(settles().length, 1, 'the re-entrant teardown wrote an ending of its own');
    assert.deepEqual(settles()[0].slice(0, 3), ['2', '9', 'errored']);
  });

  /**
   * ⭐ `performance.now`, not `Date.now`. An elapsed is a difference within one clock, so it gains
   * nothing from wall time and loses the one property that matters: a monotonic clock cannot be stepped
   * by NTP mid-broadcast into a duration that never happened. Fixed to two readings here, since a real
   * clock would leave this asserting only that a number is plausible, and clamped at the last one so an
   * extra call from anything else in the path cannot read as an unrelated failure.
   */
  it('reports the elapsed as the monotonic time the attempt actually took', () => {
    const readings = [1_000, 1_350];
    let next = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => readings[Math.min(next++, readings.length - 1)]);

    const { transport: toTransport } = drive();
    toTransport?.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);

    assert.equal(settles()[0][3], '350');
  });

  /**
   * Whole milliseconds, which the wall-clock reading gave for free and a sub-millisecond one does not.
   * Unrounded, this line would carry `350.79999999999995` and every reader of it would be parsing that.
   */
  it('rounds the elapsed rather than writing the clock’s fractions into the line', () => {
    const readings = [1_000, 1_350.8];
    let next = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => readings[Math.min(next++, readings.length - 1)]);

    const { transport: toTransport } = drive();
    toTransport?.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);

    assert.equal(settles()[0][3], '351');
  });

  // A settle is an observation, so it must not be able to stop a fragment however badly it goes.
  it('still serves the fragment when the console throws on the settle', () => {
    const { transport: toTransport, successes } = drive();
    vi.spyOn(console, 'debug').mockImplementation(() => {
      throw new Error('the console is gone');
    });

    assert.doesNotThrow(() => toTransport?.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined));
    assert.equal(successes().length, 1, 'a logging failure cost the viewer their fragment');
  });
});

/**
 * The same accounting on the in-tab path, which reaches none of the transport's callbacks.
 *
 * ⛔ `retrieveBytes` takes no abort signal, so an abandoned fragment cannot be called off and its answer
 * is dropped instead. That drop is an ENDING and it costs the node real work, so an arm that recorded
 * nothing there would report abandoned retrievals as free.
 */
describe('CustomFragmentLoader announcing how an in-tab attempt ended', () => {
  const RUNG = 'swarm://0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09/9c4e1f60b8a2d357e0f1a2b3c4d5e6f7';

  let announced: string[];

  const settles = (): string[][] =>
    announced
      .map((line) => fragmentSettledPattern().exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match.slice(1, 5));

  /**
   * Drive one fragment through a loader built while the in-tab backend was selected.
   *
   * `destroysOnError` replays hls.js destroying the loader from inside its own `onError`, re-entrantly,
   * which is what `FragmentLoader.resetLoader` (1.6.15) does.
   */
  function driveThroughWeeb3(url = WEEB3_FRAGMENT_URL, { destroysOnError = false } = {}) {
    vi.stubEnv('VITE_BROWSER_FETCH_BACKEND', FETCH_BACKEND_WEEB3);
    vi.spyOn(transport, 'load').mockImplementation(() => {});
    vi.spyOn(transport, 'abort').mockImplementation(() => {});
    vi.spyOn(transport, 'destroy').mockImplementation(() => {});

    const loader = new CustomFragmentLoader({} as HlsConfig);
    const fromHls = {
      onSuccess: vi.fn(),
      onError: vi.fn(() => {
        if (destroysOnError) {
          loader.destroy();
        }
      }),
      onTimeout: vi.fn(),
    } as unknown as LoaderCallbacks<LoaderContext>;

    loader.load(
      { url, frag: { level: 0, sn: 7, baseurl: RUNG } as FragmentLoaderContext['frag'] } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      fromHls,
    );

    const calls = (fn: unknown) => (fn as { mock: { calls: unknown[][] } }).mock.calls;
    return { loader, successes: () => calls(fromHls.onSuccess), errors: () => calls(fromHls.onError) };
  }

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
    announced = [];
    vi.spyOn(console, 'debug').mockImplementation((line: unknown) => {
      announced.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    manifestFetcher.feedHealth.clear();
  });

  it('says the node served the segment', async () => {
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { successes } = driveThroughWeeb3();
    await vi.waitFor(() => assert.equal(successes().length, 1));

    assert.deepEqual(settles()[0].slice(0, 3), ['0', '7', 'loaded']);
  });

  it('says the node could not serve it', async () => {
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockRejectedValue(new Error('no peer had the chunk'));

    const { errors } = driveThroughWeeb3();
    await vi.waitFor(() => assert.equal(errors().length, 1));

    assert.deepEqual(settles()[0].slice(0, 3), ['0', '7', 'errored']);
  });

  /**
   * ⭐ Settled where the retrieval finished rather than where hls.js walked away, because that is when
   * the node stopped working. An ending stamped at the abort would report the retrieval as instant.
   */
  it('says an abandoned retrieval was aborted, when it finally answers', async () => {
    let deliver = (_bytes: Uint8Array) => {};
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        deliver = resolve;
      }),
    );

    const { loader, successes, errors } = driveThroughWeeb3();
    loader.abort();
    assert.equal(settles().length, 0, 'the ending was stamped at the abort rather than at the answer');
    deliver(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => assert.equal(settles().length, 1));

    assert.deepEqual(settles()[0].slice(0, 3), ['0', '7', 'aborted']);
    assert.equal(successes().length, 0, 'an abandoned fragment was still handed to hls.js');
    assert.equal(errors().length, 0);
  });

  it('says an abandoned retrieval that failed was aborted, not errored', async () => {
    let refuse = (_error: Error) => {};
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes').mockReturnValue(
      new Promise<Uint8Array>((_resolve, reject) => {
        refuse = reject;
      }),
    );

    const { loader, errors } = driveThroughWeeb3();
    loader.abort();
    refuse(new Error('no peer had the chunk'));
    await vi.waitFor(() => assert.equal(settles().length, 1));

    assert.deepEqual(settles()[0].slice(0, 3), ['0', '7', 'aborted']);
    assert.equal(errors().length, 0, 'an abandoned fragment reported its failure to hls.js anyway');
  });

  it('settles a url carrying no reference, since it announced the request for it', () => {
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes');

    driveThroughWeeb3('http://127.0.0.1:1633/bytes/not-a-reference');

    assert.deepEqual(settles()[0].slice(0, 3), ['0', '7', 'errored']);
  });

  /**
   * ⛔⛔ The same load-bearing order as the gateway refusal's, on the other byte source. hls.js destroys
   * this loader from inside the `onError` it was handed, before `load` has returned, so a settle written
   * after that call would be dropped as the duplicate and the attempt would reach the artifact as
   * `aborted` rather than as the refusal it was.
   */
  it('reports the refusal as an error even though hls.js tears the loader down inside the callback', () => {
    vi.spyOn(weeb3FetchBackend, 'retrieveBytes');

    const { errors } = driveThroughWeeb3('http://127.0.0.1:1633/bytes/not-a-reference', { destroysOnError: true });

    assert.equal(errors().length, 1);
    assert.equal(settles().length, 1, 'the re-entrant teardown wrote an ending of its own');
    assert.deepEqual(settles()[0].slice(0, 3), ['0', '7', 'errored']);
  });
});

/**
 * The one attempt no callback owns: a fragment hls.js abandons while the stagger still holds it.
 *
 * No transport was ever reached, so nothing downstream will ever end it. Left unrecorded it would be the
 * only request line in a run with no ending, which reads as a fragment still in flight when the arm
 * closed.
 */
describe('CustomFragmentLoader settling a fragment abandoned before it was sent', () => {
  let staggered: (() => void)[] = [];
  let announced: string[];

  const settles = (): string[][] =>
    announced
      .map((line) => fragmentSettledPattern().exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match.slice(1, 5));

  function heldBack() {
    vi.spyOn(transport, 'load').mockImplementation(() => {});
    vi.spyOn(transport, 'abort').mockImplementation(() => {});
    vi.spyOn(transport, 'destroy').mockImplementation(() => {});

    const loader = new CustomFragmentLoader({} as HlsConfig);
    loader.load(
      {
        url: FRAGMENT_URL,
        frag: { level: 1, sn: 88, baseurl: 'swarm://0xowner/topic' } as FragmentLoaderContext['frag'],
      } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() } as unknown as LoaderCallbacks<LoaderContext>,
    );
    return loader;
  }

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    staggered = [];
    announced = [];
    vi.spyOn(requestJitter, 'stagger').mockImplementation((task) => {
      staggered.push(task);
      return { cancel: () => {} };
    });
    vi.spyOn(console, 'debug').mockImplementation((line: unknown) => {
      announced.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manifestFetcher.feedHealth.clear();
  });

  it('says it was aborted when hls.js abandons it inside the stagger', () => {
    const loader = heldBack();

    loader.abort();

    assert.deepEqual(settles()[0].slice(0, 3), ['1', '88', 'aborted']);
  });

  it('says the same when hls.js destroys it inside the stagger', () => {
    const loader = heldBack();

    loader.destroy();

    assert.deepEqual(settles()[0].slice(0, 3), ['1', '88', 'aborted']);
  });

  /**
   * ⛔⛔ The counterpart, INVERTED on 2026-09-02, and the inversion is the fix. This used to leave a
   * fragment already handed to the gateway for the transport to end, on the belief that hls.js's own
   * loader always produces an ending. It does not: `XhrLoader.destroy` (1.6.15) nulls its callbacks and
   * only then aborts itself, so a teardown with no `abort()` in front of it reached the wrapped `onAbort`
   * never and that attempt settled nowhere at all. The loader stamps its own ending now, and the wrapped
   * callback is the duplicate `recordSettle` drops.
   */
  it('settles a fragment already handed over, rather than trusting the transport to call back', () => {
    const loader = heldBack();
    staggered[0]();

    loader.abort();

    assert.equal(settles().length, 1, 'an abandoned attempt was left for a callback that may never come');
    assert.deepEqual(settles()[0].slice(0, 3), ['1', '88', 'aborted']);
  });
});

/**
 * Every attempt gets exactly one ending, against the two teardowns that used to lose one.
 *
 * ⛔⛔⛔ hls.js's own loader is NOT a reliable owner of an ending, which is what this loader used to
 * rest on. Read out of `XhrLoader` in hls.js 1.6.15: `abort()` aborts and then calls `onAbort` through
 * the callbacks it is holding, but `destroy()` nulls those callbacks FIRST and only then aborts itself,
 * so a teardown with no `abort()` in front of it calls nothing back at all. Both teardowns are real
 * paths: `FragmentLoader.resetLoader` ends every attempt with a bare `destroy()`, and only
 * `FragmentLoader.abort()` goes through `abort()`. A gateway attempt torn down the first way announced a
 * request and then never announced an ending, which reads in an artifact as a fragment still in flight
 * when the arm closed.
 *
 * The base's behaviour is REPLAYED below rather than described, so an hls.js upgrade that changed either
 * teardown would have to change these too.
 */
describe('CustomFragmentLoader keeping one ending per attempt', () => {
  const RUNG = 'swarm://0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09/9c4e1f60b8a2d357e0f1a2b3c4d5e6f7';

  const fragmentOf = (level: number, sn: number) => ({ level, sn, baseurl: RUNG } as FragmentLoaderContext['frag']);

  let announced: string[];

  const settles = (): string[][] =>
    announced
      .map((line) => fragmentSettledPattern().exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match.slice(1, 5));

  const requests = (): string[][] =>
    announced
      .map((line) => fragmentRequestedPattern().exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match.slice(1, 3));

  /** hls.js's own loader as 1.6.15 really behaves, in the three methods this one goes through. */
  function baseLoader() {
    const base = { callbacks: null as LoaderCallbacks<LoaderContext> | null, abortsCalledBack: 0 };

    vi.spyOn(transport, 'load').mockImplementation((_context, _config, callbacks) => {
      base.callbacks = callbacks;
    });
    // `XhrLoader.abort`: abort the transfer, then call back through whatever callbacks are still held.
    vi.spyOn(transport, 'abort').mockImplementation(() => {
      if (base.callbacks?.onAbort) {
        base.abortsCalledBack += 1;
        base.callbacks.onAbort({} as never, {} as LoaderContext, undefined);
      }
    });
    // `XhrLoader.destroy`: drop the callbacks, THEN abort internally. Nothing is ever called back.
    vi.spyOn(transport, 'destroy').mockImplementation(() => {
      base.callbacks = null;
    });

    return base;
  }

  function loadOne(frag: FragmentLoaderContext['frag'], loader = new CustomFragmentLoader({} as HlsConfig)) {
    loader.load(
      { url: FRAGMENT_URL, frag } as FragmentLoaderContext,
      {} as LoaderConfiguration,
      { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() } as unknown as LoaderCallbacks<LoaderContext>,
    );
    return loader;
  }

  beforeEach(() => {
    manifestFetcher.feedHealth.clear();
    runStaggerInline();
    announced = [];
    vi.spyOn(console, 'debug').mockImplementation((line: unknown) => {
      announced.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manifestFetcher.feedHealth.clear();
  });

  /** The defect itself: hls.js's ordinary teardown, on a fragment the gateway is still fetching. */
  it('settles a gateway attempt destroyed without an abort in front of it', () => {
    const base = baseLoader();
    const loader = loadOne(fragmentOf(3, 412));
    assert.ok(base.callbacks, 'the fragment never reached the transport, so there is nothing to tear down');

    loader.destroy();

    assert.equal(base.abortsCalledBack, 0, 'the base called back on destroy, which is not what 1.6.15 does');
    assert.equal(settles().length, 1, 'an in-flight attempt was destroyed and announced no ending');
    assert.deepEqual(settles()[0].slice(0, 3), ['3', '412', 'aborted']);
  });

  /**
   * The other direction, and the reason the wrapper stays. When the base DOES call back, its `onAbort`
   * arrives after this loader has already settled the attempt, and `recordSettle` drops it.
   */
  it('writes one ending, not two, when the transport does call back', () => {
    const base = baseLoader();
    const loader = loadOne(fragmentOf(3, 412));

    loader.abort();

    assert.equal(base.abortsCalledBack, 1, 'the base never called back, so nothing tested the duplicate');
    assert.equal(settles().length, 1, 'the loader and the transport each announced an ending');
    assert.deepEqual(settles()[0].slice(0, 3), ['3', '412', 'aborted']);
  });

  /**
   * ⛔ Unreachable in hls.js 1.6.15, and self-enforced anyway. Its loader throws `Loader can only be used
   * once` on a second `load` and its fragment loader builds one per fragment, so nothing here is a bug
   * report about hls.js. It is the invariant refusing to rest on somebody else's behaviour: without the
   * settle at the top of `load`, the first attempt would announce no ending at all and the second would
   * inherit its start, reporting a duration that includes however long the first one ran.
   */
  it('settles the attempt it is dropping when a second load lands on the same loader', () => {
    const base = baseLoader();
    const loader = loadOne(fragmentOf(3, 412));

    loadOne(fragmentOf(0, 7), loader);
    base.callbacks?.onSuccess(arrived(), {} as never, {} as LoaderContext, undefined);

    assert.deepEqual(requests(), [
      ['3', '412'],
      ['0', '7'],
    ]);
    assert.deepEqual(
      settles().map((settle) => settle.slice(0, 3)),
      [
        ['3', '412', 'aborted'],
        ['0', '7', 'loaded'],
      ],
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
