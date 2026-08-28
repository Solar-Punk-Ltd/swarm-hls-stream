import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { srtIngestUrl } from '../../src/harness/engine.js';
import { discoverStamp, makeHost, uploaderHealth } from '../../src/harness/host.js';
import { redactPublishKey } from '../../src/harness/redactPublishKey.js';
import { effectiveLogLevel, logLevelProblem } from '../../src/logLevel.js';

const ONE_HOUR_S = 3600;

/**
 * Read-only smoke test: proves the harness can reach the deployed profile and discover its live
 * stamp. No fault injection, no deploy, no BZZ — safe to run anytime. Run: pnpm test:e2e:smoke
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

  it('discovers a usable stamp with TTL headroom', async () => {
    const stamp = await discoverStamp(host, cfg);
    assert.equal(stamp.usable, true);
    assert.ok(
      stamp.batchTTL > ONE_HOUR_S,
      `stamp TTL ${stamp.batchTTL}s is under 1h — top up before running a stream test`,
    );
    console.log(
      `  stamp ${stamp.batchID.slice(0, 12)}… TTL ${(stamp.batchTTL / ONE_HOUR_S).toFixed(1)}h util ${
        stamp.utilization
      }`,
    );
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
