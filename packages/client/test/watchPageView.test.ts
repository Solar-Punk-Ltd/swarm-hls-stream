import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { STREAM_STATUS_LIVE, STREAM_STATUS_SCHEDULED, STREAM_STATUS_VOD } from '../src/types/stream';
import {
  isWaitingForStart,
  WATCH_VIEW_LOADING,
  WATCH_VIEW_NOT_STARTED,
  WATCH_VIEW_PLAYER,
  WATCH_VIEW_UNAVAILABLE,
  watchPageView,
} from '../src/utils/watchPageView';

const scheduled = { state: STREAM_STATUS_SCHEDULED };
const live = { state: STREAM_STATUS_LIVE };
const recorded = { state: STREAM_STATUS_VOD };

describe('what the watch page shows', () => {
  it('shows no stream before the first catalog read, so a ladder never arrives under a mounted player', () => {
    assert.equal(watchPageView(false, undefined, false), WATCH_VIEW_LOADING);
    assert.equal(watchPageView(false, scheduled, true), WATCH_VIEW_LOADING);
  });

  it('says a scheduled stream has not started', () => {
    assert.equal(watchPageView(true, scheduled, true), WATCH_VIEW_NOT_STARTED);
  });

  it('plays a stream that is live or recorded', () => {
    assert.equal(watchPageView(true, live, false), WATCH_VIEW_PLAYER);
    assert.equal(watchPageView(true, recorded, false), WATCH_VIEW_PLAYER);
  });

  it('plays an entry whose state it does not recognise, since only an announced one has no feed yet', () => {
    assert.equal(watchPageView(true, {}, false), WATCH_VIEW_PLAYER);
    assert.equal(watchPageView(true, { state: 'draining' }, false), WATCH_VIEW_PLAYER);
  });

  it('plays a deep link the catalog does not list, because nothing here knows better', () => {
    assert.equal(watchPageView(true, undefined, false), WATCH_VIEW_PLAYER);
  });

  /**
   * ⛔ The bug this exists for. The web2 admin removes an entry from the catalog when it unpublishes
   * it, and once the stream list follows every catalog change the entry a viewer is waiting on can
   * disappear from under the page. The page then no longer knew the stream had been announced and
   * mounted the player on a feed nobody had written, which loads for ever.
   */
  it('says the stream is no longer available when the one it was waiting for leaves the catalog', () => {
    assert.equal(watchPageView(true, undefined, true), WATCH_VIEW_UNAVAILABLE);
  });
});

describe('whether the page is waiting for its stream to start', () => {
  it('is waiting once the catalog lists the stream as scheduled', () => {
    assert.equal(isWaitingForStart(false, scheduled), true);
  });

  it('stops waiting once the stream is listed as live or recorded', () => {
    assert.equal(isWaitingForStart(true, live), false);
    assert.equal(isWaitingForStart(true, recorded), false);
  });

  it('keeps waiting through a read that no longer lists the stream', () => {
    assert.equal(isWaitingForStart(true, undefined), true);
  });

  it('never starts waiting for a stream the catalog has not listed', () => {
    assert.equal(isWaitingForStart(false, undefined), false);
  });

  /**
   * ⛔ A playing stream never turns into a message. Its entry can leave the list without being
   * unpublished: a viewer who switches to a node that has not caught up with this catalog gets that
   * node's list, whatever it holds. The page stopped waiting the moment the entry said live, so the
   * player stays.
   */
  it('keeps the player when a stream that was playing leaves the list', () => {
    const isWaiting = isWaitingForStart(isWaitingForStart(false, live), undefined);

    assert.equal(watchPageView(true, undefined, isWaiting), WATCH_VIEW_PLAYER);
  });
});
