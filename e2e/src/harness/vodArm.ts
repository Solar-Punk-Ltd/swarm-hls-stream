/**
 * The questions a finished recording is asked when a real player opens it.
 *
 * ## ⛔ What was never asked before this
 *
 * The VOD path looked correct by construction and `browser:vod` had established that a recording
 * starts, reports a finite duration and can be seeked around. None of that says WHAT played.
 *
 * ⛔⛔ **A ladder recording whose master resolved and whose upper rung playlists did not plays
 * perfectly at its bottom rung.** Every reading the playback run took would call that a pass: it
 * started, the duration was finite, the seeks landed, the picture moved. The rung list is the only
 * reading that can tell those two apart, and nothing was reading it.
 *
 * ## ⛔ No timing is judged
 *
 * Owner ruling of 2026-08-29. Whether the recording played, offered its whole ladder and covered the
 * broadcast is correctness. How long a seek took to land is measured, printed and filed.
 *
 * ## Why the rules live here rather than in the suite
 *
 * Nothing under `suites/` runs in CI and the file costs a broadcast, so a rule written inline is a
 * rule nothing checks until a paid broadcast is already burning.
 */

import { type BrowserArmResult, type VodResult } from './browser.js';

/**
 * How much shorter than the broadcast a recording may be and still be the whole of it.
 *
 * ⭐ A tolerance rather than an equality, and it is not a performance threshold: the publisher is
 * stopped between segment boundaries, so the last partial segment is never in the recording and the
 * broadcast's own wall clock includes the seconds before the first segment was cut. One segment
 * either side is the arithmetic of where the boundaries fall.
 */
export const RECORDING_SHORTFALL_TOLERANCE_S = 2;

/**
 * Why this run is not a real player opening a finished recording, or null.
 *
 * ⛔ Everything here is about the RUN. Each one makes every reading below it a property of the
 * harness rather than of the product.
 */
export function vodArmRefusal(result: BrowserArmResult): string | null {
  if (!result.instrumentSound) {
    return (
      'the browser was not a usable instrument for this run, so a recording that did or did not play is ' +
      `as likely to be the harness: ${result.instrumentFailures.join('; ') || 'no reason recorded'}`
    );
  }
  if (result.vod === null) {
    return (
      'this artifact carries no playback verdict, so it is a live watch rather than a recording being ' +
      'played back. Nothing here is about a finished broadcast'
    );
  }
  return null;
}

/** Why the recording did not play at all, or null. The headline result, and it comes before the rest. */
export function playedBackRefusal(vod: VodResult): string | null {
  if (vod.openError !== null) {
    return `${vod.openError}, so nothing below is a reading of a recording that played`;
  }
  return null;
}

/**
 * Why the player was not handed a finished timeline, or null.
 *
 * ⛔ A live playlist reports `Infinity` for its duration and `JSON.stringify` writes that as null, so
 * both reach here as an absent number and both mean the same thing. Without this, a recording that
 * was still being written would be played as a live stream and seeked around inside a moving window,
 * and every seek in the report would be against a target that had shifted.
 */
export function finishedTimelineRefusal(vod: VodResult): string | null {
  if (vod.durationS === null) {
    return (
      'the player was handed no finite duration, which is what a LIVE playlist looks like. This ' +
      'recording was not finalised, or the catalog still points at the live manifest'
    );
  }
  if (vod.durationS <= 0) {
    return `the recording reports a duration of ${vod.durationS}s, so there is no timeline to play`;
  }
  return null;
}

/**
 * Why this recording is not the whole ladder it was published as, or null.
 *
 * ⭐ The plan's own done-when: a recording that only plays its lowest rung fails. Compared against
 * what the DEPLOYMENT declares rather than against a number here, so a stack that reconfigures its
 * ladder is held to its own configuration.
 */
export function wholeLadderRefusal(vod: VodResult, expected: readonly number[]): string | null {
  if (expected.length === 0) {
    return null;
  }
  const missing = expected.filter((height) => !vod.ladderHeights.includes(height));
  if (missing.length === 0) {
    return null;
  }
  if (vod.ladderHeights.length === 0) {
    return (
      'the player parsed no ladder at all from this recording, so either no master playlist resolved or ' +
      `the topic played is one rung's rather than the broadcast's. ${expected.length} rungs were published`
    );
  }
  return (
    `this recording offered ${vod.ladderHeights.map((height) => `${height}p`).join(', ')} and the ` +
    `deployment published ${expected.map((height) => `${height}p`).join(', ')}. Missing: ` +
    `${missing.map((height) => `${height}p`).join(', ')}. A recording that plays perfectly at one rung ` +
    'passes every other reading in this run'
  );
}

/**
 * Why the recording is not the whole broadcast, or null.
 *
 * Measured against how long the broadcast actually ran, which the suite knows because it started and
 * stopped the publisher. ⛔ Not against a fixed length: a recording that is complete for a short
 * broadcast and truncated for a long one is a defect that only shows against the real duration.
 */
export function wholeBroadcastRefusal(vod: VodResult, broadcastS: number): string | null {
  if (vod.durationS === null) {
    return null;
  }
  // ⛔ Rounded to the millisecond before comparing. Both figures are floats read off different
  // clocks, and 64.4 - 62.4 is 2.0000000000000036 in IEEE 754, so an exact boundary comparison
  // refuses a recording that is exactly within tolerance. A paid run is not the place to discover that.
  const shortfall = Math.round((broadcastS - vod.durationS) * 1000) / 1000;
  if (shortfall <= RECORDING_SHORTFALL_TOLERANCE_S) {
    return null;
  }
  return (
    `the broadcast ran ${broadcastS.toFixed(1)}s and the recording is ${vod.durationS.toFixed(1)}s, which is ` +
    `${shortfall.toFixed(1)}s short against a tolerance of ${RECORDING_SHORTFALL_TOLERANCE_S}s. A viewer ` +
    'opening this recording cannot reach the end of what was broadcast'
  );
}

/** Why nothing was actually decoded, or null. A recording can start, report a duration and show nothing. */
export function pictureMovedRefusal(result: BrowserArmResult): string | null {
  if (result.resolutions.length === 0) {
    return 'the player never reported a resolution, so nothing was decoded and no picture was shown';
  }
  if (result.advanceRatio <= 0) {
    return (
      'the picture never moved forward across the whole settle, so this recording opened on a frame and ' +
      'stayed there'
    );
  }
  return null;
}

/** The line an operator reads while a playback arm runs. */
export function vodArmSummary(result: BrowserArmResult): string {
  const { vod } = result;
  if (vod === null) {
    return 'this arm opened no recording, so there is nothing to report about one';
  }
  if (vod.openError !== null) {
    return `the recording did not play: ${vod.openError}`;
  }
  return (
    `${vod.durationS === null ? 'no finite duration' : `${vod.durationS.toFixed(1)}s`}, seekable to ` +
    `${vod.seekableToS === null ? 'nowhere' : `${vod.seekableToS.toFixed(1)}s`}, offering ` +
    `${vod.ladderHeights.length > 0 ? vod.ladderHeights.map((height) => `${height}p`).join(', ') : 'no ladder'}. ` +
    `The picture advanced ${result.advanceRatio.toFixed(3)} and decoded ${result.resolutions.join(', ') || 'nothing'}`
  );
}
