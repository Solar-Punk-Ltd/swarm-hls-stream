import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { FEED_STATE_ENDED } from '../../src/browser/feedState.js';
import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { ladderResolutionRefusal } from '../../src/harness/browserVerdict.js';
import { MAX_WEEB3_SEGMENT_REQUESTS } from '../../src/harness/crashArm.js';
import { discoverStamp, makeHost, waitForIdle } from '../../src/harness/host.js';
import { parseUploaderLog } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import {
  keptWatchingRefusal,
  ladderInPlayRefusal,
  movedOffDeadRungRefusal,
  rungArmMinutes,
  rungArmRefusal,
  rungArmSummary,
} from '../../src/harness/rungArm.js';
import { waitFor } from '../../src/harness/wait.js';
import { requireByteSource, viewerGate } from '../../src/viewerCoverage.js';

/**
 * V3 — the rung a viewer is watching stops being produced, and three healthy ones sit beside it.
 *
 * ## What this asks that nothing else does
 *
 * A ladder is four renditions so a viewer has somewhere to go. `suites/viewer/quality-switch.test.ts`
 * asks what a player does when the LINK gets worse. This asks what it does when the rung it is riding
 * stops existing while the rest of the ladder carries on publishing. Neither question had ever been
 * put to a player before 2026-08-30, and both ABR suites answer neither: they read the uploader's
 * log, which can say four rungs were published and nothing about a viewer.
 *
 * ## ⛔ The rung is the viewer's choice, not this suite's
 *
 * The driver reads `Selected Rung` off the shipped overlay after the settle and silences THAT one.
 * In-tab viewers have been measured riding 1080p while gateway viewers rode 360p on the same
 * broadcast, so a hardcoded rung would silence one the viewer was not on and the run would watch a
 * player correctly ignore a fault that never touched it.
 *
 * ## ⛔ This may well go red, and a red here is a finding
 *
 * hls.js changes level on a fragment load ERROR. A Swarm feed that stops advancing does not error, it
 * stops offering fragments, so a player waiting for one it was never offered has nothing to react to.
 * If that is what happens, a viewer freezes on a dead rung with three live ones beside them, which is
 * a real defect worth a red rather than a harness problem to design around. `movedOffDeadRungRefusal`
 * names that mechanism in its message so the next session does not rediscover it.
 *
 * ## What this asserts
 *
 * That the viewer was watching and their player was choosing its own rung. That they ended the outage
 * on a rung other than the dead one. That the picture kept moving while it was quiet. And that they
 * were never told the broadcast had ended, because it had not: three rungs published throughout.
 *
 * ## ⛔ No timing is asserted
 *
 * Owner ruling of 2026-08-29. How long the switch took and how long the picture stopped are measured,
 * printed under a heading saying so, and filed.
 *
 * ⛔ Requires a deployed profile, a funded stamp and the browser image on the host, like every suite
 * under `suites/`. Nothing in CI runs these.
 */

/** The broadcast has to be established before a viewer joins it, or the join is what gets broken. */
const WARMUP_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const WATCH_MINUTES = rungArmMinutes();

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
// Module scope, so an undeclared run fails the file during import rather than skipping into silence.
const skip = viewerGate(cfg.viewerExpectation, backend) || abrOff(cfg.abrEnabled);

describe('V3 — a viewer whose rung goes quiet moves to one that has not', { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher;
  let startedAt: string;

  before(async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.ok(stamp.batchTTL > MIN_STAMP_TTL_S, `stamp TTL ${stamp.batchTTL}s too low to run a stream`);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
    // ⛔ Nothing to restore here, and that is deliberate rather than an omission. The driver resumes
    // the transcode from its own `finally` INSIDE the container, and a stopped transcode is invisible
    // to the deployment: SRS never spawned a replacement because the process never exited. If an arm
    // is killed by the harness timeout, the engine restart in the next suite's `waitForIdle` is what
    // clears it, and a rung still silent under a later run fails that run's own ladder assertions
    // rather than passing quietly.
  });

  it('ends the outage on a living rung, still watching, and never told the broadcast ended', async () => {
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments published before a viewer joins`,
    });

    const result = await runBrowserArm(host, cfg, {
      backend: requireByteSource(backend),
      watchMinutes: WATCH_MINUTES,
      silenceSelectedRung: true,
    });
    console.log(`  ${rungArmSummary(result)}`);
    console.log(`  the viewer passed through: ${result.feedStatesSeen.join(' → ')}`);

    // ⛔ First. It settles whether there was a viewer, whether the browser was a usable instrument,
    // and whether a rung was silenced at all. A plain watch produces a full report in which nothing
    // ever went wrong, and a player that never changed rung would look exactly like one that could not.
    const notSilenced = rungArmRefusal(result, { maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS });
    assert.equal(notSilenced, null, `this run is not a viewer whose rung went quiet: ${notSilenced}`);

    const rungs = result.rungs;
    const silencedRung = result.silencedRung;
    assert.ok(rungs && silencedRung, 'the refusal above should already have caught an arm that silenced nothing');

    // ⭐ Phase 1 of docs/e2e-viewer-coverage-plan.md, asked here as everywhere else.
    const wrongQuality = ladderResolutionRefusal(result, cfg.abrLadderResolutions);
    assert.equal(
      wrongQuality,
      null,
      `this viewer was served a quality the deployment never configured: ${wrongQuality}`,
    );

    const notAdapting = ladderInPlayRefusal(rungs);
    assert.equal(notAdapting, null, `this run says nothing about the ladder: ${notAdapting}`);

    // ⭐ The assertion the whole file exists for.
    const stuckOnTheDeadRung = movedOffDeadRungRefusal(rungs, silencedRung);
    assert.equal(stuckOnTheDeadRung, null, `this viewer stayed on a rung that had stopped: ${stuckOnTheDeadRung}`);

    // ⭐ And the half that makes moving worth anything.
    const frozen = keptWatchingRefusal(rungs);
    assert.equal(frozen, null, `moving rung bought this viewer nothing: ${frozen}`);

    // ⛔ The lie this fault can tell. One rung of four stopped and the other three published for the
    // whole outage, so a viewer told the broadcast was over would leave one that never stopped.
    assert.ok(
      !result.feedStatesSeen.includes(FEED_STATE_ENDED),
      `this viewer was told the broadcast had ended while three of four rungs were still publishing. ` +
        `They passed through: ${result.feedStatesSeen.join(' → ')}`,
    );

    const recovery = result.recovery;
    console.log(
      `  observations, none of them asserted. silenced ${silencedRung}: moved after ` +
        `${describeMs(rungs.steppedDownAfterMs)}, climbed back after ${describeMs(rungs.climbedBackAfterMs)}, ` +
        `froze ${((recovery?.longestFreezeMs ?? 0) / 1000).toFixed(1)}s, and the client said ${
          recovery && recovery.saidWhileFrozen.length > 0 ? `"${recovery.saidWhileFrozen.join('", "')}"` : 'NOTHING'
        } while it was stopped`,
    );
  });
});

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no second rung to move to';
}

/** A duration for a person, or the plain fact that it never happened. */
function describeMs(ms: number | null): string {
  return ms === null ? 'never' : `${(ms / 1000).toFixed(1)}s`;
}
