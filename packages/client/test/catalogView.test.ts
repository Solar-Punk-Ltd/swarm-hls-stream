/**
 * The browse page read only `data` off SWR and dropped `error` and `isLoading`, so a gateway nobody
 * could reach rendered as a catalog with no streams in it. A viewer whose gateway was down and a
 * viewer who was early to an event saw the same screen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { CATALOG_VIEW_MESSAGE, catalogViewFrom } from '../src/pages/StreamBrowser/catalogView';

describe('what the browse page shows for a catalog fetch', () => {
  it('shows streams when there are streams', () => {
    assert.equal(
      catalogViewFrom({ isLoading: false, hasError: false, streamCount: 3, isFromCurrentGateway: true }),
      'streams',
    );
  });

  it('separates a gateway it could not reach from a gateway with nothing on it', () => {
    const unreachable = catalogViewFrom({
      isLoading: false,
      hasError: true,
      streamCount: 0,
      isFromCurrentGateway: true,
    });
    const empty = catalogViewFrom({ isLoading: false, hasError: false, streamCount: 0, isFromCurrentGateway: true });

    assert.equal(unreachable, 'unreachable');
    assert.equal(empty, 'empty');
    assert.notEqual(unreachable, empty, 'these rendered as the same blank page and that was the bug');
  });

  it('says it is still looking before the first answer arrives', () => {
    assert.equal(
      catalogViewFrom({ isLoading: true, hasError: false, streamCount: 0, isFromCurrentGateway: true }),
      'loading',
    );
  });

  /**
   * SWR keeps the last successful `data` while a later refresh fails. Shouting about that would swap a
   * usable catalog for an error page every time one poll in twelve missed, and a viewer can still open
   * a stale stream while they can do nothing at all with an error.
   */
  it('keeps showing streams through a failing refresh rather than replacing them with an error', () => {
    assert.equal(
      catalogViewFrom({ isLoading: false, hasError: true, streamCount: 3, isFromCurrentGateway: true }),
      'streams',
    );
  });

  /**
   * ⛔ The gateway switch. A list from the node a viewer has just left is not an answer from the node
   * they chose, so it cannot hold the page: they would believe their own node was serving them, and
   * the message written for this moment could never appear, because a non-empty list is read first.
   */
  it("does not show another gateway's streams as this one's answer", () => {
    const stillLooking = catalogViewFrom({
      isLoading: true,
      hasError: false,
      streamCount: 10,
      isFromCurrentGateway: false,
    });
    const cannotReach = catalogViewFrom({
      isLoading: false,
      hasError: true,
      streamCount: 10,
      isFromCurrentGateway: false,
    });

    assert.equal(stillLooking, 'loading');
    assert.equal(cannotReach, 'unreachable');
  });

  it('has copy for every view that is not a list of streams', () => {
    for (const view of ['unreachable', 'loading', 'empty'] as const) {
      assert.ok(CATALOG_VIEW_MESSAGE[view]?.length > 0, `${view} would render a blank screen`);
    }
  });
});
