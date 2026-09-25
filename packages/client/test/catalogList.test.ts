import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { Stream, STREAM_STATUS_LIVE, STREAM_STATUS_SCHEDULED } from '@/types/stream';
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

/** The list on screen before each poll below, and the feed slot it was read from. */
const ON_SCREEN = { held: HELD, heldSlot: 7n };

/** The slot after the one {@link ON_SCREEN} was read from. */
const NEXT_SLOT = 8n;

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

    assert.deepEqual(nextStreamList({ ...ON_SCREEN, fetched, fetchedSlot: NEXT_SLOT, isSameGateway: true }), fetched);
  });

  it('keeps what is on screen when the same gateway has nothing newer', () => {
    const fetched = [streamAt(100), streamAt(200)];

    assert.equal(nextStreamList({ ...ON_SCREEN, fetched, fetchedSlot: ON_SCREEN.heldSlot, isSameGateway: true }), null);
  });

  it('keeps what is on screen when a poll on the same gateway comes back with nothing usable', () => {
    assert.equal(nextStreamList({ ...ON_SCREEN, fetched: null, fetchedSlot: null, isSameGateway: true }), null);
    assert.equal(nextStreamList({ ...ON_SCREEN, fetched: [], fetchedSlot: NEXT_SLOT, isSameGateway: true }), null);
    assert.equal(
      nextStreamList({ ...ON_SCREEN, fetched: 'not a catalog', fetchedSlot: NEXT_SLOT, isSameGateway: true }),
      null,
    );
  });

  it.each(malformedCatalogs)('rejects the whole catalog when it contains %s', (_name, fetched) => {
    assert.equal(nextStreamList({ ...ON_SCREEN, fetched, fetchedSlot: NEXT_SLOT, isSameGateway: true }), null);
    assert.equal(
      nextStreamList({ held: [], heldSlot: null, fetched, fetchedSlot: NEXT_SLOT, isSameGateway: true }),
      null,
    );
    assert.deepEqual(nextStreamList({ ...ON_SCREEN, fetched, fetchedSlot: NEXT_SLOT, isSameGateway: false }), []);
  });

  it.each(malformedRenditions)('rejects the whole catalog when it contains %s', (_name, renditions) => {
    const malformed = [{ ...streamAt(300), renditions }];

    assert.equal(
      nextStreamList({ ...ON_SCREEN, fetched: malformed, fetchedSlot: NEXT_SLOT, isSameGateway: true }),
      null,
    );
    assert.deepEqual(
      nextStreamList({ ...ON_SCREEN, fetched: malformed, fetchedSlot: NEXT_SLOT, isSameGateway: false }),
      [],
    );
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
      ...ON_SCREEN,
      fetched: [scheduled, futureState],
      fetchedSlot: NEXT_SLOT,
      isSameGateway: false,
    });

    assert.deepEqual(result, [scheduled, futureState]);
    assert.equal(result?.[0], scheduled, 'validation projected the entry and discarded fields it did not know');
    assert.equal(result?.[1], futureState, 'an unknown future state was treated as an invalid entry');
  });

  it('takes the first catalog of a session, which has nothing to be newer than', () => {
    const fetched = [streamAt(1)];

    assert.deepEqual(
      nextStreamList({ held: [], heldSlot: null, fetched, fetchedSlot: 1n, isSameGateway: true }),
      fetched,
    );
  });

  /**
   * ⛔ The switch case. Each node resolves its own head, so a node freshly pointed at this catalog
   * routinely answers with an older slot than the one on screen, and the comparison alone would refuse
   * it for ever.
   */
  it("takes another gateway's catalog even when it is older than the one on screen", () => {
    const fetched = [streamAt(5)];

    assert.deepEqual(nextStreamList({ ...ON_SCREEN, fetched, fetchedSlot: 2n, isSameGateway: false }), fetched);
  });

  it('clears the list when another gateway has nothing, rather than showing the last one as its answer', () => {
    assert.deepEqual(nextStreamList({ ...ON_SCREEN, fetched: null, fetchedSlot: null, isSameGateway: false }), []);
    assert.deepEqual(nextStreamList({ ...ON_SCREEN, fetched: [], fetchedSlot: NEXT_SLOT, isSameGateway: false }), []);
  });
});

/**
 * ⛔ The web2 admin changes an entry where it stands, and the old rule only ever looked at the end.
 *
 * The stack's own uploader removes a changed entry and appends it again, so every change it makes
 * reached the last entry, which is all the old rule compared. The admin appends an entry when it
 * first publishes it and from then on replaces it where it stands, and an unpublish removes an entry
 * without touching any other. Seen live on 2026-09-25: an entry renamed in place was never shown by an
 * open, polling viewer in 180 s, while a fresh page load showed it at once.
 */
describe('a change the same gateway makes anywhere in the catalog', () => {
  it('takes an earlier entry going live in place while the last entry stays the same', () => {
    const announced = { ...streamAt(100, 'announced'), state: STREAM_STATUS_SCHEDULED };
    const newest = streamAt(200, 'newest');
    // Stamped with the time of the write, as the admin stamps every entry it replaces. That is newer
    // than the last entry, and it was missed all the same, because only the last entry was compared.
    const wentLive = { ...announced, state: STREAM_STATUS_LIVE, timestamp: 300 };

    const next = nextStreamList({
      held: [announced, newest],
      heldSlot: 7n,
      fetched: [wentLive, newest],
      fetchedSlot: 8n,
      isSameGateway: true,
    });

    assert.deepEqual(next, [wentLive, newest]);
  });

  it('takes an entry removed from the middle, which is all an unpublish changes', () => {
    const held = [streamAt(100), streamAt(200), streamAt(300)];
    const unpublished = [streamAt(100), streamAt(300)];

    assert.deepEqual(
      nextStreamList({ held, heldSlot: 7n, fetched: unpublished, fetchedSlot: 8n, isSameGateway: true }),
      unpublished,
    );
  });

  /**
   * The reader can hand back an older slot after a newer one, when two head lookups overlap and the
   * older lands last. This catalog predates an unpublish, so taking it because it differs would put
   * the removed stream back on screen, and so did the old rule, because its last entry is the newer.
   */
  it('refuses a catalog from an older slot even when it differs from the one on screen', () => {
    const afterUnpublish = [streamAt(100), streamAt(200)];
    const beforeUnpublish = [streamAt(100), streamAt(200), streamAt(300)];

    assert.equal(
      nextStreamList({
        held: afterUnpublish,
        heldSlot: 8n,
        fetched: beforeUnpublish,
        fetchedSlot: 7n,
        isSameGateway: true,
      }),
      null,
    );
  });
});

/**
 * A head read whose `swarm-feed-index` header was missing or unreadable carries no slot, so nothing
 * orders it against the list on screen, and neither does a list that came from one. Such a catalog
 * keeps the rule this list had before reads carried a slot, rather than risk putting an older one back.
 */
describe('a catalog on the same gateway whose slot is not known', () => {
  const sides: Array<[side: string, slots: { heldSlot: bigint | null; fetchedSlot: bigint | null }]> = [
    ['the read', { heldSlot: 7n, fetchedSlot: null }],
    ['the list on screen', { heldSlot: null, fetchedSlot: 8n }],
  ];

  it.each(sides)('is taken when %s has no slot and the last entry is newer', (_side, slots) => {
    const fetched = [streamAt(100), streamAt(300)];

    assert.deepEqual(nextStreamList({ held: HELD, ...slots, fetched, isSameGateway: true }), fetched);
  });

  it.each(sides)('keeps what is on screen when %s has no slot and the last entry is not newer', (_side, slots) => {
    const fetched = [streamAt(100), streamAt(200)];

    assert.equal(nextStreamList({ held: HELD, ...slots, fetched, isSameGateway: true }), null);
  });
});
