import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import {
  isContiguous,
  parseUploaderLog,
  publishedRenditions,
  segmentIndicesByStream,
} from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { type CatalogFeed, discoverCatalogFeed, fetchCatalog } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Service — two concurrent live streams upload independently. The uploader must track both in
 * activeStreams, give each its own catalog entry (distinct topic), and finalize each to its own VOD
 * — no cross-talk, no spurious discontinuity from the concurrency. Per-stream segments can't be
 * split from the logs (the "Segment N uploaded" line has no stream id), so streams are told apart by
 * their distinct catalog entries and counted via /health.
 */

// Each stream's catalog entry is a deferred feed write through the single bee-uploader node; two
// distinct live entries can take minutes to both surface on the gateway-served catalog while the
// pusher drains a segment backlog. Generous on purpose — an accepted propagation-latency budget.
const ACTIVE_WAIT_MS = 300_000;
const IDLE_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('service — two concurrent streams upload independently', () => {
  // A second, distinct stream on the same engine app (`…/stream` → `…/stream2`) so both engines get
  // a valid concurrent path — OME apps must stay `video`/`audio`, so a fixed `live/…` won't do.
  const secondStreamPath = `${cfg.streamPath}2`;
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let first: Publisher;
  let second: Publisher;
  let feed: CatalogFeed;
  let baselineTopics: Set<string>;
  let startedAt: string;

  const safeFetch = async () => {
    try {
      return await fetchCatalog(host, cfg, feed);
    } catch {
      return [];
    }
  };
  const freshLiveTopics = async (): Promise<string[]> => [
    ...new Set(
      (await safeFetch()).filter((e) => !baselineTopics.has(e.topic) && e.state === 'live').map((e) => e.topic),
    ),
  ];

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    feed = await discoverCatalogFeed(host, cfg);
    await waitForIdle(host, cfg);
    // Deliberately NOT the swallowing `safeFetch`. A failed read here yields an empty baseline, and
    // an empty baseline makes every entry look new — including the previous scenario's, which is
    // still `live` on the gateway because these suites run serially and that catalog lags by
    // minutes. The wait below would then latch onto a stream this test never published. The read
    // carries an 8s deadline while these tests budget 300s for the gateway, so it timing out is the
    // ordinary case rather than an exotic one. On the polls `safeFetch` stays, because there "not
    // ready yet" is a real answer.
    baselineTopics = new Set((await fetchCatalog(host, cfg, feed)).map((e) => e.topic));
    startedAt = await host.nowIso();
    first = startPublisher(cfg);
    second = startPublisher(cfg, { streamPath: secondStreamPath });
  });

  after(async () => {
    await first?.stop();
    await second?.stop();
  });

  it('runs both live at once, each with its own catalog entry, then finalizes both as VOD', async () => {
    // The poll swallows a failed read: two concurrent ladders are eight transcodes and eight rung
    // uploads, and one health probe timing out under that load must cost a poll, not the scenario.
    const activeStreams = async (): Promise<number> => {
      try {
        return (await uploaderHealth(host, cfg)).activeStreams;
      } catch {
        return -1;
      }
    };
    await waitFor(async () => (await activeStreams()) >= 2, {
      timeoutMs: ACTIVE_WAIT_MS,
      intervalMs: 3_000,
      label: 'both streams register as active (activeStreams >= 2)',
    });

    let ourTopics: string[] = [];
    await waitFor(
      async () => {
        ourTopics = await freshLiveTopics();
        return ourTopics.length >= 2;
      },
      {
        timeoutMs: ACTIVE_WAIT_MS,
        intervalMs: 3_000,
        label: 'two distinct live entries appear in the gateway catalog',
      },
    );
    assert.ok(ourTopics.length >= 2, `expected two distinct concurrent streams; got topics: ${ourTopics.join(',')}`);

    const duringConcurrency = parseUploaderLog(await host.logsSince(uploader, startedAt));
    assert.equal(
      duringConcurrency.discontinuitiesArmed,
      0,
      `concurrent streams (no fault) must not arm a discontinuity; armed: ${duringConcurrency.discontinuitiesArmed}` +
        ` (upload-failure segments: ${duringConcurrency.discontinuitySegments.join(',')})`,
    );

    await first.stop();
    await second.stop();

    await waitFor(async () => (await activeStreams()) === 0, {
      timeoutMs: IDLE_WAIT_MS,
      intervalMs: 3_000,
      label: 'both streams finalize and activeStreams returns to 0',
    });

    // The uploader finalizes both to VOD at once, but that catalog write reaches the gateway on the
    // same deferred single-node path — poll until both entries flip rather than reading once. This
    // only tolerates propagation latency; the assertions below still require both to end as VOD.
    await waitFor(
      async () => {
        const settled = (await safeFetch()).filter((e) => ourTopics.includes(e.topic));
        return settled.length === ourTopics.length && settled.every((e) => e.state === 'vod');
      },
      {
        timeoutMs: IDLE_WAIT_MS,
        intervalMs: 3_000,
        label: 'both concurrent streams flip to VOD in the gateway catalog',
      },
    );

    const finalCatalog = await safeFetch();
    const mine = finalCatalog.filter((e) => ourTopics.includes(e.topic));
    assert.equal(mine.length, ourTopics.length, 'both concurrent streams must remain in the catalog');
    for (const entry of mine) {
      assert.equal(entry.state, 'vod', `stream ${entry.topic} must finalize as VOD`);
      assert.ok(
        (entry.duration ?? 0) > 0,
        `stream ${entry.topic} VOD must carry a positive duration; got ${entry.duration}`,
      );
    }
  });

  /**
   * ⭐ The ladder half, which nothing asked until 2026-08-30.
   *
   * Every ABR suite in this repo runs ONE broadcast. Two concurrent ladders are eight ffmpeg
   * transcodes and eight rung uploads through one bee node, which is a materially different load
   * from the one the ladder was ever tested under, and a rung silently missing from the SECOND
   * stream passes every assertion above: it has its own catalog entry, it goes live, it finalises.
   *
   * ⛔ Reads the same log the case above already produced, so it costs no extra broadcast.
   *
   * ⛔ Compared against what the deployment declares rather than against a count. "Four rungs
   * appeared" is satisfied by one stream publishing four and the other publishing none.
   */
  it('gives BOTH concurrent streams the whole ladder, gaplessly', { skip: abrOff(cfg.abrEnabled) }, async () => {
    const text = await host.logsSince(uploader, startedAt);

    const rungsByLadder = new Map<string, Set<string>>();
    for (const publish of publishedRenditions(text)) {
      const seen = rungsByLadder.get(publish.ladder) ?? new Set<string>();
      seen.add(publish.rung);
      rungsByLadder.set(publish.ladder, seen);
    }

    assert.equal(
      rungsByLadder.size,
      2,
      `two concurrent broadcasts should publish two ladders and this log carries ${rungsByLadder.size}: ` +
        `${[...rungsByLadder.keys()].join(', ') || 'none'}. A ladder missing entirely is a stream that ` +
        'transcoded nothing while still taking a catalog entry',
    );

    for (const [ladder, rungs] of rungsByLadder) {
      const missing = cfg.abrRungs.filter((rung) => !rungs.has(rung));
      assert.deepEqual(
        missing,
        [],
        `ladder ${ladder} published ${[...rungs].join(', ')} and the deployment declares ` +
          `${cfg.abrRungs.join(', ')}. Under concurrency one stream can carry the whole ladder while the ` +
          'other quietly drops a rung, and every other assertion in this file still passes',
      );
    }

    // Per rung-stream, for the reason `bee-outage-short` gives: the merged view of a ladder's
    // counters holes at window boundaries while no rung has lost anything, and can mask a real
    // one-rung gap behind a sibling's healthy index.
    for (const [streamId, indices] of segmentIndicesByStream(text)) {
      assert.ok(
        isContiguous(indices),
        `segment indices of ${streamId} must be gapless while a second ladder publishes beside it; ` +
          `got: ${indices.join(',')}`,
      );
    }
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no ladder to publish twice';
}
