import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { drainStillDeclared } from '../../src/harness/batchDrain.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs } from '../../src/harness/logwatch.js';
import { describeMaster, masterRungRefusal, masterRungsOf, waitForMasterRungs } from '../../src/harness/masterShape.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Service: the ladder's master offers every rung a viewer joining now could choose.
 *
 * ## What a master playlist is, in one sentence
 *
 * One small text file per ladder, published to a feed of its own, naming every quality a player may
 * pick and where each one's playlist lives. It is the only thing a viewer who arrives mid-broadcast
 * reads to find out what the ladder offers.
 *
 * ## ⛔⛔ Decision 5 of `docs/e2e-batch-drain-plan.md`, and the half that was missing
 *
 * A drain sitting arms one rung's postage to run dry, proves the master drops that rung, and then
 * restores the original batch. The recovery half of the decision is that the master offers every
 * rung again afterwards, and the step the plan named for it was `pnpm e2e:abr-ladder`. That suite
 * says in its own docblock that it does not judge the master: it reads the uploader's log, which can
 * say four rungs published and nothing at all about what a viewer is offered. Those are different
 * facts, and the one that had gone wrong in this deployment is the master. Observed 2026-08-31,
 * before the dead-rung rule shipped: the master went on naming 1080p for minutes after that rung was
 * unpublished.
 *
 * So this is the master half. `abr-ladder` still owns whether the ladder came up, and this owns
 * whether the master offers what came up. `pnpm e2e:ladder-restored` runs both, in that order.
 *
 * ## ⛔ Refused on a stage that is still armed
 *
 * An operator running this in the shell they armed the drain in still carries `E2E_DRAIN_ARMED`, and
 * on an armed stage the master is CORRECTLY down a rung. Red there would name the feature the drain
 * suites exist to prove and blame it, so `drainStillDeclared` skips instead and says which command
 * comes first. See `src/harness/batchDrain.ts` for the pair of gates and why they partition.
 *
 * ## What this asserts, and what stays an observation
 *
 * That the master offers exactly the rungs this broadcast's own announces name, joined by feed topic
 * rather than by resolution. Nothing about how long the master took to be written: the wait's
 * ceiling is the harness's patience, and the elapsed reading is printed under a heading that says it
 * is asserted nowhere. Owner ruling of 2026-08-29.
 *
 * ⛔ **The viewer half of decision 5 stays recorded rather than asserted, and it is not recorded
 * here.** That half is "a viewer who was watching keeps three", which is about a player that was
 * already mid-watch when the rung went and is a reading `suites/viewer/batch-drain-viewer.test.ts`
 * takes during the drain itself. This suite opens no browser and is deliberately cheap enough to run
 * at the end of every drain sitting.
 *
 * ⛔ Requires a deployed profile and funded stamps, like every suite under `suites/`. Nothing in CI
 * runs these.
 */

/**
 * How long the ladder gets to announce every rung, and then the master to name them.
 *
 * The same patience `abr-ladder` gives its own waits. A restored stage has no ramp to wait out,
 * unlike a drain: the master is rewritten on a segment boundary once the rungs are publishing, so
 * this covers the rungs coming up, one rewrite, and the feed write becoming readable through the
 * gateway. A ceiling on the harness, never a threshold on the product.
 */
const LADDER_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe(
  'service: the master offers every rung of the ladder',
  { skip: drainStillDeclared() || abrOff(cfg.abrEnabled) },
  () => {
    const host = makeHost(cfg);
    const uploader = containerName(cfg, 'stream-uploader');
    let publisher: Publisher;
    let startedAt: string;

    before(async () => {
      await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
      await waitForIdle(host, cfg);
      startedAt = await host.nowIso();
      publisher = startPublisher(cfg);
    });

    after(async () => {
      await publisher?.stop();
    });

    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    it('names every rung this broadcast announced, so a viewer joining now is offered the whole ladder', async () => {
      const expected = cfg.abrRungs.length;
      assert.ok(
        expected > 1,
        'ABR_LADDER names fewer than two rungs, so this asserts nothing: set it explicitly rather ' +
          'than leaving the engine to its default, which this suite cannot see',
      );

      // ⛔ The configured count first, so this does not pass by holding the master against a ladder
      // that came up short. Whether the rungs that announced are the rungs ABR_LADDER names is
      // `abr-ladder`'s own assertion and it says more about a shortfall than this could.
      await waitFor(async () => announcedRungsOf(await log()).size >= expected, {
        timeoutMs: LADDER_WAIT_MS,
        intervalMs: 3_000,
        label:
          `all ${expected} rungs announce before the master is read. A rung missing here is a rung ` +
          'the master is right not to offer, so pnpm e2e:abr-ladder is the suite that explains it',
      });

      const announced = announcedRungsOf(await log());
      const ladder = ladderGroupOf(await log());
      const { owner } = await discoverCatalogFeed(host, cfg);
      const expectedRungs = [...announced.values()];
      console.log(`  ladder ${ladder} announced ${expectedRungs.join(', ')}`);

      const waitedFromMs = Date.now();
      const master = await waitForMasterRungs(host, cfg, {
        owner,
        ladder,
        expected: expectedRungs,
        readTopics: async () => announcedRungsOf(await log()),
        timeoutMs: LADDER_WAIT_MS,
        label:
          `the master of ladder ${ladder} offers exactly ${expectedRungs.join(', ')}, every rung this ` +
          'broadcast announced. After a drain restore this is the reading that says the dropped rung ' +
          'is on offer again, which the uploader log cannot show: it says a rung published and ' +
          'nothing about what a joining viewer is handed',
      });
      const offeredAfterMs = Date.now() - waitedFromMs;

      // The wait already cleared this verdict on this body, so it can only fail if the body changed
      // underneath, which it cannot: the wait hands back the one it waited on rather than a re-read.
      const read = masterRungsOf(master, announcedRungsOf(await log()));
      console.log(`  ${describeMaster(read, master)}`);
      assert.equal(masterRungRefusal(read, expectedRungs), null, masterRungRefusal(read, expectedRungs) ?? '');

      console.log(
        `  observations, none of them asserted. the master named all ${expectedRungs.length} rungs ` +
          `${(offeredAfterMs / 1000).toFixed(1)}s after the last of them announced. The other half of ` +
          'decision 5, that a viewer who was watching keeps the rungs they had, is the drain viewer ' +
          "suite's reading and is not taken here",
      );
    });
  },
);

/** The reason a single-rendition deployment skips, or `false` to run. */
function abrOff(enabled: boolean): string | false {
  return enabled ? false : 'ABR_ENABLED is off on this deployment, so there is no ladder for a master to offer';
}

/**
 * Every rung this window announced, by its raw feed topic, which is how a master's variants are
 * joined to rung names.
 *
 * ⛔ By topic and never by resolution, for the reason `masterShape.ts` records: a master carries a
 * geometry and a `swarm://` address and no rung name anywhere, so matching on the geometry would put
 * a second copy of the ladder's name-to-height mapping here and would break on two rungs that share
 * a height.
 */
function announcedRungsOf(logText: string): ReadonlyMap<string, string> {
  const byTopic = new Map<string, string>();
  for (const announce of announcedRungs(logText)) {
    byTopic.set(announce.topic, announce.rung);
  }
  return byTopic;
}

/**
 * The one ladder group this window announced, or a refusal naming what it found instead.
 *
 * The group is also the master feed's topic, so it is the only thing needed to find the master. Two
 * groups in one window means a co-tenant broadcast on this deployment, and reading a stranger's
 * master would compare their ladder against this run's expectation.
 */
function ladderGroupOf(logText: string): string {
  const groups = [...new Set(announcedRungs(logText).map((announce) => announce.ladder))];
  if (groups.length !== 1) {
    throw new Error(
      `this window announced ${groups.length} ladder group(s) (${groups.join(', ') || 'none'}), so which ` +
        'master to read cannot be decided',
    );
  }
  return groups[0];
}
