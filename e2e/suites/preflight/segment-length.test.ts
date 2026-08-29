import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containerName, loadConfig, runProfile } from '../../src/config.js';
import { makeHost } from '../../src/harness/host.js';
import { readStageSegmenting } from '../../src/harness/stage.js';
import {
  SEGMENT_ANY,
  SEGMENT_UNDECLARED_REFUSAL,
  segmentLengthRefusal,
  stageSegmentSeconds,
  unreadableEngineRefusal,
} from '../../src/segmentLength.js';

/**
 * Preflight — the deployed stage must cut segments at the length this run's viewer can actually use.
 *
 * ⭐⭐⭐ **The two viewer types want opposite numbers, so there is no setting that is simply correct.**
 * Measured 2026-08-16 by the sibling repo `swarm-stream-loadlab`, in
 * `docs/measurements/2026-08-16-a-stock-tab-holds-realtime-on-two-second-segments.md`, and carried
 * unresolved as Q23 of its `docs/spec/product-spec.md`:
 *
 *  - a stock in-tab weeb-3 node holds **1.000x of realtime on 2s segments** with about 90s of buffer,
 *    and **0.426x on 0.5s** with 0.5 to 3.5s, because it admits about one segment per second whatever
 *    its peer count and a 0.5s profile needs two a second;
 *  - the **gateway** measures the other way over 21 funded arms, 0.5s beating 2s on
 *    capture-to-fetchable latency at 1.55s against 3.88s.
 *
 * ⛔ So a stage matching the wrong profile is a WRONG number rather than a missing one. Our latbench
 * stage publishes 0.5s and the `in-browser` profile ran against it for a day: live in-tab readings
 * sat at 0.35 to 0.68 of realtime with a 44ms buffer, complete, plausible and fully instrumented, and
 * nothing in the artefacts said the viewer had never had a chance. A warning would have scrolled
 * past, so this refuses.
 *
 * ## What it reads, and what it costs
 *
 * It reads the config the running SRS container was started on, through one `docker exec cat`. **No
 * broadcast, no publish, no stamp, no BZZ, and nothing on the deployment changed.** Reading raw
 * `#EXTINF` off a live playlist would be an observation rather than a prediction, and it needs a
 * broadcast, which is real money on every second. `deploy/scripts/stage-fingerprint.sh` already does
 * exactly that, during a sitting, where the broadcast is paid for either way. This one sits earlier
 * and cheaper and catches the fault that one is too late to save money on.
 *
 * Not from the env files this suite already resolved, though those are free too: an env file edited
 * after the last deploy states an intention, and this bench host is shared. See `harness/stage.ts`.
 *
 * **This one never skips.** A preflight that can skip has the defect it was written to catch. A run
 * that genuinely does not pin a length says `E2E_EXPECT_SEGMENT_S=any`, which is a declaration, is
 * printed, and is never asked again.
 *
 * The verdict lives in `src/segmentLength.ts` because nothing under `suites/` runs in CI. Its rules
 * are covered by `test/segmentLength.test.ts` and therefore by `pnpm verify`, leaving this file as
 * wiring and a failure message.
 */
/**
 * Read at module scope, not inside the `describe`, for the reason `abr-coverage.test.ts` records: a
 * throw inside a `describe` callback prints `not ok` and is still reported as `# fail 0` with exit 0.
 * `loadConfig` is what parses `E2E_EXPECT_SEGMENT_S`, so a spelling no arithmetic can use would
 * otherwise be waved through by the very gate that reads it.
 */
const cfg = loadConfig();

describe('preflight — the stage cuts at the length this run needs', () => {
  const host = makeHost(cfg);

  it('publishes what the profile asks for, or refuses before the first frame', async () => {
    if (cfg.segmentExpectation === 'undeclared') {
      assert.fail(`${SEGMENT_UNDECLARED_REFUSAL}\n${untouched()}`);
    }

    if (cfg.segmentExpectation === SEGMENT_ANY) {
      console.log(`  E2E_EXPECT_SEGMENT_S=${SEGMENT_ANY}: this run declared that it pins no segment length`);
      return;
    }

    const needed = cfg.segmentExpectation;
    if (cfg.engine !== 'srs') {
      assert.fail(`${unreadableEngineRefusal(cfg.engine, needed)}\n${untouched()}`);
    }

    // Every way of learning nothing is a refusal, so the read's own throws land in the same failure
    // as a mismatch does rather than as an unhandled rejection with no remedy attached.
    let stage;
    try {
      stage = await readStageSegmenting(host, cfg);
    } catch (error) {
      assert.fail(
        `could not read what ${containerName(cfg, 'srs')} cuts at: ${(error as Error).message}. An ` +
          `unreadable stage is not a matching stage, and this run needs ${needed}s segments.\n${untouched()}`,
      );
    }

    console.log(
      `  ${runProfile.name} needs ${needed}s; ${containerName(cfg, 'srs')} has hls_fragment ` +
        `${stage.fragment}, aof_ratio ${stage.aofRatio}, a ${stage.gopSeconds}s cadence from ` +
        `${stage.transcodes ? 'its own ladder' : 'whatever publishes'}, so it cuts at ` +
        `${stageSegmentSeconds(stage).toFixed(3)}s`,
    );

    const refusal = segmentLengthRefusal({ profile: runProfile.name, needed, stage });
    if (refusal === null) {
      return;
    }

    assert.fail(`${refusal}\n${untouched()}\n${howToRestage()}`);
  });
});

/**
 * The closing note on every refusal: nothing was spent, and here is where a declaration lives.
 *
 * `E2E_EXPECT_SEGMENT_S` is read out of the layered deployment env as well as out of the run profile,
 * the way `E2E_EXPECT_ABR` is, so a deployment that always serves one viewer type can state it once.
 */
function untouched(): string {
  return (
    'Nothing has been published and nothing on the deployment was changed. E2E_EXPECT_SEGMENT_S can ' +
    "go in this profile's env alongside E2E_SSH_TARGET, so a deployment declares itself once:\n" +
    cfg.envFiles.map((path) => `  ${path}`).join('\n')
  );
}

/**
 * The knob and the command, on the two refusals a redeploy can actually fix.
 *
 * `srs` alone, because that is the only service `HLS_FRAGMENT` reaches. `--profile` is passed even
 * for the default profile: this bench host is shared, and a deploy command that omits the profile is
 * how a session restages somebody else's stack.
 */
function howToRestage(): string {
  const slot = cfg.portSlot === 0 ? '' : ` --portSlot=${cfg.portSlot}`;

  return (
    'HLS_FRAGMENT belongs in the engine env named above, and the root env beats it where both are ' +
    `set. Then restage the one service that reads it:\n` +
    `  deploy/scripts/deploy.sh --profile=${cfg.profile}${slot} srs`
  );
}
