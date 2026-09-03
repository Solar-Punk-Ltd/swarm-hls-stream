import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  programDateTimeMsOf,
  reanchorEpoch,
  SAME_RESTART_TOLERANCE_MS,
  withEpoch,
} from '../src/libs/broadcastDating.js';
import { BroadcastAnchor } from '../src/types.js';

/**
 * What dates a broadcast's playlists once the engine has restarted inside it.
 *
 * A broadcast's dating is a list of epochs rather than one instant. Segment N is dated from the
 * newest epoch that starts at or below N, stepping by the declared fragment length, and the
 * broadcast's own start is the implicit first epoch. An engine restart adds one, so the media after
 * the gap carries the real time it happened while the media before it keeps the date it was
 * published with.
 *
 * ⛔ The two things these hold together pull in opposite directions. A restart must move the dating
 * on to the wall clock, and every rung of one ABR ladder must still date a given sequence
 * identically, because hls.js reads four rungs disagreeing about the same media as four rungs
 * covering different media. So the restart's dating is minted once and every rung reads that one
 * line, wherever its own numbering happened to be when the engine died.
 */

const FRAGMENT_SECONDS = 2;
const STEP_MS = FRAGMENT_SECONDS * 1000;
const STARTED_AT_MS = Date.UTC(2026, 8, 1, 12, 0, 0);

const BROADCAST: BroadcastAnchor = { startedAtMs: STARTED_AT_MS, fragmentSeconds: FRAGMENT_SECONDS };

/** The date the original anchor puts on a sequence, which is what a re-anchoring moves away from. */
function nominalDateOf(sequence: number): number {
  return STARTED_AT_MS + sequence * STEP_MS;
}

describe('the date a playlist sequence carries', () => {
  it('steps from the broadcast’s start while nothing has re-anchored', () => {
    assert.equal(programDateTimeMsOf(BROADCAST, 0), STARTED_AT_MS);
    assert.equal(programDateTimeMsOf(BROADCAST, 7), STARTED_AT_MS + 7 * STEP_MS);
  });

  it('steps from an epoch for every sequence at or above it', () => {
    const restarted = withEpoch(BROADCAST, { fromSequence: 10, atMs: STARTED_AT_MS + 600_000 });

    assert.equal(programDateTimeMsOf(restarted, 10), STARTED_AT_MS + 600_000);
    assert.equal(programDateTimeMsOf(restarted, 12), STARTED_AT_MS + 600_000 + 2 * STEP_MS);
  });

  /**
   * The half of the shape that keeps a published playlist honest. Those segments are in a window a
   * viewer is holding, and re-dating them would move media that has already gone out.
   */
  it('leaves every sequence below an epoch on the dating it was published with', () => {
    const restarted = withEpoch(BROADCAST, { fromSequence: 10, atMs: STARTED_AT_MS + 600_000 });

    assert.equal(programDateTimeMsOf(restarted, 9), nominalDateOf(9));
    assert.equal(programDateTimeMsOf(restarted, 0), STARTED_AT_MS);
  });

  it('reads the newest epoch of several, in the order they were minted', () => {
    const twice = withEpoch(withEpoch(BROADCAST, { fromSequence: 10, atMs: 10_000 }), {
      fromSequence: 20,
      atMs: 90_000,
    });

    assert.equal(programDateTimeMsOf(twice, 15), 10_000 + 5 * STEP_MS);
    assert.equal(programDateTimeMsOf(twice, 21), 90_000 + STEP_MS);
  });

  it('rounds to the millisecond, which is all a stamp can carry', () => {
    const third: BroadcastAnchor = { startedAtMs: 0, fragmentSeconds: 1 / 3 };

    assert.equal(programDateTimeMsOf(third, 1), 333);
    assert.equal(programDateTimeMsOf(third, 3), 1000);
  });
});

describe('adding an epoch to a broadcast’s dating', () => {
  it('leaves the anchor it was given untouched', () => {
    const before = { ...BROADCAST };

    withEpoch(BROADCAST, { fromSequence: 4, atMs: 1 });

    assert.deepEqual(BROADCAST, before, 'the anchor was mutated in place, so a retired session’s dates moved with it');
  });

  it('keeps the epochs it dates after', () => {
    const twice = withEpoch(withEpoch(BROADCAST, { fromSequence: 10, atMs: 10_000 }), {
      fromSequence: 20,
      atMs: 90_000,
    });

    assert.deepEqual(twice.epochs, [
      { fromSequence: 10, atMs: 10_000 },
      { fromSequence: 20, atMs: 90_000 },
    ]);
  });

  /**
   * A re-announced session publishes a fresh playlist numbered from zero, so its epoch starts at
   * zero and every earlier one is about numbering nothing will publish again.
   */
  it('supersedes the epochs it dates over, so the list stays in sequence order', () => {
    const restarted = withEpoch(BROADCAST, { fromSequence: 10, atMs: 10_000 });

    const renumbered = withEpoch(restarted, { fromSequence: 0, atMs: 90_000 });

    assert.deepEqual(renumbered.epochs, [{ fromSequence: 0, atMs: 90_000 }]);
  });
});

describe('the epoch a rung takes when its numbering resumes after a restart', () => {
  const RESTARTED_AT_MS = STARTED_AT_MS + 600_000;

  it('dates the resuming sequence at the wall clock, not one fragment on from the gap', () => {
    const epoch = reanchorEpoch(BROADCAST, { resumeAt: 40, nowMs: RESTARTED_AT_MS, notBeforeMs: nominalDateOf(40) });

    assert.deepEqual(epoch, { fromSequence: 40, atMs: RESTARTED_AT_MS });
  });

  /**
   * ⚠️ The stamps are nominal, so on a stream whose segments run longer than `HLS_FRAGMENT` the
   * dating is ahead of the clock by the excess of every segment so far. Minting at the clock there
   * would move a stamp backwards, which hls.js reads as a parsing error rather than as a restart.
   */
  it('never dates it before the segment in front of it, however far the dating has run ahead', () => {
    // Thirty seconds of segment length the stamps never charged for, against a clock that says the
    // restart happened before the dating had got to.
    const aheadOfTheClock = nominalDateOf(40) + 30_000;
    const clockBehindTheDating = nominalDateOf(40) + 20_000;

    const epoch = reanchorEpoch(BROADCAST, {
      resumeAt: 40,
      nowMs: clockBehindTheDating,
      notBeforeMs: aheadOfTheClock,
    });

    assert.equal(epoch.atMs, aheadOfTheClock);
  });

  /**
   * ⛔ The broadcast's own start is never reused. It is where the dating began rather than a
   * re-anchoring, and reusing it is exactly the lag this whole shape removes.
   */
  it('re-anchors on the first restart rather than keeping the broadcast’s start', () => {
    const epoch = reanchorEpoch(BROADCAST, {
      resumeAt: 2,
      nowMs: STARTED_AT_MS + 4_000,
      notBeforeMs: nominalDateOf(2),
    });

    assert.equal(epoch.atMs, STARTED_AT_MS + 4_000);
  });

  describe('a sibling rung crossing the same restart', () => {
    const minted = withEpoch(BROADCAST, { fromSequence: 40, atMs: RESTARTED_AT_MS });

    it('takes the epoch the first rung minted, so the two agree on the same sequence', () => {
      const epoch = reanchorEpoch(minted, {
        resumeAt: 40,
        nowMs: RESTARTED_AT_MS + 1_200,
        notBeforeMs: nominalDateOf(40),
      });

      assert.deepEqual(epoch, { fromSequence: 40, atMs: RESTARTED_AT_MS });
    });

    /**
     * The 1080p rung is routinely the one behind, because it is the slowest to transcode and the
     * slowest to upload. It resumes one sequence lower than its siblings, and it has to land on
     * their line rather than start one of its own: the mapping from sequence to date is what the
     * ladder agrees on, never the point it is written down at.
     */
    it('lands on that line one fragment earlier when it is one sequence behind', () => {
      const epoch = reanchorEpoch(minted, {
        resumeAt: 39,
        nowMs: RESTARTED_AT_MS + 1_200,
        notBeforeMs: nominalDateOf(39),
      });

      assert.deepEqual(epoch, { fromSequence: 39, atMs: RESTARTED_AT_MS - STEP_MS });
    });

    it('lands on that line one fragment later when it is one sequence ahead', () => {
      const epoch = reanchorEpoch(minted, {
        resumeAt: 41,
        nowMs: RESTARTED_AT_MS + 1_200,
        notBeforeMs: nominalDateOf(41),
      });

      assert.deepEqual(epoch, { fromSequence: 41, atMs: RESTARTED_AT_MS + STEP_MS });
    });

    /**
     * A rung behind its siblings still dates its own first post-restart segment after the segment in
     * front of it, and that holds without a floor because every rung was on one line before the
     * restart too. The minted instant is at or after the date the leader's resuming sequence would
     * have carried, so a rung `k` sequences behind lands at or after its own.
     */
    it('still moves forwards from the segment in front of it', () => {
      const epoch = reanchorEpoch(minted, {
        resumeAt: 39,
        nowMs: RESTARTED_AT_MS + 1_200,
        notBeforeMs: nominalDateOf(39),
      });

      assert.ok(
        epoch.atMs > nominalDateOf(38),
        `a rung one behind its siblings dated its resuming segment at ${new Date(epoch.atMs).toISOString()}, ` +
          `at or before the ${new Date(nominalDateOf(38)).toISOString()} of the segment in front of it`,
      );
    });

    it('keeps taking that line for as long as the restart is recognisable', () => {
      const epoch = reanchorEpoch(minted, {
        resumeAt: 40,
        nowMs: RESTARTED_AT_MS + SAME_RESTART_TOLERANCE_MS - 1,
        notBeforeMs: nominalDateOf(40),
      });

      assert.equal(epoch.atMs, RESTARTED_AT_MS);
    });
  });

  /**
   * ⛔ Two restarts must not collapse into one, and a time window alone cannot tell them apart: an
   * engine that comes back, publishes two segments and dies again re-anchors twice within a couple
   * of fragments of media. What separates them is that the first restart's line no longer dates this
   * rung's media as happening now, because the second outage passed with no sequence advancing.
   */
  it('re-anchors again for a restart the earlier line no longer dates as now', () => {
    const minted = withEpoch(BROADCAST, { fromSequence: 40, atMs: RESTARTED_AT_MS });
    const secondRestartAtMs = RESTARTED_AT_MS + 2 * STEP_MS + 600_000;

    const epoch = reanchorEpoch(minted, {
      resumeAt: 42,
      nowMs: secondRestartAtMs,
      notBeforeMs: RESTARTED_AT_MS + 2 * STEP_MS,
    });

    assert.deepEqual(epoch, { fromSequence: 42, atMs: secondRestartAtMs });
  });

  it('re-anchors the whole playlist when a replacement session numbers from zero again', () => {
    const epoch = reanchorEpoch(BROADCAST, { resumeAt: 0, nowMs: RESTARTED_AT_MS, notBeforeMs: 0 });

    assert.deepEqual(epoch, { fromSequence: 0, atMs: RESTARTED_AT_MS });
  });

  it('gives the second replacement session to re-announce the same epoch as the first', () => {
    const minted = withEpoch(BROADCAST, { fromSequence: 0, atMs: RESTARTED_AT_MS });

    const epoch = reanchorEpoch(minted, { resumeAt: 0, nowMs: RESTARTED_AT_MS + 3_000, notBeforeMs: 0 });

    assert.deepEqual(epoch, { fromSequence: 0, atMs: RESTARTED_AT_MS });
  });

  /**
   * A rung that resumes its numbering mid-playlist must not adopt a replacement session's epoch at
   * sequence zero, which would date its media five hundred fragments into the future.
   */
  it('refuses an epoch that dates this rung’s sequence nowhere near now', () => {
    const renumbered = withEpoch(BROADCAST, { fromSequence: 0, atMs: RESTARTED_AT_MS });

    const epoch = reanchorEpoch(renumbered, {
      resumeAt: 500,
      nowMs: RESTARTED_AT_MS + 4_000,
      notBeforeMs: nominalDateOf(500),
    });

    assert.notEqual(
      epoch.atMs,
      RESTARTED_AT_MS + 500 * STEP_MS,
      'the rung took a replacement session’s line and dated its media five hundred fragments into the future',
    );
    assert.ok(epoch.atMs >= nominalDateOf(500), 'the rung dated its resuming segment before the one in front of it');
  });
});
