import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseBrowserArmState, type VodResult } from '../src/harness/browser.js';
import {
  finishedTimelineRefusal,
  pictureMovedRefusal,
  playedBackRefusal,
  RECORDING_SHORTFALL_TOLERANCE_S,
  vodArmRefusal,
  vodArmSummary,
  wholeBroadcastRefusal,
  wholeLadderRefusal,
} from '../src/harness/vodArm.js';

import { armState, PLAYED_THE_WHOLE_LADDER, vodArmState } from './helpers/browserArmFixtures.js';

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

describe('whether the recording is the whole broadcast', () => {
  it('accepts a recording that covers what was broadcast', () => {
    assert.equal(wholeBroadcastRefusal(PLAYED, 63.0), null);
  });

  /**
   * ⭐ A tolerance rather than an equality, and it is arithmetic rather than a threshold: the
   * publisher stops between segment boundaries, so the last partial segment is never in the
   * recording.
   */
  it('allows the partial segment a clean stop always leaves behind', () => {
    assert.equal(wholeBroadcastRefusal(PLAYED, PLAYED.durationS! + RECORDING_SHORTFALL_TOLERANCE_S), null);
  });

  it('refuses a recording that stops well short of the broadcast', () => {
    assert.match(String(wholeBroadcastRefusal(PLAYED, 120)), /cannot reach the end of what was broadcast/);
  });

  /** Nothing to compare against where there is no duration, and the timeline refusal already said so. */
  it('says nothing where there was no duration to compare', () => {
    assert.equal(wholeBroadcastRefusal(cameBack({ durationS: null }), 120), null);
  });
});

describe('whether anything was actually shown', () => {
  it('accepts a recording that decoded and advanced', () => {
    assert.equal(pictureMovedRefusal(parseBrowserArmState(vodArmState())), null);
  });

  /** ⛔ A recording can start, report a duration, land every seek and show one frozen frame. */
  it('refuses a recording that opened on a frame and stayed there', () => {
    const frozen = parseBrowserArmState(vodArmState({ overallAdvanceRatio: 0 }));

    assert.match(String(pictureMovedRefusal(frozen)), /opened on a frame and stayed there/);
  });

  it('refuses a recording that decoded nothing at all', () => {
    const blank = parseBrowserArmState(vodArmState({ resolutions: [] }));

    assert.match(String(pictureMovedRefusal(blank)), /nothing was decoded/);
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
