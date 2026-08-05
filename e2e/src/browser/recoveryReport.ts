/**
 * The markdown a crash scenario leaves behind.
 *
 * Shares its sections with `report.ts` on purpose. A crash reading is only worth having if it sits
 * beside a clean one and means the same thing, and two renderers is how that stops being true.
 *
 * What this adds is the verdict a clean run has no place for: what a viewer saw across the fault,
 * and whether the client told them anything while they saw it.
 */

import { FAULT_PAST_TENSE, type FaultScenario } from './faults.js';
import type { RecoveryVerdict } from './recovery.js';
import { type BrowserRun, instrumentSection, networkSection, orDash, playbackSection, seconds } from './report.js';

export interface CrashRun extends BrowserRun {
  scenario: FaultScenario;
  container: string;
  fault: { injectedAtMs: number; liftedAtMs: number };
  recovery: RecoveryVerdict;
}

function phaseSection(run: CrashRun): string[] {
  const r = run.recovery;
  const downSeconds = seconds(run.fault.liftedAtMs - run.fault.injectedAtMs);

  return [
    '## What the viewer saw',
    '',
    `\`${run.container}\` was **${FAULT_PAST_TENSE[run.scenario.action]}** for ${downSeconds}s, which breaks ${
      run.scenario.breaks
    }.`,
    '',
    '| | media seconds per wall second | over |',
    '| --- | ---: | ---: |',
    `| before the fault | ${r.before.ratio.toFixed(3)} | ${seconds(r.before.wallMs)}s |`,
    `| while it was down | ${r.during.ratio.toFixed(3)} | ${seconds(r.during.wallMs)}s |`,
    `| after it came back | ${r.after.ratio.toFixed(3)} | ${seconds(r.after.wallMs)}s |`,
    '',
    '| | |',
    '| --- | ---: |',
    `| longest stretch the picture did not move | ${seconds(r.longestFreezeMs)}s |`,
    `| it stopped, after the fault | ${
      r.freezeStartedAfterFaultMs === null ? 'it never stopped' : `${seconds(r.freezeStartedAfterFaultMs)}s`
    } |`,
    `| it moved again, after the service returned | ${
      r.recoveredAfterLiftMs === null ? '—' : `${seconds(r.recoveredAfterLiftMs)}s`
    } |`,
    `| behind live before | ${orDash(r.latencyBeforeS)}s |`,
    `| behind live after | ${orDash(r.latencyAfterS)}s |`,
    '',
  ];
}

/**
 * The verdicts, written against the expectation the scenario declared before the run.
 *
 * Stated as a comparison rather than as a description, because a paragraph written after the fact
 * fits whatever came out of the run. The scenario says what should happen in `faults.ts`, and this
 * says whether it did.
 */
function verdictSection(run: CrashRun): string[] {
  const r = run.recovery;
  const lines = ['## Against what this scenario expected', '', `> ${run.scenario.expectation}`, ''];

  if (r.longestFreezeMs === 0) {
    lines.push(
      run.scenario.expectFreeze
        ? '⚠️ **The picture never stopped.** The viewer got through the whole fault on buffered media, so ' +
            'this run says the outage was shorter than the runway rather than anything about recovery. A ' +
            'longer outage is what would test it.'
        : '✅ **The picture never stopped**, which is what this fault should look like from a viewer.',
      '',
    );
  } else {
    lines.push(
      `⛔ **The picture stopped for ${seconds(r.longestFreezeMs)}s.**` +
        (run.scenario.expectFreeze ? ' Expected for this fault, and the length is the finding.' : ''),
      '',
    );
  }

  if (r.longestFreezeMs > 0) {
    lines.push(
      r.explainedTheFreeze
        ? `✅ **The client said why.** While the picture was stopped it showed: "${r.saidWhileFrozen.join('", "')}". ` +
            'A viewer who is told the stream is reconnecting waits. One looking at a frozen frame reloads, ' +
            'or leaves.'
        : '⛔ **The client said nothing.** The picture was stopped and `FeedStateOverlay` rendered no message, ' +
            'so a viewer had a frozen frame and no reason for it. That overlay exists for exactly this ' +
            'moment.',
      '',
    );
  }

  if (r.recovered) {
    lines.push(
      r.recoveredAfterLiftMs === null
        ? '✅ **Playback was running at the end of the run.**'
        : `✅ **It recovered on its own**, ${seconds(r.recoveredAfterLiftMs)}s after the service came back, with ` +
            'no reload and nothing asked of the viewer.',
      '',
    );
  } else {
    lines.push(
      '⛔ **It did not recover.** Playback was still stopped on the last sample, however long after the ' +
        'service returned. A viewer would be looking at a frozen picture with nothing left to wait for.',
      '',
    );
  }

  if (r.latencyBeforeS !== null && r.latencyAfterS !== null && r.latencyAfterS > r.latencyBeforeS + 2) {
    lines.push(
      `⚠️ **It resumed in the past.** ${orDash(r.latencyBeforeS)}s behind live before the fault, ` +
        `${orDash(r.latencyAfterS)}s after it. Playback is running and the viewer is watching something ` +
        'that already happened, which the advance ratio cannot show because both play at 1.0.',
      '',
    );
  }

  return lines;
}

export function renderCrashReport(run: CrashRun): string {
  const faultAt = (atMs: number): string => seconds(atMs - run.samples[0].atMs);

  const sampleRows = run.samples.map((sample, i) =>
    [
      `| ${i + 1}`,
      seconds(sample.atMs - run.samples[0].atMs),
      sample.currentTime.toFixed(2),
      orDash(sample.liveLatencyS),
      sample.bufferAheadS.toFixed(2),
      String(sample.readyState),
      `${sample.rebufferCount}`,
      `${sample.feedStateMessage ?? ''} |`,
    ].join(' | '),
  );

  return [
    `# ${run.scenario.name}: what a viewer saw`,
    '',
    `**${run.measuredAt}.** ${run.chromeVersion}, headed against an X display on the deployment host, ` +
      `watching a ${run.gopSeconds}s-GOP broadcast through the shipped client while \`${run.container}\` ` +
      `was ${FAULT_PAST_TENSE[run.scenario.action]}.`,
    '',
    `\`${run.watchUrl}\``,
    '',
    `The fault landed ${faultAt(run.fault.injectedAtMs)}s into the run and was lifted at ` +
      `${faultAt(run.fault.liftedAtMs)}s.`,
    '',
    ...instrumentSection(run),
    ...phaseSection(run),
    ...verdictSection(run),
    ...playbackSection(run),
    ...networkSection(run),
    '## Every sample',
    '',
    '| # | t (s) | currentTime | behind live (s) | buffered ahead (s) | readyState | rebuffers | what the client said |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...sampleRows,
    '',
    ...(run.screenshots.length > 0
      ? ['## Screenshots', '', ...run.screenshots.map((path) => `- \`${path}\``), '']
      : []),
  ].join('\n');
}
