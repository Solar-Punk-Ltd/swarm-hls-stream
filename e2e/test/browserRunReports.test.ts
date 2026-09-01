import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type FragmentRequest, judgeFragmentRequests } from '../src/browser/fragmentRequests.js';
import { judgeRun } from '../src/browser/instrument.js';
import { judgeQualitySwitch, judgeRungTimeline } from '../src/browser/qualitySwitch.js';
import { type QualityRun, renderQualityReport } from '../src/browser/qualitySwitchReport.js';
import { judgeRecovery } from '../src/browser/recovery.js';
import { renderRungOutageReport, type RungOutageRun } from '../src/browser/rungOutageReport.js';
import { summarize, type ViewerSample } from '../src/browser/session.js';
import { type LadderRung } from '../src/config.js';

/**
 * The two run reports written for V2 and V3, rendered.
 *
 * ⛔ The verdict prose is where a report can LIE. Every other section restates a number, and a wrong
 * number is visible beside the table it came from. A verdict says "it stepped down" or "it never
 * did", and nothing beside it contradicts a sentence pointing the wrong way. So what is asserted here
 * is that each verdict flips when the run flips, rather than that the markdown looks a certain way.
 *
 * ⭐ The runs are assembled the way a driver assembles one, through `summarize`, `judgeRun` and the
 * real judges, rather than hand-written. A fixture stating a summary directly would be a test about
 * the fixture.
 */

const START_MS = 1_756_377_600_000;
const INTERVAL_MS = 1_000;
const APPLIED_AT = START_MS + 10 * INTERVAL_MS;
const LIFTED_AT = START_MS + 20 * INTERVAL_MS;

const LADDER: LadderRung[] = [
  { name: '1080p', width: 1920, height: 1080, kbps: 5000 },
  { name: '720p', width: 1280, height: 720, kbps: 2800 },
  { name: '480p', width: 854, height: 480, kbps: 1200 },
  { name: '360p', width: 640, height: 360, kbps: 700 },
];

interface SamplePlan {
  rung: number;
  advanced?: number;
  bandwidthKbps?: number;
  feedState?: string;
  feedStateMessage?: string | null;
}

function watched(plans: readonly SamplePlan[]): ViewerSample[] {
  let currentTime = 0;
  return plans.map((plan, index) => {
    currentTime += (plan.advanced ?? 1) * (INTERVAL_MS / 1000);
    return {
      atMs: START_MS + index * INTERVAL_MS,
      currentTime,
      paused: false,
      readyState: 4,
      playbackRate: 1,
      bufferAheadS: 6,
      decodedFrames: null,
      liveLatencyS: 5,
      liveTargetLatencyS: 6,
      bufferStalls: 0,
      rebufferCount: 0,
      rebufferMs: 0,
      fatalErrors: 0,
      droppedFrames: 0,
      resolution: `x${plan.rung}`,
      selectedRungHeight: plan.rung,
      abrWouldPickHeight: plan.rung,
      qualitySwitches: 0,
      abrEnabled: true,
      bandwidthEstimateKbps: plan.bandwidthKbps ?? 6_000,
      ladderHeights: [1080, 720, 480, 360],
      feedState: plan.feedState ?? 'live',
      feedStateMessage: plan.feedStateMessage ?? null,
    } as unknown as ViewerSample;
  });
}

const held = (count: number, plan: SamplePlan): SamplePlan[] => Array.from({ length: count }, () => plan);

const TOP_RUNG = 'swarm://0xowner/9c4e1f60b8a2d357e0f1a2b3c4d5e6f7';
const BOTTOM_RUNG = 'swarm://0xowner/1a2b3c4d5e6f708192a3b4c5d6e7f809';

/** What the player asked for while it rode the top rung and then came down off it. */
const ASKED_AND_CAME_DOWN: FragmentRequest[] = [
  { atMs: APPLIED_AT - 2_000, level: '3', sn: '1', rung: TOP_RUNG },
  { atMs: APPLIED_AT + 1_000, level: '3', sn: '2', rung: TOP_RUNG },
  { atMs: APPLIED_AT + 2_000, level: '0', sn: '3', rung: BOTTOM_RUNG },
  { atMs: LIFTED_AT + 1_000, level: '3', sn: '4', rung: TOP_RUNG },
];

function qualityRunOf(samples: ViewerSample[], asked: FragmentRequest[] = ASKED_AND_CAME_DOWN): QualityRun {
  const throttle = { appliedAtMs: APPLIED_AT, liftedAtMs: LIFTED_AT, kbps: 1200 };
  const summary = summarize(samples);
  return {
    measuredAt: '2026-08-30T01:00:00.000Z',
    watchUrl: 'http://127.0.0.1:10074/watch',
    chromeVersion: 'Chrome 149',
    gopSeconds: 2,
    ladder: LADDER,
    throttle,
    summary,
    quality: judgeQualitySwitch(samples, throttle),
    fragmentRequests: judgeFragmentRequests(asked, throttle, summary.overallAdvanceRatio > 0),
    instrument: judgeRun([]),
    samples,
    screenshots: [],
  };
}

function rungRunOf(samples: ViewerSample[]): RungOutageRun {
  const outage = { appliedAtMs: APPLIED_AT, liftedAtMs: LIFTED_AT };
  return {
    measuredAt: '2026-08-30T01:00:00.000Z',
    watchUrl: 'http://127.0.0.1:10074/watch',
    chromeVersion: 'Chrome 149',
    gopSeconds: 2,
    engine: 'latbench-srs-1',
    ladder: LADDER,
    silenced: {
      rung: '720p',
      height: 720,
      processes: [{ pid: 418, args: 'ffmpeg -f flv rtmp://127.0.0.1:10002/live/demo_720p?vhost=abr' }],
      ...outage,
    },
    summary: summarize(samples),
    rungs: judgeRungTimeline(samples, outage),
    recovery: judgeRecovery(samples, { injectedAtMs: APPLIED_AT, liftedAtMs: LIFTED_AT, servingAtMs: null }),
    instrument: judgeRun([]),
    samples,
    screenshots: [],
  };
}

describe('the report a squeezed viewer leaves behind', () => {
  const adapted = watched([
    ...held(10, { rung: 1080 }),
    ...held(10, { rung: 360, bandwidthKbps: 1_050 }),
    ...held(10, { rung: 1080 }),
  ]);

  it('says the player stepped down, kept playing and climbed back', () => {
    const report = renderQualityReport(qualityRunOf(adapted));

    assert.match(report, /✅ \*\*It stepped down\*\* to 360p/);
    assert.match(report, /✅ \*\*The picture kept moving while capped\*\*/);
    assert.match(report, /✅ \*\*It climbed back\*\* to 1080p/);
  });

  /**
   * ⛔ The instrument verdict, and it is the one that must never read as a product result. A player
   * whose own estimate did not fall was never squeezed, whatever it then did.
   */
  it('says the cap never reached the player when its own estimate stayed above it', () => {
    const unsqueezed = watched([...held(10, { rung: 1080 }), ...held(10, { rung: 1080 }), ...held(10, { rung: 1080 })]);

    const report = renderQualityReport(qualityRunOf(unsqueezed));

    assert.match(report, /⛔ \*\*The player never noticed the cap\.\*\*/);
    assert.match(report, /did not reach whatever carried the segment bytes/);
  });

  it('says the picture stopped when it did, however well the player chose', () => {
    const stalled = watched([
      ...held(10, { rung: 1080 }),
      ...held(10, { rung: 360, advanced: 0, bandwidthKbps: 1_050 }),
      ...held(10, { rung: 360 }),
    ]);

    assert.match(renderQualityReport(qualityRunOf(stalled)), /⛔ \*\*The picture stopped while capped\.\*\*/);
  });

  it('names which rungs the cap left affordable, off the deployment own ladder', () => {
    const report = renderQualityReport(qualityRunOf(adapted));

    assert.match(report, /\| 480p \| 1200 kbps \| yes \|/);
    assert.match(report, /\| 720p \| 2800 kbps \| no \|/);
  });

  /**
   * ⭐ The reading V2's three reds had no way to take. Every other section says what the player
   * DECODED or what ABR would pick next, and neither separates a player riding a rung it cannot carry
   * from one asking for a cheaper rung that upstream answers with the expensive one.
   */
  it('names the level the player asked for in each phase, and the rung it asked against', () => {
    const report = renderQualityReport(qualityRunOf(adapted));

    assert.match(report, /## Which level the player asked for/);
    assert.match(report, /\| before the cap \| 3 \| 1 \|/);
    assert.match(report, /\| while capped \| 0 \| 1 \|/);
    assert.match(report, /\| after the cap lifted \| 3 \| 1 \|/);
    // Shortened to the tail of the topic, which is what tells two rungs of one ladder apart.
    assert.ok(report.includes(`…${BOTTOM_RUNG.slice(-12)}`), 'the rung the cheap level asked against is not named');
  });

  /**
   * ⛔⛔⛔ Zero captured is not zero requested. A picture that moved cannot have requested no
   * fragments, so an empty capture means the CLIENT this arm watched has no instrument. Printing that
   * as a player which asked for nothing would be a wrong answer wearing a measurement's clothes.
   */
  it('calls an empty capture over a moving picture an absent instrument, never a silent player', () => {
    const report = renderQualityReport(qualityRunOf(adapted, []));

    assert.match(report, /instrument absent from the deployed client/);
    assert.doesNotMatch(report, /fragment request\(s\) recorded/);
  });
});

describe('the report a silenced rung leaves behind', () => {
  const movedOff = watched([...held(10, { rung: 720 }), ...held(10, { rung: 480 }), ...held(10, { rung: 720 })]);

  it('says the player moved off the dead rung and kept watching', () => {
    const report = renderRungOutageReport(rungRunOf(movedOff));

    assert.match(report, /✅ \*\*It moved off the dead rung\*\*, from 720p to 480p/);
    assert.match(report, /✅ \*\*The picture kept moving while the rung was quiet\*\*/);
  });

  /**
   * ⭐ The outcome this suite most expects. The report has to name the MECHANISM, because the likely
   * cause is how hls.js decides to switch rather than anything in this repo, and a reader should not
   * have to rediscover that from a table of rung heights.
   */
  it('says the player stayed on the dead rung, and why that happens', () => {
    const stuck = watched([...held(10, { rung: 720 }), ...held(10, { rung: 720 }), ...held(10, { rung: 720 })]);

    const report = renderRungOutageReport(rungRunOf(stuck));

    assert.match(report, /⛔ \*\*It stayed on 720p, the rung that had stopped producing\.\*\*/);
    assert.match(report, /a feed that stops advancing does not error/);
  });

  /** ⛔ The lie this fault can tell. Three rungs published throughout, so the broadcast had not ended. */
  it('calls out a viewer told the broadcast ended while three rungs were still publishing', () => {
    const toldItEnded = watched([
      ...held(10, { rung: 720 }),
      ...held(10, { rung: 720, feedState: 'ended', feedStateMessage: 'This broadcast has ended' }),
      ...held(10, { rung: 720 }),
    ]);

    const report = renderRungOutageReport(rungRunOf(toldItEnded));

    assert.match(report, /⛔ \*\*The viewer was told the broadcast had ended\.\*\*/);
    assert.match(renderRungOutageReport(rungRunOf(movedOff)), /✅ \*\*The viewer was never told/);
  });

  /** ⛔ Filed so a reader can check what was stopped against what the run claims to have stopped. */
  it('files the process it silenced, by pid and whole command line', () => {
    assert.match(renderRungOutageReport(rungRunOf(movedOff)), /\| 418 \| `ffmpeg .*demo_720p\?vhost=abr` \|/);
  });

  it('names the rungs that stayed healthy beside the viewer', () => {
    assert.match(
      renderRungOutageReport(rungRunOf(movedOff)),
      /3 healthy rungs sat beside it throughout: 1080p, 480p, 360p/,
    );
  });
});
