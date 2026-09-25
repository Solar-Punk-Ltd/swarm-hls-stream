import { FeedIndex, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { FeedReturnWatch, feedReturnWatchWaitMs } from '../src/components/SwarmHlsPlayer/feedReturn';
import { TimedResponse } from '../src/utils/fetchWithTimeout';
import { RequestJitter } from '../src/utils/requestJitter';

import { waitFor } from './helpers/waiting';

const OWNER = 'aabbcc';
const TOPIC = Topic.fromString('a-finished-feed');

/**
 * ⛔ Every viewer who saw a broadcast end starts watching for its return within a poll of the same
 * moment. A wait every one of them computes identically keeps their asks landing together on every
 * interval, and their rejoins landing together when the broadcaster returns, so each wait is drawn.
 *
 * Written in milliseconds rather than against the constants, for the reason the backoff schedule in
 * `feedState.test.ts` gives: bounds derived from the implementation's own numbers compare those
 * numbers only to themselves.
 */
describe('the wait before each ask for a broadcaster coming back', () => {
  /**
   * The shipped random source, as the last block of `requestJitter.test.ts` uses it, and for its
   * reason: a spread is proved on the source a viewer runs, not on one a test chose.
   */
  it('falls between twenty-two and a half and thirty seconds, on the real random source', () => {
    const jitter = new RequestJitter();
    const seen = new Set<number>();
    for (let draw = 0; draw < 2_000; draw++) {
      const waitMs = feedReturnWatchWaitMs(jitter);
      assert.ok(waitMs > 22_500 && waitMs <= 30_000, `${waitMs}ms is outside (22500, 30000]`);
      seen.add(waitMs);
    }
    // A source that kept answering the same wait would pass every bound above and spread nobody.
    assert.ok(seen.size > 1_000, `only ${seen.size} distinct waits in 2000 draws, which is not a spread`);
  });

  /** Only ever earlier than the interval, so the watch never asks less often than it says it does. */
  it('is never longer than the interval it was given', () => {
    const jitter = new RequestJitter(0, () => 0);

    assert.equal(feedReturnWatchWaitMs(jitter, 40), 40);
  });

  /**
   * ⛔ Drawn per ask, not once per watch. Two viewers whose first draws happened to land close would
   * otherwise stay that close for as long as their pages stay open.
   */
  it('is drawn again before every ask', async () => {
    const asked: string[] = [];
    let draws = 0;
    const neverWritten = async (path: string): Promise<TimedResponse> => {
      asked.push(path);
      throw new Error(`Failed to fetch: ${path}`);
    };
    const watch = new FeedReturnWatch({
      fetchResource: neverWritten,
      owner: OWNER,
      topic: TOPIC,
      finishedAt: FeedIndex.fromBigInt(1n),
      onReturned: () => {},
      nextWaitMs: () => {
        draws += 1;
        return 1;
      },
    });

    watch.start();
    try {
      await waitFor(() => asked.length >= 3, 'several asks');

      // One draw per ask, plus the one for the wait in progress when this reads, if there is one.
      assert.ok(
        draws === asked.length || draws === asked.length + 1,
        `${draws} waits were drawn for ${asked.length} asks`,
      );
    } finally {
      watch.stop();
    }
  });
});
