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

import {
  fetchSegment,
  parseFeedReaderMode,
  requireGatewayReachable,
  type UnservedRetry,
} from '../src/bench/gateway.js';
import {
  bufferDemandTrend,
  type FeedProgress,
  feedProgress,
  latencyByMinute,
  type LatencyDrift,
  latencyDrift,
  medianPollGapMs,
  type MediaPacing,
  mediaPacing,
  percentile,
} from '../src/bench/longRun.js';
import type { BenchRun, SegmentSample } from '../src/bench/report.js';
import { measureLatency } from '../src/bench/run.js';
import { checkInstrumentLocally } from '../src/bench/selfCheck.js';
import { type BufferSample, median, recommendBufferMs } from '../src/bench/sweepAnalysis.js';
import { UnservedSegmentWatch } from '../src/bench/unservedWatch.js';
import { DEFAULT_KNOBS, type PublishKnobs } from '../src/bench/wallclockPublisher.js';
import { containerName, loadConfig, ROOT_DIR } from '../src/config.js';
import { makeHost, uploaderHealth } from '../src/harness/host.js';
import { effectiveLogLevel, logLevelProblem } from '../src/logLevel.js';

const DEFAULT_RUN_MINUTES = 30;

/**
 * How long to wait before asking again **when a poll found nothing new**.
 *
 * Not a cadence, and the distinction is what this replaces. The collection loop does not sleep at all
 * when a poll finds a new segment, so under steady arrival the bench polls as fast as it can read and
 * fetch. This value only bounds how late the bench can be in *noticing* a manifest that has already
 * arrived.
 *
 * It used to be a flat 2 seconds, and that made `feedPropagation` report the bench's own sleep rather
 * than the network. Measured 2026-08-05 across the segment-length grid: that hop equalled the wait for
 * the next poll to within a median of 2 to 5ms in nine of eleven runs, so the column said nothing
 * about how long a manifest actually took to reach a reader.
 *
 * A tenth of a segment keeps the discovery error under 10% of the quantity being measured. It is
 * affordable because **a feed poll is one chunk while a segment at 2500kbps and 2s is about 150**, so
 * ten polls per segment add roughly 7% to chunk retrieval rather than multiplying it.
 */
const IDLE_POLL_FRACTION_OF_SEGMENT = 0.1;
const MIN_IDLE_POLL_MS = 50;
const MAX_IDLE_POLL_MS = 250;

function idlePollIntervalMs(gopSeconds: number): number {
  const tenthOfASegment = Math.round(gopSeconds * 1_000 * IDLE_POLL_FRACTION_OF_SEGMENT);
  return Math.min(MAX_IDLE_POLL_MS, Math.max(MIN_IDLE_POLL_MS, tenthOfASegment));
}

/**
 * How often a real viewer's player is assumed to ask for a new manifest.
 *
 * A **model**, not a measurement, and separate from the bench's own idle backoff on purpose. The
 * buffer a player needs depends on its cadence rather than on how often this instrument happened to
 * look, and the two were one number until 2026-08-05, which is how the recommendation came to be
 * built on a constant that described neither.
 *
 * Kept at the value the recommendation has always used so this change moves no published figure.
 * ⚠️ It has never been checked against `ManifestManagement.ts`, and LAT-3 added backoff there, so
 * validating it is outstanding work rather than something this constant settles.
 */
const ASSUMED_CLIENT_POLL_INTERVAL_MS = 2_000;
/**
 * High enough that the duration is always what ends a run.
 *
 * A sample costs a distinct segment, so at the shortest fragment measured half an hour yields a few
 * thousand at most. A count is still required because it is the loop's other bound, and one that can
 * never bind is the honest way to say the duration governs.
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
function stallLines(
  feed: FeedProgress,
  bufferMs: number,
  segmentMs: number,
  runStartedAtMs: number,
  medianPollGapMs: number,
): string[] {
  // Polls that came back naming something. A poll that brought no answer spans the stall without
  // confirming it, and attributing a stall to the feed on the strength of silence is exactly what
  // this paragraph exists not to do.
  const confirming = feed.stallPolls - feed.stallPollsWithoutAnswer;
  const observed = confirming >= 2;
  const atMinute = ((feed.stallStartedAtMs - runStartedAtMs) / 60_000).toFixed(1);
  const unanswered =
    feed.stallPollsWithoutAnswer > 0 ? `, ${feed.stallPollsWithoutAnswer} of which brought no answer at all` : '';

  return [
    `- the feed named the same newest segment for **${seconds(feed.stallMs)}**, across ${feed.stallPolls} ` +
      `poll(s)${unanswered}, starting ${atMinute} minutes in.`,
    // The MEASURED gap, not the configured backoff. This line used to quote the constant and claim
    // nothing shorter was observable, which was false whenever the stream was healthy: the loop does
    // not sleep when a poll finds something, so it runs far faster than its own backoff.
    `- the bench itself went at most ${seconds(feed.longestPollGapMs)} between two polls and ` +
      `${seconds(medianPollGapMs)} typically. **Both are measured rather than configured**, and the ` +
      'pair is what bounds the resolution here: the gaps are bimodal, so neither alone describes it.',
    observed
      ? `- **that stall is the feed's**: ${confirming} polls inside it came back naming the same segment, so a ` +
        'viewer polling at this cadence saw the stream stop for that long.'
      : `- **that gap is this instrument's, not the feed's.** Fewer than two polls inside it came back with an ` +
        'answer, so the feed may have advanced any number of times unobserved. Read it as the resolution of ' +
        'the measurement rather than as a stall.',
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

/**
 * How long the gateway refused segments before serving them, on a run that waited rather than
 * discarded.
 *
 * Silent on a run that did not wait, since every reading would be zero by construction and a table of
 * zeroes reads as "this never happens" rather than "this was not asked".
 *
 * The share matters as much as the delay. A refused segment is the slowest sample there is, so a run
 * that discards them reports a median over everything except the samples that would have moved it.
 */
/**
 * How long refused segments stayed refused, timed off the collection loop.
 *
 * Reports what it could not watch alongside what it did, because a distribution over whatever
 * happened to fit within the concurrency bound, printed as though it covered every refusal, is
 * exactly the shape of reporting that this instrument has been wrong about twice already.
 */
function watchedRefusalLines(watch?: UnservedSegmentWatch): string[] {
  const seen = watch?.resolutions ?? [];
  if (seen.length === 0) {
    return [];
  }
  const settled = seen.filter((r) => r.resolvedAfterMs !== null).map((r) => r.resolvedAfterMs as number);
  const never = seen.length - settled.length;
  const lines = [
    '## How long a refused segment stayed refused',
    '',
    `- **${seen.length} refusals timed**, ${watch?.unwatched ?? 0} more arrived while every watcher slot ` +
      'was busy and were not timed at all.',
  ];
  if (settled.length > 0) {
    const ordered = [...settled].sort((a, b) => a - b);
    lines.push(
      `- of the ${settled.length} that were eventually served: median **${seconds(median(ordered))}**, ` +
        `p95 ${seconds(percentile(ordered, 0.95))}, worst ${seconds(Math.max(...ordered))}.`,
      `- **${ordered.filter((ms) => ms < 1_000).length} of ${ordered.length} came back inside one second**, ` +
        'which is where hls.js makes its first fragment retry and therefore where a viewer stops noticing.',
    );
  }
  if (never > 0) {
    lines.push(`- **${never} were still refused when the watcher gave up.**`);
  }
  return [...lines, ''];
}

function unservedLines(samples: readonly SegmentSample[]): string[] {
  const refused = samples.filter((sample) => sample.fetchAttempts > 1);
  const waited = refused.map((sample) => sample.unservedForMs);
  if (waited.length === 0) {
    return [];
  }
  return [
    '## How long segments stayed unretrievable',
    '',
    `- **${waited.length} of ${samples.length}** (${((100 * waited.length) / samples.length).toFixed(1)}%) took ` +
      'more than one ask, so the gateway refused them and then served them.',
    `- median wait **${seconds(median(waited))}**, p95 ${seconds(percentile(waited, 0.95))}, worst ` +
      `${seconds(Math.max(...waited))}.`,
    '- Segments are uploaded `deferred: true` while the manifest naming them is a synchronous SOC ' +
      'write, so the announcement can outrun the bytes. These waits are what that costs a viewer, ' +
      'and hls.js retries a fragment six times starting at one second, so a wait shorter than that ' +
      'is absorbed by the buffer rather than seen.',
    '',
  ];
}

export function renderLongRun(run: BenchRun, runMinutes: number, watch?: UnservedSegmentWatch): string {
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
  const buffer = recommendBufferMs(bufferSamples, ASSUMED_CLIENT_POLL_INTERVAL_MS, segmentMs);
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
    `| recommended buffer (floor + ${
      ASSUMED_CLIENT_POLL_INTERVAL_MS / 1_000
    }s assumed client poll + one segment) | ${seconds(buffer.recommendedMs)} |`,
    `| **behind live at that buffer** | **${seconds(edgeToFetchableMs + buffer.recommendedMs)}** |`,
    '',
    ...unservedLines(samples),
    ...watchedRefusalLines(watch),
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
    ...stallLines(feed, buffer.recommendedMs, segmentMs, timed[0].fetchedAtMs, medianPollGapMs(run.feedPolls)),
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

/**
 * How long to wait out a gateway that refuses a segment, from `BENCH_UNSERVED_BUDGET_MS`.
 *
 * Off unless asked for. Waiting happens inside the collection loop, and the loop's pace is what keeps
 * the reader at the live edge, so a run that waits is a diagnostic and **its latency figures are not
 * comparable** with a run that did not.
 *
 * Off is not the neutral choice either, which is the reason this is worth turning on at all. A
 * refused segment is discarded, refused segments are by definition the slowest ones, and a median
 * taken over what survives is flattered by exactly the samples that would have moved it.
 */
function unservedRetryFromEnv(): UnservedRetry | undefined {
  const budgetMs = envNumber('BENCH_UNSERVED_BUDGET_MS', 0);
  if (budgetMs <= 0) {
    return undefined;
  }
  return { budgetMs, recheckMs: envNumber('BENCH_UNSERVED_RECHECK_MS', 250) };
}

/**
 * Watchers to run at once, and how often each asks.
 *
 * Together these are the load this adds, `concurrency / recheckMs` requests a second, and four at one
 * second is at most four. The collection loop itself runs at about four requests a second at a 0.25s
 * GOP, so this doubles the gateway's read load in the worst case and never more. Four slots also
 * collect plenty: at ten minutes and even a minute per refusal that is forty measurements.
 */
const UNSERVED_WATCH_CONCURRENCY = 4;
const UNSERVED_WATCH_RECHECK_MS = 1_000;

/**
 * Times how long refused segments stay refused, from `BENCH_UNSERVED_WATCH_MS`.
 *
 * Separate from `BENCH_UNSERVED_BUDGET_MS`, which waits inside the loop, because the two answer
 * different halves and only one of them can reach past two seconds. A 10-minute run with a 2s in-loop
 * budget found 19 of 84 segments still refused when it expired, so the answer is above the only
 * window that measurement could see.
 */
function unservedWatchFromEnv(gatewayUrl: string): UnservedSegmentWatch | undefined {
  const budgetMs = envNumber('BENCH_UNSERVED_WATCH_MS', 0);
  if (budgetMs <= 0) {
    return undefined;
  }
  return new UnservedSegmentWatch(
    async (ref) => {
      await fetchSegment(gatewayUrl, ref);
    },
    { budgetMs, recheckMs: UNSERVED_WATCH_RECHECK_MS, concurrency: UNSERVED_WATCH_CONCURRENCY },
  );
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

  const watch = unservedWatchFromEnv(gatewayUrl);
  if (watch) {
    console.log(
      `longrun: timing refused segments off the loop, ${UNSERVED_WATCH_CONCURRENCY} at a time and one ` +
        `ask each per ${UNSERVED_WATCH_RECHECK_MS}ms, so at most ` +
        `${(1_000 * UNSERVED_WATCH_CONCURRENCY) / UNSERVED_WATCH_RECHECK_MS} extra requests a second`,
    );
  }

  const startedAtMs = Date.now();
  const run = await measureLatency({
    cfg,
    host,
    gatewayUrl,
    knobs,
    samples: SAMPLE_CEILING,
    collectForMs: runMinutes * 60_000,
    idlePollIntervalMs: idlePollIntervalMs(knobs.gopSeconds),
    feedReader: parseFeedReaderMode(process.env.BENCH_FEED_READER),
    mediaTimelineLeadMs: check.mediaTimelineLeadMs,
    unservedRetry: unservedRetryFromEnv(),
    unservedWatch: watch,
  });
  const report = renderLongRun(run, (Date.now() - startedAtMs) / 60_000, watch);

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
