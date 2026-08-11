/**
 * The markdown a browser validation run leaves behind.
 *
 * The instrument verdict is printed **first and unconditionally**, above any number about the
 * deployment. That ordering is the point: the previous attempt at this measurement produced a
 * confident-looking figure of 578 seconds behind live that was entirely the harness, and a reader
 * who has to scroll to find out whether the browser was degraded will quote the figure.
 */

import { LIVE_SYNC_DURATION_S } from '../bench/clientTuning.js';

import { type GatewayHealth, gatewaySection } from './gatewayHealth.js';
import { describeProof, type InstrumentProof, type InstrumentVerdict } from './instrument.js';
import type { NetworkSummary } from './network.js';
import { costSection, type ResourceCost } from './resources.js';
import type { LatencyTargetVerdict, SessionSummary, ViewerSample } from './session.js';
import { judgeStability, stabilitySection } from './stability.js';

export interface BrowserRun {
  measuredAt: string;
  watchUrl: string;
  chromeVersion: string;
  gopSeconds: number;
  summary: SessionSummary;
  instrument: InstrumentVerdict & { soundSamples: number };
  /**
   * Evidence that the soundness verdict above was capable of coming out the other way.
   *
   * Optional because every run recorded before 2026-08-12 has none, and a report that cannot be
   * rendered for the archive is a report that cannot be re-derived. A run without one is reported as
   * having an untested verdict rather than a sound one.
   */
  instrumentProof?: InstrumentProof;
  network?: NetworkSummary;
  samples: readonly ViewerSample[];
  screenshots: readonly string[];
  /** What the run took out of the postage batch and the chequebook, when it was measured. */
  cost?: ResourceCost;
  /**
   * What the gateway node itself was doing, when a run sampled it.
   *
   * Optional because every run recorded before 2026-08-07 has none, and a report that cannot be
   * rendered for the archive is a report that cannot be re-derived.
   */
  gateway?: GatewayHealth;
}

/**
 * The most sample rows a report prints.
 *
 * An hour at one sample a second is 3600 rows, which is a table nobody reads inside a document
 * nobody opens. Longer runs are printed every Nth row and say so, and the untouched series stays in
 * the `.json` beside it, so nothing is lost and the markdown stays a thing a person can scan.
 */
const MAX_TABLE_ROWS = 240;

/** `3` becomes `3rd`, because a heading reading "Every 3th sample" undermines the document it titles. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Every Nth sample, so a long run's table covers the whole run rather than the first four minutes. */
function forTable<T>(samples: readonly T[]): { rows: readonly T[]; everyNth: number } {
  const everyNth = Math.max(1, Math.ceil(samples.length / MAX_TABLE_ROWS));
  return { rows: samples.filter((_, i) => i % everyNth === 0), everyNth };
}

export const seconds = (ms: number): string => (ms / 1000).toFixed(1);
export const orDash = (value: number | null, digits = 2): string => (value === null ? '—' : value.toFixed(digits));

export function instrumentSection(run: BrowserRun): string[] {
  if (run.instrument.sound) {
    // A sound verdict is only worth printing as one if the check that produced it could have said
    // otherwise. Where it could not, the caveat goes in the heading rather than in a footnote,
    // because a reader who has to scroll to find it will quote the verdict.
    const unproven = describeProof(run.instrumentProof);
    return [
      unproven.length > 0
        ? '## ⚠️ Every sample passed, but the check could not have failed'
        : '## The instrument was sound',
      '',
      `All ${run.summary.samples} samples came from a page reporting \`visibilityState: visible\`, with a ` +
        '100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is ' +
        'the harness degrading its own subject, which is the failure that blocked this measurement ' +
        'until now.',
      '',
      ...unproven.flatMap((caveat) => [`⛔ ${caveat}`, '']),
    ];
  }

  return [
    '## ⛔ VOID — the browser was not a valid instrument',
    '',
    `Only ${run.instrument.soundSamples} of ${run.summary.samples} samples came from a browser that was ` +
      'not degrading what it was measuring. **No number below is a reading about the deployment.**',
    '',
    ...run.instrument.failures.map((failure) => `- ${failure}`),
    '',
  ];
}

export function latencySection(run: BrowserRun): string[] {
  const { latency } = run.summary;
  const lines = [
    '## Where the player sat',
    '',
    `The client is configured to hold playback \`LIVE_SYNC_DURATION_S = ${LIVE_SYNC_DURATION_S}\` seconds ` +
      'behind the live edge. That value was derived from arrival times the bench measured, and until this ' +
      'run nothing had checked that a player reaches it.',
    '',
    '| | seconds behind live |',
    '| --- | ---: |',
    `| on joining | ${orDash(latency.joinLatencyS)} |`,
    `| median | ${orDash(latency.medianLatencyS)} |`,
    `| best | ${orDash(latency.minLatencyS)} |`,
    `| worst | ${orDash(latency.maxLatencyS)} |`,
    '',
  ];

  if (latency.reachedTargetAtJoin) {
    lines.push(
      `✅ **The window names enough media.** A joining viewer started ${orDash(latency.joinLatencyS)}s behind ` +
        `the edge against a ${LIVE_SYNC_DURATION_S}s target, so the live manifest holds the runway the ` +
        'constant asks for. This is the half of the question the uploader controls.',
      '',
    );
  } else {
    lines.push(
      `⛔ **Clamped short at the join.** The viewer started only ${orDash(latency.joinLatencyS)}s behind the ` +
        `edge against a ${LIVE_SYNC_DURATION_S}s target. hls.js pins its sync position to the start of the ` +
        'playlist, so a first manifest naming less media than the target hands the viewer less runway, ' +
        'and nothing raises an error.',
      '',
    );
  }

  if (latency.reachedTargetAtJoin && !latency.heldTarget) {
    lines.push(
      `⛔ **And it did not keep it.** The median over the session was ${orDash(latency.medianLatencyS)}s, ` +
        `down from ${orDash(latency.joinLatencyS)}s at the join, with the best sample at ` +
        `${orDash(latency.minLatencyS)}s. The player started where it was told to and then drifted toward ` +
        'the edge, which it can only do by playing faster than media reached it. That is a delivery ' +
        'question, not a manifest one.',
      '',
    );
  }

  if (latency.joinedPastSeekThreshold) {
    lines.push(
      `⚠️ **The join was a jump.** A viewer arrived ${orDash(latency.joinLatencyS)}s behind, past ` +
        '`LIVE_MAX_LATENCY_DURATION_S`, so hls.js seeked to the edge rather than let them catch up. That ' +
        'recovers, and it is what the threshold is for, but the first thing this viewer saw was stale ' +
        'and then skipped. The cause is upstream of the player: the live window is budgeted in bytes, so ' +
        'a longer segment names proportionally more media and puts the start of the playlist further back.',
      '',
    );
  }

  if (latency.ranLong) {
    lines.push(
      '⛔ **Ran long.** After the join, latency passed `LIVE_MAX_LATENCY_DURATION_S`, past which hls.js is ' +
        'supposed to seek to the edge rather than drift. It did not recover on its own.',
      '',
    );
  }

  if (latency.reachedTargetAtJoin && latency.heldTarget && !latency.ranLong) {
    lines.push(`✅ **And it held it.** Median ${orDash(latency.medianLatencyS)}s across the session.`, '');
  }

  return [...lines, ...latencyTargetLines(run.summary.latencyTarget)];
}

/**
 * Whether every figure above was measured against the target the client asked for.
 *
 * Printed inside the latency section rather than beside it, because it is a precondition for reading
 * that section rather than another result. See {@link judgeLatencyTarget} for the mechanism and for
 * the run that paid for it.
 */
function latencyTargetLines(target: LatencyTargetVerdict): string[] {
  if (target.worstS === null) {
    return [
      `⚠️ **The player never reported a latency target.** Every figure above is being read against ` +
        `\`LIVE_SYNC_DURATION_S = ${target.configuredS}\` on the assumption that is what the player was ` +
        'steering to, and this run cannot confirm it. Do not compare these numbers with another run.',
      '',
    ];
  }

  const pastTarget =
    target.medianPastTargetS === null
      ? 'not measurable from this run'
      : `**${target.medianPastTargetS >= 0 ? '+' : ''}${target.medianPastTargetS.toFixed(2)}s** against the ` +
        "player's own target, taken per sample";

  if (target.held) {
    return [
      `✅ **Measured against the configured target throughout.** The player steered to ` +
        `${target.worstS.toFixed(2)}s for the whole run, with ${target.stalls} buffer ` +
        `${target.stalls === 1 ? 'stall' : 'stalls'}, so the figures above are comparable with any other ` +
        'run that says the same.',
      '',
      `Median ${pastTarget}. Negative is ordinary: the catch-up only pushes latency down and overshoots, ` +
        'so a healthy session sawtooths just below its target.',
      '',
    ];
  }

  return [
    `⛔ **The latency figures above are against a target that moved, and are not comparable with ` +
      `another run's.** The player steered to ${target.worstS.toFixed(2)}s at its worst, which is ` +
      `**${target.raisedByS.toFixed(2)}s past the configured ${target.configuredS}s**, after ` +
      `${target.stalls} buffer ${target.stalls === 1 ? 'stall' : 'stalls'}.`,
    '',
    'hls.js adds `min(stallCount * liveSyncOnStallIncrease, targetduration)` to the configured ' +
      '`liveSyncDuration`, and `stallCount` falls back to zero only when a fresh manifest loads. So the ' +
      'raise lasts the rest of the session, latency settles around the raised target, and the catch-up ' +
      'that would have pulled it back measures itself against the raised value and stops firing. ' +
      '**Nothing else in this report shows it**: a stall is not fatal, and it need not fire a `waiting` ' +
      'event, so the rebuffer, stalled-sample and fatal-error rows can all read zero.',
    '',
    target.medianPastTargetS === null
      ? '⛔ **And nothing here is comparable instead.** No sample carried both a latency and a target, ' +
        'so the distance that would have had the penalty subtracted out could not be taken either.'
      : `⭐ **What is still comparable is ${pastTarget}.** Raw latency is what this viewer got and is ` +
        'the right number for a viewer-facing claim, but it carries the stall penalty. This one has ' +
        'the penalty subtracted out, so it is the figure to put beside another run when the targets ' +
        'differed.',
    '',
  ];
}

export function playbackSection(run: BrowserRun): string[] {
  const s = run.summary;
  return [
    '## What playback did',
    '',
    '| | |',
    '| --- | ---: |',
    `| samples | ${s.samples} over ${seconds(s.spanMs)}s |`,
    `| **media seconds per wall second, whole session** | **${s.overallAdvanceRatio.toFixed(3)}** |`,
    `| media seconds per wall second, typical sample | ${s.medianAdvanceRatio.toFixed(3)} |`,
    `| samples where playback did not advance | ${s.stalledSamples} |`,
    `| forward seeks, and media they skipped | ${
      s.forwardSeeks === 0 ? 'none' : `${s.forwardSeeks}, skipping ${s.seekedPastS.toFixed(1)}s`
    } |`,
    `| rebuffers the player counted | ${s.rebufferCount}, totalling ${s.rebufferMs}ms |`,
    `| fatal errors | ${s.fatalErrors} |`,
    `| dropped frames | ${s.droppedFrames} |`,
    `| **frames per second of media** | ${
      s.deliveredFps === null ? 'too little media to say' : `**${s.deliveredFps.toFixed(1)}**`
    } |`,
    `| buffered ahead of the playhead, median | ${s.medianBufferAheadS.toFixed(2)}s |`,
    `| resolution decoded | ${s.resolution ?? '—'} |`,
    '',
    'The advance ratio is `currentTime` against the wall clock, which is the one measurement here that ' +
      'does not go through the overlay: a stalled player still reports a latency and still renders, and ' +
      'this is what says whether the picture was moving.',
    '',
    '**Read the whole-session ratio, not the typical sample.** Playback either runs at its rate or is ' +
      'stopped, so the typical sample reads 1.000 in any session that plays at all, including one that ' +
      'spends a sixth of its time frozen. The gap between the two rows is the rebuffering.',
    '',
    '**A seek is not playback, and the whole-session ratio no longer counts it as such.** When latency ' +
      'passes `LIVE_MAX_LATENCY_DURATION_S` hls.js jumps the playhead to the live edge, which is its ' +
      'designed recovery and the normal end of any freeze. Reading `currentTime` at the ends of a run ' +
      'could not tell that from playing throughout, so a freeze and the seek that ended it used to net ' +
      'to 1.000. Media above what the clock allows at the catch-up rate is now counted as skipped and ' +
      'reported on its own row. Replaying the recorded runs through both definitions moved every ' +
      'faulted run and left all 27 clean ones identical to three decimals.',
    '',
  ];
}

/**
 * Where the stalled time went: waiting between attempts, or inside a transfer.
 *
 * The two have opposite fixes and the same symptom, so they are printed against each other rather
 * than in separate places.
 */
export function networkSection(run: BrowserRun): string[] {
  const net = run.network;
  if (!net) {
    return [];
  }

  const waitedShare = run.summary.rebufferMs > 0 ? net.totalWaitedBetweenAttemptsMs / run.summary.rebufferMs : 0;
  return [
    '## Where the time went',
    '',
    '| | |',
    '| --- | ---: |',
    `| segment requests | ${net.segmentRequests} for ${net.distinctSegments} distinct segments |`,
    `| refused (404, not yet retrievable) | ${net.refusals} (${(net.refusalShare * 100).toFixed(1)}% of requests) |`,
    `| segments refused at least once | ${net.segmentsRefusedAtLeastOnce} |`,
    `| segments never served at all | ${net.segmentsNeverServed} |`,
    `| **time spent waiting between attempts** | **${net.totalWaitedBetweenAttemptsMs}ms** |`,
    `| median successful transfer | ${net.medianTransferMs.toFixed(0)}ms |`,
    `| segment bytes delivered | ${(net.segmentBytesPerSecond / 1000).toFixed(0)} kB/s |`,
    `| most segment fetches in flight at once | ${net.maxConcurrent} |`,
    '',
    `The waiting figure accounts for **${(waitedShare * 100).toFixed(0)}%** of the ${run.summary.rebufferMs}ms ` +
      'this session spent rebuffering. It is measured between one attempt ending and the next starting, so ' +
      'it contains no transfer time and cannot be inflated by a slow gateway: it is time the player chose ' +
      'to spend doing nothing, which on a refused fragment is `fragLoadPolicy.errorRetry.retryDelayMs`.',
    '',
  ];
}

export function renderBrowserReport(run: BrowserRun): string {
  const { rows, everyNth } = forTable(run.samples);
  const sampleRows = rows.map((sample, i) =>
    [
      `| ${i * everyNth + 1}`,
      seconds(sample.atMs - run.samples[0].atMs),
      sample.currentTime.toFixed(2),
      orDash(sample.liveLatencyS),
      sample.bufferAheadS.toFixed(2),
      sample.playbackRate.toFixed(2),
      String(sample.readyState),
      `${sample.rebufferCount} |`,
    ].join(' | '),
  );

  return [
    `# A viewer, watched in a real browser`,
    '',
    `**${run.measuredAt}.** ${run.chromeVersion}, headed against an X display on the deployment host, ` +
      `watching a ${run.gopSeconds}s-GOP broadcast through the shipped client.`,
    '',
    `\`${run.watchUrl}\``,
    '',
    ...instrumentSection(run),
    ...latencySection(run),
    ...playbackSection(run),
    ...stabilitySection(judgeStability(run.samples)),
    ...networkSection(run),
    ...(run.gateway ? gatewaySection(run.gateway) : []),
    ...(run.cost ? costSection(run.cost) : []),
    everyNth === 1 ? '## Every sample' : `## Every ${ordinal(everyNth)} sample`,
    '',
    ...(everyNth === 1
      ? []
      : [
          `${run.samples.length} samples is more than a table is worth reading, so this prints every ` +
            `${ordinal(everyNth)}. The whole series is in the \`.json\` beside this file.`,
          '',
        ]),
    '| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | rate | readyState | rebuffers |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...sampleRows,
    '',
    ...(run.screenshots.length > 0
      ? [
          '## Screenshots',
          '',
          'The publisher burns the host clock into the picture as epoch seconds and the harness paints the ' +
            'viewer clock over it, so each of these carries both ends of the measurement in one frame.',
          '',
          ...run.screenshots.map((path) => `- \`${path}\``),
          '',
        ]
      : []),
  ].join('\n');
}
