import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { isContiguous, ladderRungs, parseUploaderLog, publishedRenditions } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Service — an ABR ladder publishes every rung, not just the one being watched.
 *
 * The baseline the ABR fault scenarios deviate from, and the counterpart to `happy-path.test.ts`,
 * which covers the single-rendition case. One publisher pushes one source stream; SRS transcodes it
 * into the configured rungs on the ABR vhost and the uploader ingests each rung as its own stream,
 * writing each to its own feed and grouping them into one ladder.
 *
 * ## What this can see, and what it cannot
 *
 * The uploader's own log is the assertion source, as it is for every upload-side suite here. That
 * makes the observable facts "which rungs published" and "did their segments stay gapless". The
 * master playlist is written to a feed rather than logged, so **this suite does not assert that the
 * master is correct** — `packages/shared/test/masterPlaylist.test.ts` owns the master's text and
 * `packages/client/test/ladderSource.test.ts` owns reading it back. Saying so here rather than
 * implying broader coverage than there is.
 *
 * ## Skipped rather than failed on a single-rendition deployment
 *
 * `ABR_ENABLED` is the deployment's choice and not this suite's, so a stack running one rendition
 * makes these cases inapplicable. See `abrEnabled` in `src/config.ts`.
 *
 * ⛔ Requires a deployed profile and a funded stamp, like every suite under `suites/`. Nothing in
 * CI runs these.
 */

const TARGET_SEGMENTS_PER_RUNG = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('service — ABR ladder: every rung publishes and stays gapless', { skip: abrOff(cfg.abrEnabled) }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  const log = async () => host.logsSince(uploader, startedAt);

  it('publishes every rung the deployment configured, under one ladder', async () => {
    // Waits on the *count* of distinct rungs rather than on a rung list, because a ladder that comes
    // up one rung short would otherwise satisfy a `some` check and pass.
    const expected = cfg.abrRungs.length;
    assert.ok(
      expected > 1,
      'ABR_LADDER names fewer than two rungs, so this asserts nothing: set it explicitly rather ' +
        'than leaving the engine to its default, which this suite cannot see',
    );

    await waitFor(async () => ladderRungs(await log()).length >= expected, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `all ${expected} rungs publish (check the SRS transcode block if this stalls)`,
    });

    const text = await log();
    assert.deepEqual(
      [...ladderRungs(text)].sort(),
      [...cfg.abrRungs].sort(),
      'the rungs that published are not the rungs ABR_LADDER names',
    );
  });

  it('groups every rung into the same ladder, or a viewer gets one rung and no ABR', async () => {
    const groups = new Set(publishedRenditions(await log()).map((publish) => publish.ladder));

    assert.equal(groups.size, 1, `rungs were split across ladders: ${[...groups].join(', ')}`);
  });

  it('keeps each rung publishing, rather than one rung carrying the broadcast', async () => {
    await waitFor(
      async () => {
        const counts = countByRung(publishedRenditions(await log()));
        return [...counts.values()].every((n) => n >= TARGET_SEGMENTS_PER_RUNG);
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 3_000,
        label: `every rung reaches ${TARGET_SEGMENTS_PER_RUNG} publishes`,
      },
    );

    const counts = countByRung(publishedRenditions(await log()));
    for (const rung of cfg.abrRungs) {
      assert.ok(
        (counts.get(rung) ?? 0) >= TARGET_SEGMENTS_PER_RUNG,
        `rung ${rung} published ${counts.get(rung) ?? 0} times, the others reached ${TARGET_SEGMENTS_PER_RUNG}`,
      );
    }
  });

  /**
   * The ladder must not cost the property the single-rendition path already has. Segment indices are
   * reported per uploader session across all rungs, so this is the whole broadcast's run rather than
   * one rung's, which is exactly the level a discontinuity would show up at.
   */
  it('arms no discontinuity and loses no segment, as the single-rendition path does not', async () => {
    const events = parseUploaderLog(await log());

    assert.ok(events.uploadedSegments.length > 0, 'no segment uploaded at all, so nothing here is a ladder result');
    assert.ok(
      isContiguous(events.uploadedSegments),
      `ladder segment indices must be gapless; got: ${events.uploadedSegments.join(',')}`,
    );
    assert.equal(events.discontinuitiesArmed, 0, 'transcoding a ladder should not arm a discontinuity');
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no ladder to observe';
}

function countByRung(publishes: readonly { rung: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const publish of publishes) {
    counts.set(publish.rung, (counts.get(publish.rung) ?? 0) + 1);
  }
  return counts;
}
