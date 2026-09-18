/**
 * Every preview card used to take its frame by fetching the stream's manifest feed and decoding the
 * first segment it found. A scheduled entry has no manifest feed — the topic is an announcement, and
 * nothing is written under it until the broadcast starts — so that fetch was a guaranteed miss that
 * cost a slot on a queue of concurrency 1, and on the deployed build left the card spinning for good.
 * The image the broadcaster had uploaded went unread either way.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { previewMode, thumbnailFailed, thumbnailImageUrl } from '../src/components/StreamPreview/previewMode';

const REF = '6ce8aab7f729e4614ceab32b108336e0d25d53a673bc7c028d01ff386a9aaa70';

describe('where a preview card gets its picture', () => {
  it('renders the uploaded image when the entry carries one, whatever the stream is doing', () => {
    assert.equal(previewMode({ thumbnail: REF, state: 'live' }), 'image');
    assert.equal(previewMode({ thumbnail: REF, state: 'vod' }), 'image');
    assert.equal(previewMode({ thumbnail: REF, state: 'scheduled' }), 'image');
  });

  it('probes the manifest for a live or finished stream with no image', () => {
    assert.equal(previewMode({ state: 'live' }), 'probe');
    assert.equal(previewMode({ state: 'vod' }), 'probe');
  });

  /**
   * An entry published by the uploader carries no `state` at all in some shapes, and a catalog is
   * parsed unchecked, so "no status" has to mean the behaviour that was already correct.
   */
  it('probes an entry with no status, which is every entry the uploader wrote', () => {
    assert.equal(previewMode({}), 'probe');
  });

  it('treats an empty or blank thumbnail as no thumbnail rather than as a reference', () => {
    assert.equal(previewMode({ thumbnail: '', state: 'live' }), 'probe');
    assert.equal(previewMode({ thumbnail: '   ', state: 'live' }), 'probe');
  });

  // ⛔ The rule the whole module exists for. There is no manifest behind a scheduled topic, so a probe
  // there can only end as a wasted queue slot and a placeholder — before the fetch or after it.
  it('never probes a scheduled stream that has no image', () => {
    assert.equal(previewMode({ state: 'scheduled' }), 'placeholder');
  });

  it('falls back to the placeholder, not the probe, when a scheduled stream’s image fails to load', () => {
    assert.equal(previewMode({ thumbnail: REF, state: 'scheduled', imageFailed: true }), 'placeholder');
  });

  it('falls back to the probe when a live or finished stream’s image fails to load', () => {
    assert.equal(previewMode({ thumbnail: REF, state: 'live', imageFailed: true }), 'probe');
    assert.equal(previewMode({ thumbnail: REF, state: 'vod', imageFailed: true }), 'probe');
  });
});

/**
 * A preview card outlives the picture it was given, so an image failure has to be a fact about one
 * reference rather than about the card.
 *
 * `StreamList` keys a card by topic. In admin mode the topic belongs to the declaration and outlives
 * every session on it, so a publisher who replaces an unfetchable thumbnail re-renders the same
 * mounted component with a new reference and no remount. Recorded as a boolean, the first failure
 * latched: the replacement picture was never rendered, and for a scheduled entry — which is never
 * probed — the card stayed a placeholder for as long as the list was open.
 */
describe('whether a recorded image failure still applies', () => {
  const OTHER_REF = 'a'.repeat(64);

  it('demotes the reference that actually failed', () => {
    assert.equal(thumbnailFailed(REF, REF), true);
    assert.equal(previewMode({ thumbnail: REF, state: 'live', imageFailed: thumbnailFailed(REF, REF) }), 'probe');
  });

  it('does not demote a card that has never had a failure', () => {
    assert.equal(thumbnailFailed(null, REF), false);
  });

  /** ⛔ The regression itself: a new picture must be rendered rather than inheriting the old verdict. */
  it('stops applying once the publisher hands the card a different reference', () => {
    assert.equal(thumbnailFailed(REF, OTHER_REF), false);
    assert.equal(
      previewMode({ thumbnail: OTHER_REF, state: 'live', imageFailed: thumbnailFailed(REF, OTHER_REF) }),
      'image',
      'a replaced thumbnail must be rendered, not probed past',
    );
  });

  /**
   * The case that was worst, because a scheduled card has no probe to fall back to: it showed the
   * default image and nothing could ever move it off.
   */
  it('lets a scheduled card show a replacement picture instead of the placeholder for ever', () => {
    assert.equal(
      previewMode({ thumbnail: OTHER_REF, state: 'scheduled', imageFailed: thumbnailFailed(REF, OTHER_REF) }),
      'image',
    );
  });

  it('still demotes when the publisher re-publishes the same broken reference', () => {
    assert.equal(thumbnailFailed(REF, REF), true);
  });

  it('treats an entry that lost its thumbnail as carrying no failure', () => {
    assert.equal(thumbnailFailed(REF, undefined), false);
  });
});

describe('where the gateway serves a thumbnail', () => {
  it('addresses the reference as a bzz collection, trailing slash included', () => {
    assert.equal(thumbnailImageUrl('http://localhost:1633', REF), `http://localhost:1633/bzz/${REF}/`);
  });

  /**
   * The catalog is JSON off a feed and parsed unchecked, so this field is external input however
   * trusted its author. A value carrying a path separator would otherwise name somewhere on the
   * gateway this URL never meant to address.
   */
  it('encodes the reference rather than pasting it into the path', () => {
    const url = thumbnailImageUrl('http://gw', '../../bytes/deadbeef');

    assert.ok(!url.includes('../'), `a traversal reached the path: ${url}`);
  });
});
