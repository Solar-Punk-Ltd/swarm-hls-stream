/**
 * What a playlist this project publishes must say about its own timeline, checked against the text.
 *
 * Two decisions of 2026-09-02 are in here. A broadcast's playlists start at
 * `#EXT-X-MEDIA-SEQUENCE:0` whatever the engine's own counter is doing, and every segment carries an
 * `#EXT-X-PROGRAM-DATE-TIME` derived from one instant the whole ladder shares, stepping by the
 * fragment length the deployment declared. Neither is visible in the uploader's log: the log names
 * the engine's own segment index and the feed's SOC index, on purpose, because those are what
 * correlate with the engine's logs and with a segment reference. So this reads the playlist.
 *
 * ⛔ It answers with reasons rather than throwing, and it asserts nothing about timing. Every reason
 * it can give is a statement the playlist makes about itself being wrong, which is correctness. See
 * the repository's rule on what an e2e suite may gate on.
 */

import { parseManifest, programDateTimeMs, type Segment } from '@swarm-hls-stream/shared';

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

/**
 * Whether every segment is dated, and whether the dates step by the fragment length.
 *
 * A step wider than one fragment is only legal across an `#EXT-X-DISCONTINUITY`, where it is the
 * media that went missing or the engine's counter restarting, and it still has to be a whole number
 * of fragments because the stamp is derived from a segment count rather than measured.
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

    const fragments = Math.round(gapMs / stepMs);
    if (Math.abs(gapMs - fragments * stepMs) > STEP_SLACK_MS) {
      failures.push(
        `segment ${i} is dated ${gapMs}ms after the one before it, which is not a whole number of ` +
          `${fragmentSeconds}s fragments`,
      );
      continue;
    }

    if (fragments > 1 && !segments[i].discontinuity) {
      failures.push(
        `segment ${i} is dated ${fragments} fragments after the one before it with no ` +
          '#EXT-X-DISCONTINUITY between them, so the playlist promises a viewer media it does not name',
      );
    }
  }

  return failures;
}
