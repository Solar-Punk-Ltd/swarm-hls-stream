import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import {
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FEED_STATE_STALLED,
} from '../src/components/SwarmHlsPlayer/feedState';
import { FeedStateOverlay } from '../src/components/SwarmHlsPlayer/overlays/feed/FeedStateOverlay';

const CLIENT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLAYER_SOURCE = join(CLIENT_ROOT, 'src/components/SwarmHlsPlayer/SwarmHlsPlayer.tsx');

/** The overlay's own output, which a function component returns without needing anything to mount. */
function render(state: Parameters<typeof FeedStateOverlay>[0]['state']) {
  return FeedStateOverlay({ state });
}

function textOf(element: ReturnType<typeof render>): string {
  const children = (element?.props as { children?: unknown[] })?.children ?? [];
  return children.filter((child) => typeof child === 'string').join('');
}

describe('FeedStateOverlay', () => {
  it('shows nothing while the feed is live, which is nearly all of the time', () => {
    assert.equal(render(FEED_STATE_LIVE), null);
  });

  it('says the player is reconnecting when the gateway is not answering', () => {
    assert.match(textOf(render(FEED_STATE_RECONNECTING)), /Reconnecting/);
  });

  // Two messages rather than one. A gateway that is not answering usually comes back on its own; a
  // feed that has stopped advancing while its gateway answers usually does not, and telling a viewer
  // the player is reconnecting when it is connected fine points them at the wrong thing.
  it('says something different when the gateway answers but the feed is not advancing', () => {
    const stalled = textOf(render(FEED_STATE_STALLED));

    assert.notEqual(stalled, '');
    assert.notEqual(stalled, textOf(render(FEED_STATE_RECONNECTING)));
  });

  it('announces itself to a screen reader without stealing focus', () => {
    const props = render(FEED_STATE_RECONNECTING)?.props as { role?: string; 'aria-live'?: string };

    assert.equal(props.role, 'status');
    assert.equal(props['aria-live'], 'polite');
  });
});

/**
 * The seam a rendering test would cover. Nothing in this package can mount a React tree, so what is
 * checked instead is the wiring that the review of the first attempt found missing, which is more
 * specific than "the overlay exists".
 */
describe('the player component is wired to it', () => {
  const source = readFileSync(PLAYER_SOURCE, 'utf8');

  it('renders the overlay', () => {
    assert.match(source, /<FeedStateOverlay state=\{feedState\} \/>/);
  });

  /**
   * The root cause, guarded at the one place a test cannot otherwise reach. A subscription inside
   * the player effect is torn down and rebuilt on every restart, and a fatal network error is what
   * causes a restart, so it would be dropped exactly when the outage it describes is under way.
   */
  it('subscribes on the topic alone, not on anything a restart changes', () => {
    assert.match(source, /manifestFetcher\.feedHealth\.subscribe\([\s\S]{0,120}?\}, \[topicString\]\);/);
  });
});
