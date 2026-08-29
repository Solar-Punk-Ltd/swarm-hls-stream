/**
 * The markdown a silenced rung leaves behind.
 *
 * Shares its sections with `report.ts` for the same reason the other two run reports do: a reading is
 * only worth having if it sits beside a clean one and means the same thing.
 *
 * What it adds is the pairing that is the whole point of the run. The rung timeline says whether the
 * player moved, and the freeze verdict says whether the viewer paid for it. Either alone can look
 * like a success: a player that switched instantly into a stall, or a picture that never stopped
 * because the buffer outlasted the outage.
 */

import { type LadderRung } from '../config.js';

import { FEED_STATE_ENDED } from './feedState.js';
import { type QualityPhase, type RungTimeline } from './qualitySwitch.js';
import type { RecoveryVerdict } from './recovery.js';
import {
  type BrowserRun,
  describeGop,
  instrumentSection,
  networkSection,
  orDash,
  playbackSection,
  seconds,
} from './report.js';
import { type RungProcess } from './rungTranscode.js';

export interface RungOutageRun extends BrowserRun {
  engine: string;
  ladder: readonly LadderRung[];
  silenced: {
    rung: string | null;
    height: number | null;
    processes: readonly RungProcess[];
    appliedAtMs: number;
    liftedAtMs: number;
  };
  rungs: RungTimeline;
  recovery: RecoveryVerdict;
}

const rung = (height: number | null): string => (height === null ? '—' : `${height}p`);

function silencedSection(run: RungOutageRun): string[] {
  const survivors = run.ladder.filter((level) => level.name !== run.silenced.rung);

  return [
    '## What was silenced',
    '',
    `The viewer settled on **${run.silenced.rung ?? 'no rung at all'}**, and that is the rung this run ` +
      `stopped, for ${seconds(run.silenced.liftedAtMs - run.silenced.appliedAtMs)}s. ${survivors.length} healthy ` +
      `rungs sat beside it throughout: ${survivors.map((level) => level.name).join(', ') || 'none'}.`,
    '',
    '⛔ Stopped rather than killed. SRS respawns a transcode that exits, so a kill would give a rung that',
    'is quiet for however long a respawn takes rather than for the window this run chose.',
    '',
    '| pid | the process that was stopped |',
    '| ---: | --- |',
    ...run.silenced.processes.map((process) => `| ${process.pid} | \`${process.args}\` |`),
    '',
  ];
}

function phaseRow(label: string, phase: QualityPhase): string {
  return (
    `| ${label} | ${rung(phase.endedOnRungHeight)} | ${rung(phase.lowestRungHeight)} | ` +
    `${rung(phase.tallestRungHeight)} | ${phase.advance.ratio.toFixed(3)} |`
  );
}

function timelineSection(run: RungOutageRun): string[] {
  const r = run.recovery;

  return [
    '## What the viewer got',
    '',
    '| | rung it ended on | lowest | tallest | media seconds per wall second |',
    '| --- | :---: | :---: | :---: | ---: |',
    phaseRow('before the rung went quiet', run.rungs.before),
    phaseRow('while it was quiet', run.rungs.during),
    phaseRow('after it spoke again', run.rungs.after),
    '',
    '| | |',
    '| --- | ---: |',
    `| it moved off the silenced rung, after the outage | ${
      run.rungs.steppedDownAfterMs === null ? 'it never did' : `${seconds(run.rungs.steppedDownAfterMs)}s`
    } |`,
    `| it climbed back, after the rung returned | ${
      run.rungs.climbedBackAfterMs === null ? 'it never did' : `${seconds(run.rungs.climbedBackAfterMs)}s`
    } |`,
    `| level changes hls.js counted | ${run.rungs.switchesCounted} |`,
    `| longest stretch the picture did not move | ${seconds(r.longestFreezeMs)}s |`,
    `| it stopped, after the rung went quiet | ${
      r.freezeStartedAfterFaultMs === null ? 'it never stopped' : `${seconds(r.freezeStartedAfterFaultMs)}s`
    } |`,
    `| behind live before | ${orDash(r.latencyBeforeS)}s |`,
    `| behind live after | ${orDash(r.latencyAfterS)}s |`,
    '',
    '⛔ Every duration above is measured and filed rather than held against a ceiling. Owner ruling of',
    '2026-08-29: an e2e suite checks that the feature works and is stable, never how fast it is.',
    '',
  ];
}

/**
 * The verdicts, and the pairing that stops either half reading as a success on its own.
 *
 * A player that switched away instantly and then stalled has not helped anybody, and a picture that
 * never stopped because the buffer outlasted the outage has not been tested.
 */
function verdictSection(run: RungOutageRun): string[] {
  const lines = ['## What this run establishes', ''];

  lines.push(
    run.rungs.abrEnabledThroughout
      ? '✅ **The player was choosing its own rung throughout.**'
      : '⛔ **The level was pinned at some point**, so nothing below is evidence about the ladder.',
    '',
  );

  const moved = run.rungs.during.endedOnRungHeight !== run.rungs.before.endedOnRungHeight;
  lines.push(
    moved
      ? `✅ **It moved off the dead rung**, from ${rung(run.rungs.before.endedOnRungHeight)} to ` +
          `${rung(run.rungs.during.endedOnRungHeight)}.`
      : `⛔ **It stayed on ${rung(run.rungs.before.endedOnRungHeight)}, the rung that had stopped producing.** ` +
          'hls.js changes level on a fragment load ERROR, and a feed that stops advancing does not error, ' +
          'it simply stops offering fragments. A player waiting for one it was never offered has nothing ' +
          'to react to.',
    '',
  );

  lines.push(
    run.rungs.during.advance.ratio > 0
      ? `✅ **The picture kept moving while the rung was quiet**, at ${run.rungs.during.advance.ratio.toFixed(3)}x.`
      : '⛔ **The picture stopped.** Three healthy rungs sat beside this viewer for the whole outage.',
    '',
  );

  if (run.recovery.longestFreezeMs > 0) {
    lines.push(
      run.recovery.explainedTheFreeze
        ? `✅ **The client said why**, while the picture was stopped: "${run.recovery.saidWhileFrozen.join('", "')}".`
        : '⛔ **The client said nothing** while the picture was stopped.',
      '',
    );
  }

  // ⛔ Read off the run summary rather than the recovery verdict: `ended` is a feed state the viewer
  // was shown, not something the freeze judge knows about.
  const toldItEnded = run.summary.feedStatesSeen.includes(FEED_STATE_ENDED);
  lines.push(
    toldItEnded
      ? '⛔ **The viewer was told the broadcast had ended.** It had not. One rung of four went quiet and ' +
          'the other three published throughout, so a viewer who left on that message left a broadcast ' +
          'that never stopped.'
      : '✅ **The viewer was never told the broadcast had ended**, which it had not.',
    '',
  );

  return lines;
}

export function renderRungOutageReport(run: RungOutageRun): string {
  const at = (atMs: number): string => seconds(atMs - run.samples[0].atMs);

  const sampleRows = run.samples.map((sample, i) =>
    [
      `| ${i + 1}`,
      seconds(sample.atMs - run.samples[0].atMs),
      sample.currentTime.toFixed(2),
      rung(sample.selectedRungHeight),
      sample.resolution ?? '—',
      sample.bufferAheadS.toFixed(2),
      `${sample.feedStateMessage ?? ''} |`,
    ].join(' | '),
  );

  return [
    '# A viewer whose rung went quiet',
    '',
    `**${run.measuredAt}.** ${run.chromeVersion}, headed against an X display on the deployment host, ` +
      `watching ${describeGop(run.gopSeconds)} through the shipped client while the ${
        run.silenced.rung ?? 'selected'
      } transcode in \`${run.engine}\` was stopped from ${at(run.silenced.appliedAtMs)}s to ${at(
        run.silenced.liftedAtMs,
      )}s.`,
    '',
    `Watching \`${run.watchUrl}\`.`,
    '',
    ...silencedSection(run),
    ...timelineSection(run),
    ...verdictSection(run),
    ...playbackSection(run),
    ...networkSection(run),
    ...instrumentSection(run),
    '## Every sample',
    '',
    '| # | at | media | rung | delivered | buffer ahead | what the client said |',
    '| ---: | ---: | ---: | :---: | :---: | ---: | --- |',
    ...sampleRows,
    '',
  ].join('\n');
}
