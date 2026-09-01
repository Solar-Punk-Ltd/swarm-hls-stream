import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACKNOWLEDGE_UNMEASURED,
  announcementLoad,
  announcementRefusal,
  announcementSummary,
  ladderRungs,
} from '../../src/announcementRate.js';
import { loadConfig } from '../../src/config.js';
import { makeHost } from '../../src/harness/host.js';
import { PUBLISHER_GOP_SECONDS } from '../../src/harness/publisher.js';
import { readStageConf } from '../../src/harness/stage.js';
import { parseStageSegmenting, stageSegmentSeconds } from '../../src/segmentLength.js';

/**
 * Preflight, in one sentence: a ladder can ask SRS to announce more segments a second than it can
 * deliver, and when it does it quietly destroys its tallest rung, so this refuses before a broadcast
 * is paid for.
 *
 * ⛔⛔⛔ **The failure this exists for passes every other suite.** Measured 2026-08-31 on a four-rung
 * ladder at 0.5s segments: 1080p lost 765 of its 955 segments and was unpublished about two minutes
 * in, while the other three published at 96 to 99% of target, the uploader raised no queue warning,
 * and `swarm_hls_segments_uploaded_total` climbed the whole time. The master feed went on advertising
 * four rungs to viewers. Nothing threw, so nothing caught it for days.
 *
 * SRS fires `on_hls` once per closed segment per rung, so the stage asks for `rungs / segment`
 * announcements a second. Past what SRS can dispatch it does not error: announcements fall behind the
 * media at 0.46s per second of video until the lag passes `hls_window`, after which SRS deletes each
 * segment before announcing it and hands the uploader a callback naming a file that is already gone.
 *
 * ⚠️ **This is a prediction from the running config, not an observation of published media**, the same
 * standing as its sibling `segment-length`. It cannot see SRS failing to announce at a rate its own
 * config asks for, only that the config asks for one nothing has sustained. It costs one `docker exec`
 * of a text file: no publish, no stamp, no BZZ, and nothing on the deployment changed.
 *
 * ⛔⛔ THE REFUSAL ONLY STOPS THE SPEND BECAUSE OF THE `&&` IN `test:e2e`. KEEP THEM TOGETHER. See the
 * same warning in `spend-ceiling.test.ts`, which records why at length.
 *
 * The rule lives in `src/announcementRate.ts` because nothing under `suites/` runs in CI. It is
 * covered by `test/announcementRate.test.ts` and therefore by `pnpm verify`, leaving this file as
 * wiring and a failure message.
 */
/**
 * Read at module scope for the reason `abr-coverage.test.ts` records: a throw inside a `describe`
 * callback prints `not ok` and is still reported as `# fail 0` with exit 0, so a config this suite
 * cannot load would be waved through by the very gate that reads it.
 */
const cfg = loadConfig();

/**
 * Read from `process.env` rather than through `loadConfig`, deliberately and unlike everything else
 * here. It is an acknowledgement the operator makes for one run, not a property of the deployment,
 * and a value that lives in a profile would silently acknowledge every run after it.
 */
function unmeasuredAcknowledged(): boolean {
  const raw = process.env[ACKNOWLEDGE_UNMEASURED];
  return raw === 'true' || raw === '1';
}

describe('preflight — the ladder asks for a rate SRS has been shown sustaining', () => {
  const host = makeHost(cfg);

  it('is inside the measured band', async () => {
    const conf = await readStageConf(host, cfg);
    const segmentSeconds = stageSegmentSeconds(parseStageSegmenting(conf, PUBLISHER_GOP_SECONDS));
    const load = announcementLoad(ladderRungs(conf), segmentSeconds);

    const refusal = announcementRefusal(load, unmeasuredAcknowledged());
    if (refusal !== null) {
      assert.fail(refusal);
    }

    console.log(`  ${announcementSummary(load)}`);
    console.log(`    rungs: ${load.rungs.join(', ')}`);
  });
});
