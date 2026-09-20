import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import assert from 'node:assert/strict';
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

    assert.equal(
      selection.current,
      null,
      'the player would start without the ladder during the initial catalogue read',
    );

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

  it('keeps the completed snapshot route for audio playback', () => {
    const selection = new StreamPlaybackSelection({ ...ROUTE, mediaType: 'audio' });
    const audioStream = { ...managedStream('vod'), mediatype: 'audio' as const };

    assert.equal(selection.select(audioStream).kind, 'replay');
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

  it('keeps live run A selected through its completed snapshot and run B until Watch live is explicit', () => {
    const selection = new StreamPlaybackSelection(ROUTE);
    const liveA = {
      ...managedStream('live'),
      lifecycle: { version: 1 as const, revision: 4, runNumber: 4, state: 'live' as const },
    };
    const vodA = {
      ...managedStream('vod'),
      lifecycle: { version: 1 as const, revision: 5, runNumber: 4, state: 'vod' as const },
    };
    const liveB = {
      ...managedStream('live'),
      lifecycle: { version: 1 as const, revision: 6, runNumber: 5, state: 'live' as const },
    };

    const runA = selection.select(liveA);
    const afterClose = selection.select(vodA);
    const beforeWatchLive = selection.select(liveB);

    assert.equal(runA.kind, 'live');
    assert.equal(afterClose.session, runA.session);
    assert.equal(beforeWatchLive.session, runA.session);
    assert.equal(beforeWatchLive.runNumber, 4);
    assert.equal(beforeWatchLive.pinnedRecording?.master.reference, 'master-reference');

    const runB = selection.watchLive(liveB);
    assert.equal(runB.kind, 'live');
    assert.equal(runB.runNumber, 5);
    assert.notEqual(runB.session, runA.session);
  });

  it('selects the latest combined replay only after the viewer asks for it', () => {
    const selection = new StreamPlaybackSelection(ROUTE);
    const liveA = {
      ...managedStream('live'),
      lifecycle: { version: 1 as const, revision: 4, runNumber: 4, state: 'live' as const },
    };
    const vodB = {
      ...managedStream('vod'),
      lifecycle: { version: 1 as const, revision: 7, runNumber: 5, state: 'vod' as const },
      completedRecording: { ...completedRecording(), runNumber: 5 },
    };

    const runA = selection.select(liveA);
    const beforeReplaySelection = selection.select(vodB);

    assert.equal(beforeReplaySelection.session, runA.session, 'a catalogue poll must not replace run A');

    const replayB = selection.watchReplay(vodB);
    assert.equal(replayB.kind, 'replay');
    assert.equal(replayB.runNumber, 5);
    assert.notEqual(replayB.session, runA.session, 'the explicit replay switch must mount a new player');
  });

  it('replaces replay A with completed replay B only after the viewer asks for it', () => {
    const selection = new StreamPlaybackSelection(ROUTE);
    const replayA = selection.select(managedStream('vod'));
    const vodB = {
      ...managedStream('vod'),
      lifecycle: { version: 1 as const, revision: 7, runNumber: 5, state: 'vod' as const },
      completedRecording: { ...completedRecording(), runNumber: 5 },
    };

    const beforeReplaySelection = selection.select(vodB);

    assert.equal(beforeReplaySelection.session, replayA.session, 'a catalogue poll must keep replay A selected');
    assert.equal(beforeReplaySelection.runNumber, 4);

    const replayB = selection.watchReplay(vodB);
    assert.equal(replayB.kind, 'replay');
    assert.equal(replayB.runNumber, 5);
    assert.notEqual(replayB.session, replayA.session, 'the explicit replay switch must mount replay B once');

    assert.equal(selection.watchReplay(vodB).session, replayB.session, 'selecting replay B again must keep its player');
  });

  it('offers the previous combined replay while a managed continuation is live, without adding a history list', () => {
    watchPage.isStreamListLoaded = true;
    watchPage.streamList = [managedStream('live')];

    const html = renderWatchPage();

    assert.match(html, /Watch previous replay/);
    assert.doesNotMatch(html, /history/i);
  });

  it('shows an existing replay while the catalogue still marks the next run as scheduled', () => {
    watchPage.isStreamListLoaded = true;
    watchPage.streamList = [{
      ...managedStream('vod'),
      state: 'scheduled',
      lifecycle: { version: 1, revision: 10, runNumber: 5, state: 'ready' },
    }];

    const html = renderWatchPage();

    assert.equal(watchPage.playerProps.length, 1);
    assert.doesNotMatch(html, /This stream has not started yet/);
  });
});
