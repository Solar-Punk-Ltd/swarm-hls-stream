import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATEWAY_BYTES, WEEB3_BYTES } from '../src/browser/fetchBackendSweep.js';
import { type BrowserArmResult, parseBrowserArmState } from '../src/harness/browser.js';
import {
  byteSourceArmRefusal,
  ladderResolutionRefusal,
  viewerPlaybackRefusal,
  weeb3ArmRefusal,
} from '../src/harness/browserVerdict.js';

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

describe('whether a viewer actually watched the broadcast', () => {
  it('passes a session that decoded a picture, moved it forward and errored at nothing', () => {
    assert.equal(viewerPlaybackRefusal(CLEAN), null);
  });

  /**
   * ⛔ First, and before any figure is looked at. A hidden or throttled page produces numbers that
   * are properties of the harness rather than of the product, and the previous attempt at this ran
   * in a pane reporting `visibilityState: hidden` permanently and ended 578 seconds behind live. A
   * suite that passed on those figures would be certifying the harness.
   */
  it('refuses a run whose browser was not a usable instrument, whatever its figures say', () => {
    const degraded = watched({ instrumentSound: false, instrumentFailures: ['timer drift 61x the interval'] });

    assert.match(String(viewerPlaybackRefusal(degraded)), /timer drift 61x the interval/);
  });

  it('refuses a run before its playback figures, so a degraded browser is never the reported cause', () => {
    const degradedAndStalled = watched({
      instrumentSound: false,
      instrumentFailures: ['hidden page'],
      advanceRatio: 0,
    });

    assert.match(String(viewerPlaybackRefusal(degradedAndStalled)), /hidden page/);
  });

  it('refuses a player that raised a fatal error, which is a viewer whose picture stopped for good', () => {
    assert.match(String(viewerPlaybackRefusal(watched({ fatalErrors: 2 }))), /2/);
  });

  /**
   * ⛔ A run that decoded nothing reports zero rebuffers, zero fatal errors and no resolution at all,
   * which is the same shape as a flawless one on every field but this. `#41` cost this project the
   * same confusion elsewhere: "I could not find X" and "there is no X" are the same return value.
   */
  it('refuses a run that named no resolution, whose silence looks exactly like a clean run', () => {
    assert.match(String(viewerPlaybackRefusal(watched({ resolutions: [] }))), /resolution/);
  });

  /**
   * ⛔ The picture has to have moved. A session that decoded a first frame and then sat on it for
   * four minutes reports a resolution and no error, which is the shape of a watch on every field but
   * this one, and it is the one outcome that means the feature did not work.
   */
  it('refuses a session whose picture never moved forward at all', () => {
    assert.match(String(viewerPlaybackRefusal(watched({ advanceRatio: 0 }))), /never moved/);
  });

  /**
   * ⭐ The owner's ruling of 2026-08-29: an e2e suite checks that the feature works, and how fast it
   * worked is an observation rather than a gate. A viewer who kept up with 0.62 of the wall clock
   * watched the broadcast, on a configuration that delivers less of it per second, and a suite that
   * failed them would be reporting a performance difference as a broken product.
   */
  it('passes a session that kept up slowly, which is a performance reading rather than a defect', () => {
    assert.equal(viewerPlaybackRefusal(watched({ advanceRatio: 0.62 })), null);
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
    const landedElsewhere = watched({
      proof: { requested: WEEB3_BYTES, reported: GATEWAY_BYTES, settledForMs: 60_000 },
    });

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

/**
 * The three-branch rule every viewer suite applies to its arm, stated once.
 *
 * ⛔⛔ It was stated four times before: inline in `qualityArm`, `rungArm` and `crashArm`, and
 * nowhere at all for V4 and V5, which is how those two came to pass in the in-browser profile
 * whatever served them. A rule with four copies and two gaps is the shape the copies produce.
 *
 * ⭐ The gateway condition passes with no ceiling applied, and that is the branch worth a test of
 * its own. A gateway arm reads every segment through the gateway by definition, so holding one to
 * the in-tab ceiling would refuse the only arm the in-tab readings are ever compared against.
 */
describe('whether an arm was the byte source it is filed as, in either condition', () => {
  const SINGLE_DIGIT = { maxSegmentRequests: 9 };

  it('passes an in-tab arm that asked for the node, landed on it and barely touched the gateway', () => {
    assert.equal(byteSourceArmRefusal(CLEAN, SINGLE_DIGIT), null);
  });

  it('passes a gateway arm that landed on the gateway, however many segments it read there', () => {
    const gateway = parseBrowserArmState(armState({ backend: GATEWAY_BYTES, segmentRequests: 512 }));

    assert.equal(byteSourceArmRefusal(gateway, SINGLE_DIGIT), null);
  });

  /** A verdict filed against a condition nobody chose is a verdict about nothing. */
  it('refuses an arm that named no byte source at all', () => {
    const unswitched = parseBrowserArmState(armState({ byteSource: null }));

    assert.match(String(byteSourceArmRefusal(unswitched, SINGLE_DIGIT)), /named no byte source/);
  });

  /**
   * ⛔ A switch that silently did nothing puts both conditions on one, every metric agrees, and the
   * run reports that an in-tab Swarm node performs exactly like a gateway. That is the most
   * attractive headline this line of work has, produced by nothing happening.
   */
  it('refuses an arm that asked for the node and landed on the gateway', () => {
    const landedElsewhere = watched({
      proof: { requested: WEEB3_BYTES, reported: GATEWAY_BYTES, settledForMs: 60_000 },
    });

    assert.match(String(byteSourceArmRefusal(landedElsewhere, SINGLE_DIGIT)), /switch did not take/);
  });

  /** Both directions, because the control condition drifting is as wrong as the subject drifting. */
  it('refuses an arm that asked for the gateway and landed on the node', () => {
    const landedElsewhere = watched({
      proof: { requested: GATEWAY_BYTES, reported: WEEB3_BYTES, settledForMs: 60_000 },
    });

    assert.match(String(byteSourceArmRefusal(landedElsewhere, SINGLE_DIGIT)), /switch did not take/);
  });

  /**
   * ⭐ The readback above is what the client BELIEVES. This is what the network DID, and on
   * 2026-08-13 those disagreed while both arms of a paid sitting fetched all their video from one
   * node.
   */
  it('refuses an in-tab arm that went on reading segments from the gateway', () => {
    const refusal = byteSourceArmRefusal(watched({ segmentRequests: 512 }), SINGLE_DIGIT);

    assert.match(String(refusal), /512/);
    assert.match(String(refusal), /9/);
  });
});

/**
 * Whether the viewer received a quality the deployment actually configured.
 *
 * ⛔⛔ **Phase 1 of `docs/e2e-viewer-coverage-plan.md`.** Every watching suite already captured the
 * resolutions a viewer passed through and printed them under "observed, not asserted", so a viewer
 * silently riding a rung outside the ladder passed every test. The reading was there the whole time
 * and nothing could fail on it.
 *
 * ⭐ **It asks whether the rung is one the ladder declares, never which one.** Which rung a player
 * picks is its own adaptive decision, and pinning it would be a performance assertion wearing a
 * correctness coat. Owner rule of 2026-08-29.
 *
 * ⚠️ It cannot catch a failure to SWITCH. A viewer pinned to one legitimate rung for the whole watch
 * passes here and is exactly what V2 exists to catch.
 */
describe('whether the viewer got a quality the ladder declares', () => {
  const LADDER = ['1920×1080', '1280×720', '854×480', '640×360'] as const;

  it('passes a viewer who stayed on one rung of the ladder', () => {
    assert.equal(ladderResolutionRefusal(watched({ resolutions: ['1280×720'] }), LADDER), null);
  });

  it('passes a viewer who moved between rungs of the ladder', () => {
    assert.equal(ladderResolutionRefusal(watched({ resolutions: ['640×360', '1280×720', '1920×1080'] }), LADDER), null);
  });

  it('refuses a resolution the ladder never declared', () => {
    const refusal = ladderResolutionRefusal(watched({ resolutions: ['1280×720', '426×240'] }), LADDER);

    assert.match(refusal ?? '', /426×240/, `the refusal must name the rung nobody configured: ${refusal}`);
  });

  /**
   * ⛔ The client renders U+00D7, not the letter x. A check built with `${w}x${h}` matches nothing
   * and passes every run, which is the same shape of silence this whole phase exists to remove.
   */
  it('matches the multiplication sign the client actually renders', () => {
    assert.equal(ladderResolutionRefusal(watched({ resolutions: ['1280x720'] }), LADDER), null);
  });

  /** A single-rendition deployment has no ladder to be outside of, so there is nothing to refuse. */
  it('says nothing when the deployment declares no ladder', () => {
    assert.equal(ladderResolutionRefusal(watched({ resolutions: ['1280×720'] }), []), null);
  });

  /**
   * Deliberately silent, because `viewerPlaybackRefusal` already refuses it with the far better
   * account: no resolution at all is a viewer who saw no picture, not one who saw a wrong quality.
   */
  it('leaves a viewer who decoded nothing to the refusal that explains it', () => {
    assert.equal(ladderResolutionRefusal(watched({ resolutions: [] }), LADDER), null);
  });
});
