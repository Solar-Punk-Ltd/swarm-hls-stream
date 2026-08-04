/**
 * `pnpm bench:longrun` — publish for half an hour instead of fifty seconds, and answer the question
 * every other artifact in `docs/bench/` leaves open: whether a setting holds still.
 *
 * The profile grid measures the opening of a broadcast. Its runs are reproducible across independent
 * starts, which is not the same property as constant over time, and an operator choosing a setting
 * cares about the second one. This publishes once, keeps sampling, and reports what the latency did
 * to itself while it watched.
 *
 * Same publisher, same gateway polling and same per-hop split as `bench:latency`, deliberately. A
 * long run that measured differently could not be compared against the grid, and the comparison is
 * most of the point.
 *
 * Usage, on the deployment host:
 *   deploy/scripts/bench-on-host.sh --script bench:longrun -- BENCH_RUN_MINUTES=30 BENCH_GOP_SECONDS=0.5
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseFeedReaderMode, requireGatewayReachable } from '../src/bench/gateway.js';
import {
  bufferDemandTrend,
  type FeedProgress,
  feedProgress,
  latencyByMinute,
  type LatencyDrift,
  latencyDrift,
  type MediaPacing,
  mediaPacing,
  percentile,
} from '../src/bench/longRun.js';
import type { BenchRun } from '../src/bench/report.js';
import { measureLatency } from '../src/bench/run.js';
import { checkInstrumentLocally } from '../src/bench/selfCheck.js';
import { type BufferSample, median, recommendBufferMs } from '../src/bench/sweepAnalysis.js';
import { DEFAULT_KNOBS, type PublishKnobs } from '../src/bench/wallclockPublisher.js';
import { containerName, loadConfig, ROOT_DIR } from '../src/config.js';
import { makeHost, uploaderHealth } from '../src/harness/host.js';
import { effectiveLogLevel, logLevelProblem } from '../src/logLevel.js';

const DEFAULT_RUN_MINUTES = 30;
/** Matches `bench:latency`, so a long run's totals are comparable against every grid row. */
const POLL_INTERVAL_MS = 2_000;
/**
 * High enough that the duration is always what ends a run.
 *
 * At the shortest fragment measured and the poll cadence above, half an hour yields under a thousand
 * samples. A count is still required because it is the loop's other bound, and one that can never
 * bind is the honest way to say the duration governs.
 */
const SAMPLE_CEILING = 100_000;

const REPORT_DIR = join(ROOT_DIR, 'docs', 'bench');

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

function knobsFromEnv(): PublishKnobs {
  return {
    fps: envNumber('BENCH_FPS', DEFAULT_KNOBS.fps),
    gopSeconds: envNumber('BENCH_GOP_SECONDS', DEFAULT_KNOBS.gopSeconds),
    videoBitrateKbps: envNumber('BENCH_BITRATE_KBPS', DEFAULT_KNOBS.videoBitrateKbps),
    size: process.env.BENCH_SIZE ?? DEFAULT_KNOBS.size,
  };
}

function seconds(ms: number): string {
  return `${(ms / 1_000).toFixed(2)}s`;
}

function ratio(value: number): string {
  return value.toFixed(4);
}

/**
 * What the pacing readings license the rest of the report to claim.
 *
 * Computed from the run's own numbers rather than stated as a caveat, because the size of the
 * correction is the whole question: a publisher a tenth of a percent slow contributes 60ms per minute
 * and changes nothing, and one two percent slow contributes 1.2s per minute and would be the entire
 * headline.
 */
function pacingLines(pacing: MediaPacing, drift: LatencyDrift): string[] {
  const publisherMsPerMinute = (1 - pacing.timelinePerWallSecond) * 60_000;
  const share = drift.msPerMinute === 0 ? 0 : publisherMsPerMinute / drift.msPerMinute;

  return [
    `- media the segments carried, per second of wall clock: **${ratio(pacing.deliveredPerWallSecond)}**`,
    `- distance the media timeline travelled, per second of wall clock: **${ratio(pacing.timelinePerWallSecond)}**`,
    `- media the timeline crossed that no segment carried: **${seconds(pacing.holeMs)}** across the run` +
      (pacing.holeMs > 0
        ? '. A viewer sees that much of the broadcast simply missing, in jumps, and no latency column shows it.'
        : ', so the segments tile the timeline and a viewer misses nothing.'),
    '',
    `**The publisher's own pacing accounts for ${Math.round(publisherMsPerMinute)}ms per minute of drift**, ` +
      `against the ${Math.round(drift.msPerMinute)}ms per minute measured below` +
      (Math.abs(publisherMsPerMinute) < 1
        ? '. It is real-time to within a millisecond per minute, so the drift below is the pipeline.'
        : `, which is ${Math.round(share * 100)}% of it. The publisher is paced by ffmpeg's \`realtime\` filter ` +
          'at the nominal frame rate, and a real broadcaster sending from a camera has no equivalent, so ' +
          'subtract this before reading the drift as the deployment.'),
  ];
}

/**
 * The drift, with the statement of whether it is readable computed from the fit rather than asserted.
 *
 * The short bench prints its trend unconditionally and says not to read it, because five samples over
 * ten seconds cannot resolve one. Here the run is long enough that the question has an answer, and
 * the answer is whether the change the line predicts across the run clears the spread of the samples
 * around it.
 */
function driftLines(drift: LatencyDrift, runMinutes: number): string[] {
  const resolvable = Math.abs(drift.fittedChangeMs) > 2 * drift.residualMs;
  return [
    `- fitted slope: **${drift.msPerMinute >= 0 ? '+' : ''}${Math.round(drift.msPerMinute)}ms per minute**, ` +
      `which across ${runMinutes.toFixed(1)} minutes predicts ${drift.fittedChangeMs >= 0 ? '+' : ''}` +
      `${seconds(drift.fittedChangeMs)}. Positive means later segments measured **more** latency.`,
    `- samples sit **${seconds(drift.residualMs)}** from that line, root mean square.`,
    resolvable
      ? `- **the slope is resolvable**: the ${seconds(Math.abs(drift.fittedChangeMs))} it predicts is more than ` +
        `twice the ${seconds(drift.residualMs)} the samples scatter by, so this run really did move.`
      : `- **the slope is not resolvable**: the ${seconds(Math.abs(drift.fittedChangeMs))} it predicts does not ` +
        `clear twice the ${seconds(drift.residualMs)} the samples scatter by, so this run is flat within its ` +
        'own noise and the slope is a fit through scatter.',
  ];
}

/**
 * The longest the feed stood still, and whose seconds those were.
 *
 * The 2026-08-03 smoke run went 48 seconds without a new segment and the artifact could not say
 * whether the feed had stopped or the bench had. It took the uploader's log, which held 154 manifest
 * writes inside that window, to establish the pipeline never paused. A report that needs a second
 * instrument to interpret its own gaps will eventually publish one of them as the product, so the
 * attribution is printed rather than left to a reader.
 *
 * The whole discriminator is how many polls saw the same answer. Several means the bench kept asking
 * and the feed kept standing still, which is what a viewer polling at that cadence would have seen.
 * One means the bench was not asking, and what the feed did in that window is simply not known.
 */
function stallLines(feed: FeedProgress, bufferMs: number, segmentMs: number, runStartedAtMs: number): string[] {
  const observed = feed.stallPolls >= 2;
  const atMinute = ((feed.stallStartedAtMs - runStartedAtMs) / 60_000).toFixed(1);

  return [
    `- the feed named the same newest segment for **${seconds(feed.stallMs)}**, across ${feed.stallPolls} ` +
      `poll(s), starting ${atMinute} minutes in.`,
    `- the bench itself went at most ${seconds(feed.longestPollGapMs)} between two polls, against a ` +
      `${seconds(POLL_INTERVAL_MS)} cadence. Nothing shorter than that is observable here.`,
    observed
      ? `- **that stall is the feed's**: the bench asked ${feed.stallPolls} times inside it and got the same ` +
        'answer every time, so a viewer polling at this cadence saw the stream stop for that long.'
      : `- **that gap is this instrument's, not the feed's.** Only one poll fell inside it, so the feed may ` +
        'have advanced any number of times unobserved. Read it as the resolution of the measurement rather ' +
        'than as a stall.',
    observed
      ? `- a player holding ${seconds(bufferMs)} ` +
        (feed.stallMs > bufferMs + segmentMs
          ? '**would have rebuffered there**, since the stall exceeded the buffer plus the segment it was playing.'
          : 'would have played through it.')
      : '- whether a player would have rebuffered cannot be said from this run, for the reason above.',
    ...(feed.stallSkippedUpdates === null
      ? ['- the gateway sent no `Swarm-Feed-Index`, so how far behind the reader was is not knowable here.']
      : [
          `- when it moved, the gateway's resolved feed index jumped **${feed.stallSkippedUpdates} updates**. ` +
            'A reader keeping up moves one at a time, so that many were already written and waiting: the ' +
            'writer did not pause, the reader was behind it.',
        ]),
  ];
}

export function renderLongRun(run: BenchRun, runMinutes: number): string {
  const samples = [...run.samples].sort((a, b) => a.split.instants.fetchedAtMs - b.split.instants.fetchedAtMs);
  if (samples.length < 3) {
    return [
      `# Long run: ${run.measuredAt}`,
      '',
      `**${samples.length} sample(s) in ${runMinutes.toFixed(1)} minutes, which is not a long run.**`,
      '',
      'Publishing for half an hour and measuring three segments is a failed run, not a stable one. The',
      'reason is above this report in the run log, and in the discarded list in the JSON beside it.',
    ].join('\n');
  }

  const timed = samples.map((sample) => ({
    fetchedAtMs: sample.split.instants.fetchedAtMs,
    totalMs: sample.split.totalMs,
  }));
  const buffered = samples.map((sample) => ({
    fetchedAtMs: sample.split.instants.fetchedAtMs,
    totalMs: sample.split.totalMs,
    segmentMs: sample.split.instants.segmentDurationS * 1_000,
  }));
  const bufferSamples: BufferSample[] = buffered.map(({ totalMs, segmentMs }) => ({ totalMs, segmentMs }));

  const pacing = mediaPacing(
    samples.map((sample) => ({
      index: sample.index,
      capturedAtMs: sample.split.instants.capturedAtMs,
      fetchedAtMs: sample.split.instants.fetchedAtMs,
      segmentMs: sample.split.instants.segmentDurationS * 1_000,
    })),
  );
  const drift = latencyDrift(timed);
  const demand = bufferDemandTrend(buffered);
  const feed = feedProgress(run.feedPolls);
  const segmentMs = median(bufferSamples.map((sample) => sample.segmentMs));
  const buffer = recommendBufferMs(bufferSamples, POLL_INTERVAL_MS, segmentMs);
  const totals = timed.map((sample) => sample.totalMs);
  const edgeToFetchableMs = median(totals) - segmentMs;

  const lines: string[] = [
    `# Long run: ${run.measuredAt}`,
    '',
    `engine \`${run.engine}\`, profile \`${run.profile}\`, publishing ${run.knobs.size} @ ${run.knobs.fps}fps, ` +
      `${run.knobs.videoBitrateKbps}kbps, ${run.knobs.gopSeconds}s GOP`,
    '',
    `**${samples.length} segments measured across ${runMinutes.toFixed(1)} minutes of one continuous broadcast.** ` +
      'Every other report in this directory covers the opening seconds of a fresh one.',
    '',
    '## Is the instrument honest',
    '',
    ...pacingLines(pacing, drift),
    '',
    '## Did the latency hold still',
    '',
    ...driftLines(drift, runMinutes),
    '',
    '## What a viewer experienced',
    '',
    '| | |',
    '| --- | --- |',
    `| capture to fetchable, median | **${seconds(median(totals))}** |`,
    `| capture to fetchable, p95 | ${seconds(percentile(totals, 0.95))} |`,
    `| capture to fetchable, worst | ${seconds(Math.max(...totals))} |`,
    `| segment, median | ${seconds(segmentMs)} |`,
    `| smallest buffer that would not have stalled | ${seconds(buffer.observedFloorMs)} |`,
    `| recommended buffer (floor + ${POLL_INTERVAL_MS / 1_000}s poll + one segment) | ${seconds(
      buffer.recommendedMs,
    )} |`,
    `| **behind live at that buffer** | **${seconds(edgeToFetchableMs + buffer.recommendedMs)}** |`,
    '',
    '## Does the buffer demand grow',
    '',
    `- first third of the run needed **${seconds(demand.firstThirdMs)}**, last third needed ` +
      `**${seconds(demand.lastThirdMs)}**, a change of ${demand.growthMs >= 0 ? '+' : ''}` +
      `${seconds(demand.growthMs)}.`,
    demand.growthMs > 0
      ? `- **a player configured from this run's opening third would eventually stall**, by ` +
        `${seconds(demand.growthMs)}. That is what every buffer recommendation in \`profiles.md\` was ` +
        'derived from, since each of those runs is roughly one third of this one long.'
      : '- the demand did not grow, so a buffer derived from this run’s opening third would still have held ' +
        'at the end of it.',
    '',
    '## The longest a viewer waited',
    '',
    ...stallLines(feed, buffer.recommendedMs, segmentMs, timed[0].fetchedAtMs),
    '',
    '## Minute by minute',
    '',
    '| minute | samples | median | p95 | worst |',
    '| ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const bucket of latencyByMinute(timed)) {
    if (bucket.samples === 0) {
      lines.push(`| ${bucket.fromMinute} | **0** | | | **nothing arrived** |`);
      continue;
    }
    lines.push(
      `| ${bucket.fromMinute} | ${bucket.samples} | ${seconds(bucket.medianMs!)} | ` +
        `${seconds(bucket.p95Ms!)} | ${seconds(bucket.maxMs!)} |`,
    );
  }

  if (run.discarded.length > 0) {
    lines.push(
      '',
      `## ${run.discarded.length} segment(s) reached the bench and could not be read`,
      '',
      ...run.discarded.slice(0, 20).map((drop) => `- \`${drop.ref.slice(0, 12)}\`: ${drop.reason}`),
      ...(run.discarded.length > 20
        ? [`- ...and ${run.discarded.length - 20} more, in the JSON beside this file.`]
        : []),
    );
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const knobs = knobsFromEnv();
  const runMinutes = envNumber('BENCH_RUN_MINUTES', DEFAULT_RUN_MINUTES);
  const gatewayUrl = process.env.BENCH_GATEWAY_URL ?? `http://${cfg.publicHost}:${cfg.ports.beeGatewayApi}`;

  console.log(`longrun: engine ${cfg.engine}, profile ${cfg.profile}, gateway ${gatewayUrl}`);
  console.log(
    `longrun: publishing ${knobs.size} @ ${knobs.fps}fps, ${knobs.videoBitrateKbps}kbps, ${knobs.gopSeconds}s GOP ` +
      `for ${runMinutes} minutes`,
  );

  console.log('longrun: checking the instrument locally, which spends nothing...');
  const check = await checkInstrumentLocally(knobs);
  console.log(
    `longrun: instrument ok. The publisher's timestamps run ${Math.round(check.mediaTimelineLeadMs)}ms ahead of ` +
      `wall clock (spread ${Math.round(check.leadSpreadMs)}ms).`,
  );

  await requireGatewayReachable(gatewayUrl);

  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const level = effectiveLogLevel((await host.containerEnv(uploader)).LOG_LEVEL);
  const problem = logLevelProblem(level);
  if (problem) {
    throw new Error(problem);
  }
  const health = await uploaderHealth(host, cfg);
  console.log(`longrun: uploader ${health.status}, ${health.activeStreams} active stream(s), LOG_LEVEL=${level}`);

  const startedAtMs = Date.now();
  const run = await measureLatency({
    cfg,
    host,
    gatewayUrl,
    knobs,
    samples: SAMPLE_CEILING,
    collectForMs: runMinutes * 60_000,
    pollIntervalMs: POLL_INTERVAL_MS,
    feedReader: parseFeedReaderMode(process.env.BENCH_FEED_READER),
    mediaTimelineLeadMs: check.mediaTimelineLeadMs,
  });
  const report = renderLongRun(run, (Date.now() - startedAtMs) / 60_000);

  await mkdir(REPORT_DIR, { recursive: true });
  const stem = join(REPORT_DIR, `longrun-${run.measuredAt.replace(/[:.]/g, '-')}`);
  await writeFile(`${stem}.md`, `${report}\n`);
  await writeFile(`${stem}.json`, `${JSON.stringify(run, null, 2)}\n`);

  console.log(`\n${report}\n`);
  console.log(`longrun: written to ${stem}.md and ${stem}.json`);
}

main().catch((error: unknown) => {
  console.error(`\nlongrun failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
