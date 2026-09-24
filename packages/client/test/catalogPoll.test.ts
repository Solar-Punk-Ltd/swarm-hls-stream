import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { CATALOG_POLL_INTERVAL_MS, watchPageCatalogPollMs } from '../src/providers/catalogPoll';
import { STREAM_STATUS_LIVE, STREAM_STATUS_SCHEDULED, STREAM_STATUS_VOD } from '../src/types/stream';

describe('when the watch page reads the catalog again', () => {
  it('keeps reading it while the stream has not started, so the page notices when it does', () => {
    assert.equal(watchPageCatalogPollMs(STREAM_STATUS_SCHEDULED), CATALOG_POLL_INTERVAL_MS);
  });

  it('stops once the stream is live or recorded, because the player follows its feeds from then on', () => {
    assert.equal(watchPageCatalogPollMs(STREAM_STATUS_LIVE), null);
    assert.equal(watchPageCatalogPollMs(STREAM_STATUS_VOD), null);
  });

  /**
   * A deep link to a topic the catalog does not list mounts the player straight away, which follows
   * the feed itself, so there is nothing for a catalog poll to wait for.
   */
  it('does not poll for a stream the catalog does not list', () => {
    assert.equal(watchPageCatalogPollMs(undefined), null);
  });
});
