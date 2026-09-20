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
import { AdminApiClient } from './libs/AdminApiClient.js';
import { AdminLadderRegistry } from './libs/AdminLadderRegistry.js';
import { BeePublisherPool, safeUrl } from './libs/BeePublisherPool.js';
import { CatalogIndexStore } from './libs/CatalogIndexStore.js';
import { bzzToPlur, ChequebookGate } from './libs/ChequebookGate.js';
import { LadderGroupStore } from './libs/LadderGroupStore.js';
import { LadderRegistry } from './libs/LadderRegistry.js';
import { Logger } from './libs/Logger.js';
import { ManagedMediaStore } from './libs/ManagedMediaStore.js';
import { ManagedRunStore } from './libs/ManagedRunStore.js';
import { MasterFeedWriter } from './libs/MasterFeedWriter.js';
import { assertNodeReachable, waitForNode } from './libs/NodeWait.js';
import { PostageGate } from './libs/PostageGate.js';
import { registerCrashHandlers, registerShutdownSignals } from './libs/processSignals.js';
import { RecoveryStore } from './libs/RecoveryStore.js';
import { ServiceLifecycle } from './libs/ServiceLifecycle.js';
import { runStartGates } from './libs/StartGates.js';
import { StreamCatalog } from './libs/StreamCatalog.js';
import { StreamOrchestrator } from './libs/StreamOrchestrator.js';
import { config } from './utils/config.js';
import { sameFeedOwner } from './utils/feedOwner.js';
import { NodeWaitReport } from './types.js';

/** The gate's floor is configured in hours, because that is the unit an operator tops a batch up in. */
const SECONDS_PER_HOUR = 3_600;

const logger = Logger.getInstance();
const lifecycle = new ServiceLifecycle((code) => process.exit(code), logger);

registerShutdownSignals(lifecycle);
registerCrashHandlers(logger);

/**
 * Which Bee nodes this stage publishes through.
 *
 * BEE_PUBLISHERS unset is the single-node deployment: one node, one batch, everything through it.
 * Set, it is one node per rung, and every rung of ABR_LADDER must appear, which only means
 * anything with a ladder to map onto, hence the refusal below rather than silently ignoring it.
 */
function buildPublishers(requestTimeoutMs: number): BeePublisherPool {
  if (config.publishers.length === 0) {
    return BeePublisherPool.single(config.beeUrl, config.stamp, requestTimeoutMs);
  }

  if (!config.abr) {
    throw new Error('BEE_PUBLISHERS is set but ABR_ENABLED is false. Per-rung publishers have no ladder to map onto');
  }

  return BeePublisherPool.perRung(
    config.publishers,
    config.abr.ladder.rungs().map((rung) => rung.name),
    requestTimeoutMs,
  );
}

/**
 * The admin service this uploader answers to, or undefined for the standalone deployment.
 *
 * Constructed once and shared, deliberately. The engines' publish gate resolves declarations through
 * it and each uploader reports state through it, and those two pointed at different admins is a
 * deployment where a broadcast is admitted by one service and reported to another. See
 * {@link AdminApiClient}.
 */
function buildAdminApi(): AdminApiClient | undefined {
  if (!config.admin) {
    logger.info('[Admin] ADMIN_API_URL is not set, running standalone: the stream catalog on Swarm is ours to write');
    return undefined;
  }

  logger.info(
    `[Admin] Admin mode against ${config.admin.apiUrl}: streams are declared there, publishes are resolved ` +
      'and authenticated against those declarations, and this service writes no stream catalog entries',
  );
  return new AdminApiClient({
    baseUrl: config.admin.apiUrl,
    token: config.admin.apiToken,
    lifecycleVersion: config.srsLifecycle?.version,
  });
}

/**
 * Refuse to come up as an admin-mode uploader whose feeds the admin's catalog can never point at.
 *
 * The admin's entry names `owner/topic` and every feed this service writes at that topic is signed
 * with `STREAM_KEY`, so the admin's `FEED_PRIVATE_KEY` and `STREAM_KEY` have to derive one address.
 * Nothing else enforces it: with the two apart every report answers 200 and every viewer resolves a
 * feed nobody wrote. Asked once here, off the admin's public config, and again per declaration in
 * the publish gate. An admin that cannot be reached yet is a warning rather than a refusal, because
 * that is a deploy ordering and the gate covers it.
 */
async function assertAdminSignsAsThisService(adminApi: AdminApiClient, signerOwner: string): Promise<void> {
  const feedOwner = await adminApi.fetchFeedOwner();
  if (feedOwner === null) {
    logger.warn(
      `[Admin] Could not confirm that ${adminApi.describe()} signs its catalog as ${signerOwner}. Every declaration ` +
        'is checked against it at publish time instead',
    );
    return;
  }
  if (!sameFeedOwner(feedOwner, signerOwner)) {
    throw new Error(
      `${adminApi.describe()} signs its catalog as ${feedOwner} and this service signs its feeds as ${signerOwner}. ` +
        "STREAM_KEY and the admin's FEED_PRIVATE_KEY have to derive one address, or the admin's catalog entries " +
        'point viewers at feeds nobody writes. Fix one of the two and restart.',
    );
  }
  logger.info(`[Admin] ${adminApi.describe()} signs its catalog as ${feedOwner}, the same owner as this service`);
}

async function start() {
  try {
    const publishers = buildPublishers(config.beeRequestTimeoutMs);
    const adminApi = buildAdminApi();
    const signerOwner = new PrivateKey(config.streamKey).publicKey().address().toHex();
    if (adminApi) {
      await assertAdminSignsAsThisService(adminApi, signerOwner);
    }

    // The gates read the same nodes through their own clients, because a chequebook balance and a
    // postage batch are answered off the chain and neither read has a retry around it. The upload
    // loop's per-request deadline is derived from retry windows that do not apply to either, and
    // lending it to them is what held a live uploader in a restart loop on 2026-09-16.
    //
    // ⛔ The reachability probe reads through this pool too, and that is the point of keeping it
    // rather than only its nodes. Probing through the pool above would give a node four seconds to
    // answer a liveness check while the gates behind it wait twenty, so a node that is merely slow
    // would be waited for forever by a boot whose gates could have cleared it.
    const gatePublishers = buildPublishers(config.startGateTimeoutMs);
    const gateNodes = gatePublishers.nodes();

    const recoveryStore = new RecoveryStore(config.stateDir);
    const managedRunStore = config.srsLifecycle
      ? new ManagedRunStore(path.join(config.stateDir, 'managed-runs'))
      : undefined;
    const managedMediaStore = config.srsLifecycle
      ? new ManagedMediaStore(path.join(config.stateDir, 'managed-media'))
      : undefined;

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
      // ⛔ Withheld in admin mode, where this catalog writes nothing at all: the master belongs to the
      // ladder registry below, and a catalog holding a writer it must never reach is a catalog a
      // later change can make write one. Nothing would call it today. The wiring says so anyway.
      config.admin ? undefined : masterWriter,
    );

    // Where a ladder rung's rendition record goes. Standalone, the catalog: it merges four rungs into
    // one entry on the stream list feed and writes the master from it. In admin mode the merge moves
    // into the admin. The declared topic becomes the master feed's topic, each rung reports its own
    // record, and the admin writes `renditions` into the catalog entry it already owns. See
    // `libs/AdminLadderRegistry.ts` and the "Admin mode" section of the package README.
    const ladderRegistry: LadderRegistry =
      adminApi && masterWriter ? new AdminLadderRegistry({ client: adminApi, masterWriter }) : streamCatalog;
    if (adminApi && masterWriter) {
      logger.info(
        '[Admin] ABR ladder in admin mode: the declared topic is the ladder master feed, each rung publishes ' +
          'to a topic derived from the group and its rung name, and the ladder the master is written from is ' +
          'the one the admin merges',
      );
    }

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
      adminApi,
      ladderRegistry,
      managedSourceReconnectMs: config.srsLifecycle ? 60_000 : undefined,
      managedRunStore,
      managedMediaStore,
    });

    lifecycle.trackOrchestrator(streamOrchestrator);

    const engines = loadEngines(config.engine, {
      adminApi,
      signerOwner,
      managedLifecycle: config.srsLifecycle ? { uploaderId: config.srsLifecycle.uploaderId } : undefined,
    });

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

    // ⛔ Ahead of every Bee-dependent step, which is the whole of D16. The admin owner check above
    // contacts the admin service, but nothing above asks a Bee node anything. The Bee reads below
    // used to run first, so a node that was not answering meant no listener at all, a
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
    // Since 2026-09-17 the chequebook gate warns and the uploader starts whatever it found, on the
    // owner's ruling. The postage gate still stops the boot on a batch the node answered about,
    // absent, unusable, expired or full, and warns only on one it could not read, which is decision
    // 7 b of the same day. UPLOADER_START_GATES=refuse makes both gates refuse both readings. See
    // StartGates for what that cost and why the reading still happens on every boot.
    const recoveredStreamIds = await waitForNode(
      async () => {
        // ⛔ The cheapest question, before anything has to interpret an answer. A node that is not
        // there costs each gate its whole budget and then arrives as a sentence, and it reaches
        // `StreamCatalog.init` as a status that has to be told apart from an empty feed. See
        // `assertNodeReachable`.
        await assertNodeReachable(gatePublishers.coordinator());

        await runStartGates(
          [
            {
              name: 'ChequebookGate',
              refuses: config.startGates.chequebookRefuses,
              run: (collect) =>
                new ChequebookGate(gateNodes, bzzToPlur(config.chequebookMinBzz), logger).assertFunded(collect),
            },
            {
              name: 'PostageGate',
              refuses: config.startGates.postageRefuses,
              run: (collect) =>
                new PostageGate(
                  gateNodes,
                  config.stampMinTtlHours * SECONDS_PER_HOUR,
                  config.stampMaxUtilization,
                  logger,
                ).assertUsable(collect),
            },
          ],
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
