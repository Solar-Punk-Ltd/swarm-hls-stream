import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { judgeQualitySwitch, type ThrottleWindow } from '../src/browser/qualitySwitch.js';
import { type ViewerSample } from '../src/browser/session.js';
import {
  judgeVodSqueeze,
  vodSqueezeObservations,
  type VodSqueezeReport,
  vodSqueezeSection,
} from '../src/browser/vodSqueeze.js';
import { type WebSocketFrame, type WebSocketTraffic } from '../src/browser/webSocketTraffic.js';

/**
 * The two readings a squeezed recording leaves that a rung timeline cannot carry: how often the
 * picture stopped in each stretch, and how many bytes the tab's own sockets pulled across it.
 *
 * `browser/vod.ts` costs a browser and a deployment to run, so every rule it reports on is here.
 */

const START_MS = 1_756_377_600_000;
const INTERVAL_MS = 1_000;

const THROTTLED_AT = START_MS + 10 * INTERVAL_MS;
const RELEASED_AT = START_MS + 20 * INTERVAL_MS;
const WINDOW: ThrottleWindow = { appliedAtMs: THROTTLED_AT, liftedAtMs: RELEASED_AT, kbps: 2800 };

/** A run of samples one second apart, described only by how far the picture moved in each. */
function played(advanced: readonly number[]): ViewerSample[] {
  let currentTime = 0;
  return advanced.map((gained, index) => {
    currentTime += gained * (INTERVAL_MS / 1000);
    return {
      atMs: START_MS + index * INTERVAL_MS,
      currentTime,
      paused: false,
      readyState: 4,
      playbackRate: 1,
      bufferAheadS: 6,
      decodedFrames: null,
      liveLatencyS: null,
      liveTargetLatencyS: null,
      bufferStalls: 0,
      rebufferCount: 0,
      rebufferMs: 0,
      fatalErrors: 0,
      droppedFrames: 0,
      resolution: '640x360',
      selectedRungHeight: 360,
      abrWouldPickHeight: 360,
      qualitySwitches: 0,
      abrEnabled: true,
      bandwidthEstimateKbps: 4_000,
      ladderHeights: [1080, 720, 480, 360],
      feedState: 'live',
      feedStateMessage: null,
    } as ViewerSample;
  });
}

const tenAt = (gained: number): number[] => Array.from({ length: 10 }, () => gained);

/** Ten samples keeping up, ten with a frozen picture, ten keeping up again. */
const FROZEN_UNDER_THE_CAP = played([...tenAt(1), ...tenAt(0), ...tenAt(1)]);
/** The same shape at four tenths of real time under the cap, which is slow rather than stopped. */
const SLOWED_UNDER_THE_CAP = played([...tenAt(1), ...tenAt(0.4), ...tenAt(1)]);

function socketed(frames: readonly WebSocketFrame[], connections = 1): WebSocketTraffic {
  return {
    connections: Array.from({ length: connections }, (_unused, index) => ({
      url: `wss://peer-${index}.example/ws`,
      openedAtMs: START_MS,
      closedAtMs: null,
    })),
    frames: [...frames],
  };
}

const inbound = (atMs: number, bytes: number): WebSocketFrame => ({ atMs, direction: 'in', bytes });
const outbound = (atMs: number, bytes: number): WebSocketFrame => ({ atMs, direction: 'out', bytes });

describe('how often the picture stopped in each stretch of a squeeze', () => {
  it('charges a frozen stretch to the phase it froze in', () => {
    const reading = judgeVodSqueeze(FROZEN_UNDER_THE_CAP, socketed([]), WINDOW);

    assert.equal(reading.before.stalledSamples, 0);
    assert.equal(reading.during.stalledSamples, 10);
    assert.equal(reading.after.stalledSamples, 0);
  });

  /** A picture at four tenths of real time is slow and not stopped, which is what stepping down buys. */
  it('counts no stall where the picture merely slowed', () => {
    assert.equal(judgeVodSqueeze(SLOWED_UNDER_THE_CAP, socketed([]), WINDOW).during.stalledSamples, 0);
  });

  /**
   * ⛔ A stall count without its denominator says nothing. Ten out of ten is a stretch that never
   * played and ten out of two hundred is one that hiccupped, and both print the same digits.
   */
  it('says how many intervals each count is out of', () => {
    const reading = judgeVodSqueeze(FROZEN_UNDER_THE_CAP, socketed([]), WINDOW);

    // Nine before the cap rather than ten: an advance describes the gap between two samples, so the
    // first sample of a run opens no interval.
    assert.equal(reading.before.sampledIntervals, 9);
    assert.equal(reading.during.sampledIntervals, 10);
    assert.equal(reading.after.sampledIntervals, 10);
  });

  it('reads a run of no samples as empty stretches rather than throwing', () => {
    const reading = judgeVodSqueeze([], socketed([]), WINDOW);

    assert.equal(reading.during.sampledIntervals, 0);
    assert.equal(reading.during.stalledSamples, 0);
    assert.equal(reading.after.webSocketInBytes, 0);
  });
});

describe('what the tab pulled over its own sockets in each stretch', () => {
  it('sums the inbound bytes of each stretch and leaves the outbound out', () => {
    const traffic = socketed([
      inbound(THROTTLED_AT - 1_000, 500),
      outbound(THROTTLED_AT - 1_000, 9_000),
      inbound(THROTTLED_AT + 1_000, 40),
      inbound(RELEASED_AT + 1_000, 7_000),
    ]);

    const reading = judgeVodSqueeze(FROZEN_UNDER_THE_CAP, traffic, WINDOW);

    assert.equal(reading.before.webSocketInBytes, 500);
    assert.equal(reading.during.webSocketInBytes, 40);
    assert.equal(reading.after.webSocketInBytes, 7_000);
  });

  /** Half open, the same boundary the rung timeline cuts on, so no byte lands in two stretches. */
  it('gives a frame at the instant the cap lifted to the stretch after it', () => {
    const reading = judgeVodSqueeze(FROZEN_UNDER_THE_CAP, socketed([inbound(RELEASED_AT, 1_234)]), WINDOW);

    assert.equal(reading.during.webSocketInBytes, 0);
    assert.equal(reading.after.webSocketInBytes, 1_234);
  });

  /**
   * ⛔ The recover stretch closes with the last sample, so the byte sums cover exactly the stretches
   * the advance ratios beside them describe. A frame that arrived while the browser was closing is
   * out of every stretch rather than inflating the last one.
   */
  it('closes the recover stretch at the last sample', () => {
    const lastAtMs = FROZEN_UNDER_THE_CAP[FROZEN_UNDER_THE_CAP.length - 1].atMs;
    const traffic = socketed([inbound(lastAtMs, 11), inbound(lastAtMs + 5_000, 22)]);

    assert.equal(judgeVodSqueeze(FROZEN_UNDER_THE_CAP, traffic, WINDOW).after.webSocketInBytes, 11);
  });

  /**
   * ⛔⛔ Zero bytes over no socket is a tab with no in-tab node in it, and zero bytes over open
   * sockets is a node that was quiet. Opposite findings about a starved viewer, printed as one zero.
   */
  it('carries how many sockets the tab opened, so a quiet node reads apart from an absent one', () => {
    assert.equal(judgeVodSqueeze(FROZEN_UNDER_THE_CAP, socketed([], 0), WINDOW).connections, 0);
    assert.equal(judgeVodSqueeze(FROZEN_UNDER_THE_CAP, socketed([], 3), WINDOW).connections, 3);
  });
});

describe('the squeeze sections a report carries', () => {
  const REPORT: VodSqueezeReport = {
    throttle: WINDOW,
    quality: judgeQualitySwitch(SLOWED_UNDER_THE_CAP, WINDOW),
    phases: judgeVodSqueeze(SLOWED_UNDER_THE_CAP, socketed([inbound(START_MS + 500, 64)]), WINDOW),
  };

  it('names all three stretches and the cap they were measured either side of', () => {
    const section = vodSqueezeSection(REPORT).join('\n');

    assert.match(section, /2800 kbps/);
    assert.match(section, /before the cap/);
    assert.match(section, /while capped/);
    assert.match(section, /after the cap lifted/);
  });

  it('carries the stall counts with their denominators and the bytes beside them', () => {
    const section = vodSqueezeSection(REPORT).join('\n');

    assert.match(section, /0 of 10/);
    assert.match(section, /64/);
  });

  /** ⛔ Owner ruling of 2026-08-29. Every rate here is measured, filed, and refuses nothing. */
  it('says in the section itself that none of it is asserted', () => {
    assert.match(vodSqueezeSection(REPORT).join('\n'), /asserted/);
  });

  it('prints the three advance ratios as observations', () => {
    const printed = vodSqueezeObservations(REPORT).join('\n');

    assert.match(printed, /observations, none of them asserted/);
    assert.match(printed, /1\.000/);
    assert.match(printed, /0\.400/);
  });
});
