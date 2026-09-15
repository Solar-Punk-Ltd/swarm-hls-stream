/**
 * What a playlist this project publishes must say about its own timeline, checked against the text.
 *
 * Two decisions of 2026-09-02 are in here. A broadcast's playlists start at
 * `#EXT-X-MEDIA-SEQUENCE:0` whatever the engine's own counter is doing, and every segment carries an
 * `#EXT-X-PROGRAM-DATE-TIME` derived from one instant the whole ladder shares. Neither is visible in
 * the uploader's log: the log names the engine's own segment index and the feed's SOC index, on
 * purpose, because those are what correlate with the engine's logs and with a segment reference. So
 * this reads the playlist.
 *
 * A third, of 2026-09-03, is what an `#EXT-X-DISCONTINUITY` excuses. An engine restart inside a
 * broadcast re-anchors the dating on the wall clock the engine came back at, so the step across the
 * break is the length of the outage rather than a whole number of fragments. See {@link stampFailures}.
 *
 * A fourth, of 2026-09-06, is how a hole is said. A segment the broadcast lost is listed as an
 * `#EXT-X-GAP` entry rather than left out, so the stamps step one fragment at a time straight through
 * it and the entries behind it keep the numbers they were published with.
 *
 * A fifth, of 2026-09-15, is what the stamps step by. Each one is the stamp in front of it plus the
 * media that entry declares, read as the declared fragment length where the two agree to within
 * {@link DATING_TOLERANCE}. Under a ladder every reading agrees, so the step is the declared length
 * and nothing about a ladder's playlists changed. On a single rendition the publisher's own keyframe
 * interval decides the segment, and a contract that still demanded the declared length there passed
 * a recording whose wall clock fell further behind its own media with every segment.
 *
 * ⛔ It answers with reasons rather than throwing, and it asserts nothing about timing. Every reason
 * it can give is a statement the playlist makes about itself being wrong, which is correctness. See
 * the repository's rule on what an e2e suite may gate on.
 */

import { parseManifest, programDateTimeMs, type Segment, segmentDuration } from '@swarm-hls-stream/shared';

const MS_PER_SECOND = 1000;

/**
 * How far apart two stamps may land from a whole number of fragments before the step is called
 * uneven.
 *
 * The publisher writes milliseconds and derives the stamp with one rounding, so a step is exact to
 * the millisecond and this only absorbs that rounding. It is not a tolerance for drift: a stamp that
 * tracked measured drift would be the defect, not the reading.
 */
const STEP_SLACK_MS = 2;

/**
 * How far an entry's own `#EXTINF` may sit from the declared fragment length and still be read as
 * that length.
 *
 * ⛔ **Mirrored from `DATING_SNAP_TOLERANCE` in
 * `packages/stream-uploader/src/libs/broadcastDating.ts`, which is where the publisher decides it.**
 * `e2e` does not depend on the uploader package, so the number is copied rather than imported, and a
 * copy that drifted would pass real drift or refuse a correct ladder. `manifestContract.test.ts`
 * reads that file and refuses a difference, which is the cheapest check that catches either side
 * moving.
 *
 * ⚠️ Not `FRAGMENT_TOLERANCE`, which is the publisher's five percent band for deciding whether a
 * stage is misconfigured. That question is a different one and its answer is five times wider, wide
 * enough that a 2.067 second segment against a configured 2 sits inside it. The publisher charges
 * those 67 milliseconds, so this contract has to expect them.
 */
export const DATING_TOLERANCE = 0.01;

export interface ManifestContract {
  /** Nominal seconds of media per fragment, from `HLS_FRAGMENT` on the deployment under test. */
  fragmentSeconds: number;
  /**
   * Whether this playlist is the first one of its broadcast, whose window still starts at the
   * broadcast's first segment. Only then must the media sequence be 0: a window that has slid names
   * a later segment, and a viewer joining then is meant to see that number.
   */
  firstOfBroadcast: boolean;
}

/** The `#EXT-X-MEDIA-SEQUENCE` a playlist declares, or null when it declares none. */
export function mediaSequenceOf(text: string): number | null {
  const line = parseManifest(text).headers.find((header) => header.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  if (line === undefined) {
    return null;
  }
  const value = Number.parseInt(line.slice(line.indexOf(':') + 1), 10);
  return Number.isFinite(value) ? value : null;
}

/** Every segment's `#EXT-X-PROGRAM-DATE-TIME` as epoch milliseconds, or null where it carries none. */
export function programDateTimesOf(text: string): (number | null)[] {
  return parseManifest(text).segments.map(stampOf);
}

function stampOf(segment: Segment): number | null {
  return segment.programDateTime === undefined ? null : programDateTimeMs(segment.programDateTime);
}

/**
 * Everything wrong with this playlist's timeline, or an empty list.
 *
 * @param text the m3u8 as the gateway served it
 */
export function manifestContractFailures(text: string, contract: ManifestContract): string[] {
  const { segments } = parseManifest(text);
  const failures: string[] = [];

  if (segments.length === 0) {
    return ['the playlist names no segments, so there is no timeline in it to check'];
  }

  failures.push(...mediaSequenceFailures(text, contract));
  failures.push(...stampFailures(segments, contract.fragmentSeconds));
  failures.push(...wallClockFailures(segments));

  return failures;
}

/**
 * No broadcast this project publishes predates it, so a stamp before this instant is not a date.
 *
 * ⛔ The first stage broadcast with stamps, 2026-09-03, dated every segment `1970-01-01T00:00:51Z`:
 * the anchor had been minted from the uploader's monotonic clock and read as the process's uptime.
 * Every other check here passed on those stamps, because they rose by exactly one fragment. A stamp
 * is only a timeline if it is also a date.
 */
const EARLIEST_PLAUSIBLE_STAMP_MS = Date.UTC(2025, 0, 1);

function wallClockFailures(segments: Segment[]): string[] {
  const earliest = segments.map(stampOf).find((stamp): stamp is number => stamp !== null);
  if (earliest === undefined || earliest >= EARLIEST_PLAUSIBLE_STAMP_MS) {
    return [];
  }
  return [
    `the first stamp reads ${new Date(earliest).toISOString()}, which is before any broadcast this project ` +
      "published, so the publisher's anchor was not taken from a wall clock",
  ];
}

function mediaSequenceFailures(text: string, contract: ManifestContract): string[] {
  const sequence = mediaSequenceOf(text);

  if (sequence === null) {
    return ['the playlist carries no #EXT-X-MEDIA-SEQUENCE, so nothing says where its window starts'];
  }
  if (contract.firstOfBroadcast && sequence !== 0) {
    return [
      `the first playlist of the broadcast declares #EXT-X-MEDIA-SEQUENCE:${sequence} rather than 0. ` +
        "That is the engine's own counter, which runs on across broadcasts, and a player that requires " +
        'a history starting at 0 has nothing to start from',
    ];
  }
  if (sequence < 0) {
    return [`the playlist declares a negative #EXT-X-MEDIA-SEQUENCE:${sequence}`];
  }
  return [];
}

/** `count` fragments with the noun agreeing, since a hole of one is the ordinary case. */
function fragmentsRead(count: number): string {
  return count === 1 ? '1 fragment' : `${count} fragments`;
}

/**
 * The media an entry holds as the publisher dates by it, in milliseconds.
 *
 * ⛔ **A reading within {@link DATING_TOLERANCE} of the declared length is read AS the declared
 * length**, which is what lets a ladder's four rungs date one piece of media identically while each
 * writes its own `#EXTINF`. Under `ABR_ENABLED` every rung is re-encoded with a keyframe every
 * `ABR_FPS x HLS_FRAGMENT` frames and SRS cuts exactly there, so every rung's reading lands inside
 * that band and the dates step by the declared fragment, which is what this contract has always
 * accepted.
 *
 * An entry whose `#EXTINF` cannot be read falls back to the declared length, because an unparseable
 * duration is the parser's complaint to make and not this one's.
 */
function heldMediaMs(segment: Segment, fragmentSeconds: number): number {
  const measured = segmentDuration(segment.extinf);
  if (measured === null) {
    return Math.round(fragmentSeconds * MS_PER_SECOND);
  }

  const agrees = Math.abs(measured - fragmentSeconds) <= fragmentSeconds * DATING_TOLERANCE;
  return Math.round((agrees ? fragmentSeconds : measured) * MS_PER_SECOND);
}

/**
 * Whether every entry is dated, and whether each date is the one before it plus the media that entry
 * holds.
 *
 * Without an `#EXT-X-DISCONTINUITY` the step must be exactly the media the entry in front declares,
 * plus one declared fragment for every sequence the playlist left out. The stamp is derived from the
 * broadcast's anchor and the media before it rather than read off a clock, so anything else means it
 * was taken from something else: an arrival time, or media the playlist does not name.
 *
 * ⭐ **Under a ladder that is still exactly the declared fragment length**, because every rung's
 * reading sits inside the tolerance and is read as that length. See {@link heldMediaMs}. On a single
 * rendition the publisher's own keyframe interval decides the segment and `HLS_FRAGMENT` is only a
 * floor, so the step is whatever that segment really held: this stage was measured cutting 2.4 and
 * 10.033 second segments against a configured 2 on 2026-09-15, and a contract demanding the declared
 * length passed a recording whose clock fell further behind its own media with every segment.
 *
 * ⭐ Owner ruling of 2026-09-06. A segment the broadcast lost is listed as an `#EXT-X-GAP` entry
 * carrying its own stamp and the declared length, because the media is gone and nobody measured it,
 * so a hole that was said steps one entry at a time and passes here by construction. A step that
 * runs a whole fragment or more past the media in front of it therefore means the hole was left out
 * of the playlist entirely, which is the numbering defect the gap entries exist to prevent, and it is
 * still what this refuses.
 *
 * ⛔ A step a whole number of fragments **short** of that media is refused too, and that is the same
 * defect in the other direction: the entries overlap, so the playlist dates one piece of media twice
 * and the recording's clock falls behind what it holds by the difference every segment. It read as
 * correct until 2026-09-16 because the count of fragments is rounded off a signed difference and only
 * a positive count was reported, so a stage cutting a whole multiple of `HLS_FRAGMENT` while the
 * publisher dated by the configured length passed this check silently.
 *
 * ⛔ Across a discontinuity a forward step of **any** size is legal, and this required a whole number
 * of fragments until the owner's decision of 2026-09-03. An engine restart re-anchors the dating on
 * the wall clock the engine came back at, so the step across that break is the length of the outage
 * and nothing rounds it. A step that does not move forwards stays illegal everywhere: a date that
 * repeats or goes backwards is media a viewer is already holding being re-dated.
 */
function stampFailures(segments: Segment[], fragmentSeconds: number): string[] {
  const failures: string[] = [];
  const stepMs = fragmentSeconds * MS_PER_SECOND;

  const undated = segments.filter((segment) => stampOf(segment) === null).length;
  if (undated > 0) {
    failures.push(
      `${undated} of ${segments.length} segments carry no readable #EXT-X-PROGRAM-DATE-TIME, so nothing ` +
        'says when their media happened',
    );
    return failures;
  }

  for (let i = 1; i < segments.length; i++) {
    const previous = stampOf(segments[i - 1])!;
    const current = stampOf(segments[i])!;
    const gapMs = current - previous;

    if (gapMs <= 0) {
      failures.push(
        `segment ${i} is dated ${new Date(current).toISOString()}, at or before the ` +
          `${new Date(previous).toISOString()} of the segment in front of it`,
      );
      continue;
    }

    // The break is where the dating re-anchors, so the size of the step across it says nothing.
    if (segments[i].discontinuity) {
      continue;
    }

    const heldMs = heldMediaMs(segments[i - 1], fragmentSeconds);
    const lost = Math.round((gapMs - heldMs) / stepMs);
    if (Math.abs(gapMs - heldMs - lost * stepMs) > STEP_SLACK_MS) {
      failures.push(
        `segment ${i} is dated ${gapMs}ms after the one before it, which is neither the ${heldMs}ms of ` +
          `media that entry declares nor that plus a whole number of ${fragmentSeconds}s fragments`,
      );
      continue;
    }

    if (lost > 0) {
      failures.push(
        `entry ${i} is dated ${fragmentsRead(lost)} past the media the entry before it declares, with ` +
          'no #EXT-X-GAP entries for the sequences in between, so the playlist promises a viewer media ' +
          'it does not name and renumbers everything behind the hole',
      );
      continue;
    }

    if (lost < 0) {
      failures.push(
        `entry ${i} is dated ${fragmentsRead(-lost)} short of the media the entry before it declares, so ` +
          'the two entries claim the same media and the recording keeps a clock that falls further ' +
          'behind what it holds with every segment',
      );
    }
  }

  return failures;
}
