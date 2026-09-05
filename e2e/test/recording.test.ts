import { rungAnnounced, segmentUploaded } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lowestRungOf, recordingProgress, recordingSummary } from '../src/harness/recording.js';

/**
 * What `pnpm make:recording` counts, held against a log rather than against the driver.
 *
 * ⛔⛔ **Found live on 2026-09-02 on the latbench stage, a four rung ladder.** The driver asked for
 * 60 segments before its outage and 60 after and produced 32 per rung, because it counted the
 * uploader's merged upload lines and a ladder writes one per rung. A recording is watched one rung
 * at a time, so the number an operator sets has to mean segments of the rung a player rides, and on
 * that stage it meant a quarter of them.
 *
 * ⛔ The fixtures are built with `segmentUploaded` and `rungAnnounced`, the composers the uploader
 * logs through, never with a hand-typed copy of the sentence. A hand-typed fixture tests the parser
 * against itself and both halves drift away from the uploader together. Same rule
 * `logwatchLadder.test.ts` states at length.
 */

/** `Logger`'s text format: `[ts] [LEVEL] - message`. */
function line(message: string): string {
  return `[2026-09-02T09:14:05.123Z] [INFO] - ${message}`;
}

const LADDER = 'group-7';
const RUNGS = ['360p', '480p', '720p', '1080p'] as const;

function streamOf(rung: string): string {
  return `live/stream_${rung}`;
}

/** One announce per rung, the way a ladder broadcast opens. */
function announces(rungs: readonly string[] = RUNGS): string[] {
  return rungs.map((rung) => line(rungAnnounced(streamOf(rung), rung, LADDER, `topic-${rung}`)));
}

/** `counts` segments on each named rung, indices continuing from `firstIndex`. */
function uploads(counts: Readonly<Record<string, number>>, firstIndex = 0): string[] {
  return Object.entries(counts).flatMap(([rung, count]) =>
    Array.from({ length: count }, (_unused, step) =>
      line(segmentUploaded(streamOf(rung), firstIndex + step, `ref-${rung}-${firstIndex + step}`)),
    ),
  );
}

describe('how far a recording has got, per rung', () => {
  /**
   * ⛔⛔ The whole finding, in one case. Forty lines across four rungs is ten segments of the
   * recording a player sees, and the driver read it as forty.
   */
  it('counts one rung rather than summing the ladder', () => {
    const log = [...announces(), ...uploads({ '360p': 10, '480p': 10, '720p': 10, '1080p': 10 })].join('\n');

    assert.equal(recordingProgress(log).perRung, 10);
  });

  /**
   * ⭐ The minimum, because a player rides one rung and the recording has to hold the target on
   * whichever one that is. Taking the tallest, or an average, would call a recording ready while a
   * viewer on the slow rung reaches its end early.
   */
  it('takes the rung that has published least, since a viewer may be riding it', () => {
    const log = [...announces(), ...uploads({ '360p': 20, '480p': 20, '720p': 20, '1080p': 14 })].join('\n');

    assert.equal(recordingProgress(log).perRung, 14);
  });

  /**
   * ⛔ A rung the broadcast announced and never published on is this deployment's signature failure,
   * and it has to read as zero rather than be left out of the minimum. Left out, a ladder that lost
   * its 1080p rung at segment one would report the other three's count and the driver would stop
   * publishing on a recording that cannot be watched at 1080p at all.
   */
  it('counts an announced rung that published nothing as zero rather than dropping it', () => {
    const log = [...announces(), ...uploads({ '360p': 30, '480p': 30, '720p': 30 })].join('\n');

    const progress = recordingProgress(log);

    assert.equal(progress.perRung, 0);
    assert.deepEqual(
      progress.rungs.find((rung) => rung.rung === '1080p'),
      { rung: '1080p', segments: 0 },
    );
  });

  /** A single-rendition broadcast announces no rungs, and its one stream is the whole recording. */
  it('falls back to the streams that published where the log announces no rungs at all', () => {
    const log = Array.from({ length: 12 }, (_unused, index) =>
      line(segmentUploaded('live/stream', index, `ref-${index}`)),
    ).join('\n');

    const progress = recordingProgress(log);

    assert.equal(progress.perRung, 12);
    assert.deepEqual(progress.rungs, [{ rung: 'live/stream', segments: 12 }]);
  });

  /** Nothing has published, which is where every run starts and is not an error. */
  it('reads an empty log as no progress rather than throwing', () => {
    assert.deepEqual(recordingProgress(''), { rungs: [], perRung: 0 });
  });

  /**
   * A rung re-announces on a fresh topic when it recovers, and that is one rung publishing twice
   * rather than two rungs. Counting the announces would put a phantom rung at zero into the minimum
   * and hold the driver at zero for the rest of the run.
   */
  it('treats a rung that re-announced after a recovery as the one rung it is', () => {
    const log = [
      ...announces(['720p']),
      ...uploads({ '720p': 5 }),
      line(rungAnnounced(streamOf('720p'), '720p', LADDER, 'topic-720p-again')),
      ...uploads({ '720p': 5 }, 5),
    ].join('\n');

    assert.deepEqual(recordingProgress(log), { rungs: [{ rung: '720p', segments: 10 }], perRung: 10 });
  });

  /**
   * ⚠️ Distinct indices, so a line the uploader wrote twice for one segment is one segment. It does
   * NOT repair the other overcount this window has: SRS's counter runs on across broadcasts, so a
   * straggler from the previous broadcast arrives at an index that continues the sequence and is
   * indistinguishable from this broadcast's own. `lastUploadedSegmentRefByRung` records that at
   * length. A few segments over on a target of sixty is not the four-fold error this replaces.
   */
  it('counts a segment once however many lines it produced', () => {
    const log = [...announces(['360p']), ...uploads({ '360p': 4 }), ...uploads({ '360p': 4 })].join('\n');

    assert.equal(recordingProgress(log).perRung, 4);
  });
});

describe('what the driver prints about a recording in progress', () => {
  it('names every rung and its count, so a stalled rung is visible while the run waits', () => {
    const log = [...announces(), ...uploads({ '360p': 20, '480p': 20, '720p': 20, '1080p': 3 })].join('\n');

    const summary = recordingSummary(recordingProgress(log), 2);

    assert.match(summary, /1080p/);
    assert.match(summary, /3/);
  });

  /** Media seconds is the number an operator sizes a recording by, and no reader multiplies by hand. */
  it('states the media each rung holds, at the length the stage cuts', () => {
    const log = [...announces(['720p']), ...uploads({ '720p': 45 })].join('\n');

    assert.match(recordingSummary(recordingProgress(log), 2), /90(\.0)?s/);
  });

  /**
   * ⛔ An engine whose segment length this harness cannot read says so, rather than multiplying by a
   * zero and reporting a recording holding no media at all. Those are the same sentence to a reader
   * and only one of them is a fault.
   */
  it('says the length is unknown rather than printing a recording of zero seconds', () => {
    const log = [...announces(['720p']), ...uploads({ '720p': 45 })].join('\n');

    const summary = recordingSummary(recordingProgress(log), null);

    assert.doesNotMatch(summary, /0\.0s/);
    assert.match(summary, /does not report/);
  });
});

describe('which rung the writer node carries', () => {
  /**
   * `bee-uploader` is the LOWEST rung's node as well as the shared default, because the catalog and
   * every ladder master go through it. See `BEE_PUBLISHERS` in `.env.sample`.
   */
  it('is the shortest rung of the ladder, whatever order the log announced them in', () => {
    assert.equal(lowestRungOf(['1080p', '360p', '720p', '480p']), '360p');
  });

  it('is the one rung of a ladder that has one', () => {
    assert.equal(lowestRungOf(['720p']), '720p');
  });

  it('is nothing at all where no rung carries a height, so no caller claims a rung it invented', () => {
    assert.equal(lowestRungOf(['live/stream']), null);
    assert.equal(lowestRungOf([]), null);
  });
});
