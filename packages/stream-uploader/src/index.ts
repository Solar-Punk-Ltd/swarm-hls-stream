import { PrivateKey } from '@ethersphere/bee-js';
import path from 'path';

// Side-effect import, and it must stay ahead of every other local import. `utils/env.js` runs
// `dotenv.config()` at module scope, and anything that reads `process.env` while being imported gets
// whatever the real environment held before the `.env` file was applied. `Logger` did exactly that,
// through `utils/common.js`, so `LOG_LEVEL` in the root `.env` was read too late and ignored, with
// no way for an operator to tell. `simple-import-sort` places side-effect imports ahead of the
// relative groups, so the ordering this depends on is the one the linter already enforces, and
// `test/envLoadOrder.test.ts` fails if it stops holding.
import './utils/env.js';

import { startApiServer } from './api/server.js';
import { loadEngines } from './engines/load.js';
import { BeePublisherPool, safeUrl } from './libs/BeePublisherPool.js';
import { CatalogIndexStore } from './libs/CatalogIndexStore.js';
import { bzzToPlur, ChequebookGate } from './libs/ChequebookGate.js';
import { PostageGate } from './libs/PostageGate.js';

/** The gate's floor is configured in hours, because that is the unit an operator tops a batch up in. */
const SECONDS_PER_HOUR = 3_600;
import { LadderGroupStore } from './libs/LadderGroupStore.js';
import { Logger } from './libs/Logger.js';
import { MasterFeedWriter } from './libs/MasterFeedWriter.js';
import { assertNodeReachable, waitForNode } from './libs/NodeWait.js';
import { registerCrashHandlers, registerShutdownSignals } from './libs/processSignals.js';
import { RecoveryStore } from './libs/RecoveryStore.js';
import { ServiceLifecycle } from './libs/ServiceLifecycle.js';
import { runStartGates } from './libs/StartGates.js';
import { StreamCatalog } from './libs/StreamCatalog.js';
import { StreamOrchestrator } from './libs/StreamOrchestrator.js';
import { config } from './utils/config.js';
import { NodeWaitReport } from './types.js';

const logger = Logger.getInstance();
const lifecycle = new ServiceLifecycle((code) => process.exit(code), logger);

registerShutdownSignals(lifecycle);
registerCrashHandlers(logger);

/**
 * Which Bee nodes this stage publishes through.
 *
 * BEE_PUBLISHERS unset is the single-node deployment: one node, one batch, everything through it.
 * Set, it is one node per rung, and every rung of ABR_LADDER must appear — which only means
 * anything with a ladder to map onto, hence the refusal below rather than silently ignoring it.
 */
function buildPublishers(requestTimeoutMs: number): BeePublisherPool {
  if (config.publishers.length === 0) {
    return BeePublisherPool.single(config.beeUrl, config.stamp, requestTimeoutMs);
  }

  if (!config.abr) {
    throw new Error('BEE_PUBLISHERS is set but ABR_ENABLED is false — per-rung publishers have no ladder to map onto');
  }

  return BeePublisherPool.perRung(
    config.publishers,
    config.abr.ladder.rungs().map((rung) => rung.name),
    requestTimeoutMs,
  );
}

async function start() {
  try {
    const publishers = buildPublishers(config.beeRequestTimeoutMs);

    // The gates read the same nodes through their own clients, because a chequebook balance and a
    // postage batch are answered off the chain and neither read has a retry around it. The upload
    // loop's per-request deadline is derived from retry windows that do not apply to either, and
    // lending it to them is what held a live uploader in a restart loop on 2026-09-16.
    const gateNodes = buildPublishers(config.startGateTimeoutMs).nodes();

    const recoveryStore = new RecoveryStore(config.stateDir);

    // In a subdirectory so RecoveryStore's *.json scan of stateDir never picks it up as a stream.
    const catalogIndexStore = new CatalogIndexStore(path.join(config.stateDir, 'catalog', 'feed-index.json'));

    // Only with the ladder on. A single-rendition stream has nothing to be multivariant about, and
    // publishing a one-entry master for it would buy a second feed and no choice.
    const masterWriter = config.abr ? new MasterFeedWriter(publishers, new PrivateKey(config.streamKey)) : undefined;

    // Also ladder-only, and in a subdirectory for the same reason the catalog index is: RecoveryStore
    // scans stateDir for `*.json` and would otherwise offer this file up as a stream to recover.
    const ladderGroupStore = config.abr
      ? new LadderGroupStore(path.join(config.stateDir, 'ladder', 'groups.json'))
      : undefined;

    const streamCatalog = new StreamCatalog(
      publishers,
      config.streamKey,
      config.streamListTopic,
      catalogIndexStore,
      masterWriter,
    );

    const streamOrchestrator = new StreamOrchestrator(publishers, streamCatalog, recoveryStore, {
      streamKey: config.streamKey,
      maxQueueSize: config.maxQueueSize,
      recoveryTimeout: config.recoveryTimeout,
      orphanReapMs: config.orphanReapMs,
      segmentStallMs: config.segmentStallMs,
      fragmentSeconds: config.fragmentSeconds,
      segmentDedupWindow: config.segmentDedupWindow,
      segmentRedundancy: config.segmentRedundancy,
      ladder: config.abr?.ladder,
      ladderGroupStore,
    });

    lifecycle.trackOrchestrator(streamOrchestrator);

    const engines = loadEngines(config.engine);

    // ⛔ Stripped once, here, because a node url may carry basic auth in its userinfo and everything
    // built from this reaches `/health`, which takes no credential of its own. `waitForNode` strips
    // what it publishes too, so neither path depends on the other having remembered.
    const coordinatorUrl = safeUrl(publishers.coordinator().url);

    // Waiting from the first second rather than from the first failed read. The API below listens
    // before anything touches a node, so a probe arriving in between has to be told the boot is not
    // finished. `waitForNode` replaces this with its own report as soon as it starts.
    let nodeWait: NodeWaitReport | null = {
      url: coordinatorUrl,
      waitingSince: new Date().toISOString(),
      attempts: 0,
    };

    // ⛔ Ahead of every node-dependent step, which is the whole of D16. Everything above is local:
    // config, disk and object construction, none of it asks a node anything. Everything below needs
    // one, and it used to run first, so a node that was not answering meant no listener at all, a
    // container that exited, and a deploy refused on a restart count that was climbing for a reason
    // nothing about this service could fix. See `libs/NodeWait.ts` and `refuseWhileWaiting`.
    const apiServer = startApiServer(streamOrchestrator, config.apiPort, {
      authToken: config.apiAuthToken,
      engines,
      waitingForNode: () => nodeWait,
    });
    lifecycle.trackApiServer(apiServer);

    // The two gates read what is silent when it is wrong. A dry chequebook answers /health in a
    // millisecond while every paid push behind it stalls, and a full or expired batch fails every
    // upload while the node answers and the config reads correctly. BeePublisherPool already rejects
    // a batch id that is malformed or does not cover the ladder, and PostageGate is the half that
    // asks whether the batch it names can still carry anything.
    //
    // Since 2026-09-17 a gate that cannot clear its node warns and the uploader starts anyway, on
    // the owner's ruling. UPLOADER_START_GATES=refuse restores the refusal. See StartGates for what
    // that cost and why the reading still happens on every boot.
    const recoveredStreamIds = await waitForNode(
      async () => {
        // ⛔ The cheapest question, before anything has to interpret an answer. A node that is not
        // there costs each gate its whole budget and then arrives as a sentence, and it reaches
        // `StreamCatalog.init` as a status that has to be told apart from an empty feed. See
        // `assertNodeReachable`.
        await assertNodeReachable(publishers.coordinator());

        await runStartGates(
          [
            {
              name: 'ChequebookGate',
              run: (collect) =>
                new ChequebookGate(gateNodes, bzzToPlur(config.chequebookMinBzz), logger).assertFunded(collect),
            },
            {
              name: 'PostageGate',
              run: (collect) =>
                new PostageGate(
                  gateNodes,
                  config.stampMinTtlHours * SECONDS_PER_HOUR,
                  config.stampMaxUtilization,
                  logger,
                ).assertUsable(collect),
            },
          ],
          config.startGateMode,
          logger,
          (warnings) => streamOrchestrator.recordStartGateWarnings(warnings),
        );

        await streamCatalog.init();
        return streamOrchestrator.recoverStreams();
      },
      {
        url: coordinatorUrl,
        logger,
        onReport: (report) => {
          nodeWait = report;
        },
      },
    );

    // Only now, so nothing reaches an orchestrator whose catalog has never been read.
    nodeWait = null;

    // An engine that pulls segments itself must re-attach its fetch loop to recovered streams.
    // Otherwise the recovered stream produces no segments and is finalized as VOD at the timeout.
    for (const streamId of recoveredStreamIds) {
      for (const engine of engines) {
        engine.resumeRecoveredStream?.(streamOrchestrator, streamId);
      }
    }

    logger.info('Stream uploader started, waiting for engine connections');
  } catch (error) {
    logger.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
