import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath } from '@swarm-hls-stream/shared';
import { describe, expect, it } from 'vitest';

import { previewSegmentUrl, thumbnailManifestUrl } from '@/utils/thumbnailManifest';

/**
 * Which URL a stream card asks for to build its thumbnail.
 *
 * A finished stream's catalog entry carries the SOC index of its own final manifest, so the card is
 * searching a feed for a position it was handed. Measured against the real catalog on 2026-08-05:
 * the head lookup those cards do is **2647ms at the median**, the slot read is **4ms**, and the two
 * returned byte-identical manifests in 12 of 12 entries. The previews run through a queue at
 * concurrency 1, so the head lookups are serial and ten cards is about 26 seconds of them.
 *
 * These assert on the URL rather than on any fetch, because the URL *is* the change.
 */

const GATEWAY = 'http://gw';
const OWNER = '1f6e0f8a9b7c3d5e2a4b6c8d0e1f2a3b4c5d6e7f';
const RAW_TOPIC = 'a-finished-broadcast';

describe('thumbnailManifestUrl', () => {
  it('addresses the published slot directly when the entry carries an index', () => {
    const url = thumbnailManifestUrl(GATEWAY, OWNER, RAW_TOPIC, 365);

    expect(url).toBe(`${GATEWAY}/${feedSlotPath(OWNER, Topic.fromString(RAW_TOPIC), FeedIndex.fromBigInt(365n))}`);
    expect(url).toContain('/soc/');
  });

  it('addresses slot zero, which a one-segment stream really does publish at', () => {
    expect(thumbnailManifestUrl(GATEWAY, OWNER, RAW_TOPIC, 0)).toContain('/soc/');
  });

  /**
   * Live entries genuinely have nothing to go on. `notifyStart` publishes no index, unlike the VOD
   * entry, so the search is still the only way to find a live thumbnail. That is fix 3 and it needs a
   * new publish rather than a client change.
   */
  it('falls back to resolving the head when the entry has no index', () => {
    const url = thumbnailManifestUrl(GATEWAY, OWNER, RAW_TOPIC, undefined);

    expect(url).toBe(`${GATEWAY}/feeds/${OWNER}/${Topic.fromString(RAW_TOPIC).toString()}`);
  });

  /**
   * The catalog is JSON off the network. Every one of these throws inside `BigInt()` or addresses a
   * slot that cannot exist, and the failure would land in a React effect during render rather than
   * anywhere a reader would look. The old code ignored the field entirely, so falling back to the
   * search is the behaviour that was already shipping.
   */
  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['past the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('falls back to the head lookup for an index that is %s', (_label, index) => {
    expect(thumbnailManifestUrl(GATEWAY, OWNER, RAW_TOPIC, index)).toContain('/feeds/');
  });
});

/**
 * The media line a preview's one-line playlist carries.
 *
 * That playlist reaches hls.js as a blob, and hls.js resolves a relative media line against the
 * playlist's own URL. Resolved against a blob, a rooted path loses everything that identifies the
 * gateway: `/bytes/<ref>` against `blob:http://viewer.example/<uuid>` comes back as
 * `blob:http:/bytes/<ref>`, run through hls.js 1.6.15's own resolver on 2026-08-07. So an unresolved
 * line is not merely awkward downstream, it is unrecoverable, and this is the last place that knows
 * which gateway was meant.
 *
 * The rooted case is the one that used to be passed through untouched, and `MANIFEST_ACCESS_URL` set
 * to a path rather than a full URL is what produces it. No env file in the repo does that today,
 * which is why it went unnoticed: `.env.latbench` sets a full URL and `.env.sample` leaves it empty.
 */
describe('previewSegmentUrl', () => {
  it('sends a rooted path to the gateway, not to whatever origin the page came from', () => {
    expect(previewSegmentUrl('/bytes/abc123', GATEWAY)).toBe(`${GATEWAY}/bytes/abc123`);
  });

  it('addresses a bare swarm reference under the gateway bytes endpoint', () => {
    expect(previewSegmentUrl('abc123', GATEWAY)).toBe(`${GATEWAY}/bytes/abc123`);
  });

  it.each([
    ['http', 'http://other-gw:1633/bytes/abc123'],
    ['https', 'https://other-gw/bytes/abc123'],
  ])('leaves an absolute %s uri alone, since the uploader already named a gateway', (_scheme, uri) => {
    expect(previewSegmentUrl(uri, GATEWAY)).toBe(uri);
  });

  /**
   * The old condition was `startsWith('http')`, which is true of any reference whose hex happens to
   * begin with those four characters. Swarm references are hex, so `http` cannot occur in one, but
   * the check was reading as a scheme test while only testing a prefix.
   */
  it('does not mistake a reference beginning with the letters http for an absolute url', () => {
    expect(previewSegmentUrl('httpabc123', GATEWAY)).toBe(`${GATEWAY}/bytes/httpabc123`);
  });

  // Every result has to be something hls.js will not try to resolve, which is what makes the blob
  // base irrelevant. `buildAbsoluteURL` returns a reference with a scheme unchanged.
  it.each([['/bytes/abc123'], ['abc123'], ['http://other-gw/bytes/abc123']])(
    'returns an absolute url for %s, so hls.js has nothing left to resolve',
    (uri) => {
      expect(previewSegmentUrl(uri, GATEWAY)).toMatch(/^https?:\/\//);
    },
  );
});
