import {
  addingStreamToList,
  catalogStateLost,
  finalizeResumed,
  ladderFinalized,
  manifestUploaded,
  omeSegmentLossReported,
  originDeclaredDiscontinuity,
  publishingRendition,
  replacedSessionFinalized,
  rungAnnounced,
  segmentsNeverArrived,
  segmentUploaded,
  segmentUploadFailed,
  streamStopped,
  updatingStreamToVod,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import {
  deployedLogShapeRefusal,
  deployedLogShapeSummary,
  type DeployedMessage,
  deployedMessage,
} from '../../src/deployedLogShape.js';
import { makeHost } from '../../src/harness/host.js';

/**
 * Preflight, in one sentence: the uploader deployed on this stage must write the log lines this
 * harness reads its answers out of, or every upload-side scenario measures a silence.
 *
 * ⛔⛔⛔ **The failure this exists for, walked into on 2026-09-01 at the cost of a paid sitting.**
 * `Manifest uploaded at SOC index N` gained a stream id that morning, because on a four rung ladder
 * the four SOC counters were indistinguishable. `bench-on-host.sh` syncs this repo to the host and
 * runs the harness from it. It does NOT redeploy the uploader, which ships as a prebuilt `dist/`.
 * So the harness looked for the new line, the deployment wrote the old one, and `bee-outage-long`
 * and `service/happy-path` both went red for "manifest publishes never resumed" against a stage that
 * was publishing manifests the entire time. Two false reds, both reading as product faults.
 *
 * `logLevel.ts` already guards the sibling precondition, that the deployment's `LOG_LEVEL` admits
 * these lines at all. It guards the LEVEL. Nothing guarded the SHAPE.
 *
 * ⚠️ **It reads the container's built code, not a log.** A preflight runs before anything publishes,
 * so there is no recent window holding these lines to sample, and an idle stage would look identical
 * to a stale one. The composed messages' fixed halves survive bundling as literals, so grepping
 * `dist` answers the question with no broadcast, no stamp and no BZZ. It proves the deployment CAN
 * write the line rather than that it did, which is the right question: a scenario waiting for a line
 * already knows how to fail when it never comes, and cannot survive one arriving unreadable.
 *
 * ⛔⛔ THE REFUSAL ONLY STOPS THE SPEND BECAUSE OF THE `&&` IN `test:e2e`. KEEP THEM TOGETHER. See
 * `spend-ceiling.test.ts`, which records why at length.
 *
 * The rule lives in `src/deployedLogShape.ts` because nothing under `suites/` runs in CI. It is
 * covered by `test/deployedLogShape.test.ts` and therefore by `pnpm verify`, leaving this file as
 * the list of messages, the wiring and a failure message.
 */

/** Read at module scope: a throw inside `describe` prints `not ok` and still exits 0. */
const cfg = loadConfig();

/**
 * The lines the harness parses whose wording is a contract with the deployment.
 *
 * Composed through `packages/shared/src/uploaderLog.ts` rather than written out, so this list cannot
 * drift from the producer the way a copied string would. A line the harness reads that is NOT here
 * is a line a stale deployment can still break silently.
 *
 * ⚠️ Two entries refuse a deployment built before the messages moved into the contract, even though
 * the words never changed. The catalog line used to be assembled from two string literals joined by
 * a `+`, so the fragment spanning the join was in no built file, and the OME line lived under
 * `dist/engines/`, which this gate does not read. Both now compose in the shared module the gate
 * does read. One redeploy answers it, which is what the refusal already asks for.
 */
const PARSED_MESSAGES: readonly DeployedMessage[] = [
  deployedMessage(
    'manifest publishes',
    (stream, index) => manifestUploaded(stream, index),
    'service/happy-path and the freeze regression guard in bee-outage-long',
  ),
  deployedMessage(
    'per-segment uploads',
    // ⚠️ Every substituted value takes the placeholder, including the ones this line does not vary
    // on. Passing a real-looking string instead bakes it into the fixed half, and the gate then
    // demands the deployment contain the word "reference".
    (stream, index) => segmentUploaded(stream, index, stream),
    'every scenario that counts segments or checks they are gapless',
  ),
  deployedMessage(
    'rung announces',
    (stream) => publishingRendition(stream, stream),
    'the ABR ladder suite, which reads how many rungs actually published',
  ),
  deployedMessage(
    'session topics',
    (stream) => rungAnnounced(stream, stream, stream, stream),
    'every ladder scenario, which scopes its assertions to the topics announced in its own window',
  ),
  deployedMessage(
    'catalog announces',
    (stream) => addingStreamToList(stream),
    'the broadcast identification every upload-side scenario does on a single-rendition deployment, ' +
      'and the feed location the bench resolves before it reads a single segment',
  ),
  deployedMessage(
    'single-rendition VOD flips',
    (stream) => updatingStreamToVod(stream),
    'the recording-finalized wait in publish-stop-to-vod, finalize-crash, whole-stack-restart, ' +
      'reconnect-during-drain, recovery-entry-corrupt, vod-playback and broadcast-ended, on a ' +
      'single-rendition deployment',
  ),
  deployedMessage(
    'ladder VOD flips',
    (stream) => ladderFinalized(stream),
    'the same recording-finalized wait in those seven scenarios on a ladder deployment, where no ' +
      'rung flips its own entry and the group flip is the only evidence a broadcast ended',
  ),
  deployedMessage(
    'session ends',
    (stream) => streamStopped(stream),
    "reconnect-during-drain's ladder path, which waits for every outgoing rung's session to end",
  ),
  deployedMessage(
    'replaced session ends',
    (stream) => replacedSessionFinalized(stream),
    'the same wait, for a rung whose drain lost the race to its own reconnect, which is the half of ' +
      'that scenario nothing else can observe',
  ),
  // ⛔ The four below are one counter, `discontinuitiesArmed`. Six suites assert it is zero on a
  // clean run, so a line nothing matches does not fail them, it passes them for ever on a stage
  // arming discontinuities all night. A vacuous green is the worst thing this gate can be asked to
  // prevent, which is why each of the four is listed rather than the family.
  deployedMessage(
    'discontinuities armed by a spent retry window',
    (stream, index) => segmentUploadFailed(stream, index),
    'the zero-arm assertions in happy-path, abr-ladder, bee-outage-short, gateway-outage-viewer, ' +
      'multi-stream-concurrent and crash-writer-bee-pause, which turn vacuously green rather than ' +
      'red, the armed-count assertion in bee-outage-long, which fails red, and the segment indices ' +
      'every one of them prints when it fails',
  ),
  deployedMessage(
    'discontinuities armed by segments that never arrived',
    (stream) => segmentsNeverArrived(stream, stream),
    'the same seven assertions, for the path an engine that could not download from the origin takes',
  ),
  deployedMessage(
    'discontinuities the origin declared',
    (stream) => originDeclaredDiscontinuity(stream),
    'the same seven assertions, for the one path that leaves the segment run gapless, so nothing else ' +
      'in the suite can see it at all',
  ),
  deployedMessage(
    'discontinuities the OME puller reported',
    (stream) => omeSegmentLossReported(stream, stream, stream),
    "the same seven assertions on an OME deployment, where this line is written beside the uploader's " +
      'own and both have always counted, so losing it changes a count as well as blinding a check',
  ),
  deployedMessage(
    'the catalog giving up on its own previous state',
    (stream, index) => catalogStateLost(stream, index),
    "finalize-crash's discriminator, which is the only thing separating a genuine second finalize " +
      'from a first one the catalog guard was blind to',
  ),
  deployedMessage(
    'a finalize resuming rather than republishing after a crash',
    (stream, index) => finalizeResumed(stream, index),
    "resumedFinalizeCount, which reports whether finalize-crash's kill landed inside the window it " +
      'aims at and was answered there. A deployment that cannot write this line still passes the ' +
      'scenario, and passes it without anyone being able to say the window was ever exercised',
  ),
];

describe('preflight — the deployed uploader writes the lines this harness reads', () => {
  const host = makeHost(cfg);

  it('is built from a checkout that agrees with this one about the messages', async () => {
    const container = containerName(cfg, 'stream-uploader');
    // The bundled contract module itself, which is where every composed message's literal halves
    // end up, plus the uploader's own libs for anything still written inline.
    const { stdout } = await host.run(
      `docker exec ${container} sh -c ` +
        `'cat dist/node_modules/@swarm-hls-stream/shared/uploaderLog.js dist/libs/*.js 2>/dev/null'`,
    );

    assert.ok(
      stdout.length > 0,
      `read no built code out of ${container}. This gate cannot tell a stale deployment from an ` +
        'unreadable one, so it refuses rather than passing: check the container is up and that the ' +
        'uploader still ships a prebuilt dist/.',
    );

    const refusal = deployedLogShapeRefusal(PARSED_MESSAGES, stdout);
    assert.equal(refusal, null, String(refusal));
    console.log(`  ${deployedLogShapeSummary(PARSED_MESSAGES)}`);
  });
});
