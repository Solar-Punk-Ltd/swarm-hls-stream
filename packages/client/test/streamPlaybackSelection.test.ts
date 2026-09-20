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

function completedRecording() {
  return {
    runNumber: 4,
    master: {
      topic: 'stable-master-topic',
      index: 18,
      reference: 'master-reference',
      duration: 95,
    },
    expectedRenditions: ['720p'],
    renditions: [
      {
        name: '720p',
        topic: 'archived-rung',
        index: 7,
        reference: 'archived-rung-reference',
        duration: 95,
        width: 1280,
        height: 720,
        bandwidth: 2_000_000,
        avgBandwidth: 1_800_000,
      },
    ],
  };
}

function managedStream(state: 'live' | 'waiting' | 'vod'): Stream {
  return {
    ...stream([rendition('live-rung', 12)]),
    lifecycle: { version: 1, revision: 9, runNumber: 5, state },
    completedRecording: completedRecording(),
  } as Stream;
}

function renderWatchPage(): string {
  return renderToStaticMarkup(
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

    assert.equal(mounted.kind, 'live');
    assert.deepEqual(mounted.renditions, [rendition('archived-rung', 7)]);
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

    assert.equal(selection.select(undefined).kind, 'live');
    assert.equal(selection.current?.renditions, undefined);
  });

  it('starts a new selection when navigation creates a new watch-page boundary', () => {
    const oldRoute = new StreamPlaybackSelection(ROUTE);
    oldRoute.select(stream([rendition('old-rung', 1)]));
    const nextRoute = new StreamPlaybackSelection({ ...ROUTE, topicString: 'another-master-topic' });

    assert.equal(nextRoute.select(stream([rendition('new-rung', 2)])).topicString, 'another-master-topic');
    assert.equal(nextRoute.current?.renditions?.[0].topic, 'new-rung');
  });

  it('opens a completed snapshot for a new visitor when the managed stream is not live', () => {
    const selection = new StreamPlaybackSelection(ROUTE);

    const playback = selection.select(managedStream('vod'));

    assert.equal(playback.kind, 'replay');
    assert.equal(playback.completedRecording.master.reference, 'master-reference');
    assert.equal(playback.completedRecording.renditions[0].reference, 'archived-rung-reference');
  });

  it('opens the live feed for a new visitor during a live continuation and switches an existing replay once', () => {
    const selection = new StreamPlaybackSelection(ROUTE);
    const managed = managedStream('live');

    const initiallyLive = selection.select(managed);
    assert.equal(initiallyLive.kind, 'live');

    const replay = new StreamPlaybackSelection(ROUTE);
    replay.select(managedStream('vod'));
    const replaySession = replay.current!.session;
    const switched = replay.watchLive(managed);

    assert.equal(switched.kind, 'live');
    assert.equal(switched.renditions?.[0].topic, 'live-rung');
    assert.notEqual(switched.session, replaySession, 'the explicit switch must mount a new player');
  });

  it('offers the previous combined replay while a managed continuation is live, without adding a history list', () => {
    watchPage.isStreamListLoaded = true;
    watchPage.streamList = [managedStream('live')];

    const html = renderWatchPage();

    assert.match(html, /Watch previous replay/);
    assert.doesNotMatch(html, /history/i);
  });
});
