import { Topic } from '@ethersphere/bee-js';
import { buildMasterPlaylist, type Rendition } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';

import {
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FeedHealthTracker,
} from '../src/components/SwarmHlsPlayer/feedState';
import { ManifestFetcher, ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { RequestJitter } from '../src/utils/requestJitter';

/**
 * The ladder entry points, which arrived with the ABR merge carrying no tests at all.
 *
 * `fetchSource` is the one hls.js calls from `loadSource`, so once a stream can be a ladder it is the
 * read every mount makes and every restart comes back through. That makes it the place a gateway
 * outage is met, which is why the guards asserted below belong to it and not only to
 * `handleInitialFetch` — the path it replaced on this route.
 */

const BEE_URL = 'http://bee.test';
const OWNER = '0x2222222222222222222222222222222222222222';
const SOURCE_TOPIC = 'ladder-source';
const NO_JITTER = new RequestJitter(0, () => 0);
/** Short enough that a rung's first read lands inside a test, long enough not to spin. */
const POLL_MS = 2;

const sourceTopic = Topic.fromString(SOURCE_TOPIC);
const hexSource = sourceTopic.toString();

function rung(name: string, width: number, height: number, bandwidth: number): Rendition {
  return { name, width, height, topic: `rung-${name}`, bandwidth, avgBandwidth: bandwidth };
}

const LADDER = [rung('360p', 640, 360, 700_000), rung('720p', 1280, 720, 2_800_000)];
const RUNG_TOPICS = LADDER.map((r) => Topic.fromString(r.topic).toString());

function mediaPlaylist(segment: string): string {
  return ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXTINF:2,', segment].join('\n');
}

/** A feed read carrying the index header the fetcher takes its next position from. */
function feedResponse(body: string, index = 3n): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Swarm-Feed-Index': index.toString(16).padStart(16, '0') },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function settle(ticks = 30): Promise<void> {
  for (let tick = 0; tick < ticks; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const manager = ManifestStateManager.getInstance();
const realFetch = globalThis.fetch;
const realConsoleLog = console.log;
const realConsoleError = console.error;

describe('the ladder entry points', () => {
  let fetcher: ManifestFetcher;
  let health: FeedHealthTracker;
  let requested: string[];

  beforeEach(() => {
    manager.clear();
    health = new FeedHealthTracker();
    fetcher = new ManifestFetcher(manager, health, undefined, NO_JITTER, POLL_MS);
    fetcher.beeUrl = BEE_URL;
    requested = [];
    // The master is logged once per session, deliberately, and it is not what any of these assert.
    console.log = () => {};
  });

  afterEach(() => {
    fetcher.unregisterLadder(`${OWNER}/${SOURCE_TOPIC}`);
    globalThis.fetch = realFetch;
    console.log = realConsoleLog;
    console.error = realConsoleError;
  });

  /** Answers the source feed with `sourceBody` and every rung feed with a media playlist. */
  function stubFetch(sourceBody: string, onRequest: (path: string) => Response | null = () => null): void {
    globalThis.fetch = (async (url: string) => {
      const path = url.replace(`${BEE_URL}/`, '');
      requested.push(path);

      const override = onRequest(path);
      if (override) {
        return override;
      }
      if (path === `feeds/${OWNER}/${hexSource}`) {
        return feedResponse(sourceBody);
      }
      if (RUNG_TOPICS.some((hex) => path === `feeds/${OWNER}/${hex}`)) {
        return feedResponse(mediaPlaylist('rung-seg.ts'));
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  describe('a published master', () => {
    it('is returned as it stands, because the uploader is the authority on its own ladder', async () => {
      const master = buildMasterPlaylist(OWNER, LADDER);
      stubFetch(master);

      assert.equal(await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`), master);
    });

    it('starts every rung it names, before hls.js has asked for any of them', async () => {
      stubFetch(buildMasterPlaylist(OWNER, LADDER));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      await settle();

      for (const hex of RUNG_TOPICS) {
        assert.ok(
          requested.some((path) => path.includes(hex)),
          `rung ${hex} was never read, so switching to it would start eighty indices behind`,
        );
      }
    });

    it('does not ingest the master as a media playlist, which would serve zero segments', async () => {
      stubFetch(buildMasterPlaylist(OWNER, LADDER));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.equal(manager.serialize(hexSource, `${BEE_URL}/bytes`), '');
    });
  });

  describe('a catalog entry written before masters were published', () => {
    it('is answered with a locally built master, so it plays as a ladder rather than one rung', async () => {
      stubFetch(mediaPlaylist('lowest-rung-seg.ts'));
      fetcher.registerLadder(`${OWNER}/${SOURCE_TOPIC}`, () => ({ owner: OWNER, renditions: LADDER }));

      assert.equal(await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`), buildMasterPlaylist(OWNER, LADDER));
    });

    it('has no master to synthesise once the ladder is unregistered', async () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      fetcher.registerLadder(source, () => ({ owner: OWNER, renditions: LADDER }));
      assert.ok(fetcher.masterFor(source));

      fetcher.unregisterLadder(source);

      assert.equal(fetcher.masterFor(source), null);
    });

    it('is not a ladder when the resolver has no rungs, so a single-rendition stream is left alone', () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      fetcher.registerLadder(source, () => ({ owner: OWNER, renditions: [] }));

      assert.equal(fetcher.masterFor(source), null);
    });
  });

  describe('a single-rendition stream', () => {
    it('is ingested from the read that identified it, rather than fetched a second time', async () => {
      stubFetch(mediaPlaylist('only-seg.ts'));

      const manifest = await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.match(manifest, /only-seg\.ts/);
      assert.deepEqual(requested, [`feeds/${OWNER}/${hexSource}`], 'the head was read twice for one playlist');
    });

    it('commits the index the gateway resolved, so the next poll follows on rather than resyncing', async () => {
      stubFetch(mediaPlaylist('only-seg.ts'));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.equal(manager.getIndex(hexSource)?.toBigInt(), 3n);
    });
  });

  /**
   * The guards `handleInitialFetch` documents at length. `fetchSource` is the same kind of read and
   * had none of them: a gateway outage was an unbounded restart loop with no backoff accumulating and
   * nothing for the overlay to report.
   */
  describe('the guards a head read needs', () => {
    it('records the gateway as failing when it does not answer', async () => {
      console.error = () => {};
      globalThis.fetch = (async () => new Response('gone', { status: 502 })) as typeof fetch;

      await assert.rejects(fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`));

      assert.equal(health.state(hexSource), FEED_STATE_RECONNECTING);
      assert.ok(health.backoffRemainingMs(hexSource) > 0, 'nothing would hold the restart loop off');
    });

    it('records it as reachable once it answers, so the overlay does not stay on reconnecting', async () => {
      stubFetch(buildMasterPlaylist(OWNER, LADDER));

      await fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.equal(health.state(hexSource), FEED_STATE_LIVE);
    });

    it('waits out the backoff a failing gateway earned, rather than asking again at once', async () => {
      const waited: number[] = [];
      const waiting = new ManifestFetcher(
        manager,
        health,
        async (ms) => {
          waited.push(ms);
        },
        NO_JITTER,
        POLL_MS,
      );
      waiting.beeUrl = BEE_URL;
      health.recordGatewayFailure(hexSource);
      // Read before the call, because a successful read clears the backoff: comparing afterwards
      // would be comparing against zero. Bounded rather than equal, because the tracker returns the
      // time *remaining*, which decays between this read and the one inside the fetcher.
      const owed = health.backoffRemainingMs(hexSource);
      assert.ok(owed > 0, 'one recorded failure has to owe a wait, or this test asserts nothing');
      stubFetch(mediaPlaylist('after-the-wait.ts'));

      await waiting.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);

      assert.equal(waited.length, 1, 'the wait has to happen exactly once per attempt');
      assert.ok(waited[0] > owed / 2 && waited[0] <= owed, `waited ${waited[0]}ms against ${owed}ms owed`);
    });

    it('does not resurrect a topic torn down while the head read was in flight', async () => {
      const gate = deferred<void>();
      globalThis.fetch = (async () => {
        await gate.promise;
        return feedResponse(mediaPlaylist('landed-too-late.ts'));
      }) as typeof fetch;

      const pending = fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      manager.clear(hexSource);
      gate.resolve();

      await assert.rejects(pending, /torn down/);
      assert.equal(manager.getIndex(hexSource), null, 'a cleared topic came back at a pre-teardown index');
      assert.equal(manager.serialize(hexSource, `${BEE_URL}/bytes`), '');
    });

    it('does not start four rung pollers when a master lands after the topic was torn down', async () => {
      // The master branch of the same race. `startVariants` starts all four rung walks, and their only
      // stopper is `unregisterLadder`, which the teardown already ran against no rungs. Without the
      // guard the late master both resolves the read and leaves four orphan walks that nothing stops.
      const gate = deferred<void>();
      globalThis.fetch = (async (url: string) => {
        const path = url.replace(`${BEE_URL}/`, '');
        requested.push(path);
        await gate.promise;
        return feedResponse(buildMasterPlaylist(OWNER, LADDER));
      }) as typeof fetch;

      const pending = fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`);
      manager.clear(hexSource);
      gate.resolve();

      await assert.rejects(pending, /torn down/);
      await settle();

      for (const hex of RUNG_TOPICS) {
        assert.ok(
          !requested.some((path) => path.includes(hex)),
          `rung ${hex} was walked after teardown, so a torn-down player left an orphan poller running`,
        );
      }
    });

    it('refuses a 200 whose body is not a playlist, rather than answering with an empty string', async () => {
      console.error = () => {};
      stubFetch('<html>captive portal</html>');

      await assert.rejects(fetcher.fetchSource(`${OWNER}/${SOURCE_TOPIC}`));

      assert.equal(health.state(hexSource), FEED_STATE_RECONNECTING);
    });
  });

  describe('unregistering a ladder', () => {
    it('discards every rung playlist, so the next session does not resume this one', async () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      stubFetch(buildMasterPlaylist(OWNER, LADDER));
      await fetcher.fetchSource(source);
      await settle();
      assert.ok(
        RUNG_TOPICS.some((hex) => manager.serialize(hex, `${BEE_URL}/bytes`) !== ''),
        'no rung accumulated a playlist, so this test cannot show one being cleared',
      );

      fetcher.unregisterLadder(source);

      for (const hex of RUNG_TOPICS) {
        assert.equal(manager.serialize(hex, `${BEE_URL}/bytes`), '', `rung ${hex} kept its playlist`);
      }
    });

    /**
     * Both paths fire for one source: the catalog registers the ladder as the player mounts, and the
     * published master names the same rungs a moment later. `trackLadder` merges rather than
     * replaces, or whichever set lost the race is left walking with nothing to stop it.
     */
    it('stops the rungs from both the catalog and the master, not just the later set', async () => {
      const source = `${OWNER}/${SOURCE_TOPIC}`;
      const extra = rung('1080p', 1920, 1080, 5_000_000);
      stubFetch(buildMasterPlaylist(OWNER, LADDER));
      fetcher.registerLadder(source, () => ({ owner: OWNER, renditions: [extra] }));
      await fetcher.fetchSource(source);
      await settle();

      fetcher.unregisterLadder(source);
      const stillRunning = requested.length;
      await settle();

      assert.equal(requested.length, stillRunning, 'a rung kept polling after its player was torn down');
    });

    it('is safe on a source that was never registered, since teardown runs on every unmount', () => {
      assert.doesNotThrow(() => fetcher.unregisterLadder('never/registered'));
    });
  });
});
