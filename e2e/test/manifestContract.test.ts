import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DATING_TOLERANCE,
  type ManifestContract,
  manifestContractFailures,
  mediaSequenceOf,
  programDateTimesOf,
} from '../src/harness/manifestContract.js';

/**
 * The check a live suite calls on a playlist it fetched, exercised on text rather than on a stage.
 *
 * ⛔ Every case here is built from strings, so it is free and it runs in CI. What it cannot do is
 * prove the stage writes such a playlist, which is the paid half and is what the scenario suites are
 * for. See `docs/e2e-coverage.md` for what those suites still need before they can call this.
 */

const FRAGMENT_SECONDS = 2;
const CONTRACT: ManifestContract = { fragmentSeconds: FRAGMENT_SECONDS, firstOfBroadcast: true };
const STARTED_AT_MS = Date.UTC(2026, 8, 1, 12, 0, 0);

function ref(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function stamp(sequence: number): string {
  return `#EXT-X-PROGRAM-DATE-TIME:${new Date(STARTED_AT_MS + sequence * FRAGMENT_SECONDS * 1000).toISOString()}`;
}

/**
 * A playlist as `ManifestManager` writes one.
 *
 * @param sequences the playlist sequence of each entry, so a caller can build a hole or a repeat
 * @param options.breaks sequences that carry an `#EXT-X-DISCONTINUITY`
 * @param options.gaps sequences listed as an `#EXT-X-GAP` entry rather than as media
 */
function playlist(
  sequences: readonly number[],
  options: { mediaSequence?: number; breaks?: number[]; gaps?: number[] } = {},
): string {
  const breaks = new Set(options.breaks ?? []);
  const gaps = new Set(options.gaps ?? []);
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${options.mediaSequence ?? sequences[0] ?? 0}`,
    '',
    ...sequences.flatMap((sequence) => [
      ...(breaks.has(sequence) ? ['#EXT-X-DISCONTINUITY'] : []),
      ...(gaps.has(sequence) ? ['#EXT-X-GAP'] : []),
      stamp(sequence),
      '#EXTINF:2,',
      gaps.has(sequence) ? `gap-${sequence}` : ref(sequence),
    ]),
    '',
  ].join('\n');
}

/** One entry of a playlist, stating both halves the contract compares. */
interface DatedEntry {
  /** The `#EXTINF` it declares, in seconds. */
  holds: number;
  /** The `#EXT-X-PROGRAM-DATE-TIME` it carries. */
  atMs: number;
  lost?: boolean;
}

/**
 * A playlist whose media and dates are each stated outright, so a case can put the two at odds.
 *
 * The other builder derives every stamp from `sequence * FRAGMENT_SECONDS` and writes a constant
 * `#EXTINF`, which cannot express the defect at all: a playlist whose dates step by the declared
 * length while its media ran longer reads there exactly like a correct one.
 */
function datedPlaylist(entries: readonly DatedEntry[]): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:11',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '',
    ...entries.flatMap((entry, sequence) => [
      ...(entry.lost ? ['#EXT-X-GAP'] : []),
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(entry.atMs).toISOString()}`,
      `#EXTINF:${entry.holds},`,
      entry.lost ? `gap-${sequence}` : ref(sequence),
    ]),
    '',
  ].join('\n');
}

/** Where the tolerance this contract reads is really decided. */
const BROADCAST_DATING_PATH = '../../packages/stream-uploader/src/libs/broadcastDating.ts';

describe('the timeline a playlist declares', () => {
  it('passes a playlist that opens at zero and steps by the fragment', () => {
    assert.deepEqual(manifestContractFailures(playlist([0, 1, 2, 3]), CONTRACT), []);
  });

  it('refuses the first playlist of a broadcast that opens on the engine’s own counter', () => {
    const failures = manifestContractFailures(playlist([0, 1, 2], { mediaSequence: 580 }), CONTRACT);

    assert.equal(failures.length, 1);
    assert.match(failures[0], /#EXT-X-MEDIA-SEQUENCE:580 rather than 0/);
  });

  /** A window that has slid names a later segment, and a viewer joining then is meant to see it. */
  it('accepts a later media sequence once the window has slid', () => {
    const slid = playlist([12, 13, 14], { mediaSequence: 12 });

    assert.deepEqual(manifestContractFailures(slid, { ...CONTRACT, firstOfBroadcast: false }), []);
  });

  it('refuses a playlist with no media sequence at all', () => {
    const headerless = ['#EXTM3U', stamp(0), '#EXTINF:2,', ref(0), ''].join('\n');

    assert.match(manifestContractFailures(headerless, CONTRACT)[0], /carries no #EXT-X-MEDIA-SEQUENCE/);
  });

  it('refuses a playlist whose segments carry no wall clock', () => {
    const bare = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '', '#EXTINF:2,', ref(0), '#EXTINF:2,', ref(1), ''].join('\n');

    assert.match(manifestContractFailures(bare, CONTRACT)[0], /2 of 2 segments carry no readable/);
  });

  it('names how many segments were left undated rather than only the first', () => {
    const partial = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
      stamp(0),
      '#EXTINF:2,',
      ref(0),
      '#EXTINF:2,',
      ref(1),
      '',
    ].join('\n');

    assert.match(manifestContractFailures(partial, CONTRACT)[0], /1 of 2 segments carry no readable/);
  });

  it('refuses a stamp that does not move', () => {
    const stalled = playlist([0, 0, 1]);

    assert.match(manifestContractFailures(stalled, CONTRACT)[0], /at or before the/);
  });

  it('refuses a stamp that goes backwards', () => {
    const backwards = playlist([0, 2, 1], { mediaSequence: 0 });

    assert.ok(manifestContractFailures(backwards, CONTRACT).some((failure) => /at or before the/.test(failure)));
  });

  /**
   * A segment whose upload failed leaves a hole, and since the owner's ruling of 2026-09-06 the hole
   * is listed: every missing sequence is an `#EXT-X-GAP` entry carrying its own derived stamp. So the
   * dates step by exactly one fragment across a hole that was said, which is the whole point of
   * saying it.
   */
  it('accepts a hole said with gap entries', () => {
    const said = playlist([0, 1, 2, 3, 4], { gaps: [2] });

    assert.deepEqual(manifestContractFailures(said, CONTRACT), []);
  });

  it('accepts a run of gap entries, which is what a wider hole is', () => {
    const said = playlist([0, 1, 2, 3, 4], { gaps: [1, 2, 3] });

    assert.deepEqual(manifestContractFailures(said, CONTRACT), []);
  });

  it('refuses a hole that nothing says', () => {
    const silent = playlist([0, 1, 3, 4]);

    assert.equal(manifestContractFailures(silent, CONTRACT).length, 1);
    assert.match(manifestContractFailures(silent, CONTRACT)[0], /no #EXT-X-GAP entries/);
  });

  /**
   * ⚠️ A break still excuses a wide step, and that is deliberate rather than an oversight. The step
   * across an engine restart is the length of the outage and is not a whole number of fragments, so
   * a check that refused a wide step across a break would red a correct restart on any outage that
   * happened to land on one. A hole answered with a discontinuity instead of gap entries therefore
   * passes here, and is caught in the uploader's own tests where the two are told apart.
   */
  it('still excuses a wide step across a discontinuity, which is where the dating re-anchors', () => {
    assert.deepEqual(manifestContractFailures(playlist([0, 1, 3, 4], { breaks: [3] }), CONTRACT), []);
  });

  /**
   * A playlist whose dating re-anchors, which is what an engine restart inside a broadcast produces.
   *
   * @param accountedFor whether the segment the dating re-anchors at carries its `#EXT-X-DISCONTINUITY`
   */
  function reanchoredPlaylist(accountedFor: boolean): string {
    return [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:00.000Z',
      '#EXTINF:2,',
      ref(0),
      ...(accountedFor ? ['#EXT-X-DISCONTINUITY'] : []),
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:09:41.317Z',
      '#EXTINF:2,',
      ref(1),
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:09:43.317Z',
      '#EXTINF:2,',
      ref(2),
      '',
    ].join('\n');
  }

  /**
   * ⛔ Owner decision of 2026-09-03. An engine restart re-anchors the dating on the wall clock the
   * engine came back at, so the step across the break is the length of the outage and nothing makes
   * that a whole number of fragments. The step after it is one fragment again.
   */
  it('accepts an uneven forward step across a discontinuity, which is where the dating re-anchors', () => {
    assert.deepEqual(manifestContractFailures(reanchoredPlaylist(true), CONTRACT), []);
  });

  it('refuses that same re-anchoring with no discontinuity to account for it', () => {
    const failures = manifestContractFailures(reanchoredPlaylist(false), CONTRACT);

    assert.equal(failures.length, 1);
    assert.match(failures[0], /neither the 2000ms of media/);
  });

  /**
   * A break excuses a step of any size **forwards** and nothing excuses one that does not move. A
   * media sequence that goes backwards is what hls.js reports as a parsing error, and a stamp that
   * goes backwards with it is a re-anchoring that re-dated media a viewer is already holding.
   */
  it('refuses a stamp that goes backwards even where a discontinuity accounts for the break', () => {
    const backwards = playlist([0, 2, 1], { mediaSequence: 0, breaks: [1] });

    assert.ok(manifestContractFailures(backwards, CONTRACT).some((failure) => /at or before the/.test(failure)));
  });

  /**
   * ⛔ The rule this holds a publisher to, and the one it used to get wrong. A date is the one in
   * front of it plus the media that entry declares, so on a single rendition, where the publisher's
   * own keyframe interval decides the segment, the step is whatever that segment really held. The
   * old rule wanted the declared fragment length whatever the media did, and a stream measured live
   * on 2026-09-15 cutting 2.4 and 10.033 second segments against a configured 2 passed it while its
   * recording fell further behind its own media with every segment.
   */
  it('accepts a single rendition whose dates follow the media its entries declare', () => {
    const led = datedPlaylist([
      { holds: 2.4, atMs: STARTED_AT_MS },
      { holds: 10.033, atMs: STARTED_AT_MS + 2_400 },
      { holds: 2, atMs: STARTED_AT_MS + 2_400 + 10_033 },
    ]);

    assert.deepEqual(manifestContractFailures(led, CONTRACT), []);
  });

  it('refuses a playlist still stepping by the declared length while its media ran longer', () => {
    const onTheGrid = datedPlaylist([
      { holds: 2.4, atMs: STARTED_AT_MS },
      { holds: 10.033, atMs: STARTED_AT_MS + 2_000 },
      { holds: 2, atMs: STARTED_AT_MS + 4_000 },
    ]);

    const failures = manifestContractFailures(onTheGrid, CONTRACT);

    assert.equal(failures.length, 2, failures.join('\n'));
    assert.match(failures[0], /2000ms after the one before it/);
  });

  /**
   * ⛔ The half that must not move. Under a ladder every rung is re-encoded with a keyframe every
   * `ABR_FPS x HLS_FRAGMENT` frames, so each rung's readings sit a tick either side of the declared
   * length and every one of them is read as that length. The dates then step by exactly the declared
   * fragment, which is what the four rungs agree on and what this contract has always accepted.
   */
  it('reads a measurement inside the tolerance as the declared length, so a ladder still passes', () => {
    const rung = datedPlaylist([
      { holds: 2.015, atMs: STARTED_AT_MS },
      { holds: 1.99, atMs: STARTED_AT_MS + 2_000 },
      { holds: 2.005, atMs: STARTED_AT_MS + 4_000 },
    ]);

    assert.deepEqual(manifestContractFailures(rung, CONTRACT), []);
  });

  it('charges a gap entry the declared length, after the media that really ran', () => {
    const holed = datedPlaylist([
      { holds: 2.4, atMs: STARTED_AT_MS },
      { holds: 2, atMs: STARTED_AT_MS + 2_400, lost: true },
      { holds: 2, atMs: STARTED_AT_MS + 2_400 + 2_000 },
    ]);

    assert.deepEqual(manifestContractFailures(holed, CONTRACT), []);
  });

  it('still refuses a hole nothing says, counted past the media that really ran', () => {
    const silent = datedPlaylist([
      { holds: 2.4, atMs: STARTED_AT_MS },
      { holds: 2, atMs: STARTED_AT_MS + 2_400 + 2_000 },
    ]);

    const failures = manifestContractFailures(silent, CONTRACT);

    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /no #EXT-X-GAP entries/);
  });

  /**
   * ⛔ The tolerance is the publisher's, mirrored here because `e2e` does not depend on the uploader
   * package. A contract reading a different band would pass real drift or refuse a correct ladder, so
   * this reads the publisher's own source rather than trusting the copy to have kept up.
   */
  it('reads the same tolerance the publisher dates by', () => {
    const source = readFileSync(join(import.meta.dirname, BROADCAST_DATING_PATH), 'utf8');
    const declared = /export const DATING_SNAP_TOLERANCE = ([\d.]+);/.exec(source);

    assert.ok(declared, `could not read a numeric DATING_SNAP_TOLERANCE out of ${BROADCAST_DATING_PATH}`);
    assert.equal(Number(declared![1]), DATING_TOLERANCE);
  });

  /**
   * The stamp is derived rather than read off a clock, so a step that is neither the media the entry
   * in front declares nor that plus whole fragments of lost media was taken from something else: an
   * arrival time, or a rounding nothing accounts for.
   */
  it('refuses a step that is neither the media held nor a whole number of fragments past it', () => {
    const drifting = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:00.000Z',
      '#EXTINF:2,',
      ref(0),
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:01.000Z',
      '#EXTINF:2,',
      ref(1),
      '',
    ].join('\n');

    assert.match(manifestContractFailures(drifting, CONTRACT)[0], /neither the 2000ms of media/);
  });

  it('absorbs the publisher’s own millisecond rounding on a fragment that is not a whole second', () => {
    const third: ManifestContract = { fragmentSeconds: 1 / 3, firstOfBroadcast: true };
    const rounded = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:00.000Z',
      '#EXTINF:0.333,',
      ref(0),
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-01T12:00:00.333Z',
      '#EXTINF:0.333,',
      ref(1),
      '',
    ].join('\n');

    assert.deepEqual(manifestContractFailures(rounded, third), []);
  });

  it('says so rather than passing when the playlist names nothing', () => {
    const empty = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', ''].join('\n');

    assert.match(manifestContractFailures(empty, CONTRACT)[0], /names no segments/);
  });

  /** A finished recording is the same contract with an end on it. */
  it('passes a closed recording', () => {
    const recording = `${playlist([0, 1, 2])}#EXT-X-ENDLIST\n`;

    assert.deepEqual(manifestContractFailures(recording, CONTRACT), []);
  });
});

describe('reading the two numbers on their own', () => {
  it('hands back the media sequence a playlist declares', () => {
    assert.equal(mediaSequenceOf(playlist([7, 8], { mediaSequence: 7 })), 7);
  });

  it('hands back null for a playlist that declares none', () => {
    assert.equal(mediaSequenceOf(['#EXTM3U', '#EXTINF:2,', ref(0)].join('\n')), null);
  });

  it('hands back every stamp in playlist order', () => {
    assert.deepEqual(programDateTimesOf(playlist([0, 1, 2])), [
      STARTED_AT_MS,
      STARTED_AT_MS + 2_000,
      STARTED_AT_MS + 4_000,
    ]);
  });

  it('hands back null in place of a segment that carries no stamp', () => {
    const partial = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '', '#EXTINF:2,', ref(0)].join('\n');

    assert.deepEqual(programDateTimesOf(partial), [null]);
  });
});

/**
 * ⛔ The reading the first stage broadcast with stamps produced on 2026-09-03: every segment dated
 * 1970-01-01T00:00:51Z, fifty-two seconds being the uploader's uptime, because the anchor had been
 * minted from the monotonic clock. Those stamps rose by exactly one fragment and passed every other
 * check here.
 */
describe('a stamp has to be a date', () => {
  it('refuses stamps that predate every broadcast this project published', () => {
    const uptimeStamped = playlist([0, 1, 2]).replace(/2026-09-01T12:00/g, '1970-01-01T00:00');

    const failures = manifestContractFailures(uptimeStamped, CONTRACT);

    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /1970-01-01T00:00:00.000Z, which is before any broadcast/);
    assert.match(failures[0], /not taken from a wall clock/);
  });

  it("accepts stamps from this project's own era", () => {
    assert.deepEqual(manifestContractFailures(playlist([0, 1, 2]), CONTRACT), []);
  });
});
