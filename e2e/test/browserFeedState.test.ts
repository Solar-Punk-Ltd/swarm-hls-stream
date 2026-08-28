import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  FEED_STATE_DEGRADED,
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_MESSAGES,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
  feedStatesSeen,
  readFeedState,
} from '../src/browser/feedState.js';
import { ROOT_DIR } from '../src/config.js';

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

/**
 * ⛔⛔ The mirror, checked against the client's own source rather than against a memory of it.
 *
 * `FEED_STATE_MESSAGES` restates strings that live in another package, which `e2e` deliberately does
 * not depend on. A restatement rots: a copy edit in the overlay would leave every viewer run
 * throwing at its first sample, on a paid broadcast, with a message about an overlay nobody had
 * touched that week. This turns that into a red unit test at the moment of the edit.
 *
 * Reading another package's source as data is the pattern `test/logLevel.test.ts` already uses for
 * the uploader's log levels, and for the same reason.
 */
describe('the messages still match the ones the client renders', () => {
  const overlay = readFileSync(
    join(
      ROOT_DIR,
      'packages',
      'client',
      'src',
      'components',
      'SwarmHlsPlayer',
      'overlays',
      'feed',
      'FeedStateOverlay.tsx',
    ),
    'utf8',
  );

  it('finds every message this harness knows in the component that renders them', () => {
    for (const message of Object.keys(FEED_STATE_MESSAGES)) {
      assert.ok(
        overlay.includes(`'${message}'`),
        `the overlay no longer renders '${message}'. It was reworded, and a viewer run would now throw ` +
          'at its first sample. Update FEED_STATE_MESSAGES to match.',
      );
    }
  });

  /**
   * The other direction, which is the one that fails quietly. A state gained in the client and not
   * here would reach a viewer, throw, and read as the harness being broken rather than as the mirror
   * being short.
   */
  it('knows every message the component can render, so a new state cannot arrive unannounced', () => {
    const rendered = [...overlay.matchAll(/\[FEED_STATE_[A-Z]+\]:\s*'([^']+)'/g)].map((match) => match[1]);

    assert.ok(rendered.length > 0, 'no messages were found in the overlay at all, so this check is reading nothing');
    assert.deepEqual([...rendered].sort(), Object.keys(FEED_STATE_MESSAGES).sort());
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
