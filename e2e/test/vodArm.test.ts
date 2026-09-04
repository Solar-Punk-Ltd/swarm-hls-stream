import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATEWAY_BYTES, WEEB3_BYTES } from '../src/browser/fetchBackendSweep.js';
import { type BrowserArmResult, parseBrowserArmState, type VodResult } from '../src/harness/browser.js';
import {
  finishedTimelineRefusal,
  type LastPublishedByRungHeight,
  pictureMovedRefusal,
  playedBackRefusal,
  vodArmRefusal,
  vodArmSummary,
  vodByteSourceRefusal,
  wholeBroadcastRefusal,
  wholeLadderRefusal,
} from '../src/harness/vodArm.js';

import { armState, lastSegmentRefFor, PLAYED_THE_WHOLE_LADDER, vodArmState } from './helpers/browserArmFixtures.js';

/**
 * The questions a finished recording is asked when a real player opens it.
 *
 * `suites/viewer/vod-playback.test.ts` costs a broadcast and nothing under `suites/` runs in CI, so
 * every rule it judges on is covered here.
 */

const SHIPPED_LADDER = [1080, 720, 480, 360];
const PLAYED = parseBrowserArmState(vodArmState()).vod as VodResult;
const cameBack = (overrides: Partial<VodResult>): VodResult => ({ ...PLAYED, ...overrides });

describe('whether a run is a player opening a finished recording', () => {
  it('passes an arm that opened one', () => {
    assert.equal(vodArmRefusal(parseBrowserArmState(vodArmState())), null);
  });

  /** ⛔ A live watch produces a full report about a stream that was never finished. */
  it('refuses a live watch, which is about a broadcast rather than a recording', () => {
    assert.match(String(vodArmRefusal(parseBrowserArmState(armState()))), /live watch rather than a recording/);
  });

  it('refuses a run whose browser was not a usable instrument', () => {
    const degraded = parseBrowserArmState(
      vodArmState({ instrument: { sound: false, failures: ['timer drift 61x the interval'] } }),
    );

    assert.match(String(vodArmRefusal(degraded)), /timer drift 61x the interval/);
  });
});

describe('whether the recording played at all', () => {
  it('accepts one that did', () => {
    assert.equal(playedBackRefusal(PLAYED), null);
  });

  /**
   * ⛔ A result rather than an exception, on purpose. A run that threw would leave no artifact, and
   * "the recording never started" is the single most important thing a playback run can report.
   */
  it('carries the reason it did not, out of the artifact', () => {
    const never = cameBack({ openError: 'the recording never started playing' });

    assert.match(String(playedBackRefusal(never)), /never started playing/);
  });
});

describe('whether the player was handed a finished timeline', () => {
  it('accepts a finite duration', () => {
    assert.equal(finishedTimelineRefusal(PLAYED), null);
  });

  /**
   * ⛔⛔ A live playlist reports Infinity, and `JSON.stringify` writes Infinity as null, so both reach
   * the reader as an absent number and both mean the same thing: this was not a finished recording.
   * Without this the run would seek around inside a MOVING window and every target would have shifted.
   */
  it('refuses a player handed a live playlist where a finished one was expected', () => {
    assert.match(String(finishedTimelineRefusal(cameBack({ durationS: null }))), /LIVE playlist/);
  });

  it('refuses a recording with no timeline in it', () => {
    assert.match(String(finishedTimelineRefusal(cameBack({ durationS: 0 }))), /no timeline to play/);
  });
});

describe('whether the recording is the whole ladder it was published as', () => {
  it('accepts a recording offering every rung the deployment published', () => {
    assert.equal(wholeLadderRefusal(PLAYED, SHIPPED_LADDER), null);
  });

  /**
   * ⭐⭐ The plan's own done-when, and the failure this whole file exists for. A recording whose
   * master resolved and whose upper rung playlists did not plays PERFECTLY at its bottom rung: it
   * starts, the duration is finite, the seeks land, the picture moves. Every other reading here calls
   * that a pass.
   */
  it('refuses a recording that only plays its lowest rung', () => {
    const bottomOnly = cameBack({ ladderHeights: [360] });

    const refusal = String(wholeLadderRefusal(bottomOnly, SHIPPED_LADDER));
    assert.match(refusal, /Missing: 1080p, 720p, 480p/);
    assert.match(refusal, /passes every other reading in this run/);
  });

  /**
   * ⛔ A different failure from a short ladder, and the message says so: no master at all usually
   * means the topic played was one rung's rather than the broadcast's.
   */
  it('says so differently when no ladder resolved at all', () => {
    assert.match(String(wholeLadderRefusal(cameBack({ ladderHeights: [] }), SHIPPED_LADDER)), /no master playlist/);
  });

  /** A single-rendition deployment publishes no ladder, so there is no ladder to be missing. */
  it('asks nothing of a deployment that declares no ladder', () => {
    assert.equal(wholeLadderRefusal(cameBack({ ladderHeights: [] }), []), null);
  });
});

describe('the per-rung reading, out of the artifact', () => {
  it('reads every rung the driver wrote, with the segment each one ends at', () => {
    assert.deepEqual(PLAYED.rungs, [
      { height: 1080, segments: 31, durationS: 62, lastSegmentRef: lastSegmentRefFor(1080), readFrom: 'player' },
      { height: 720, segments: 31, durationS: 62, lastSegmentRef: lastSegmentRefFor(720), readFrom: 'feed' },
      { height: 480, segments: 31, durationS: 62, lastSegmentRef: lastSegmentRefFor(480), readFrom: 'feed' },
      { height: 360, segments: 31, durationS: 62, lastSegmentRef: lastSegmentRefFor(360), readFrom: 'feed' },
    ]);
  });

  /**
   * ⛔ Additive, because a browser image built before the reading existed writes a file that is right
   * in every other respect. Read as null and refused by name, never defaulted into a pass.
   */
  it('reads an artifact written before the section existed as having none', () => {
    const older = { ...PLAYED_THE_WHOLE_LADDER };
    delete older.rungs;

    assert.equal(parseBrowserArmState(vodArmState({ vod: older })).vod?.rungs, null);
  });

  /** A rung neither the player nor its own feed produced a playlist for is a reading, so it parses. */
  it('reads a rung whose playlist nothing produced', () => {
    const unread = {
      ...PLAYED_THE_WHOLE_LADDER,
      rungs: [{ height: 720, segments: null, durationS: null, lastSegmentRef: null, readFrom: null }],
    };

    assert.deepEqual(parseBrowserArmState(vodArmState({ vod: unread })).vod?.rungs, [
      { height: 720, segments: null, durationS: null, lastSegmentRef: null, readFrom: null },
    ]);
  });
});

/**
 * ⛔⛔⛔ An identity per rung, and the reason it is not a length.
 *
 * This compared the player's duration against a segment COUNT times the DECLARED segment length,
 * inside two seconds of tolerance, until 2026-09-03. SRS's segment counter runs on across broadcasts,
 * so the count also picked up the previous broadcast's stragglers: on 2026-09-02 one line from a
 * broadcast that had ended eleven seconds earlier made a complete four rung recording read as 2.4s
 * short, and V4 was the only red of the sitting. The nine passes before it landed anywhere from 0.3s
 * over to exactly on the tolerance, so the check was a coin toss rather than a rule.
 */
describe('whether the recording is the whole broadcast', () => {
  const SHIPPED = [1080, 720, 480, 360];
  const published = (overrides: Record<number, string | null> = {}): LastPublishedByRungHeight =>
    new Map(SHIPPED.map((height) => [height, height in overrides ? overrides[height] : lastSegmentRefFor(height)]));

  it('accepts a recording whose every rung ends at the last segment the uploader published', () => {
    assert.equal(wholeBroadcastRefusal(PLAYED, published()), null);
  });

  /** ⭐⭐ The straggler case, which is the one the seconds comparison got wrong on a complete recording. */
  it('names the rung that ends before the uploader did, and only that rung', () => {
    const refusal = String(wholeBroadcastRefusal(PLAYED, published({ 1080: 'f'.repeat(64) })));

    assert.match(refusal, /the 1080p rung ends at 1080108010/);
    assert.match(refusal, /31 segment\(s\)/);
    assert.match(refusal, /cannot reach the end of what was broadcast/);
    assert.doesNotMatch(refusal, /720p|480p|360p/);
  });

  /** A recording that plays perfectly at every rung it kept, and lost one of the four it was published as. */
  it('names a rung the deployment published and the recording does not carry', () => {
    const withoutTheTop = cameBack({ rungs: PLAYED.rungs!.filter((rung) => rung.height !== 1080) });

    const refusal = String(wholeBroadcastRefusal(withoutTheTop, published()));
    assert.match(refusal, /carries no 1080p rung and the deployment published one/);
    assert.match(refusal, /720p, 480p, 360p/);
  });

  /**
   * ⛔ A reading nobody took, said in those words. A browser image built before `vod.rungs` existed
   * writes every other field intact, so a default here would report the recording as whole on the
   * strength of nothing.
   */
  it('refuses an artifact whose driver predates the reading rather than passing it', () => {
    const refusal = String(wholeBroadcastRefusal(cameBack({ rungs: null }), published()));

    assert.match(refusal, /predates the last-segment check/);
    assert.match(refusal, /Rebuild the browser image/);
  });

  /** Neither the player nor the rung's own feed produced a playlist, which is not the same as a short one. */
  it('says so where a rung of the recording could not be read at all', () => {
    const unread = cameBack({
      rungs: PLAYED.rungs!.map((rung) =>
        rung.height === 480 ? { ...rung, segments: null, lastSegmentRef: null, readFrom: null } : rung,
      ),
    });

    assert.match(String(wholeBroadcastRefusal(unread, published())), /480p rung's playlist reached neither/);
  });

  /** A playlist that reached the run and named no segment, which is a different shape from no playlist. */
  it('says so where a rung of the recording names no last segment', () => {
    const nameless = cameBack({
      rungs: PLAYED.rungs!.map((rung) => (rung.height === 480 ? { ...rung, segments: 0, lastSegmentRef: null } : rung)),
    });

    assert.match(String(wholeBroadcastRefusal(nameless, published())), /480p rung holds 0 segment\(s\)/);
  });

  /** A declared rung the uploader never wrote a segment for, which is a fault of the broadcast. */
  it('names a rung the uploader published nothing on', () => {
    assert.match(String(wholeBroadcastRefusal(PLAYED, published({ 720: null }))), /no segment at all on the 720p rung/);
  });

  /** ⛔ Not a silent pass. An expectation of nothing would certify any recording at all. */
  it('refuses where the log named no last segment on any rung', () => {
    assert.match(String(wholeBroadcastRefusal(PLAYED, new Map())), /nothing for this recording to be the whole of/);
  });
});

describe('whether anything was actually shown', () => {
  it('accepts a recording that decoded and advanced', () => {
    assert.equal(pictureMovedRefusal(parseBrowserArmState(vodArmState())), null);
  });

  /** ⛔ A recording can start, report a duration, land every seek and show one frozen frame. */
  it('refuses a recording that opened on a frame and stayed there', () => {
    const frozen = parseBrowserArmState(
      vodArmState({
        overallAdvanceRatio: 0,
        startedPlaying: { currentTime: 0.01 },
        afterSettle: { currentTime: 0.01 },
      }),
    );

    assert.match(String(pictureMovedRefusal(frozen)), /opened on a frame and stayed there/);
  });

  /**
   * ⛔⛔ The reading six V4 runs produced on 2026-09-02 and 09-03: a 30 s recording played to its last
   * second inside the 60 s settle, the watch that followed found an ended element, and advance read 0.
   * That recording played, and calling it frozen was the harness reading its own window.
   */
  it('accepts a recording that reached its end during the settle, whatever the watch after it read', () => {
    const ended = parseBrowserArmState(
      vodArmState({
        overallAdvanceRatio: 0,
        startedPlaying: { currentTime: 0.012 },
        afterSettle: { currentTime: 30.533 },
      }),
    );

    assert.equal(pictureMovedRefusal(ended), null);
    assert.equal(ended.vod?.playedThroughS, 30.521);
  });

  it('reads no settle travel off an artifact that recorded no start or no post-settle state', () => {
    const older = parseBrowserArmState(vodArmState({ overallAdvanceRatio: 0 }));

    assert.equal(older.vod?.playedThroughS, null);
    assert.match(String(pictureMovedRefusal(older)), /opened on a frame and stayed there/);
  });

  it('refuses a recording that decoded nothing at all', () => {
    const blank = parseBrowserArmState(vodArmState({ resolutions: [] }));

    assert.match(String(pictureMovedRefusal(blank)), /nothing was decoded/);
  });
});

/**
 * Whether the recording that played was served by the arm this run is filed under.
 *
 * ⛔⛔ Until now V4 asked nothing of the kind. The proof was recorded on every arm and read by
 * nobody, so an in-browser run whose in-tab node never served a byte passed exactly like one whose
 * node served all of them, and every past in-tab playback result means only that A recording played.
 *
 * ⭐ The measured separation this is judged on, both arms from 2026-09-03 on the same 120s recording:
 * the in-tab arm made **6** gateway segment requests over the whole run and the gateway arm made
 * **61**, one per segment of the recording.
 */
describe('whether a playback arm was the byte source it is filed as', () => {
  const SINGLE_DIGIT = { maxSegmentRequests: 9 };
  const played = (overrides: Partial<BrowserArmResult>): BrowserArmResult => ({
    ...parseBrowserArmState(vodArmState()),
    ...overrides,
  });

  it('passes an in-tab arm that read the recording through the node in the tab', () => {
    assert.equal(vodByteSourceRefusal(parseBrowserArmState(vodArmState()), SINGLE_DIGIT), null);
  });

  /**
   * ⛔ The control condition, at the count a real one produces. 61 requests is the whole recording
   * on one rung, and a ceiling applied here would refuse the only arm the in-tab arm is compared
   * against.
   */
  it('passes a gateway arm that read every segment of the recording through the gateway', () => {
    const gateway = parseBrowserArmState(vodArmState({ backend: GATEWAY_BYTES, segmentRequests: 61 }));

    assert.equal(vodByteSourceRefusal(gateway, SINGLE_DIGIT), null);
  });

  it('refuses an arm that named no byte source', () => {
    const unnamed = parseBrowserArmState(vodArmState({ byteSource: null }));

    assert.match(String(vodByteSourceRefusal(unnamed, SINGLE_DIGIT)), /named no byte source/);
  });

  it('refuses an in-tab arm the client reports on the gateway', () => {
    const landedElsewhere = played({
      proof: { requested: WEEB3_BYTES, reported: GATEWAY_BYTES, settledForMs: 60_000 },
    });

    assert.match(String(vodByteSourceRefusal(landedElsewhere, SINGLE_DIGIT)), /switch did not take/);
  });

  /**
   * ⭐ The count is what separates a node that served the recording from a client that answered
   * honestly and read the gateway anyway. 61 is what the gateway arm of 2026-09-03 measured, so an
   * in-tab arm reaching it read the whole recording from the wrong place.
   */
  it('refuses an in-tab arm that read the recording from the gateway after all', () => {
    const refusal = vodByteSourceRefusal(played({ segmentRequests: 61 }), SINGLE_DIGIT);

    assert.match(String(refusal), /61/);
    assert.match(String(refusal), /9/);
  });
});

describe('the line an operator reads while a playback arm runs', () => {
  it('names the timeline and the ladder it found', () => {
    const line = vodArmSummary(parseBrowserArmState(vodArmState()));

    assert.match(line, /62\.4s/);
    assert.match(line, /1080p, 720p, 480p, 360p/);
  });

  it('leads with the reason where the recording did not play', () => {
    const never = { ...PLAYED_THE_WHOLE_LADDER, openError: 'the recording never started playing' };

    assert.match(vodArmSummary(parseBrowserArmState(vodArmState({ vod: never }))), /did not play/);
  });

  it('has something to say about an arm that opened no recording', () => {
    assert.match(vodArmSummary(parseBrowserArmState(armState())), /opened no recording/);
  });
});
