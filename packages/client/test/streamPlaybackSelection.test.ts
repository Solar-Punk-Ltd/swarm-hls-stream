import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, it, vi } from 'vitest';

import { StreamPlaybackSelection } from '@/pages/StreamWatcher/StreamPlaybackSelection';
import { type Rendition, type Stream } from '@/types/stream';

const watchPage = vi.hoisted(() => ({
  isStreamListLoaded: false,
  playerProps: [] as Array<{ renditions?: Rendition[] }>,
  streamList: [] as Stream[],
}));

vi.mock('@/providers/App', () => ({
  useAppContext: () => watchPage,
}));

vi.mock('@/components/SwarmHlsPlayer/SwarmHlsPlayer', () => ({
  SwarmHlsPlayer: (props: { renditions?: Rendition[] }) => {
    watchPage.playerProps.push(props);
    return null;
  },
}));

const { StreamWatcher } = await import('@/pages/StreamWatcher/StreamWatcher');

const ROUTE = {
  owner: '0xviewer',
  topicString: 'stable-master-topic',
  mediaType: 'video' as const,
};

function rendition(topic: string, index?: number): Rendition {
  return {
    name: '720p',
    width: 1280,
    height: 720,
    topic,
    bandwidth: 2_000_000,
    avgBandwidth: 1_800_000,
    index,
  };
}

function stream(renditions?: Rendition[]): Stream {
  return {
    owner: ROUTE.owner,
    topic: ROUTE.topicString,
    timestamp: 1,
    mediatype: ROUTE.mediaType,
    title: 'A stream',
    renditions,
  };
}

function renderWatchPage(): void {
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/watch/video/0xviewer/stable-master-topic'] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/watch/:mediatype/:owner/:topic',
          element: createElement(StreamWatcher),
        }),
      ),
    ),
  );
}

describe('StreamWatcher playback selection', () => {
  beforeEach(() => {
    watchPage.isStreamListLoaded = false;
    watchPage.playerProps.length = 0;
    watchPage.streamList = [];
  });

  it('does not mount while the catalogue is loading, then starts the player with the first ABR row', () => {
    renderWatchPage();
    assert.equal(watchPage.playerProps.length, 0);

    watchPage.isStreamListLoaded = true;
    watchPage.streamList = [stream([rendition('archived-rung', 7)])];
    renderWatchPage();

    assert.deepEqual(watchPage.playerProps[0].renditions, [rendition('archived-rung', 7)]);
  });

  it('waits for the first catalogue lookup, then captures the ABR inputs it mounts with', () => {
    const selection = new StreamPlaybackSelection(ROUTE);

    assert.equal(selection.current, null, 'the player would start without the ladder during the initial catalogue read');

    const mounted = selection.select(stream([rendition('archived-rung', 7)]));

    assert.deepEqual(mounted, {
      ...ROUTE,
      renditions: [rendition('archived-rung', 7)],
    });
  });

  it('keeps the mounted replay inputs when a later catalogue poll changes metadata and every rung', () => {
    const firstCatalogEntry = stream([rendition('archived-rung', 7)]);
    const selection = new StreamPlaybackSelection(ROUTE);
    const mounted = selection.select(firstCatalogEntry);

    firstCatalogEntry.title = 'Refreshed title';
    firstCatalogEntry.renditions![0].topic = 'mutated-by-catalogue';
    firstCatalogEntry.renditions = [rendition('live-rung', 12)];
    const afterPoll = selection.select(firstCatalogEntry);

    assert.strictEqual(afterPoll, mounted, 'the mounted player would be replaced by the refreshed catalogue entry');
    assert.equal(afterPoll.renditions?.[0].topic, 'archived-rung');
    assert.equal(afterPoll.renditions?.[0].index, 7);
  });

  it('uses the route for legacy direct playback when the completed lookup has no catalogue row', () => {
    const selection = new StreamPlaybackSelection(ROUTE);

    assert.deepEqual(selection.select(undefined), { ...ROUTE, renditions: undefined });
  });

  it('starts a new selection when navigation creates a new watch-page boundary', () => {
    const oldRoute = new StreamPlaybackSelection(ROUTE);
    oldRoute.select(stream([rendition('old-rung', 1)]));
    const nextRoute = new StreamPlaybackSelection({ ...ROUTE, topicString: 'another-master-topic' });

    assert.equal(nextRoute.select(stream([rendition('new-rung', 2)])).topicString, 'another-master-topic');
    assert.equal(nextRoute.current?.renditions?.[0].topic, 'new-rung');
  });
});
