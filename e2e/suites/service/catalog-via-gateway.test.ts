import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { type CatalogFeed, discoverCatalogFeed, fetchCatalog } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Service — the stream catalog a VIEWER loads (resolved through the bee-gateway) reflects the
 * live→VOD lifecycle. This is the player-visible layer: the same `GET /feeds/{owner}/{topic}` the
 * client's StreamBrowser makes. A fresh publish must surface a new `live` entry, and a clean stop
 * must flip that same entry to `vod` with a real duration.
 */

// Catalog feed writes are deferred through the single bee-uploader node, so a fresh live/VOD entry
// can take minutes to surface on the gateway-served catalog when the pusher is draining a segment
// backlog. These waits are generous on purpose — this is an accepted propagation-latency budget,
// not a behavioural expectation.
const APPEAR_WAIT_MS = 300_000;
const VOD_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

describe('service — viewer catalog via gateway reflects live→VOD', () => {
  const cfg = loadConfig();
  const host = makeHost(cfg);
  let publisher: Publisher;
  let feed: CatalogFeed;
  let baselineTopics: Set<string>;

  const safeFetch = async () => {
    try {
      return await fetchCatalog(host, cfg, feed);
    } catch {
      return []; // transient feed-resolution blip — treated as "not ready yet" by the pollers
    }
  };

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    baselineTopics = new Set((await safeFetch()).map((e) => e.topic));
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('surfaces a new live entry, then flips it to VOD on a clean stop', async () => {
    let ourTopic: string | undefined;

    await waitFor(
      async () => {
        const mine = (await safeFetch()).find((e) => !baselineTopics.has(e.topic) && e.state === 'live');
        if (mine) {
          ourTopic = mine.topic;
        }
        return mine !== undefined;
      },
      { timeoutMs: APPEAR_WAIT_MS, intervalMs: 3_000, label: 'a new live entry appears in the gateway-served catalog' },
    );
    assert.ok(ourTopic, 'expected to capture the new stream topic');

    await publisher.stop();

    await waitFor(async () => (await safeFetch()).find((e) => e.topic === ourTopic)?.state === 'vod', {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 3_000,
      label: 'our catalog entry flips to VOD after the broadcaster stops',
    });

    const finalEntry = (await safeFetch()).find((e) => e.topic === ourTopic);
    assert.equal(finalEntry?.state, 'vod', 'the entry must end as VOD');
    assert.ok(
      (finalEntry?.duration ?? 0) > 0,
      `a VOD entry must carry a positive duration; got ${finalEntry?.duration}`,
    );
    assert.equal(finalEntry?.owner, feed.owner, 'the entry owner must match the catalog feed owner');
  });
});
