import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  BUILD_STAMP_PATH,
  clientShapeRefusal,
  clientShapeSummary,
  type ClientTrees,
  parseClientBuildStamp,
  readClientShapeExpectation,
} from '../../src/clientShape.js';
import { loadConfig, ROOT_DIR } from '../../src/config.js';
import { makeHost } from '../../src/harness/host.js';

/**
 * Preflight, in one sentence: the client this stage serves must have been built from the client
 * sources this harness was checked out with, or every viewer scenario parses a client it does not
 * agree with.
 *
 * ⛔⛔⛔ **The gap this closes, and it has been open the whole time.**
 * `deploy/scripts/bench-on-host.sh` syncs this repo to the host on every run and runs the harness
 * from it. It does NOT rebuild the client image. So the harness can be current while the client a
 * viewer is served is weeks old, and until this gate nothing in the path noticed. The harness-side
 * version of the same staleness was found three days old under a sitting about to be paid for, and
 * the client-side version was found FIFTEEN days old under a browser sitting that had already run.
 *
 * `uploader-log-shape.test.ts` closed exactly this on the upload side, on 2026-09-01, at the cost of
 * a paid sitting. Read its docblock: the manifest log line gained a stream id, the harness was
 * synced and the uploader was not, and two scenarios reported a stage that was publishing manifests
 * throughout as never publishing any. The viewer side is the same shape, with more surface: the
 * browser harness parses the served client's console lines, the fetch backend it publishes on
 * `globalThis` and the weeb-3 worker it serves.
 *
 * ⚠️ **It compares what the client was BUILT FROM, not what survived the build.** A client bundle is
 * minified and tree-shaken, so grepping it for a symbol the way the uploader gate greps `dist` would
 * answer about the wrong thing. The image records `git rev-parse HEAD:packages/client` and the same
 * for `packages/shared`, and this reads it back. Content hashes rather than commits, so a rebuild
 * from an unchanged tree still matches.
 *
 * **Read through nginx rather than out of the container**, because what a viewer is actually served
 * is the thing under test. A stamp sitting in an image layer that the running container does not
 * serve would pass a check nobody could use.
 *
 * ⛔⛔ THE REFUSAL ONLY STOPS THE SPEND BECAUSE OF THE `&&` IN `test:e2e`. KEEP THEM TOGETHER. See
 * `spend-ceiling.test.ts`, which records why at length.
 *
 * The rule lives in `src/clientShape.ts` because nothing under `suites/` runs in CI. It is covered
 * by `test/clientShape.test.ts` and therefore by `pnpm verify`, leaving this file as the wiring, the
 * one impure read of git, and a failure message.
 */

/** Read at module scope: a throw inside `describe` prints `not ok` and still exits 0. */
const cfg = loadConfig();

/** Seconds allowed for one small file over loopback, past which the client is not answering. */
const STAMP_FETCH_TIMEOUT_S = 10;

/**
 * The trees this checkout holds, or null when it has no history to ask.
 *
 * ⛔ Null is the ordinary answer on the deployment host, not an error: `bench-on-host.sh` excludes
 * `.git` from its rsync, so a harness there cannot answer this for itself and the run script passes
 * the answer in instead. `existsSync` rather than a directory check because a git worktree carries
 * `.git` as a file pointing elsewhere, and a worktree has history like any other checkout.
 */
function readGitTrees(): ClientTrees | null {
  if (!existsSync(join(ROOT_DIR, '.git'))) {
    return null;
  }

  const git = (args: readonly string[]) => execFileSync('git', ['-C', ROOT_DIR, ...args], { encoding: 'utf8' }).trim();

  try {
    return {
      clientTree: git(['rev-parse', 'HEAD:packages/client']),
      sharedTree: git(['rev-parse', 'HEAD:packages/shared']),
      dirty:
        git([
          'status',
          '--porcelain',
          '--',
          'packages/client',
          'packages/shared',
          'deploy/Dockerfile.client',
          'deploy/client-nginx.conf.template',
        ]).length > 0,
    };
  } catch {
    return null;
  }
}

describe('preflight — the deployed client is built from the sources this harness reads', () => {
  const host = makeHost(cfg);

  it('serves a build stamp that matches this checkout', async () => {
    const expectation = readClientShapeExpectation(process.env, readGitTrees);

    // ⛔ Through `localText` rather than a hand-built loopback URL, because the container this runs
    // in does not always have the deployment on its own loopback. Under `--own-network` the client
    // is a hop away on the docker bridge and `Host.serviceAddress` is what knows that, from
    // `E2E_LOCAL_HOST_ADDRESS`. A shaped browser arm runs the whole preflight inside exactly that
    // container, so a hardcoded 127.0.0.1 here would have refused every one of them on an empty
    // loopback and blamed the client.
    //
    // `Host.curl` passes `-s` and `--max-time` and no `-f`, which is what this needs: a missing
    // stamp is a 200 carrying the app index rather than a 404, so the body is what decides, and
    // `clientShapeRefusal` reads an HTML page as no stamp.
    const stdout = await host.localText(cfg.ports.client, BUILD_STAMP_PATH, STAMP_FETCH_TIMEOUT_S);

    const refusal = clientShapeRefusal(expectation, stdout);
    assert.equal(refusal, null, String(refusal));

    assert.ok(expectation, 'a null expectation passed the refusal above, which cannot happen');
    console.log(`  ${clientShapeSummary(expectation, parseClientBuildStamp(stdout))}`);
  });
});
