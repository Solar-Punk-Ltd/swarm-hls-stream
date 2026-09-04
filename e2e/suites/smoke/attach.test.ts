import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { srtIngestUrl } from '../../src/harness/engine.js';
import { makeHost, uploaderHealth } from '../../src/harness/host.js';
import { redactPublishKey } from '../../src/harness/redactPublishKey.js';
import { readStageStamps, stageStampsRefusal } from '../../src/harness/stageStamps.js';
import { effectiveLogLevel, logLevelProblem } from '../../src/logLevel.js';

const ONE_HOUR_S = 3600;

/**
 * Read-only smoke test: proves the harness can reach the deployed profile and discover a live stamp
 * on every node it publishes through. No fault injection, no deploy, no BZZ, safe to run anytime.
 * Run: pnpm test:e2e:smoke
 */
const cfg = loadConfig();

describe('attach smoke (read-only)', () => {
  const host = makeHost(cfg);

  it('reaches the host over ssh', async () => {
    const { stdout } = await host.run('echo e2e-ok');
    assert.equal(stdout.trim(), 'e2e-ok');
  });

  it('finds the stream-uploader healthy', async () => {
    const health = await uploaderHealth(host, cfg);
    assert.equal(health.status, 'ok');
    assert.ok(Array.isArray(health.engines), 'engines should be a list');
    console.log(`  uploader: ${JSON.stringify(health)}`);
  });

  /**
   * ⛔ Every publisher node, never the coordinator alone. Each rung publishes through its own Bee node
   * holding its own postage batch, so an expired batch on the 1080p node is invisible to a read of the
   * coordinator and turns up mid-broadcast as a rung that stopped being produced.
   *
   * ⛔ And on each node the batch `BEE_PUBLISHERS` routes that rung to, never the healthiest one the
   * node happens to hold. A node holding a drained configured batch beside a fresh unused one used to
   * print and pass on the fresh one while refusing every upload the rung made.
   *
   * This one prints, which `requireStageStamps` deliberately does not. It is the read-only run an
   * operator makes first and its whole job is to report what is out there.
   *
   * ⭐ The fill is printed beside the TTL and NOTHING here refuses on it. A batch at 90% with a year
   * of TTL clears this case and is about to be refused by `deploy/scripts/stamp-guard.sh` and by the
   * uploader's own `PostageGate`, which are where the stop line lives. Printing it is what turns that
   * into something an operator sees on the run they make first rather than mid-sitting.
   */
  it('finds every publisher node holding the batch it is configured with, with TTL headroom', async () => {
    const readings = await readStageStamps(host, cfg);

    console.log(`  ${readings.length} publisher node(s):`);
    for (const reading of readings) {
      const headroom = reading.ttlS === null ? 'no TTL read' : `TTL ${(reading.ttlS / ONE_HOUR_S).toFixed(1)}h`;
      const fill = reading.utilizationPct === null ? 'fill unknown' : `${reading.utilizationPct.toFixed(0)}% full`;
      console.log(
        `  | ${reading.rungs.join(', ')} :${reading.port} configured batch ${reading.batch} ` +
          `${reading.state} ${headroom} ${fill}` +
          (reading.problem === null ? '' : ` (${reading.problem})`),
      );
    }

    const refusal = stageStampsRefusal(readings, ONE_HOUR_S);
    assert.equal(refusal, null, refusal ?? '');
  });

  /**
   * The URL is printed redacted and only printed redacted. On a deployment with SEC-28 on it carries
   * the live publish credential, and this line put one into a transcript on 2026-08-28. What is
   * published with is still the real URL, which the publisher builds for itself.
   */
  it('resolves the uploader container + prints the ingest URL', async () => {
    const container = containerName(cfg, 'stream-uploader');
    assert.ok(await host.isRunning(container), `${container} should be running`);
    console.log(`  ingest: ${redactPublishKey(srtIngestUrl(cfg))}`);
    console.log(`  config: profile=${cfg.profile} slot=${cfg.portSlot} engine=${cfg.engine}`);
    console.log(`  env:    ${cfg.envFiles.join(', ')}`);
  });

  /**
   * Every upload-side assertion in the suite is parsed out of the uploader's log, so a deployment
   * running quieter than `debug` cannot be measured — and does not say so. At `info`, which
   * `.env.sample` recommends to drop the per-segment line, the segment counter never moves and each
   * scenario spends its full timeout before failing with a label that blames the publisher. Checked
   * here because this is the read-only run an operator makes first.
   */
  it('runs at a log level the suite can actually read', async () => {
    const env = await host.containerEnv(containerName(cfg, 'stream-uploader'));
    const level = effectiveLogLevel(env.LOG_LEVEL);
    const problem = logLevelProblem(level);

    console.log(`  logging: LOG_LEVEL=${env.LOG_LEVEL ?? '<unset, so debug>'} LOG_FORMAT=${env.LOG_FORMAT || 'text'}`);
    assert.equal(problem, null, problem ?? '');
  });
});
