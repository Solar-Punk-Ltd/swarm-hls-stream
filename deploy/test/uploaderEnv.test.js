import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = resolve(ROOT, 'packages/stream-uploader/src/utils/config.ts');
const COMPOSE = resolve(ROOT, 'deploy/docker-compose.yml');
const ENV_SAMPLE = resolve(ROOT, '.env.sample');

/**
 * That every knob the uploader reads can actually be set on a deployment.
 *
 * `deploy/docker-compose.yml` enumerates the uploader's environment rather than inheriting it, which
 * is deliberate and is the same SEC-28 reasoning the engine files carry: `env_file` would hand every
 * root variable to every container. The cost is that a variable absent from that block is one the
 * container never sees, so it silently keeps its compiled default however carefully an operator sets
 * it, and nothing anywhere reports a problem.
 *
 * `ORPHAN_REAP_MS` shipped that way. Its own JSDoc argues at length that it must be tunable
 * separately from `RECOVERY_TIMEOUT` and `SEGMENT_STALL_MS`, and it reached neither compose nor
 * `.env.sample`, so the argument was unreachable: every deployment kept 60000 whatever it asked for.
 * Every sibling from the same config block was already wired, which is what made it invisible.
 *
 * Derived from `config.ts` rather than from a hand-kept list, because a list is the thing that goes
 * stale here.
 */
describe('the uploader environment reaches the container', () => {
  /** Names read via the `optional*`/`required*` helpers, which is every knob the service has. */
  const knobs = [
    ...new Set(
      [...readFileSync(CONFIG, 'utf8').matchAll(/\b(?:optional|required)(?:Int|Bool)?\('([A-Z0-9_]+)'/g)].map(
        (m) => m[1],
      ),
    ),
  ];

  it('reads a plausible set of knobs from config.ts, so an empty match cannot pass silently', () => {
    assert.ok(knobs.length >= 10, `only found ${knobs.length} knobs, so the pattern has stopped matching config.ts`);
    assert.ok(knobs.includes('ORPHAN_REAP_MS'), 'the knob this test was written for is not being found');
  });

  /**
   * Pinned to a value the container must use rather than left to the environment. `STATE_DIR` is the
   * path a volume is mounted at, so an operator changing it would move the recovery store off the
   * mount and lose every stream across a restart. Listed rather than pattern-matched, so adding one
   * is a decision someone writes down.
   */
  const FIXED_IN_THE_IMAGE = new Set(['STATE_DIR']);

  it('passes every knob through docker-compose', () => {
    const compose = readFileSync(COMPOSE, 'utf8');

    for (const knob of knobs) {
      // Present at all, which is what decides whether the container can see it.
      assert.match(
        compose,
        new RegExp(`^\\s*${knob}:`, 'm'),
        `${knob} is read by the uploader and never passed to it, so setting it does nothing`,
      );

      if (FIXED_IN_THE_IMAGE.has(knob)) {
        continue;
      }
      // And interpolated from the same name, or it is passed as a constant nobody can change, which
      // is the same defect wearing a value.
      assert.match(
        compose,
        new RegExp(`^\\s*${knob}:\\s*\\$\\{${knob}`, 'm'),
        `${knob} is passed as a hard-coded value, so an operator setting it in .env is ignored`,
      );
    }
  });

  /**
   * Secrets are excluded because `.env.sample` is committed and a sample value for one of these
   * reads as a credential to paste rather than as a placeholder. They are in compose, which is what
   * decides whether the container can see them.
   */
  it('documents every non-secret knob in .env.sample', () => {
    const SECRETS = new Set(['API_AUTH_TOKEN', 'STREAM_KEY', 'STAMP']);
    const sample = readFileSync(ENV_SAMPLE, 'utf8');

    for (const knob of knobs.filter((name) => !SECRETS.has(name))) {
      assert.match(
        sample,
        new RegExp(`^${knob}=`, 'm'),
        `${knob} can be set but is not in .env.sample, so an operator has no way to learn it exists`,
      );
    }
  });
});
