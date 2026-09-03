import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  announcedRungs,
  isContiguous,
  ladderRungs,
  parseUploaderLog,
  publishedRenditions,
  segmentUploads,
} from '../../src/harness/logwatch.js';
import { checkPublishedTimeline, publishingRungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
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
 * The uploader's own log is the assertion source for everything about the ladder's SHAPE, as it is
 * for every upload-side suite here. That makes the observable facts "which rungs published" and "did
 * their segments stay gapless". The master playlist is written to a feed rather than logged, so
 * **this suite does not assert that the master is correct**. `packages/shared/test/masterPlaylist.test.ts`
 * owns the master's text and `packages/client/test/ladderSource.test.ts` owns reading it back. Saying
 * so here rather than implying broader coverage than there is.
 *
 * ⭐ The last case is the exception, and it reads the rung playlists themselves. Every rung of one
 * ladder derives its media sequence and its `#EXT-X-PROGRAM-DATE-TIME` from a single anchor, so that
 * segment N of 360p and segment N of 1080p cover the same interval and a level switch lands where the
 * player expects. Nothing in the log can show that, because the log names each rung's own engine
 * index. See `src/harness/manifestContractLive.ts`.
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
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
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

  /**
   * Counted in segments rather than in catalog announces, because the announce cadence is the
   * catalog's refresh interval: waiting for four announces per rung is minutes of broadcast, while
   * four segments per rung is seconds, and segments are the thing a stalled rung stops producing.
   */
  it('keeps each rung publishing, rather than one rung carrying the broadcast', async () => {
    await waitFor(
      async () => {
        const counts = segmentCountsByRung(await log());
        return cfg.abrRungs.every((rung) => (counts.get(rung) ?? 0) >= TARGET_SEGMENTS_PER_RUNG);
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 3_000,
        label: `every rung uploads ${TARGET_SEGMENTS_PER_RUNG} segments`,
      },
    );

    const counts = segmentCountsByRung(await log());
    for (const rung of cfg.abrRungs) {
      assert.ok(
        (counts.get(rung) ?? 0) >= TARGET_SEGMENTS_PER_RUNG,
        `rung ${rung} uploaded ${counts.get(rung) ?? 0} segments, the others reached ${TARGET_SEGMENTS_PER_RUNG}`,
      );
    }
  });

  /**
   * The ladder must not cost the property the single-rendition path already has. Four rungs are four
   * independent segment counters, and the merged deduplicated view can mask a one-rung gap behind a
   * sibling's healthy index just as easily as it can invent one, so contiguity is judged per rung
   * stream and never on the merge. Found 2026-08-27: the merged view read a healthy ladder as chaos.
   */
  it('arms no discontinuity and loses no segment, as the single-rendition path does not', async () => {
    const text = await log();
    const uploads = segmentUploads(text);

    assert.ok(uploads.length > 0, 'no segment uploaded at all, so nothing here is a ladder result');
    for (const streamId of new Set(uploads.map((upload) => upload.streamId))) {
      const indices = uploads.filter((upload) => upload.streamId === streamId).map((upload) => upload.index);
      assert.ok(isContiguous(indices), `segment indices of ${streamId} must be gapless; got: ${indices.join(',')}`);
    }
    assert.equal(parseUploaderLog(text).discontinuitiesArmed, 0, 'transcoding a ladder should not arm a discontinuity');
  });

  /**
   * Every rung's playlist declares a sound timeline of its own, which is what makes them one ladder.
   *
   * ⛔ Last in the file on purpose. The cases above have already waited for every rung to upload
   * several segments, so by here each rung's feed holds a playlist rather than nothing, and a rung
   * that is merely announced cannot make this red for a reason the suite is not about.
   *
   * ⛔ Nothing here is judged on the clock. Whether a live window still starts at the broadcast's
   * first segment, and therefore whether `#EXT-X-MEDIA-SEQUENCE:0` is owed, is settled by comparing
   * the playlist against what its rung has published rather than by how long the broadcast has run.
   */
  it('declares a sound timeline on every rung, with the sequence and the wall clock the log cannot show', async () => {
    const { owner } = await discoverCatalogFeed(host, cfg);
    const rungs = publishingRungFeedsOf(await log());

    const verdict = await checkPublishedTimeline(host, cfg, {
      owner,
      rungs,
      expectation: cfg.segmentExpectation,
      logAfterTheRead: log,
    });

    console.log(verdict.summary);
    assert.equal(verdict.refusal, null, verdict.refusal ?? '');
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no ladder to observe';
}

/** Segment counts per rung, joined through the announces: only they know which stream is which rung. */
function segmentCountsByRung(text: string): Map<string, number> {
  const rungOf = new Map(announcedRungs(text).map((announce) => [announce.streamId, announce.rung]));
  const counts = new Map<string, number>();
  for (const upload of segmentUploads(text)) {
    const rung = rungOf.get(upload.streamId);
    if (rung !== undefined) {
      counts.set(rung, (counts.get(rung) ?? 0) + 1);
    }
  }
  return counts;
}
