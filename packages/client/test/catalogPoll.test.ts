import { Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { CATALOG_POLL_INTERVAL_MS, watchPageCatalogPollMs } from '../src/providers/catalogPoll';
import { catalogUpdater, StreamCatalog, toCatalogRead } from '../src/providers/catalogState';
import { Stream, STREAM_STATUS_LIVE, STREAM_STATUS_SCHEDULED } from '../src/types/stream';
import { CatalogFeedReader } from '../src/utils/catalogFeed';
import type { TimedResponse } from '../src/utils/fetchWithTimeout';
import {
  isWaitingForStart,
  WATCH_VIEW_LOADING,
  WATCH_VIEW_NOT_STARTED,
  WATCH_VIEW_PLAYER,
  WATCH_VIEW_UNAVAILABLE,
  WatchPageView,
  watchPageView,
} from '../src/utils/watchPageView';

describe('when the watch page reads the catalog again', () => {
  it('keeps reading it while the stream has not started, so the page notices when it does', () => {
    assert.equal(watchPageCatalogPollMs(WATCH_VIEW_NOT_STARTED), CATALOG_POLL_INTERVAL_MS);
  });

  it('keeps reading it while the stream it waited for is missing, so a republish reaches the page', () => {
    assert.equal(watchPageCatalogPollMs(WATCH_VIEW_UNAVAILABLE), CATALOG_POLL_INTERVAL_MS);
  });

  /**
   * The player follows the stream's own feeds from then on, and that includes a deep link to a topic
   * the catalog does not list, so there is nothing for a catalog poll to wait for.
   */
  it('stops once the player is mounted', () => {
    assert.equal(watchPageCatalogPollMs(WATCH_VIEW_PLAYER), null);
  });

  it('adds no read of its own before the first one lands, which the app makes itself', () => {
    assert.equal(watchPageCatalogPollMs(WATCH_VIEW_LOADING), null);
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

  /** What the watch page shows for the announced stream, from the list it holds. */
  function shownView(catalog: StreamCatalog): WatchPageView {
    const listed = catalog.streams.find((entry) => entry.owner === announced.owner && entry.topic === announced.topic);
    return watchPageView(true, listed, isWaitingForStart(true, listed));
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

    assert.equal(shownView(opened), WATCH_VIEW_NOT_STARTED);
    assert.equal(shownView(afterGoLive), WATCH_VIEW_PLAYER, 'the page still shows the stream as not started');
  });
});

/**
 * ⛔ The same path, for a scheduled stream the web2 admin unpublishes, which removes its entry and
 * touches no other. Once the list follows every catalog change, the entry leaves the page's list on the
 * next poll, and the page used to answer that by mounting the player on a feed nobody had written.
 *
 * The page's memory is carried from poll to poll here the way the page carries it, through
 * `isWaitingForStart`, because the list alone cannot tell a stream that was unpublished from one the
 * catalog never had.
 */
describe('when a scheduled stream that is not the newest entry is unpublished', () => {
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

  function listedAnnounced(catalog: StreamCatalog) {
    return catalog.streams.find((entry) => entry.owner === announced.owner && entry.topic === announced.topic);
  }

  it('says it is no longer available, and shows it again when it is republished', async () => {
    const selectedGateway = { current: GATEWAY };
    const reader = new CatalogFeedReader(
      announced.owner,
      Topic.fromString('catalog-test'),
      gatewayAnswering([
        catalogHead(7, [announced, newest]),
        catalogSlot([newest]),
        SLOT_NOT_WRITTEN_YET,
        catalogSlot([{ ...announced, timestamp: 300 }, newest]),
        SLOT_NOT_WRITTEN_YET,
      ]),
    );
    const poll = async (held: StreamCatalog) =>
      catalogUpdater(toCatalogRead(GATEWAY, await reader.read(GATEWAY)), selectedGateway)(held);

    const opened = await poll({ streams: [], gateway: null, slot: null });
    const afterUnpublish = await poll(opened);
    const afterRepublish = await poll(afterUnpublish);

    const waitingWhenOpened = isWaitingForStart(false, listedAnnounced(opened));
    const waitingAfterUnpublish = isWaitingForStart(waitingWhenOpened, listedAnnounced(afterUnpublish));
    const waitingAfterRepublish = isWaitingForStart(waitingAfterUnpublish, listedAnnounced(afterRepublish));
    const viewAfterUnpublish = watchPageView(true, listedAnnounced(afterUnpublish), waitingAfterUnpublish);

    assert.equal(watchPageView(true, listedAnnounced(opened), waitingWhenOpened), WATCH_VIEW_NOT_STARTED);
    assert.equal(viewAfterUnpublish, WATCH_VIEW_UNAVAILABLE, 'the page mounts a player that can never load');
    assert.equal(watchPageCatalogPollMs(viewAfterUnpublish), CATALOG_POLL_INTERVAL_MS);
    assert.equal(
      watchPageView(true, listedAnnounced(afterRepublish), waitingAfterRepublish),
      WATCH_VIEW_NOT_STARTED,
      'a republished stream does not come back to a page that stopped reading the catalog',
    );
  });
});
