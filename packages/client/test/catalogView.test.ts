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
    assert.equal(catalogViewFrom({ isLoading: false, hasError: false, streamCount: 3 }), 'streams');
  });

  it('separates a gateway it could not reach from a gateway with nothing on it', () => {
    const unreachable = catalogViewFrom({ isLoading: false, hasError: true, streamCount: 0 });
    const empty = catalogViewFrom({ isLoading: false, hasError: false, streamCount: 0 });

    assert.equal(unreachable, 'unreachable');
    assert.equal(empty, 'empty');
    assert.notEqual(unreachable, empty, 'these rendered as the same blank page and that was the bug');
  });

  it('says it is still looking before the first answer arrives', () => {
    assert.equal(catalogViewFrom({ isLoading: true, hasError: false, streamCount: 0 }), 'loading');
  });

  /**
   * SWR keeps the last successful `data` while a later refresh fails. Shouting about that would swap a
   * usable catalog for an error page every time one poll in twelve missed, and a viewer can still open
   * a stale stream while they can do nothing at all with an error.
   */
  it('keeps showing streams through a failing refresh rather than replacing them with an error', () => {
    assert.equal(catalogViewFrom({ isLoading: false, hasError: true, streamCount: 3 }), 'streams');
  });

  it('has copy for every view that is not a list of streams', () => {
    for (const view of ['unreachable', 'loading', 'empty'] as const) {
      assert.ok(CATALOG_VIEW_MESSAGE[view]?.length > 0, `${view} would render a blank screen`);
    }
  });
});
