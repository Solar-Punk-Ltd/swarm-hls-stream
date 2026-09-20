import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { Stream } from '@/types/stream';
import { nextStreamList } from '@/utils/catalogList';

/**
 * Which catalog the browse page holds after a poll.
 *
 * Switching to a Bee node that holds none of this catalog left the previous gateway's streams on the
 * page: the timestamp comparison refused the new node's older catalog, an empty answer was skipped
 * outright, and the page looked unchanged while everything behind it had been repointed. A viewer
 * then opened a stream their node has never heard of and got a player that said it was reconnecting.
 */

function streamAt(timestamp: number, title = `stream ${timestamp}`): Stream {
  return { owner: '0xabc', topic: `topic-${timestamp}`, timestamp, mediatype: 'video', title };
}

const HELD = [streamAt(100), streamAt(200)];

const malformedCatalogs: Array<[name: string, fetched: unknown[]]> = [
  ['a null entry', [null]],
  ['a non-string owner', [{ ...streamAt(300), owner: 12 }]],
  ['a non-string topic', [{ ...streamAt(300), topic: null }]],
  ['a non-string title', [{ ...streamAt(300), title: false }]],
  ['a non-finite timestamp', [{ ...streamAt(300), timestamp: Number.POSITIVE_INFINITY }]],
  ['an unknown media type', [{ ...streamAt(300), mediatype: 'image' }]],
  ['a non-string state', [{ ...streamAt(300), state: 1 }]],
  ['an unusable duration', [{ ...streamAt(300), duration: null }]],
  ['a non-numeric final index', [{ ...streamAt(300), index: '2' }]],
  ['a non-string thumbnail', [{ ...streamAt(300), thumbnail: 12 }]],
  ['an unusable scheduled start time', [{ ...streamAt(300), scheduledStartTime: false }]],
  ['a valid entry mixed with an invalid entry', [streamAt(300), { ...streamAt(400), title: null }]],
];

const validRendition = {
  name: '360p',
  width: 640,
  height: 360,
  topic: 'rung-topic',
  bandwidth: 800_000,
  avgBandwidth: 700_000,
};

const validCompletedRecording = {
  runNumber: 4,
  master: {
    topic: 'archived-master-topic',
    index: 11,
    reference: 'archived-master-reference',
    duration: 95,
  },
  expectedRenditions: ['720p'],
  renditions: [
    {
      name: '720p',
      topic: 'archived-rung-topic',
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

const validLifecycle = { version: 1, revision: 9, runNumber: 4, state: 'vod' };

const malformedRenditions: Array<[name: string, renditions: unknown]> = [
  ['a non-array ladder', {}],
  ['a null rung', [null]],
  ['a rung without a string name', [{ ...validRendition, name: null }]],
  ['a rung without a string topic', [{ ...validRendition, topic: 12 }]],
  ['a rung without finite dimensions', [{ ...validRendition, width: Number.NaN }]],
  ['a rung without finite bandwidth', [{ ...validRendition, avgBandwidth: Number.POSITIVE_INFINITY }]],
  ['a rung with a non-numeric final index', [{ ...validRendition, index: '2' }]],
  ['a rung with a non-numeric duration', [{ ...validRendition, duration: '12' }]],
];

describe('the catalog a poll leaves on screen', () => {
  it('takes a newer catalog from the same gateway', () => {
    const fetched = [streamAt(100), streamAt(300)];

    assert.deepEqual(nextStreamList({ held: HELD, fetched, isSameGateway: true }), fetched);
  });

  it('keeps what is on screen when the same gateway has nothing newer', () => {
    const fetched = [streamAt(100), streamAt(200)];

    assert.equal(nextStreamList({ held: HELD, fetched, isSameGateway: true }), null);
  });

  it('keeps what is on screen when a poll on the same gateway comes back with nothing usable', () => {
    assert.equal(nextStreamList({ held: HELD, fetched: null, isSameGateway: true }), null);
    assert.equal(nextStreamList({ held: HELD, fetched: [], isSameGateway: true }), null);
    assert.equal(nextStreamList({ held: HELD, fetched: 'not a catalog', isSameGateway: true }), null);
  });

  it.each(malformedCatalogs)('rejects the whole catalog when it contains %s', (_name, fetched) => {
    assert.equal(nextStreamList({ held: HELD, fetched, isSameGateway: true }), null);
    assert.equal(nextStreamList({ held: [], fetched, isSameGateway: true }), null);
    assert.deepEqual(nextStreamList({ held: HELD, fetched, isSameGateway: false }), []);
  });

  it.each(malformedRenditions)('rejects the whole catalog when it contains %s', (_name, renditions) => {
    const malformed = [{ ...streamAt(300), renditions }];

    assert.equal(nextStreamList({ held: HELD, fetched: malformed, isSameGateway: true }), null);
    assert.deepEqual(nextStreamList({ held: HELD, fetched: malformed, isSameGateway: false }), []);
  });

  it.each([
    [
      'a managed snapshot without a master reference',
      validLifecycle,
      { ...validCompletedRecording, master: { ...validCompletedRecording.master, reference: '' } },
    ],
    [
      'a managed snapshot missing an expected rung',
      validLifecycle,
      { ...validCompletedRecording, expectedRenditions: ['720p', '1080p'] },
    ],
    ['an unsupported lifecycle version', { ...validLifecycle, version: 2 }, validCompletedRecording],
  ])('rejects the whole catalog when it contains %s', (_name, lifecycle, completedRecording) => {
    const malformed = [
      {
        ...streamAt(300),
        lifecycle,
        completedRecording,
      },
    ];

    assert.equal(nextStreamList({ held: HELD, fetched: malformed, isSameGateway: true }), null);
    assert.deepEqual(nextStreamList({ held: [], fetched: malformed, isSameGateway: false }), []);
  });

  it('keeps a legacy row whose optional continuation fields are absent', () => {
    const legacyAudio = { ...streamAt(300), mediatype: 'audio' as const };

    assert.deepEqual(nextStreamList({ held: [], fetched: [legacyAudio], isSameGateway: false }), [legacyAudio]);
  });

  it('keeps compatible optional and unknown fields on entries that pass validation', () => {
    const scheduled = {
      ...streamAt(300, 'scheduled stream'),
      state: 'scheduled',
      duration: 42,
      index: 3,
      thumbnail: 'thumbnail-reference',
      scheduledStartTime: null,
      renditions: [
        {
          ...validRendition,
          index: 2,
          duration: 42,
        },
      ],
      legacyField: { kept: true },
    };
    const futureState = {
      ...streamAt(400, 'future stream'),
      state: 'announced-by-a-future-writer',
      duration: '42.5',
      scheduledStartTime: 1_800_000_000_000,
    };

    const result = nextStreamList({
      held: HELD,
      fetched: [scheduled, futureState],
      isSameGateway: false,
    });

    assert.deepEqual(result, [scheduled, futureState]);
    assert.equal(result?.[0], scheduled, 'validation projected the entry and discarded fields it did not know');
    assert.equal(result?.[1], futureState, 'an unknown future state was treated as an invalid entry');
  });

  it('takes the first catalog of a session, which has nothing to be newer than', () => {
    const fetched = [streamAt(1)];

    assert.deepEqual(nextStreamList({ held: [], fetched, isSameGateway: true }), fetched);
  });

  /**
   * ⛔ The switch case. Two nodes number their own view of the feed, so a node freshly pointed at
   * this catalog routinely answers with one older than what is on screen, and the comparison alone
   * would refuse it for ever.
   */
  it("takes another gateway's catalog even when it is older than the one on screen", () => {
    const fetched = [streamAt(5)];

    assert.deepEqual(nextStreamList({ held: HELD, fetched, isSameGateway: false }), fetched);
  });

  it('clears the list when another gateway has nothing, rather than showing the last one as its answer', () => {
    assert.deepEqual(nextStreamList({ held: HELD, fetched: null, isSameGateway: false }), []);
    assert.deepEqual(nextStreamList({ held: HELD, fetched: [], isSameGateway: false }), []);
  });
});
