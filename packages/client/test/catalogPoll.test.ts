import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { CATALOG_POLL_INTERVAL_MS, watchPageCatalogPollMs } from '../src/providers/catalogPoll';
import { catalogUpdater, StreamCatalog, toCatalogRead } from '../src/providers/catalogState';
import { Stream, STREAM_STATUS_LIVE, STREAM_STATUS_SCHEDULED, STREAM_STATUS_VOD } from '../src/types/stream';
import { CatalogFeedReader } from '../src/utils/catalogFeed';
import type { TimedResponse } from '../src/utils/fetchWithTimeout';

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

const GATEWAY = 'https://gateway.example';

function catalogSlot(streams: Stream[], headers = new Headers()): TimedResponse {
  return { ok: true, status: 200, headers, text: JSON.stringify(streams) };
}

/** The head of the catalog feed, which is the one answer that says which slot it is. */
function catalogHead(slot: number, streams: Stream[]): TimedResponse {
  return catalogSlot(streams, new Headers({ 'swarm-feed-index': slot.toString(16).padStart(16, '0') }));
}

const SLOT_NOT_WRITTEN_YET: TimedResponse = { ok: false, status: 404, headers: new Headers(), text: '' };

/** A gateway that answers the catalog reader's requests in the order given. */
function gatewayAnswering(answers: TimedResponse[]) {
  return async (): Promise<TimedResponse> => {
    const answer = answers.shift();
    if (!answer) {
      throw new Error('the reader asked for a slot this feed does not hold');
    }
    return answer;
  };
}

/**
 * ⛔ The watch page's path from a poll to its decision, for a scheduled stream that is not the newest.
 *
 * The web2 admin turns an announced stream live by replacing its entry where it stands, so the last
 * entry of the catalog stays the same. The stream list used to compare only the last entries, so this
 * page started a scheduled stream only when it was the newest in the catalog, and showed "This stream
 * has not started yet" for any other until the viewer reloaded.
 *
 * Driven through the catalog reader and the read it hands the list, rather than through the list's
 * rule alone, so that a slot lost anywhere on the way fails here instead of falling back to the old
 * ordering without a sound.
 */
describe('when a scheduled stream that is not the newest entry goes live in place', () => {
  const announced: Stream = {
    owner: '0xabc',
    topic: 'announced-topic',
    title: 'announced',
    mediatype: 'video',
    timestamp: 100,
    state: STREAM_STATUS_SCHEDULED,
  };
  const newest: Stream = {
    owner: '0xabc',
    topic: 'newest-topic',
    title: 'newest',
    mediatype: 'video',
    timestamp: 200,
    state: STREAM_STATUS_LIVE,
  };

  /** How the watch page finds the stream it shows in the list. */
  function shownState(catalog: StreamCatalog) {
    return catalog.streams.find((entry) => entry.owner === announced.owner && entry.topic === announced.topic)?.state;
  }

  it('stops showing it as not started on the next poll', async () => {
    const selectedGateway = { current: GATEWAY };
    const reader = new CatalogFeedReader(
      announced.owner,
      Topic.fromString('catalog-test'),
      gatewayAnswering([
        catalogHead(7, [announced, newest]),
        catalogSlot([{ ...announced, state: STREAM_STATUS_LIVE, timestamp: 300 }, newest]),
        SLOT_NOT_WRITTEN_YET,
      ]),
    );
    const poll = async (held: StreamCatalog) =>
      catalogUpdater(toCatalogRead(GATEWAY, await reader.read(GATEWAY)), selectedGateway)(held);

    const opened = await poll({ streams: [], gateway: null, slot: null });
    const afterGoLive = await poll(opened);

    assert.equal(watchPageCatalogPollMs(shownState(opened)), CATALOG_POLL_INTERVAL_MS);
    assert.equal(
      watchPageCatalogPollMs(shownState(afterGoLive)),
      null,
      'the page still shows the stream as not started',
    );
  });
});
