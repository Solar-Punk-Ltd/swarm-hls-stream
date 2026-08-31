import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { makeHost, uploaderHealth } from '../../src/harness/host.js';
import { describeRouting, publisherRoutingRefusal } from '../../src/publisherRouting.js';

/**
 * Preflight — the stage publishes each rung through the Bee node its configuration says it does.
 *
 * ⛔⛔⛔ **What this is here to stop, and it already happened.** Every rung of the ladder was published
 * through one shared Bee node for the whole life of the project up to 2026-08-31. The stage
 * transcoded four renditions, four feeds advanced, four playlists were written, and the difference
 * from a properly split stage sat upstream of everything anyone measured. A note recording that the
 * split had never happened was read as a caveat on the numbers rather than as the reason the numbers
 * were wrong, and eleven live arms were scored against viewer behaviour while the shared publisher
 * was the constraint. That is the whole failure: not a bug, a precondition nobody could see.
 *
 * So this refuses. A threshold you write down is not a control, and neither is a note in a memory
 * file. The deployment declares a shape in BEE_PUBLISHERS, the uploader reports the shape it is
 * running on `/health`, and the sitting does not start unless the two agree.
 *
 * Costs nothing: two reads, no broadcast, no stamp. It sorts ahead of the chequebook preflight, whose
 * per-node readings come off the same routing, so a stage that cannot say what it is running stops
 * before anything is asked of the nodes at all.
 *
 * **It never skips.** A preflight that can skip has the defect it was written to catch: an unsplit
 * deployment is the case it most needs to report, and reporting it as "not applicable" is how the
 * original miss survived for weeks.
 *
 * The verdict lives in `src/publisherRouting.ts` because nothing under `suites/` runs in CI. Its rules
 * are covered by `test/publisherRouting.test.ts` and therefore by `pnpm verify`, leaving this file as
 * wiring and a failure message.
 */
const cfg = loadConfig();

describe('preflight — each rung publishes through the node it is configured to', () => {
  const host = makeHost(cfg);

  it('runs the publisher routing its own env declares', async () => {
    const health = await uploaderHealth(host, cfg);

    const declared = cfg.declaredPublishers.trim() === '' ? 'none (one node for every rung)' : cfg.declaredPublishers;
    console.log(`  BEE_PUBLISHERS declares: ${declared}`);
    console.log(`  uploader is running: ${health.publishers ? describeRouting(health.publishers) : 'not reported'}`);

    const refusal = publisherRoutingRefusal({
      declared: cfg.declaredPublishers,
      abrEnabled: cfg.abrEnabled,
      abrRungs: cfg.abrRungs,
      live: health.publishers,
    });

    assert.equal(refusal, null, refusal ?? '');
  });
});
