import { Topic } from '@ethersphere/bee-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ManifestFetcher,
  ManifestStateManager,
  RUNG_READY_DEADLINE_POLLS,
  RungNotReadyError,
} from '../src/components/SwarmHlsPlayer/ManifestManagement';
import { RequestJitter } from '../src/utils/requestJitter';

/**
 * A level request for a rung the gateway cannot read used to wait for ever.
 *
 * The poller resolves a rung's `ready` on its first playlist and on a teardown, so a gateway that
 * fails every read of one rung's feed never resolves it. Our loader is the only thing hls.js has for
 * a playlist, and it starts no timer, so that level had no timeout, no retry and no error: a black
 * player, no message, and the rungs that were fine never reached.
 */

const OWNER = '8d8a30ff4cbcf8ad0e0773547686295f8157feb0';
const GROUP_ID = 'deadline-group';
const RUNG_ID = 'deadline-rung';
const SOURCE_URL = `swarm://${OWNER}/${GROUP_ID}`;
const RUNG_URL = `swarm://${OWNER}/${RUNG_ID}`;

const PUBLISHED_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=1012693,RESOLUTION=640x360',
  `swarm://${OWNER}/${RUNG_ID}`,
  '',
].join('\n');

/** Short enough that the walk turns over during the test, and the deadline is a multiple of it. */
const POLL_INTERVAL_MS = 50;

/** Neither staggers nor spreads, as in every other fetcher test, so the walk is driven rather than waited out. */
const NO_JITTER = new RequestJitter(0, () => 0);

const manager = ManifestStateManager.getInstance();
const realFetch = globalThis.fetch;
const realConsoleWarn = console.warn;

const groupTopicHex = Topic.fromString(GROUP_ID).toString();
const rungTopicHex = Topic.fromString(RUNG_ID).toString();

describe('a level request for a rung whose feed the gateway cannot read', () => {
  let fetcher: ManifestFetcher;
  /** What the fetcher asked to wait for, rather than what it waited, so the deadline is read not timed. */
  let waited: number[];

  beforeEach(() => {
    manager.clear(groupTopicHex);
    manager.clear(rungTopicHex);
    waited = [];
    console.warn = () => {};

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(groupTopicHex)) {
        return new Response(PUBLISHED_MASTER, {
          status: 200,
          headers: { 'Swarm-Feed-Index': '000000000000000a', 'Swarm-Feed-Index-Next': '000000000000000b' },
        });
      }
      // What a node that holds none of this rung's chunks does: the read fails rather than
      // answering, on this pass and on every pass after it, so `ready` is never resolved.
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    fetcher = new ManifestFetcher(
      manager,
      undefined,
      async (ms) => {
        waited.push(ms);
      },
      NO_JITTER,
      POLL_INTERVAL_MS,
    );
    fetcher.beeUrl = 'http://gateway.test';
  });

  afterEach(async () => {
    fetcher.unregisterLadder(SOURCE_URL);
    await fetcher.settled();
    globalThis.fetch = realFetch;
    console.warn = realConsoleWarn;
  });

  it('fails the level after the deadline rather than leaving hls.js with a request that never ends', async () => {
    await fetcher.fetchSource(SOURCE_URL);

    await expect(fetcher.fetch(RUNG_URL)).rejects.toBeInstanceOf(RungNotReadyError);
  });

  it('waits the poller cadence multiplied by the bound, so a slower poll is waited on for longer', async () => {
    await fetcher.fetchSource(SOURCE_URL);

    await fetcher.fetch(RUNG_URL).catch(() => {});

    expect(waited).toEqual([RUNG_READY_DEADLINE_POLLS * POLL_INTERVAL_MS]);
  });

  it('names the rung in the error, because the level error hls.js raises names only a URL', async () => {
    await fetcher.fetchSource(SOURCE_URL);

    const error = await fetcher.fetch(RUNG_URL).catch((reason: unknown) => reason);

    expect((error as RungNotReadyError).hexTopic).toBe(rungTopicHex);
    expect((error as Error).message).toContain(rungTopicHex);
  });
});
