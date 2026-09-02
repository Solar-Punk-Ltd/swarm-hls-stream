/**
 * The markdown a squeezed viewer leaves behind.
 *
 * Shares its sections with `report.ts` for the same reason `recoveryReport.ts` does: a throttled
 * reading is only worth having if it sits beside a clean one and means the same thing.
 *
 * What it adds is the rung timeline, which is the whole point of the run and appears nowhere else.
 */

import { type LadderRung } from '../config.js';

import {
  abandonedAnswerVerdict,
  describeElapsed,
  describeSettleOutcomes,
  fragmentLogVerdict,
  type FragmentRequestPhase,
  type FragmentRequestTimeline,
  type FragmentSettlePhase,
  fragmentSettleVerdict,
} from './fragmentRequests.js';
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
  /** Which level the player asked for, per phase. An observation, asserted nowhere. */
  fragmentRequests: FragmentRequestTimeline;
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
    // ⛔ Above the arrival, because deciding and arriving come apart and the decision is read first.
    // V2 on 2026-09-01: ABR asked at 3.0s and the player arrived after the cap had already lifted.
    `| ABR asked for a lower rung, after the cap | ${
      q.abrChoseLowerAfterMs === null ? 'it never asked' : `${seconds(q.abrChoseLowerAfterMs)}s`
    } |`,
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
 * How much of a rung address to print, counted from its end.
 *
 * A rung is `swarm://<40 hex owner>/<64 hex topic>`, which is 113 characters and would make the table
 * unreadable. The tail is the end of the topic, and the topic is what differs between rungs of one
 * ladder. ⚠️ The state file carries every address in full, so nothing here is the only copy.
 */
const RUNG_TAIL_CHARS = 12;

const shortRung = (rung: string): string =>
  rung.length <= RUNG_TAIL_CHARS ? rung : `…${rung.slice(-RUNG_TAIL_CHARS)}`;

function levelRows(phase: FragmentRequestPhase, named: string): string[] {
  if (phase.levels.length === 0) {
    return [`| ${named} | — | 0 | — |`];
  }
  return phase.levels.map(
    (level) => `| ${named} | ${level.level} | ${level.requests} | ${level.rungs.map(shortRung).join(', ')} |`,
  );
}

/**
 * ⭐ The one reading that says which rung the fragments in flight belonged to.
 *
 * Every other quality figure in this report is about what the player DECODED or what ABR would pick
 * NEXT. Neither can separate a player that kept asking for a rung it could not afford from a player
 * that asked for a cheaper one and was served the expensive one. This can.
 *
 * ⛔ The verdict line comes first and has to be read first. An arm with no lines captured prints the
 * same zeroes whether the player asked for nothing or the client it watched never had the instrument,
 * and those are opposite conclusions.
 *
 * ⭐ Exported and given its own arguments so a second driver can render it. `browser/vod.ts` squeezes
 * a finished recording and needs this exact reading, and a second copy of the table would drift from
 * this one. `at` is the caller's time axis, because the report it lands in owns what second zero is.
 */
export function fragmentRequestSection(asked: FragmentRequestTimeline, at: (atMs: number) => string): string[] {
  return [
    '## Which level the player asked for',
    '',
    `**${fragmentLogVerdict(asked)}.**`,
    '',
    '| | level | fragment requests | rung playlist(s) it named |',
    '| --- | :---: | ---: | --- |',
    ...levelRows(asked.before, 'before the cap'),
    ...levelRows(asked.during, 'while capped'),
    ...levelRows(asked.after, 'after the cap lifted'),
    '',
    '⛔ Counted and filed, never asserted on. A rung address is shortened to the tail of its topic here',
    'and written out in full in the state file beside this report.',
    '',
    ...settleSection(asked),
    // On the report's own axis, seconds from its first sample, so this table can be read straight
    // against `What the player chose` and `Every sample`. The state file keeps the wall clock.
    ...everyRequestSection(asked, at),
  ];
}

function settleRow(phase: FragmentSettlePhase, named: string): string {
  return `| ${named} | ${phase.settled} | ${describeSettleOutcomes(phase)} | ${describeElapsed(phase)} | ${
    phase.pairedToRequests
  } |`;
}

/**
 * ⭐ What became of each of those requests, which the level counts above cannot say.
 *
 * A level count is a count of ASKING. Six requests at one level is six fragments if they all arrived and
 * one fragment six times if they did not, and on 2026-09-01 a squeeze arm produced exactly that shape
 * with no way to tell which. The outcomes here decide it, and the durations say what the attempts cost.
 *
 * ⛔ The verdict line comes first, as it does above and for the same reason. Zero attempts settled and a
 * client that writes no settle line print the same digits and mean opposite things.
 */
function settleSection(asked: FragmentRequestTimeline): string[] {
  const { settled } = asked;
  const heading = ['## How each of those attempts ended', '', `**${fragmentSettleVerdict(settled)}.**`, ''];

  if (settled === null) {
    return [...heading, ...abandonedAnswerLine(asked)];
  }

  return [
    ...heading,
    '| | attempts settled | how they ended | elapsed min / median / max | paired to a request |',
    '| --- | ---: | --- | ---: | ---: |',
    settleRow(settled.before, 'before the cap'),
    settleRow(settled.during, 'while capped'),
    settleRow(settled.after, 'after the cap lifted'),
    '',
    '⛔ Observations, all of them, and no duration here is held against a ceiling. An attempt is paired to',
    'a request when some request in the run named the same level and segment number, which is a check on',
    'the join rather than a finding: a phase pairing with nothing means the two halves are describing',
    `different fragments. The whole list of ${settled.captured} settled attempt(s) is in the state file.`,
    '',
    ...abandonedAnswerLine(asked),
  ];
}

/**
 * ⭐⭐ The one bit an `aborted` cannot carry: whether the node ever produced the bytes.
 *
 * On the in-tab path a retrieval takes no abort signal, so a fragment the player walked away from keeps
 * costing the node until it answers, and both a segment that arrived far too late and one that never
 * arrived reach the settle table above as `aborted`. Under a cap those are opposite findings, and V2's
 * open question is which of the two happened.
 *
 * ⛔ One line, and an observation. The per-phase counts and every entry are in the state file beside
 * this report.
 */
function abandonedAnswerLine(asked: FragmentRequestTimeline): string[] {
  return [`⭐ ${abandonedAnswerVerdict(asked.abandonedAnswers)}.`, ''];
}

/**
 * How many raw requests the markdown prints before it stops.
 *
 * A six-minute squeeze arm asks for a few hundred fragments, which is a table a person can still scroll.
 * ⚠️ The cap is on the RENDER only. The state file beside this report carries every entry, and the
 * counts above are computed over all of them, so no figure here changes when the table is truncated.
 */
const MAX_RENDERED_REQUESTS = 200;

/**
 * ⭐⭐ Every request, in order, with its own segment number.
 *
 * ⛔⛔ **This is the section the buckets above cannot replace.** A phase that reports six level-0
 * requests has aggregated away the one thing that separates six fragments from one fragment asked for
 * six times, and that difference is where a defect lives: the first is a player stepping down and being
 * served, the second is a player stepping down and getting nothing. Repeated segment numbers here are
 * retries, plainly.
 */
function everyRequestSection(asked: FragmentRequestTimeline, at: (atMs: number) => string): string[] {
  const { requests } = asked;
  if (requests === null) {
    return [
      '### Every fragment this viewer asked for',
      '',
      'Not in this artifact: it was written before the raw list was carried, so only the buckets above',
      'survive from that run. Retries cannot be told from distinct fragments in a file of that vintage.',
      '',
    ];
  }

  const shown = requests.slice(0, MAX_RENDERED_REQUESTS);
  const truncated =
    requests.length > shown.length
      ? [`⚠️ The first ${shown.length} of ${requests.length}. The state file beside this report carries them all.`, '']
      : [];

  return [
    '### Every fragment this viewer asked for',
    '',
    '| # | at | level | sn | rung |',
    '| ---: | ---: | :---: | ---: | --- |',
    ...shown.map(
      (request, i) =>
        `| ${i + 1} | ${at(request.atMs)}s | ${request.level} | ${request.sn} | ${shortRung(request.rung)} |`,
    ),
    '',
    ...truncated,
    '⛔ A repeated segment number at one level is the same fragment asked for again, which is the reading',
    'a count of requests cannot give. Each instant is seconds from the first sample, the axis every other',
    'table here uses, and the state file carries the wall clock the phase boundaries were cut on.',
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
    ...fragmentRequestSection(run.fragmentRequests, at),
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
