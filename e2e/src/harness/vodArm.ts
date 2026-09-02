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

import { type BrowserArmResult, type VodResult, type VodRung } from './browser.js';

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
 * The last segment the uploader published on each rung, keyed by that rung's height in the ladder.
 *
 * A null value is a rung the deployment declares that the uploader published nothing on at all, which
 * is a fault of its own and not the same as a rung missing from the recording.
 */
export type LastPublishedByRungHeight = ReadonlyMap<number, string | null>;

/**
 * Why the recording is not the whole broadcast, or null.
 *
 * ## ⛔⛔⛔ Why this is an identity and not a length
 *
 * Until 2026-09-03 this compared the player's duration against a segment COUNT off the uploader's log
 * times the DECLARED segment length, inside two seconds of tolerance. That is an estimate held
 * against a measurement, and it was wrong in both directions.
 *
 * SRS's segment counter runs on across broadcasts, so a log window opened at a broadcast's start also
 * holds the previous broadcast's last segments at indices that continue the sequence. On 2026-09-02
 * one such straggler, from a broadcast that had ended eleven seconds earlier, made a complete four
 * rung recording read as 2.4s short and V4 was the only red of the sitting. The other direction is
 * the partial fragment a clean stop always leaves: counting it as a full segment inflates the
 * estimate, which is what the tolerance was there to absorb. Across the nine passes before that the
 * gap ran from 0.3s over to exactly 2.0s, against a tolerance of 2, so the check was a coin toss.
 *
 * A reference is the segment. Comparing the last one in each rung's playlist against the last one the
 * uploader published on that rung needs no tolerance, no segment length, and no arithmetic that a
 * neighbouring broadcast can reach.
 *
 * ⛔ Per rung, because one rung of four stopping is this deployment's signature failure. A recording
 * whose 1080p playlist ends four segments early plays perfectly at 360p.
 */
export function wholeBroadcastRefusal(vod: VodResult, lastPublished: LastPublishedByRungHeight): string | null {
  const rungs = vod.rungs;
  if (rungs === null) {
    return (
      'this artifact carries no per-rung reading, so the browser image that wrote it predates the ' +
      'last-segment check and cannot say whether the recording is the whole broadcast. Rebuild the ' +
      'browser image on the host rather than reading this run as a complete recording'
    );
  }
  if (lastPublished.size === 0) {
    return (
      'the uploader published no last segment on any rung of the declared ladder, so there is nothing ' +
      'for this recording to be the whole of. That is the log window or the rung names, not the recording'
    );
  }

  const reasons = [...lastPublished].flatMap(([height, published]) => {
    const reason = rungShortfall(rungs, height, published);
    return reason === null ? [] : [reason];
  });
  if (reasons.length === 0) {
    return null;
  }
  return `${reasons.join('. ')}. Judged on the identity of each rung's last segment, with no tolerance`;
}

function rungShortfall(rungs: readonly VodRung[], height: number, published: string | null): string | null {
  if (published === null) {
    return `the uploader published no segment at all on the ${height}p rung, so that rung holds no broadcast`;
  }

  const rung = rungs.find((candidate) => candidate.height === height);
  if (rung === undefined) {
    const offered = rungs.map((candidate) =>
      candidate.height === null ? 'a rung with no height' : `${candidate.height}p`,
    );
    return (
      `this recording carries no ${height}p rung and the deployment published one. It offers ` +
      `${offered.join(', ') || 'no rungs at all'}`
    );
  }
  if (rung.segments === null) {
    return (
      `the ${height}p rung's playlist reached neither the player nor a read of its own feed, so nothing ` +
      'here says how much of the broadcast it holds'
    );
  }
  if (rung.lastSegmentRef === null) {
    return (
      `the ${height}p rung holds ${rung.segments} segment(s) and names no last reference, so its ` +
      'playlist reached this run in a shape nothing can be judged against'
    );
  }
  if (rung.lastSegmentRef !== published) {
    return (
      `the ${height}p rung ends at ${shortRef(rung.lastSegmentRef)} over ${rung.segments} segment(s) and ` +
      `the uploader published ${shortRef(published)} last on it, so a viewer on that rung cannot reach ` +
      'the end of what was broadcast'
    );
  }
  return null;
}

/** Enough of a reference to identify a segment. The artifact keeps every character of it. */
function shortRef(reference: string): string {
  return `${reference.slice(0, 12)}…`;
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
