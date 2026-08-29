/**
 * The markdown a squeezed viewer leaves behind.
 *
 * Shares its sections with `report.ts` for the same reason `recoveryReport.ts` does: a throttled
 * reading is only worth having if it sits beside a clean one and means the same thing.
 *
 * What it adds is the rung timeline, which is the whole point of the run and appears nowhere else.
 */

import { type LadderRung } from '../config.js';

import { type QualitySwitchVerdict, type ThrottleWindow } from './qualitySwitch.js';
import {
  type BrowserRun,
  describeGop,
  instrumentSection,
  networkSection,
  orDash,
  playbackSection,
  seconds,
} from './report.js';

export interface QualityRun extends BrowserRun {
  ladder: readonly LadderRung[];
  throttle: ThrottleWindow;
  quality: QualitySwitchVerdict;
}

const rung = (height: number | null): string => (height === null ? '—' : `${height}p`);

function ladderSection(run: QualityRun): string[] {
  return [
    '## The ladder this viewer was offered',
    '',
    '| rung | cut at | affordable at the cap |',
    '| --- | ---: | :---: |',
    ...run.ladder.map(
      (level) => `| ${level.name} | ${level.kbps} kbps | ${level.kbps <= run.quality.throttledToKbps ? 'yes' : 'no'} |`,
    ),
    '',
    `The tab's download was capped at **${run.quality.throttledToKbps} kbps** for ${seconds(
      run.throttle.liftedAtMs - run.throttle.appliedAtMs,
    )}s, which is the second lowest rung's own bitrate. Everything above it asks for more than the ` +
      'link can carry.',
    '',
  ];
}

function rungSection(run: QualityRun): string[] {
  const q = run.quality;

  return [
    '## What the player chose',
    '',
    '| | rung it ended on | lowest | tallest | media seconds per wall second |',
    '| --- | :---: | :---: | :---: | ---: |',
    `| before the cap | ${rung(q.before.endedOnRungHeight)} | ${rung(q.before.lowestRungHeight)} | ${rung(
      q.before.tallestRungHeight,
    )} | ${q.before.advance.ratio.toFixed(3)} |`,
    `| while capped | ${rung(q.during.endedOnRungHeight)} | ${rung(q.during.lowestRungHeight)} | ${rung(
      q.during.tallestRungHeight,
    )} | ${q.during.advance.ratio.toFixed(3)} |`,
    `| after the cap lifted | ${rung(q.after.endedOnRungHeight)} | ${rung(q.after.lowestRungHeight)} | ${rung(
      q.after.tallestRungHeight,
    )} | ${q.after.advance.ratio.toFixed(3)} |`,
    '',
    '| | |',
    '| --- | ---: |',
    `| the player's own bandwidth estimate, before | ${orDash(q.before.bandwidthEstimateKbps)} kbps |`,
    `| while capped | ${orDash(q.during.bandwidthEstimateKbps)} kbps |`,
    `| after | ${orDash(q.after.bandwidthEstimateKbps)} kbps |`,
    `| level changes hls.js counted | ${q.switchesCounted} |`,
    `| it came down, after the cap | ${
      q.steppedDownAfterMs === null ? 'it never did' : `${seconds(q.steppedDownAfterMs)}s`
    } |`,
    `| it went back up, after the lift | ${
      q.climbedBackAfterMs === null ? 'it never did' : `${seconds(q.climbedBackAfterMs)}s`
    } |`,
    `| resolutions the decoder produced while capped | ${q.during.resolutions.join(', ') || '—'} |`,
    '',
    '⛔ Every duration above is measured and filed rather than held against a ceiling. Owner ruling of',
    '2026-08-29: an e2e suite checks that the feature works and is stable, never how fast it is.',
    '',
  ];
}

/**
 * The verdicts, in the order a reader needs them.
 *
 * ⛔ The throttle first. Chromium applies network emulation itself and whether it reaches a given
 * transport is the browser's business, so a run whose player never noticed the cap says nothing about
 * ABR and every line below it would be read as though it did.
 */
function verdictSection(run: QualityRun): string[] {
  const q = run.quality;
  const lines = ['## What this run establishes', ''];

  lines.push(
    q.abrEnabledThroughout
      ? '✅ **The player was choosing its own rung throughout.**'
      : '⛔ **The level was pinned at some point in this run**, so nothing below is evidence about ABR. A ' +
          'pinned player rides one rung by instruction.',
    '',
  );

  const noticed =
    q.before.bandwidthEstimateKbps !== null &&
    q.during.bandwidthEstimateKbps !== null &&
    q.during.bandwidthEstimateKbps < q.before.bandwidthEstimateKbps;
  lines.push(
    noticed
      ? `✅ **The cap reached the player.** Its own estimate fell from ${q.before.bandwidthEstimateKbps} to ` +
          `${q.during.bandwidthEstimateKbps} kbps.`
      : '⛔ **The player never noticed the cap.** Its own bandwidth estimate did not fall, so the emulation ' +
          'did not reach whatever carried the segment bytes, and this run cannot say what ABR would have ' +
          'done on a genuinely worse connection.',
    '',
  );

  lines.push(
    q.steppedDownAfterMs === null
      ? '⛔ **It never stepped down.** The link could not carry the rung it was on and it stayed there.'
      : `✅ **It stepped down** to ${rung(q.during.lowestRungHeight)}, ${seconds(
          q.steppedDownAfterMs,
        )}s after the cap.`,
    '',
  );

  lines.push(
    q.during.advance.ratio > 0
      ? `✅ **The picture kept moving while capped**, at ${q.during.advance.ratio.toFixed(3)}x. That is what ` +
          'stepping down is for.'
      : '⛔ **The picture stopped while capped.** Stepping down bought the viewer nothing.',
    '',
  );

  lines.push(
    q.climbedBackAfterMs === null
      ? '⚠️ **It never climbed back** within this run. The viewer is left on a lower quality than their ' +
          'connection can now carry.'
      : `✅ **It climbed back** to ${rung(q.after.tallestRungHeight)}, ${seconds(
          q.climbedBackAfterMs,
        )}s after the lift.`,
    '',
  );

  return lines;
}

export function renderQualityReport(run: QualityRun): string {
  const at = (atMs: number): string => seconds(atMs - run.samples[0].atMs);

  const sampleRows = run.samples.map((sample, i) =>
    [
      `| ${i + 1}`,
      seconds(sample.atMs - run.samples[0].atMs),
      sample.currentTime.toFixed(2),
      rung(sample.selectedRungHeight),
      sample.resolution ?? '—',
      orDash(sample.bandwidthEstimateKbps),
      sample.bufferAheadS.toFixed(2),
      `${sample.rebufferCount} |`,
    ].join(' | '),
  );

  return [
    '# A viewer whose connection got worse',
    '',
    `**${run.measuredAt}.** ${run.chromeVersion}, headed against an X display on the deployment host, ` +
      `watching ${describeGop(run.gopSeconds)} through the shipped client while the tab's download was ` +
      `capped at ${run.quality.throttledToKbps} kbps from ${at(run.throttle.appliedAtMs)}s to ${at(
        run.throttle.liftedAtMs,
      )}s.`,
    '',
    `Watching \`${run.watchUrl}\`.`,
    '',
    ...ladderSection(run),
    ...rungSection(run),
    ...verdictSection(run),
    ...playbackSection(run),
    ...networkSection(run),
    ...instrumentSection(run),
    '## Every sample',
    '',
    '| # | at | media | rung | delivered | estimate kbps | buffer ahead | rebuffers |',
    '| ---: | ---: | ---: | :---: | :---: | ---: | ---: | ---: |',
    ...sampleRows,
    '',
  ].join('\n');
}
