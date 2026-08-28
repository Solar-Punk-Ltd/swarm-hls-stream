import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATEWAY_BYTES, WEEB3_BYTES } from '../src/browser/fetchBackendSweep.js';
import { type BrowserArmResult, parseBrowserArmState } from '../src/harness/browser.js';
import { viewerPlaybackRefusal, weeb3ArmRefusal } from '../src/harness/browserVerdict.js';

import { armState } from './helpers/browserArmFixtures.js';

/**
 * The two questions a viewer scenario asks, kept out of the suites so their rules are covered by the
 * unit run. Nothing under `suites/` runs in CI, so a verdict written inline in a scenario is a
 * verdict nothing checks until a paid broadcast is already burning.
 *
 * ⭐ Both return the reason a run is not what it claims, or null. That is the idiom the byte-source
 * and gateway gates already use: a boolean would let a suite print "assertion failed" where the
 * harness could have said which of four things went wrong.
 */

const CLEAN = parseBrowserArmState(armState());
const watched = (overrides: Partial<BrowserArmResult>): BrowserArmResult => ({ ...CLEAN, ...overrides });

const PLAYED = { minAdvanceRatio: 0.95 };

describe('whether a viewer actually watched the broadcast', () => {
  it('passes a session that kept up, decoded a picture and errored at nothing', () => {
    assert.equal(viewerPlaybackRefusal(CLEAN, PLAYED), null);
  });

  /**
   * ⛔ First, and before any figure is looked at. A hidden or throttled page produces numbers that
   * are properties of the harness rather than of the product, and the previous attempt at this ran
   * in a pane reporting `visibilityState: hidden` permanently and ended 578 seconds behind live. A
   * suite that passed on those figures would be certifying the harness.
   */
  it('refuses a run whose browser was not a usable instrument, whatever its figures say', () => {
    const degraded = watched({ instrumentSound: false, instrumentFailures: ['timer drift 61x the interval'] });

    assert.match(String(viewerPlaybackRefusal(degraded, PLAYED)), /timer drift 61x the interval/);
  });

  it('refuses a run before its playback figures, so a degraded browser is never the reported cause', () => {
    const degradedAndStalled = watched({ instrumentSound: false, instrumentFailures: ['hidden page'], advanceRatio: 0 });

    assert.match(String(viewerPlaybackRefusal(degradedAndStalled, PLAYED)), /hidden page/);
  });

  it('refuses a player that raised a fatal error, which is a viewer whose picture stopped for good', () => {
    assert.match(String(viewerPlaybackRefusal(watched({ fatalErrors: 2 }), PLAYED)), /2/);
  });

  /**
   * The honest number: media seconds delivered per wall second across the whole watch, stalls
   * included. The shortfall below one is time the viewer spent looking at a frozen frame.
   */
  it('refuses a session that did not keep up with the world', () => {
    const refusal = viewerPlaybackRefusal(watched({ advanceRatio: 0.62 }), PLAYED);

    assert.match(String(refusal), /0\.62/);
    assert.match(String(refusal), /0\.95/);
  });

  it('accepts a session sitting exactly on the threshold, which is a pass rather than a near miss', () => {
    assert.equal(viewerPlaybackRefusal(watched({ advanceRatio: 0.95 }), PLAYED), null);
  });

  /**
   * ⛔ A run that decoded nothing reports zero rebuffers, zero fatal errors and no resolution at all,
   * which is the same shape as a flawless one on every field but this. `#41` cost this project the
   * same confusion elsewhere: "I could not find X" and "there is no X" are the same return value.
   */
  it('refuses a run that named no resolution, whose silence looks exactly like a clean run', () => {
    assert.match(String(viewerPlaybackRefusal(watched({ resolutions: [] }), PLAYED)), /resolution/);
  });
});

describe('whether the arm was the in-tab node it is filed as', () => {
  const SINGLE_DIGIT = { maxSegmentRequests: 9 };

  it('passes an arm that asked for the node, landed on it, and barely touched the gateway', () => {
    assert.equal(weeb3ArmRefusal(CLEAN, SINGLE_DIGIT), null);
  });

  it('refuses an arm that never asked for the node at all', () => {
    const gateway = parseBrowserArmState(armState({ backend: GATEWAY_BYTES }));

    assert.match(String(weeb3ArmRefusal(gateway, SINGLE_DIGIT)), new RegExp(GATEWAY_BYTES));
  });

  it('refuses an arm that named no condition, since a verdict needs one', () => {
    const unswitched = parseBrowserArmState(armState({ byteSource: null }));

    assert.notEqual(weeb3ArmRefusal(unswitched, SINGLE_DIGIT), null);
  });

  /**
   * ⛔ A switch that silently did nothing puts both conditions on one, every metric agrees, and the
   * run reports that an in-tab Swarm node performs exactly like a gateway. That is the most
   * attractive headline this line of work has, produced by nothing happening.
   */
  it('refuses an arm that asked for the node and landed on the gateway', () => {
    const landedElsewhere = watched({ proof: { requested: WEEB3_BYTES, reported: GATEWAY_BYTES, settledForMs: 60_000 } });

    assert.match(String(weeb3ArmRefusal(landedElsewhere, SINGLE_DIGIT)), new RegExp(GATEWAY_BYTES));
  });

  /**
   * ⭐ The readback above proves what the client BELIEVES. This is what the network DID, and on
   * 2026-08-13 those disagreed while both arms of a paid sitting fetched all their video from one
   * node. An in-tab arm reads through the gateway while its own node boots, so a handful is expected
   * and a hundred is a viewer whose video came from the gateway after all.
   */
  it('refuses an arm that went on reading segments from the gateway', () => {
    const refusal = weeb3ArmRefusal(watched({ segmentRequests: 512 }), SINGLE_DIGIT);

    assert.match(String(refusal), /512/);
    assert.match(String(refusal), /9/);
  });

  it('accepts an arm sitting exactly on the ceiling', () => {
    assert.equal(weeb3ArmRefusal(watched({ segmentRequests: 9 }), SINGLE_DIGIT), null);
  });
});
