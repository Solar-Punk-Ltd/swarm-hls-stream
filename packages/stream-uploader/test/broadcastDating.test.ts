import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  datedDurationMs,
  DATING_SNAP_TOLERANCE,
  presentationMsOf,
  programDateTimeMsOf,
  reanchorDecision,
  reanchorEpoch,
  SAME_RESTART_TOLERANCE_MS,
  withEpoch,
} from '../src/libs/broadcastDating.js';
import { FRAGMENT_TOLERANCE } from '../src/libs/fragmentAgreement.js';
import { BroadcastAnchor } from '../src/types.js';

/**
 * What dates a broadcast's playlists once the engine has restarted inside it.
 *
 * A broadcast's dating is a list of epochs rather than one instant. The first segment placed at or
 * after an epoch takes that epoch's instant, every segment after it is dated from the one in front
 * of it plus the media that one holds, and the broadcast's own start is the implicit first epoch. An
 * engine restart adds one, so the media after the gap carries the real time it happened while the
 * media before it keeps the date it was published with.
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

/**
 * How much media a segment contributes to the date of the one after it.
 *
 * ⛔ The snapping is what keeps a ladder's rungs agreeing. Under `ABR_ENABLED` every rung is
 * re-encoded with a keyframe every `ABR_FPS x HLS_FRAGMENT` frames, so each rung's segment holds the
 * configured length to within 90kHz tick rounding, and reading every one of those as the configured
 * length makes four rungs date the same media identically. Outside the tolerance the measurement is
 * the only honest answer: on a single rendition the publisher's own keyframe interval decides the
 * segment, and dating a 10 second segment as 2 puts the recording's clock 8 seconds behind its own
 * media and leaves it there.
 */
describe('the media a segment contributes to the date of the next one', () => {
  it('reads a measurement inside the tolerance as the configured length, so a ladder agrees', () => {
    assert.equal(datedDurationMs(1.001, 1), 1000);
    assert.equal(datedDurationMs(0.999, 1), 1000);
    assert.equal(datedDurationMs(2.015, 2), 2000);
  });

  it('reads a measurement outside the tolerance as itself', () => {
    assert.equal(datedDurationMs(2.067, 2), 2067);
    assert.equal(datedDurationMs(2.4, 2), 2400);
    assert.equal(datedDurationMs(10.033, 2), 10_033);
    assert.equal(datedDurationMs(1, 2), 1000);
  });

  /**
   * ⛔ The two tolerances answer different questions and must not be made one number. The agreement
   * check asks whether this stage is misconfigured, so it is wide enough to survive a force-closed
   * segment. This one only absorbs the tick rounding several encoders put on one keyframe grid.
   *
   * ⛔ The gap between them is not academic: it is exactly the live reading this dating exists for.
   * 2.067 seconds against a configured 2 is inside five percent, so the agreement check calls the
   * stage healthy, which it is. Dating it as 2.000 would lose 67ms per segment for ever, about two
   * minutes an hour.
   */
  it('snaps on its own band rather than on the agreement check’s, which is five times wider', () => {
    const justInside = 2 * (1 + DATING_SNAP_TOLERANCE) - 0.001;
    const justOutside = 2 * (1 + DATING_SNAP_TOLERANCE) + 0.001;

    assert.equal(datedDurationMs(justInside, 2), 2000);
    assert.equal(datedDurationMs(justOutside, 2), Math.round(justOutside * 1000));

    assert.ok(DATING_SNAP_TOLERANCE < FRAGMENT_TOLERANCE, 'the dating snapped on the agreement check’s band');
    assert.ok(Math.abs(2.067 - 2) <= 2 * FRAGMENT_TOLERANCE, 'the agreement check no longer calls 2.067 a healthy 2');
    assert.equal(datedDurationMs(2.067, 2), 2067);
  });

  /**
   * ⭐ The band is inclusive, and this pins that rather than sitting a millisecond either side of it.
   * A fragment of 1.21 is chosen because its band is exactly 0.0121 in binary floating point, so
   * `1.2221` and `1.1979` land ON the edge rather than near it. At a fragment of 2 the same attempt
   * is not honest: `Math.abs(1.98 - 2)` is 0.020000000000000018 against a band of 0.02, a float hair
   * outside.
   *
   * Without these the comparison could be narrowed from `<=` to `<` with the suite still green:
   * every measured value the suite used sat clear of the edge on one side or the other, so the
   * mutant survived. One millisecond of band is small, and an arithmetic line nothing pins is not.
   */
  it('takes a measurement exactly on the band as the configured length, on both sides of it', () => {
    const fragment = 1.21;
    const band = fragment * DATING_SNAP_TOLERANCE;
    assert.equal(band, 0.0121, 'the point of this fragment length is that its band is exact');

    assert.equal(datedDurationMs(fragment + band, fragment), 1210);
    assert.equal(datedDurationMs(fragment - band, fragment), 1210);
  });

  /**
   * The lower side of the band, which nothing covered at all. A segment measuring 1.98 against a
   * configured 2 is dated as the 1.980 it really held, so a stage cutting short keeps its clock the
   * same way a stage cutting long does. `ManifestManager.test.ts` used to carry this value and moved
   * off it, which left the direction untested everywhere.
   */
  it('reads a measurement just below the band as itself, not as the configured length', () => {
    assert.equal(datedDurationMs(1.98, 2), 1980);
  });

  it('rounds to the millisecond, which is all a stamp can carry', () => {
    assert.equal(datedDurationMs(2.4567, 2), 2457);
  });
});

/**
 * When a segment is presented, which is decided once as it is placed and then never derived again.
 *
 * The anchor plus the media held in front of it, never an arrival time. A missing sequence is media
 * nobody observed, so it is charged at the configured length, which is also the `#EXTINF` its gap
 * entry carries.
 */
describe('when a placed segment is presented', () => {
  it('dates the first segment of a broadcast at the anchor itself', () => {
    assert.equal(presentationMsOf(BROADCAST, 0, null), STARTED_AT_MS);
  });

  it('dates a segment from the one in front of it plus the media that one holds', () => {
    const previous = { sequence: 4, presentedAtMs: STARTED_AT_MS, durationSeconds: 2.4 };

    assert.equal(presentationMsOf(BROADCAST, 5, previous), STARTED_AT_MS + 2400);
  });

  it('steps by the configured length where the one in front measured within tolerance', () => {
    const previous = { sequence: 4, presentedAtMs: STARTED_AT_MS, durationSeconds: 1.995 };

    assert.equal(presentationMsOf(BROADCAST, 5, previous), STARTED_AT_MS + STEP_MS);
  });

  it('charges the configured length for every sequence nobody observed', () => {
    const previous = { sequence: 4, presentedAtMs: STARTED_AT_MS, durationSeconds: 2.4 };

    assert.equal(presentationMsOf(BROADCAST, 8, previous), STARTED_AT_MS + 2400 + 3 * STEP_MS);
  });

  it('takes the epoch itself for the first segment placed at or after a re-anchoring', () => {
    const restarted = withEpoch(BROADCAST, { fromSequence: 10, atMs: STARTED_AT_MS + 600_000 });
    const before = { sequence: 9, presentedAtMs: nominalDateOf(9), durationSeconds: 2.4 };

    assert.equal(presentationMsOf(restarted, 10, before), STARTED_AT_MS + 600_000);
  });

  it('carries on from the media held once a segment of that epoch has been placed', () => {
    const restarted = withEpoch(BROADCAST, { fromSequence: 10, atMs: STARTED_AT_MS + 600_000 });
    const resumed = { sequence: 10, presentedAtMs: STARTED_AT_MS + 600_000, durationSeconds: 2.4 };

    assert.equal(presentationMsOf(restarted, 11, resumed), STARTED_AT_MS + 600_000 + 2400);
  });

  /**
   * Nothing is held where a restart is asking what its resuming sequence would have been dated, and
   * the epoch's own arithmetic is the answer that was right before any media was observed.
   */
  it('falls back to the epoch’s own arithmetic where nothing has been placed', () => {
    const restarted = withEpoch(BROADCAST, { fromSequence: 10, atMs: STARTED_AT_MS + 600_000 });

    assert.equal(presentationMsOf(restarted, 12, null), STARTED_AT_MS + 600_000 + 2 * STEP_MS);
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
   * ⛔⛔ **An epoch above the new one is KEPT, and dropping it cost a ladder its agreement.** The list
   * belongs to the whole broadcast, so a rung joining a line from a sequence below its siblings' is
   * writing down its own point on their line rather than superseding it. Truncating above the join
   * left a third rung asking at the original sequence with nothing to join, so it minted a line of
   * its own and the ladder dated one instant two ways.
   *
   * Nothing dated before the join moves: {@link epochFor} walks back to the newest epoch at or below
   * the sequence it is dating, so a sequence above the join still finds the epoch it always found.
   */
  it('keeps an epoch above the new one, and stays in sequence order', () => {
    const restarted = withEpoch(BROADCAST, { fromSequence: 10, atMs: 10_000 });

    const joinedFromBelow = withEpoch(restarted, { fromSequence: 8, atMs: 9_000 });

    assert.deepEqual(joinedFromBelow.epochs, [
      { fromSequence: 8, atMs: 9_000 },
      { fromSequence: 10, atMs: 10_000 },
    ]);
    assert.equal(
      programDateTimeMsOf(joinedFromBelow, 12),
      10_000 + 2 * STEP_MS,
      'a sequence above the join must keep the line it already had',
    );
  });

  /**
   * A re-announced session publishes a fresh playlist numbered from zero, so its epoch starts at zero
   * and dates every sequence it will ever publish. The epochs above it are about numbering nothing
   * will produce again, and they are harmless where they are: `epochFor` never reaches them.
   */
  it('replaces an epoch at the same sequence rather than holding two', () => {
    const restarted = withEpoch(BROADCAST, { fromSequence: 10, atMs: 10_000 });

    const renumbered = withEpoch(restarted, { fromSequence: 10, atMs: 90_000 });

    assert.deepEqual(renumbered.epochs, [{ fromSequence: 10, atMs: 90_000 }]);
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
     * front of it. The line the leader minted is at or after the date the leader's own resuming
     * sequence would have carried, so a rung a few sequences behind lands that many fragments earlier
     * on the same line, which is at or after its own. That argument is about a rung whose media kept
     * to the grid, and the two cases below are the ones it does not reach.
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

    /**
     * ⛔⛔⛔ A line is grid arithmetic and the media is not, so a rung can join a line that names an
     * instant its own playlist has already gone past. The stage measured on 2026-09-15 cut 2.067
     * seconds against a configured 2, so every segment since the restart put the real stamps another
     * 67 milliseconds ahead of the line. A hundred segments in, the line dates the resuming sequence
     * 6.7 seconds behind the segment in front of it, and the clock is still close enough to the line
     * for this to read as the same restart.
     *
     * A date that goes backwards is not a late date. hls.js reads it as a parsing error rather than
     * as a restart, the e2e manifest contract refuses the shape before it excuses a discontinuity,
     * and a recording is sealed with it for ever.
     */
    it('never lands below the date this rung’s own media had already reached', () => {
      // What the 2026-09-15 stage really cut against a configured 2 seconds, in milliseconds. A rung
      // two sequences behind its siblings, whose own media has run this far ahead of the grid, so the
      // line it joins names an instant its playlist has already gone past.
      const MEASURED_MS = 2_067;
      const resumeAt = 38;
      const wouldHaveBeen = RESTARTED_AT_MS + 30 * (MEASURED_MS - STEP_MS);

      const { epoch, joined } = reanchorDecision(minted, {
        resumeAt,
        nowMs: RESTARTED_AT_MS + 1_200,
        notBeforeMs: wouldHaveBeen,
      });

      assert.equal(joined, true, 'the case is about the joining branch, so a mint here tests nothing');
      assert.ok(
        epoch.atMs >= wouldHaveBeen,
        `the rung dated its resuming segment at ${new Date(epoch.atMs).toISOString()}, ` +
          `${wouldHaveBeen - epoch.atMs}ms behind the ${new Date(wouldHaveBeen).toISOString()} its own media ` +
          'had already reached',
      );
    });

    /** The floor takes nothing from a rung whose media kept to the grid: the two are the same date. */
    it('lands on the line itself where the media has kept to the grid', () => {
      const onTheLine = RESTARTED_AT_MS - STEP_MS;

      const { epoch, joined } = reanchorDecision(minted, {
        resumeAt: 39,
        nowMs: RESTARTED_AT_MS + 1_200,
        notBeforeMs: onTheLine,
      });

      assert.equal(joined, true);
      assert.deepEqual(epoch, { fromSequence: 39, atMs: onTheLine });
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

/**
 * Which of the two ways a rung reached its epoch, which the epoch alone cannot say.
 *
 * ⭐ A rung landing on a sibling's line usually lands on the very date its own sequence already
 * carried, so a caller comparing the date before against the date after sees no change and has no
 * way to tell a join from a restart that moved nothing.
 */
/**
 * The other cause, and the one no clock and no sequence can judge: an encoder that went away and came
 * back.
 *
 * ⛔⛔ **Two sequence-shaped rules were tried here first and both were wrong.** The clock alone read a
 * second outage on the same rung as a sibling crossing the first one, because nothing advances while
 * an encoder is away, so the line still dates the resuming sequence as happening about now — four
 * fifty second outages measured through the orchestrator dated the second return 48 seconds behind
 * and the third 96. Keying on "at or below the minted sequence" fixed that for a lone rung and failed
 * on a ladder, because the epoch list is the whole ladder's: a rung a segment behind its siblings
 * asks below THEIR line and joins the previous return's, about half the time depending on which rung
 * came back first.
 *
 * The orchestrator witnesses a return once per rung and names it. That name is the whole test here.
 */
describe('the epoch a rung takes when its encoder came back', () => {
  const RETURNED_AT_MS = STARTED_AT_MS + 600_000;
  const THIS_RETURN = 'return-1';
  const minted = withEpoch(BROADCAST, { fromSequence: 40, atMs: RETURNED_AT_MS, returnToken: THIS_RETURN });

  it('mints a line for the first rung of a return, and names it', () => {
    const { epoch, joined } = reanchorDecision(BROADCAST, {
      resumeAt: 40,
      nowMs: RETURNED_AT_MS,
      notBeforeMs: nominalDateOf(40),
      returnToken: THIS_RETURN,
    });

    assert.equal(joined, false);
    assert.deepEqual(epoch, { fromSequence: 40, atMs: RETURNED_AT_MS, returnToken: THIS_RETURN });
  });

  /** The rung that is behind, which is the routine one: the 1080p rung is the slowest of the four. */
  it('joins the line its siblings minted from a lower sequence', () => {
    const { epoch, joined } = reanchorDecision(minted, {
      resumeAt: 39,
      nowMs: RETURNED_AT_MS + 3_000,
      notBeforeMs: nominalDateOf(39),
      returnToken: THIS_RETURN,
    });

    assert.equal(joined, true);
    assert.deepEqual(epoch, { fromSequence: 39, atMs: RETURNED_AT_MS - STEP_MS, returnToken: THIS_RETURN });
  });

  /** And the rung that is ahead, which no sequence rule could tell from a second outage. */
  it('joins that same line from a higher sequence', () => {
    const { epoch, joined } = reanchorDecision(minted, {
      resumeAt: 41,
      nowMs: RETURNED_AT_MS + 3_000,
      notBeforeMs: nominalDateOf(41),
      returnToken: THIS_RETURN,
    });

    assert.equal(joined, true);
    assert.deepEqual(epoch, { fromSequence: 41, atMs: RETURNED_AT_MS + STEP_MS, returnToken: THIS_RETURN });
  });

  /**
   * The defect the name exists for. A rung that crossed one outage, published a segment and then
   * crossed another asks about a sequence its own line still dates as happening about now, so every
   * clock-shaped test read it as a sibling and its media carried the first outage's date.
   */
  it('mints again for a later return, however close its sequence and its clock are', () => {
    const secondReturnAt = RETURNED_AT_MS + 50_000;

    const { epoch, joined } = reanchorDecision(minted, {
      resumeAt: 41,
      nowMs: secondReturnAt,
      notBeforeMs: nominalDateOf(41),
      returnToken: 'return-2',
    });

    assert.equal(joined, false, 'the second return was read as a sibling crossing the first one');
    assert.deepEqual(epoch, { fromSequence: 41, atMs: secondReturnAt, returnToken: 'return-2' });
  });

  /**
   * A rung that missed a return entirely and comes back in the next one. The line it must land on is
   * the one ITS return minted rather than the newest in the list, which is what a rule reading only
   * `epochs.at(-1)` could not express.
   */
  it('joins the return it is part of rather than the newest line in the list', () => {
    const laterReturnAt = RETURNED_AT_MS + 50_000;
    const twoReturns = withEpoch(minted, { fromSequence: 45, atMs: laterReturnAt, returnToken: 'return-2' });

    const { epoch, joined } = reanchorDecision(twoReturns, {
      resumeAt: 44,
      nowMs: laterReturnAt + 4_000,
      notBeforeMs: nominalDateOf(44),
      returnToken: 'return-2',
    });

    assert.equal(joined, true);
    assert.equal(epoch.atMs, laterReturnAt - STEP_MS, 'it landed on the wrong return’s line');
  });

  /** The floor applies to a joined line here exactly as it does for a counter restart. */
  it('never lands below the date this rung’s own media had already reached', () => {
    const ranLong = RETURNED_AT_MS + 4_000;

    const { epoch, joined } = reanchorDecision(minted, {
      resumeAt: 39,
      nowMs: RETURNED_AT_MS + 3_000,
      notBeforeMs: ranLong,
      returnToken: THIS_RETURN,
    });

    assert.equal(joined, true);
    assert.equal(epoch.atMs, ranLong);
  });
});

describe('what a re-anchoring reports about how it reached its epoch', () => {
  const RESTARTED_AT_MS = STARTED_AT_MS + 600_000;
  const MINTED = withEpoch(BROADCAST, { fromSequence: 40, atMs: RESTARTED_AT_MS });

  it('reports a mint where this restart has no line yet', () => {
    const decision = reanchorDecision(BROADCAST, {
      resumeAt: 40,
      nowMs: RESTARTED_AT_MS,
      notBeforeMs: nominalDateOf(40),
    });

    assert.deepEqual(decision, { epoch: { fromSequence: 40, atMs: RESTARTED_AT_MS }, joined: false });
  });

  /**
   * ⚠️ The tolerance is measured against where this rung lands on the line, not against the point
   * the line was minted at. A rung one sequence behind its siblings lands one fragment back down the
   * line, so its window sits one fragment earlier too.
   */
  it('reports a join where a sibling rung minted the line, anywhere inside the tolerance', () => {
    const landsAt = RESTARTED_AT_MS - STEP_MS;

    const decision = reanchorDecision(MINTED, {
      resumeAt: 39,
      nowMs: landsAt + SAME_RESTART_TOLERANCE_MS - 1,
      notBeforeMs: nominalDateOf(39),
    });

    assert.deepEqual(decision, { epoch: { fromSequence: 39, atMs: landsAt }, joined: true });
  });

  it('reports a mint where the floor wins over the clock', () => {
    const aheadOfTheClock = nominalDateOf(40) + 30_000;

    const decision = reanchorDecision(BROADCAST, {
      resumeAt: 40,
      nowMs: nominalDateOf(40) + 20_000,
      notBeforeMs: aheadOfTheClock,
    });

    assert.deepEqual(decision, { epoch: { fromSequence: 40, atMs: aheadOfTheClock }, joined: false });
  });

  /**
   * The case a test on whether any line exists at all gets wrong. A second restart has a line in
   * front of it and still mints, because that line no longer dates this rung's media as happening
   * now.
   */
  it('reports a mint for a second restart the earlier line no longer dates as now', () => {
    const secondRestartAtMs = RESTARTED_AT_MS + 2 * STEP_MS + 600_000;

    const decision = reanchorDecision(MINTED, {
      resumeAt: 42,
      nowMs: secondRestartAtMs,
      notBeforeMs: RESTARTED_AT_MS + 2 * STEP_MS,
    });

    assert.deepEqual(decision, { epoch: { fromSequence: 42, atMs: secondRestartAtMs }, joined: false });
  });
});
