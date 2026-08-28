import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FEED_STATE_DEGRADED,
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  feedStatesSeen,
  readFeedState,
} from '../src/browser/feedState.js';

/**
 * That a sample carries what the overlay MEANT and not only what it said.
 *
 * ⛔ The reading was the overlay's prose and nothing else, so the only way to ask "did this viewer
 * reach the end of the broadcast" was to compare a sentence. A pass/fail suite cannot assert on a
 * sentence: the wording is a product decision that may change without anything about the viewer
 * changing, and a copy edit would turn a green scenario red while a genuinely broken terminal state
 * would stay green as long as the words survived.
 *
 * ⭐ An unknown message throws rather than reading as live. That is the rule `readOverlayMetrics`
 * already follows for a renamed label, and for the same reason: the honest answer to "I no longer
 * know what the overlay is saying" is to stop, not to report that it was saying nothing.
 */

describe('what the feed-state overlay was telling the viewer', () => {
  it('reads no overlay as live, which is what the client renders while the feed is live', () => {
    assert.equal(readFeedState(null), FEED_STATE_LIVE);
  });

  it('reads an overlay that rendered only whitespace as live', () => {
    assert.equal(readFeedState('   '), FEED_STATE_LIVE);
  });

  it('reads each message the client can render as its own state', () => {
    assert.equal(readFeedState('Reconnecting to the stream'), FEED_STATE_RECONNECTING);
    assert.equal(readFeedState('Waiting for the broadcast to continue'), FEED_STATE_STALLED);
    assert.equal(readFeedState('The stream is struggling to keep up'), FEED_STATE_DEGRADED);
    assert.equal(readFeedState('This broadcast has ended'), FEED_STATE_ENDED);
  });

  /** The overlay's text node sits beside a dot element, so the reading arrives padded. */
  it('reads a message the DOM handed back with surrounding whitespace', () => {
    assert.equal(readFeedState('  This broadcast has ended \n'), FEED_STATE_ENDED);
  });

  /**
   * ⛔ The failure this exists to prevent. Reading an unknown message as live would report a viewer
   * being told something as a viewer being told nothing, and every scenario asserting on a terminal
   * or a degraded state would pass while blind.
   */
  it('refuses a message it does not know rather than calling the feed live', () => {
    assert.throws(() => readFeedState('Buffering, please hold'), /Buffering, please hold/);
  });

  it('names the module to update when it refuses, so the fix is not a search', () => {
    assert.throws(() => readFeedState('Something new'), /FEED_STATE_MESSAGES/);
  });
});

describe('the states a session passed through', () => {
  it('reports nothing for a session with no samples, rather than inventing a live one', () => {
    assert.deepEqual(feedStatesSeen([]), []);
  });

  it('lists each state once, in the order the viewer first met it', () => {
    const seen = feedStatesSeen([
      FEED_STATE_LIVE,
      FEED_STATE_LIVE,
      FEED_STATE_RECONNECTING,
      FEED_STATE_LIVE,
      FEED_STATE_ENDED,
      FEED_STATE_ENDED,
    ]);

    assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING, FEED_STATE_ENDED]);
  });
});
