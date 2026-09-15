import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { Stream } from '@/types/stream';
import { nextStreamList } from '@/utils/catalogList';

/**
 * Which catalog the browse page holds after a poll.
 *
 * Switching to a Bee node that holds none of this catalog left the previous gateway's streams on the
 * page: the timestamp comparison refused the new node's older catalog, an empty answer was skipped
 * outright, and the page looked unchanged while everything behind it had been repointed. A viewer
 * then opened a stream their node has never heard of and got a player that said it was reconnecting.
 */

function streamAt(timestamp: number, title = `stream ${timestamp}`): Stream {
  return { owner: '0xabc', topic: `topic-${timestamp}`, timestamp, mediatype: 'video', title };
}

const HELD = [streamAt(100), streamAt(200)];

describe('the catalog a poll leaves on screen', () => {
  it('takes a newer catalog from the same gateway', () => {
    const fetched = [streamAt(100), streamAt(300)];

    assert.deepEqual(nextStreamList({ held: HELD, fetched, isSameGateway: true }), fetched);
  });

  it('keeps what is on screen when the same gateway has nothing newer', () => {
    const fetched = [streamAt(100), streamAt(200)];

    assert.equal(nextStreamList({ held: HELD, fetched, isSameGateway: true }), null);
  });

  it('keeps what is on screen when a poll on the same gateway comes back with nothing usable', () => {
    assert.equal(nextStreamList({ held: HELD, fetched: null, isSameGateway: true }), null);
    assert.equal(nextStreamList({ held: HELD, fetched: [], isSameGateway: true }), null);
    assert.equal(nextStreamList({ held: HELD, fetched: 'not a catalog', isSameGateway: true }), null);
  });

  it('takes the first catalog of a session, which has nothing to be newer than', () => {
    const fetched = [streamAt(1)];

    assert.deepEqual(nextStreamList({ held: [], fetched, isSameGateway: true }), fetched);
  });

  /**
   * ⛔ The switch case. Two nodes number their own view of the feed, so a node freshly pointed at
   * this catalog routinely answers with one older than what is on screen, and the comparison alone
   * would refuse it for ever.
   */
  it("takes another gateway's catalog even when it is older than the one on screen", () => {
    const fetched = [streamAt(5)];

    assert.deepEqual(nextStreamList({ held: HELD, fetched, isSameGateway: false }), fetched);
  });

  it('clears the list when another gateway has nothing, rather than showing the last one as its answer', () => {
    assert.deepEqual(nextStreamList({ held: HELD, fetched: null, isSameGateway: false }), []);
    assert.deepEqual(nextStreamList({ held: HELD, fetched: [], isSameGateway: false }), []);
  });
});
