import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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
 * @param sequences the playlist sequence of each segment, so a caller can build a gap or a repeat
 * @param breaks sequences that carry an `#EXT-X-DISCONTINUITY`
 */
function playlist(sequences: readonly number[], options: { mediaSequence?: number; breaks?: number[] } = {}): string {
  const breaks = new Set(options.breaks ?? []);
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${options.mediaSequence ?? sequences[0] ?? 0}`,
    '',
    ...sequences.flatMap((sequence) => [
      ...(breaks.has(sequence) ? ['#EXT-X-DISCONTINUITY'] : []),
      stamp(sequence),
      '#EXTINF:2,',
      ref(sequence),
    ]),
    '',
  ].join('\n');
}

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
   * A segment whose upload failed leaves a hole, and the next segment carries the break that tells a
   * player to skip it. The stamps are derived from a segment count, so the hole is a whole number of
   * fragments wide and that is what makes it distinguishable from an uneven step.
   */
  it('accepts a gap that a discontinuity accounts for', () => {
    const gapped = playlist([0, 1, 3, 4], { breaks: [3] });

    assert.deepEqual(manifestContractFailures(gapped, CONTRACT), []);
  });

  it('refuses a gap with no discontinuity to account for it', () => {
    const silent = playlist([0, 1, 3, 4]);

    assert.equal(manifestContractFailures(silent, CONTRACT).length, 1);
    assert.match(manifestContractFailures(silent, CONTRACT)[0], /no #EXT-X-DISCONTINUITY between them/);
  });

  /**
   * The stamp is nominal, so a step of half a fragment means it was taken from something other than
   * the anchor: an arrival time, or a measured `#EXTINF`. That is the defect the derivation exists to
   * prevent, and a suite that let it through would be watching four rungs drift apart.
   */
  it('refuses a step that is not a whole number of fragments', () => {
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

    assert.match(manifestContractFailures(drifting, CONTRACT)[0], /not a whole number of 2s fragments/);
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
