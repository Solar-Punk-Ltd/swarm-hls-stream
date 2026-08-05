/**
 * The markdown a browser validation run leaves behind.
 *
 * The instrument verdict is printed **first and unconditionally**, above any number about the
 * deployment. That ordering is the point: the previous attempt at this measurement produced a
 * confident-looking figure of 578 seconds behind live that was entirely the harness, and a reader
 * who has to scroll to find out whether the browser was degraded will quote the figure.
 */

import { LIVE_SYNC_DURATION_S } from '../bench/clientTuning.js';

import type { InstrumentVerdict } from './instrument.js';
import type { SessionSummary, ViewerSample } from './session.js';

export interface BrowserRun {
  measuredAt: string;
  watchUrl: string;
  chromeVersion: string;
  gopSeconds: number;
  summary: SessionSummary;
  instrument: InstrumentVerdict & { soundSamples: number };
  samples: readonly ViewerSample[];
  screenshots: readonly string[];
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const orDash = (value: number | null, digits = 2): string => (value === null ? '—' : value.toFixed(digits));

function instrumentSection(run: BrowserRun): string[] {
  if (run.instrument.sound) {
    return [
      '## The instrument was sound',
      '',
      `All ${run.summary.samples} samples came from a page reporting \`visibilityState: visible\`, with a ` +
        '100ms timer keeping its schedule and a build that can decode H.264 and AAC. Nothing below is ' +
        'the harness degrading its own subject, which is the failure that blocked this measurement ' +
        'until now.',
      '',
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

function latencySection(run: BrowserRun): string[] {
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

  if (latency.clampedShort) {
    lines.push(
      `⛔ **Clamped short.** The median sat below the ${LIVE_SYNC_DURATION_S}s target by more than the ` +
        'tolerance, which is what happens when the uploader names less media than the player asks for: ' +
        'hls.js pins its sync position to the start of the playlist, so the viewer gets whatever the ' +
        'window holds and no error is raised anywhere.',
      '',
    );
  }
  if (latency.ranLong) {
    lines.push(
      '⛔ **Ran long.** Latency passed `LIVE_MAX_LATENCY_DURATION_S`, past which hls.js is supposed to seek ' +
        'to the edge rather than drift. It did not recover on its own.',
      '',
    );
  }
  if (!latency.clampedShort && !latency.ranLong && latency.medianLatencyS !== null) {
    lines.push(
      `✅ **The configured buffer is reachable and was held.** The player settled at ` +
        `${orDash(latency.medianLatencyS)}s against a ${LIVE_SYNC_DURATION_S}s target, so the live window ` +
        'names enough media for a joining viewer to get the runway the constant promises.',
      '',
    );
  }

  return lines;
}

function playbackSection(run: BrowserRun): string[] {
  const s = run.summary;
  return [
    '## What playback did',
    '',
    '| | |',
    '| --- | ---: |',
    `| samples | ${s.samples} over ${seconds(s.spanMs)}s |`,
    `| media seconds per wall second | ${s.medianAdvanceRatio.toFixed(3)} |`,
    `| samples where playback did not advance | ${s.stalledSamples} |`,
    `| rebuffers the player counted | ${s.rebufferCount}, totalling ${s.rebufferMs}ms |`,
    `| fatal errors | ${s.fatalErrors} |`,
    `| dropped frames | ${s.droppedFrames} |`,
    `| buffered ahead of the playhead, median | ${s.medianBufferAheadS.toFixed(2)}s |`,
    `| resolution decoded | ${s.resolution ?? '—'} |`,
    '',
    'The advance ratio is `currentTime` against the wall clock, which is the one measurement here that ' +
      'does not go through the overlay: a stalled player still reports a latency and still renders, and ' +
      'this is what says whether the picture was moving.',
    '',
  ];
}

export function renderBrowserReport(run: BrowserRun): string {
  const sampleRows = run.samples.map((sample, i) =>
    [
      `| ${i + 1}`,
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
    '## Every sample',
    '',
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
