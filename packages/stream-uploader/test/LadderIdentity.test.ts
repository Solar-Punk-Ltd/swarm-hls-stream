import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { AdminApiClient } from '../src/libs/AdminApiClient.js';
import { LadderGroupStore, RememberedLadder } from '../src/libs/LadderGroupStore.js';
import { LadderRegistry } from '../src/libs/LadderRegistry.js';
import { Logger } from '../src/libs/Logger.js';
import { RecoveryStore } from '../src/libs/RecoveryStore.js';
import { buildLadderEntry, LadderIdentity, StreamEntry } from '../src/libs/StreamCatalog.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, Rendition, StreamState } from '../src/types.js';

import { makeFakeRecoveryStore, makeTestOrchestrator } from './helpers/fakes.js';
import { waitFor } from './helpers/waiting.js';

/**
 * One broadcast is one recording, across a crash.
 *
 * The catalog keys a ladder's entry on `(owner, group)`: four rungs merge into a single row and
 * `StreamCatalog.withoutGroup` replaces that row only when the group matches. So a source handed a
 * second group is not a cosmetic slip, it is the same broadcast listed twice for viewers, each copy
 * paid for in its own postage and neither reachable from the other.
 *
 * The group used to live only in `StreamOrchestrator.ladderGroups`, an in-process map, with one
 * route back after a restart: a surviving per-stream recovery entry. A crash *around finalize* is
 * exactly the case with none, because `finalize` deletes each rung's entry as that rung completes.
 * These pin the identity surviving that gap, and pin the other half of the rule too, that a ladder
 * which really did finish does not adopt the next broadcast on the same source.
 */

const BASE = 'live/stream';
const RUNG_720P = `${BASE}_720p`;
const RUNG_360P = `${BASE}_360p`;
const SETTLE_CEILING_MS = 4_000;

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-identity-'));
  tempRoots.push(root);
  return root;
}

/** Reaches the ladder maps directly, for the reason `StreamOrchestrator.test.ts` gives: the group id has no behavioural signal to observe. */
interface LadderMaps {
  ladderGroups: Map<string, RememberedLadder>;
}

function ladderOf(orch: StreamOrchestrator, base: string): RememberedLadder | undefined {
  return (orch as unknown as LadderMaps).ladderGroups.get(base);
}

function groupOf(orch: StreamOrchestrator, base: string): string | undefined {
  return ladderOf(orch, base)?.group;
}

/**
 * How many segments have actually reached Swarm, which is how a case waits for media to have been
 * published rather than merely offered.
 *
 * The queue is asynchronous and a re-anchoring is minted where a segment is placed in the manifest,
 * so a case that re-announced immediately after handing a segment over would sometimes read the
 * epoch before the segment that mints it had landed.
 */
function published(orch: StreamOrchestrator): number {
  return orch.getMetricsSnapshot().segmentsUploadedTotal;
}

/**
 * An orchestrator as `index.ts` builds one for an ABR deployment: a ladder, and a group store under
 * the state directory it shares with every other boot of the same deployment.
 */
function bootWithLadder(root: string): StreamOrchestrator {
  return makeTestOrchestrator({
    ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
    ladderGroupStore: new LadderGroupStore(path.join(root, 'ladder', 'groups.json')),
  });
}

describe('a ladder keeps its identity across a restart of the uploader', () => {
  after(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The defect scenario H caught live on 2026-08-29: the uploader was killed inside `finalize` and
   * the broadcast came back as a second recording. Modelled with no recovery entry left, which is
   * what a crash at the tail of finalize leaves, so the persisted group is the only identity there is.
   */
  it('gives a rung announced after the crash the group its ladder already had', async () => {
    const root = makeTempRoot();
    const before = bootWithLadder(root);
    before.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    await waitFor(() => groupOf(before, BASE) !== undefined, SETTLE_CEILING_MS);
    const group = groupOf(before, BASE);

    // The crash: the process is gone, so nothing stops, nothing drains and nothing is released. The
    // next boot is a new orchestrator over the same state directory and an empty memory.
    const after = bootWithLadder(root);
    after.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);

    assert.equal(
      groupOf(after, BASE),
      group,
      'the reboot minted a second ladder for one broadcast, so the catalog lists it twice',
    );

    await after.stopStream(RUNG_720P);
  });

  /**
   * ⛔ The orchestrator's injected clock is `performance.now()`, milliseconds since the process
   * started, and the first stage broadcast of 2026-09-03 stamped every segment fifty-two seconds
   * after 1970 because the anchor had been minted from it. An anchor is a date and comes from the
   * wall clock, whatever the monotonic clock reads.
   */
  it('mints the anchor from the wall clock, never from the monotonic clock', async () => {
    const wallNow = Date.UTC(2026, 8, 3, 3, 26, 50);
    const root = makeTempRoot();
    const orch = makeTestOrchestrator({
      ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
      ladderGroupStore: new LadderGroupStore(path.join(root, 'ladder', 'groups.json')),
      wallClock: () => wallNow,
    });
    orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    await waitFor(() => ladderOf(orch, BASE) !== undefined, SETTLE_CEILING_MS);

    assert.equal(
      ladderOf(orch, BASE)?.startedAtMs,
      wallNow,
      'the anchor is not the wall clock, so every stamp derived from it is a process uptime rather than a date',
    );

    await orch.stopStream(RUNG_720P);
  });

  it('gives a rung announced after the crash the wall clock its broadcast started on', async () => {
    const root = makeTempRoot();
    const before = bootWithLadder(root);
    before.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    await waitFor(() => ladderOf(before, BASE) !== undefined, SETTLE_CEILING_MS);
    const startedAtMs = ladderOf(before, BASE)?.startedAtMs;

    const after = bootWithLadder(root);
    after.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);

    assert.equal(
      ladderOf(after, BASE)?.startedAtMs,
      startedAtMs,
      'the reboot re-dated the broadcast, so every segment after it claims a wall clock the media never had',
    );

    await after.stopStream(RUNG_720P);
  });

  /**
   * The dating a restart re-anchors to, which is the owner's decision of 2026-09-03: the media after
   * an engine restart carries the wall clock it really happened at rather than a time behind real
   * time by the length of the gap.
   *
   * ⛔ It is minted **once for the whole ladder**, by whichever rung crosses the restart first, and
   * every other rung lands on that same line. Four rungs each taking their own reading of the clock
   * is the disagreement `#EXT-X-PROGRAM-DATE-TIME` exists here to prevent: hls.js reads four rungs
   * dating one segment differently as four rungs covering different media.
   */
  it('mints one re-anchoring for the whole ladder when its rungs re-announce', async () => {
    const startedAtMs = Date.UTC(2026, 8, 3, 12, 0, 0);
    const restartedAtMs = startedAtMs + 600_000;
    let nowMs = startedAtMs;
    const root = makeTempRoot();
    const orch = makeTestOrchestrator({
      ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
      ladderGroupStore: new LadderGroupStore(path.join(root, 'ladder', 'groups.json')),
      wallClock: () => nowMs,
    });

    orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    orch.startStream(RUNG_360P, MEDIA_TYPE_VIDEO);
    await waitFor(() => ladderOf(orch, BASE) !== undefined, SETTLE_CEILING_MS);
    // ⚠️ **Each rung has to publish something first, and that is a change of instrument rather than
    // of subject.** A re-announce resumes the session it finds rather than replacing it, so the
    // re-anchoring is minted where the numbering actually continues — on the first segment after the
    // gap — instead of at the announce. A rung with nothing published has no sequence to resume at.
    orch.handleSegment(RUNG_720P, 0, 2, Buffer.from('720-before'));
    orch.handleSegment(RUNG_360P, 0, 2, Buffer.from('360-before'));
    await waitFor(() => published(orch) >= 2, SETTLE_CEILING_MS);

    // The engine comes back and re-announces its rungs, seconds apart as a transcoder does. Each
    // rung's own segment is awaited before the clock moves on, because the re-anchoring is minted
    // where that segment is placed: leaving them in flight lets both read one reading of the clock,
    // which is the very disagreement this case exists to detect.
    nowMs = restartedAtMs;
    orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    orch.handleSegment(RUNG_720P, 1, 2, Buffer.from('720-after'));
    await waitFor(() => published(orch) >= 3, SETTLE_CEILING_MS);

    nowMs = restartedAtMs + 3_000;
    orch.startStream(RUNG_360P, MEDIA_TYPE_VIDEO);
    orch.handleSegment(RUNG_360P, 1, 2, Buffer.from('360-after'));
    await waitFor(() => published(orch) >= 4, SETTLE_CEILING_MS);

    const epochs = ladderOf(orch, BASE)?.epochs ?? [];
    assert.equal(epochs.length, 1, 'the rungs re-anchored one ladder twice');
    assert.equal(epochs[0].atMs, restartedAtMs, 'and the line they share is the clock the engine came back at');
    assert.equal(epochs[0].fromSequence, 1, 'written down at the sequence the numbering resumed from');
    assert.ok(
      epochs[0].returnToken,
      'a returning encoder’s line carries the return it belongs to, which is what makes it joinable',
    );

    await orch.cleanup();
  });

  it('carries the re-anchoring across a restart of the uploader', async () => {
    const startedAtMs = Date.UTC(2026, 8, 3, 12, 0, 0);
    const restartedAtMs = startedAtMs + 600_000;
    let nowMs = startedAtMs;
    const root = makeTempRoot();
    const before = makeTestOrchestrator({
      ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
      ladderGroupStore: new LadderGroupStore(path.join(root, 'ladder', 'groups.json')),
      wallClock: () => nowMs,
    });
    before.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    await waitFor(() => ladderOf(before, BASE) !== undefined, SETTLE_CEILING_MS);
    // Published before the gap and again after it, for the reason the case above gives: the
    // re-anchoring is minted on the segment that resumes the numbering, not on the announce.
    before.handleSegment(RUNG_720P, 0, 2, Buffer.from('before'));
    await waitFor(() => published(before) >= 1, SETTLE_CEILING_MS);
    nowMs = restartedAtMs;
    before.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    before.handleSegment(RUNG_720P, 1, 2, Buffer.from('after'));
    await waitFor(() => (ladderOf(before, BASE)?.epochs?.length ?? 0) > 0, SETTLE_CEILING_MS);
    assert.ok(ladderOf(before, BASE)?.epochs?.length, 'the re-announce did not re-anchor, so nothing is being carried');

    const after = bootWithLadder(root);
    after.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);

    const carried = ladderOf(after, BASE)?.epochs ?? [];
    assert.equal(carried.length, 1, 'the reboot came back holding a different number of lines than it left');
    assert.equal(
      carried[0].atMs,
      restartedAtMs,
      'the reboot came back on the dating the broadcast opened with, so it re-dated everything after the restart',
    );
    assert.equal(carried[0].fromSequence, 1);

    await after.stopStream(RUNG_720P);
    await before.cleanup();
  });

  it('gives a sibling rung the same group after the crash, not one ladder each', async () => {
    const root = makeTempRoot();
    const before = bootWithLadder(root);
    before.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    await waitFor(() => groupOf(before, BASE) !== undefined, SETTLE_CEILING_MS);
    const group = groupOf(before, BASE);

    const after = bootWithLadder(root);
    after.startStream(RUNG_360P, MEDIA_TYPE_VIDEO);

    assert.equal(groupOf(after, BASE), group, 'a rung that came back on its own started a ladder of its own');

    await after.stopStream(RUNG_360P);
  });

  /**
   * The other half of the rule, and the reason the record is retired rather than kept forever. A
   * ladder whose last rung finalized is a finished recording, so the next broadcast on that source
   * must not be merged into it.
   */
  it('gives the next broadcast on the same source a new group once the ladder has finished', async () => {
    const root = makeTempRoot();
    const first = bootWithLadder(root);
    first.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    await waitFor(() => groupOf(first, BASE) !== undefined, SETTLE_CEILING_MS);
    const group = groupOf(first, BASE);
    await first.stopStream(RUNG_720P);

    const second = bootWithLadder(root);
    second.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);

    assert.notEqual(groupOf(second, BASE), group, 'a finished recording adopted the broadcast that came after it');

    await second.stopStream(RUNG_720P);
  });

  /**
   * A deployment with no ladder configured has no group store either, and nothing about the
   * single-rendition path may start depending on one.
   */
  it('runs a ladder with no store configured exactly as it did before', async () => {
    const orch = makeTestOrchestrator({ ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC) });

    orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    await waitFor(() => groupOf(orch, BASE) !== undefined, SETTLE_CEILING_MS);

    assert.ok(groupOf(orch, BASE), 'a ladder without a store must still get a group');

    await orch.stopStream(RUNG_720P);
    assert.equal(groupOf(orch, BASE), undefined, 'the in-memory group outlived its last rung');
  });
});

/**
 * What the identity buys once it has survived: the rest of the broadcast lands in the row that is
 * already there. The catalog is a list of entries and `upsertRendition` replaces the one matching
 * `(owner, group)`, so holding the group is the whole of the difference between updating a recording
 * and buying a second one.
 */
describe('the tail of a broadcast after a crash goes into the recording already listed', () => {
  const identity: LadderIdentity = {
    title: '29/08/2026',
    owner: 'abcd',
    group: 'ladder-1',
    mediatype: MEDIA_TYPE_VIDEO,
  };

  const rendition = (name: string, height: number, extra: Partial<Rendition> = {}): Rendition => ({
    name,
    width: (height * 16) / 9,
    height,
    topic: `${name}-before-the-crash`,
    bandwidth: height * 5000,
    avgBandwidth: height * 4000,
    ...extra,
  });

  /**
   * ⛔ The merge is keyed on the rung's NAME and never on its topic, and these cases drive it with a
   * topic that changed to pin that. In production a returning rung carries the same derived topic it
   * carried before — it resumes the feed it was already on — so this is the harder case rather than
   * the real one, and keying on the name is what makes both of them one entry. The group is what
   * decides how many recordings there are.
   */
  it('updates the one entry when a rung returns on a new topic, rather than appending a second', () => {
    const beforeTheCrash = buildLadderEntry(identity, [], rendition('720p', 720));

    const afterTheCrash = buildLadderEntry(
      identity,
      [beforeTheCrash],
      rendition('720p', 720, { topic: '720p-after-the-crash' }),
    );

    assert.equal(afterTheCrash.group, identity.group);
    assert.equal(afterTheCrash.renditions?.length, 1, 'the returning rung was listed alongside its own earlier self');
    assert.equal(afterTheCrash.topic, '720p-after-the-crash');
  });

  it('finalizes into the same entry, so the recovered broadcast is listed once', () => {
    const live = buildLadderEntry(identity, [], rendition('360p', 360));
    const recovered = buildLadderEntry(identity, [live], rendition('360p', 360, { topic: '360p-recovered' }));

    const finalized = buildLadderEntry(
      identity,
      [recovered],
      rendition('360p', 360, { topic: '360p-recovered', index: 42, duration: 61 }),
    );

    assert.equal(finalized.state, 'vod');
    assert.equal(finalized.index, 42);
    assert.equal(finalized.renditions?.length, 1);
  });

  /**
   * A second group is the defect in the shape a viewer sees it. Pinned here because every assertion
   * above is about one entry, and none of them would notice the list simply growing.
   */
  it('leaves a second group as a second recording, which is what a lost identity costs', () => {
    const first = buildLadderEntry(identity, [], rendition('720p', 720));
    const reminted: LadderIdentity = { ...identity, group: 'ladder-2' };

    const second = buildLadderEntry(reminted, [first], rendition('720p', 720, { topic: '720p-after-the-crash' }));

    const listed: StreamEntry[] = [first, second];
    assert.equal(new Set(listed.map((entry) => entry.group)).size, 2);
    assert.equal(second.renditions?.length, 1, 'the re-minted ladder must not inherit the first one');
  });
});

/**
 * A ladder under a declaration, which is what admin mode and `ABR_ENABLED` together produce.
 *
 * ⛔ **The declared topic becomes the ladder's GROUP, and a rung's own feed topic is derived from it.**
 * The group is the master playlist's feed topic, and the master is what a viewer opens: the admin
 * hands out the declared topic before anything has published, so the two have to be the same string or
 * the admin's catalog entry points at a feed nothing ever writes. Handing the rung that topic as well
 * would put four rungs and the master on one feed, all claiming the same indexes, so a rung publishes
 * on `rungTopicFor(group, rung)` instead — one feed per rung, stable for the life of the ladder.
 *
 * ⛔ **What is remembered still wins after a restart.** The group store and each rung's recovery entry
 * are the two records of the identity the surviving rungs are already publishing under, and a
 * declaration that disagrees with them arrives only for a broadcast that crashed and was re-declared.
 * Adopting the new topic mid-ladder would strand the master the other rungs are still writing.
 */
describe('a ladder in admin mode', () => {
  const DECLARED_TOPIC = 'declared-topic-0001';
  const ADMIN_SESSION = { id: 'str_01HZY', topic: DECLARED_TOPIC };

  /** One rung's announce as the ladder registry received it. */
  interface Announce {
    identity: LadderIdentity;
    rendition: Rendition;
  }

  /**
   * A ladder registry that keeps every record registered with it and writes no master, standing in
   * for `AdminLadderRegistry`. What these cases pin is that the orchestrator hands its configured
   * registry to every session it builds, under the identity a declared ladder has to carry: the group
   * is the declared topic and the stream id is the declaration's.
   */
  function recordingRegistry(): { registry: LadderRegistry; announces: Announce[] } {
    const announces: Announce[] = [];
    return {
      announces,
      registry: {
        upsertRendition: async (identity, rendition) => {
          announces.push({ identity, rendition });
          return { masterIndex: null, flippedToFinished: false, duration: null };
        },
        recordRungDelivered: () => {},
      },
    };
  }

  function declaredAdmin(): AdminApiClient {
    return new AdminApiClient({
      baseUrl: 'http://admin.test:9877',
      token: 'admin-api-token-0123456789abcdef',
      fetcher: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
    });
  }

  /**
   * An orchestrator as `index.ts` builds one for a deployment running both: a ladder, a group store
   * under the shared state directory, an admin client, and the ladder registry admin mode swaps in.
   * The client answers every report, because these cases are about identity and a session that
   * reached its retry ladder in the background would spend seconds of an unrelated assertion.
   */
  function bootDeclaredLadder(
    root: string,
    ladderRegistry: LadderRegistry = recordingRegistry().registry,
  ): StreamOrchestrator {
    return makeTestOrchestrator({
      ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
      ladderGroupStore: new LadderGroupStore(path.join(root, 'ladder', 'groups.json')),
      adminApi: declaredAdmin(),
      ladderRegistry,
    });
  }

  /**
   * Every error the error handler logged while `run` ran. An announce that dies inside the uploader is
   * caught by `announceToCatalog` and handed to the error handler, which logs it and nothing else, so a
   * case that asserts only on what the registry holds would pass over a registry that was never
   * reached.
   * Fifteen cases in this file did exactly that once, over a fake catalog with no `upsertRendition`.
   */
  async function errorsDuring(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const logger = Logger.getInstance();
    const previous = logger.configure({ sink: (level, line) => (level === 'error' ? lines.push(line) : undefined) });
    try {
      await run();
    } finally {
      logger.configure(previous);
    }
    return lines;
  }

  /**
   * Reaches the live session for its own feed topic. The topic has no behavioural signal to observe
   * from outside — the same reason `groupOf` above reaches into the ladder maps.
   */
  interface ActiveStreams {
    activeStreams: Map<string, { getStreamState(): { streamRawTopic: string; adminStreamId?: string } }>;
  }

  function sessionOf(orch: StreamOrchestrator, streamId: string) {
    return (orch as unknown as ActiveStreams).activeStreams.get(streamId)?.getStreamState();
  }

  it('makes the declared topic the ladder group and leaves every rung a feed of its own', async () => {
    const root = makeTempRoot();
    const orch = bootDeclaredLadder(root);

    try {
      orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO, undefined, ADMIN_SESSION);
      orch.startStream(RUNG_360P, MEDIA_TYPE_VIDEO, undefined, ADMIN_SESSION);
      await waitFor(() => groupOf(orch, BASE) !== undefined, SETTLE_CEILING_MS);

      assert.equal(groupOf(orch, BASE), DECLARED_TOPIC, 'the master feed has to be where the admin points viewers');
      const topics = [RUNG_720P, RUNG_360P].map((rung) => sessionOf(orch, rung)?.streamRawTopic);
      assert.equal(new Set(topics).size, 2, 'two rungs sharing one feed write over each other');
      assert.ok(
        topics.every((topic) => topic !== undefined && topic !== DECLARED_TOPIC),
        `a rung must not publish its manifests onto the master′s feed, got ${JSON.stringify(topics)}`,
      );
      assert.equal(sessionOf(orch, RUNG_720P)?.adminStreamId, ADMIN_SESSION.id, 'and each rung reports to the ladder');
    } finally {
      await orch.cleanup();
    }
  });

  /**
   * ⛔ The one wiring `index.ts` adds for admin mode: the registry it builds has to reach every
   * session, or a rung registers with the stream catalog admin mode is never allowed to write. Pinned
   * through the orchestrator rather than on `StreamUploader` directly, because the orchestrator is
   * where the registry is threaded and where it was silently dropped from the fixture for fifteen
   * passing cases.
   */
  it('registers each rung′s record with the ladder registry under the declared group and stream id', async () => {
    const root = makeTempRoot();
    const { registry, announces } = recordingRegistry();
    const orch = bootDeclaredLadder(root, registry);

    try {
      const errors = await errorsDuring(async () => {
        orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO, undefined, ADMIN_SESSION);
        orch.handleSegment(RUNG_720P, 0, 2, Buffer.from('seg'));
        await waitFor(() => announces.length > 0, SETTLE_CEILING_MS);
      });

      const [{ identity, rendition }] = announces;
      assert.equal(identity.group, DECLARED_TOPIC, 'the ladder is merged under the topic the admin points viewers at');
      assert.equal(identity.adminStreamId, ADMIN_SESSION.id, 'and reported against the declaration');
      assert.equal(rendition.name, '720p');
      assert.notEqual(rendition.topic, DECLARED_TOPIC, 'the rung′s own feed is never the master′s');
      assert.deepEqual(errors, [], 'an announce that died on the way to the registry is logged, never thrown');
    } finally {
      await orch.cleanup();
    }
  });

  it('keeps the group its ladder already had when a declaration names a different topic', async () => {
    const root = makeTempRoot();
    const before = bootDeclaredLadder(root);
    before.startStream(RUNG_720P, MEDIA_TYPE_VIDEO, undefined, ADMIN_SESSION);
    await waitFor(() => groupOf(before, BASE) !== undefined, SETTLE_CEILING_MS);

    // The crash: the process is gone, so nothing stops and nothing is retired. Then a re-declaration,
    // which is the only way a second topic can reach the same base at all.
    const after = bootDeclaredLadder(root);
    try {
      after.startStream(RUNG_720P, MEDIA_TYPE_VIDEO, undefined, { id: 'str_SECOND', topic: 'declared-topic-0002' });

      assert.equal(
        groupOf(after, BASE),
        DECLARED_TOPIC,
        'the remembered group is where the master the surviving rungs publish under already lives',
      );
    } finally {
      await after.cleanup();
    }
  });

  /**
   * ⛔ Nothing re-announces a recovered stream, so the entry on disk is the only surviving record of
   * which declaration this rung belonged to and of which ladder it was merged into. Without the id the
   * broadcast finalizes into its feed and stays `live` in the admin's list for ever; without the group
   * its master is written to a topic the admin points nobody at.
   */
  it('rebuilds a recovered rung on the group and the declaration its entry carries', async () => {
    const root = makeTempRoot();
    const state: StreamState = {
      streamId: RUNG_720P,
      streamRawTopic: 'rung-topic-0001',
      mediatype: MEDIA_TYPE_VIDEO,
      socIndex: 3,
      segments: [{ index: 0, duration: 2, ref: 'ref0' }],
      hlsHeaders: ['#EXTM3U', '#EXT-X-VERSION:3'],
      isFirstSegmentReady: true,
      isFirstManifestReady: true,
      updatedAt: Date.now(),
      ladder: { group: DECLARED_TOPIC, rung: { name: '720p', width: 1280, height: 720, configuredKbps: 2800 } },
      adminStreamId: ADMIN_SESSION.id,
    };

    const { registry, announces } = recordingRegistry();
    const orch = bootDeclaredLadder(root, registry);
    (orch as unknown as { recoveryStore: RecoveryStore }).recoveryStore = makeFakeRecoveryStore({
      listActive: () => [RUNG_720P],
      load: () => state,
    });

    try {
      await orch.recoverStreams();

      assert.equal(sessionOf(orch, RUNG_720P)?.adminStreamId, ADMIN_SESSION.id);
      assert.equal(groupOf(orch, BASE), DECLARED_TOPIC, 'the group store is rewritten from the entry that survived');

      // Nothing re-announces a recovered stream, so the first record it registers is its finalize, the
      // announce that carries the recording's index. It goes through the same registry a fresh
      // session's does, under the same declaration, or the recovered tail of the broadcast is merged
      // into nothing the admin holds.
      const errors = await errorsDuring(async () => {
        await orch.stopStream(RUNG_720P);
        await waitFor(() => announces.length > 0, SETTLE_CEILING_MS);
      });
      assert.equal(announces[0].identity.adminStreamId, ADMIN_SESSION.id);
      assert.equal(announces[0].identity.group, DECLARED_TOPIC);
      assert.notEqual(announces[0].rendition.index, undefined, 'a finalize announces where the recording ended');
      assert.deepEqual(errors, []);
    } finally {
      await orch.cleanup();
    }
  });

  /**
   * ⛔⛔ **A re-announced rung is handed its predecessor's drain, exactly as a declared single stream
   * is.** It was not, while a rung minted a fresh topic per session and the two sessions therefore
   * wrote to different feeds. A rung's topic is now derived from its ladder group and its rung name,
   * so the retired session's closing and VOD playlists are SOC writes onto the very feed the
   * replacement is about to publish into. Without the gate the two claim the same indexes and the
   * retired session's recording lands above the live broadcast, leaving the feed head saying a
   * running broadcast had ended.
   *
   * ⚠️ What this costs is the replacement's live playlist for the length of one finalize, and it is
   * paid on purpose. Segments keep uploading throughout; only naming them in a playlist waits, and
   * the next segment re-attempts. The other way round corrupts the feed.
   */
  it('holds a rung announced mid-drain until its predecessor has drained, then continues above it', async () => {
    const root = makeTempRoot();
    /** Every SOC write, in order, with what it carried, so a media playlist can be told from a master. */
    const writes: { index: number; payload: string }[] = [];
    const mediaPlaylists = () => writes.filter((write) => !write.payload.includes('#EXT-X-STREAM-INF'));

    /** Held open so the retired session's finalize cannot settle until the test lets it. */
    let releaseTheDrain = () => {};
    const drainHeld = new Promise<void>((resolve) => {
      releaseTheDrain = resolve;
    });
    /** The retired session's recording, which is the last thing it writes before its drain settles. */
    let vodIndex: number | null = null;

    const orch = makeTestOrchestrator(
      {
        ladder: AbrLadder.parse(DEFAULT_LADDER_SPEC),
        ladderGroupStore: new LadderGroupStore(path.join(root, 'ladder', 'groups.json')),
        adminApi: new AdminApiClient({
          baseUrl: 'http://admin.test:9877',
          token: 'admin-api-token-0123456789abcdef',
          fetcher: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
        }),
      },
      {
        uploadPayload: async (index, data) => {
          const payload = String(data);
          if (payload.includes('#EXT-X-PLAYLIST-TYPE:VOD')) {
            vodIndex = index;
            await drainHeld;
          }
          writes.push({ index, payload });
          return { reference: { toHex: () => `soc${index}` } };
        },
        // The feed answers with whatever was last written to it, which is what the replacement reads
        // to find where it continues from.
        feedHead: () => {
          const newest = writes[writes.length - 1];
          return newest === undefined ? null : { index: newest.index, manifest: newest.payload };
        },
      },
    );

    try {
      orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO, undefined, ADMIN_SESSION);
      orch.handleSegment(RUNG_720P, 0, 2, Buffer.from('seg'));
      await waitFor(() => mediaPlaylists().length > 0, SETTLE_CEILING_MS);

      // ⚠️ **The stop is what makes two sessions, and it has to come first.** A bare re-announce of a
      // live rung resumes the session it finds, which is the encoder-reconnect path and has no
      // predecessor to wait for. Two sessions hold one derived topic only while a stop of that id is
      // still finalizing, which is the window this gate exists for: the retired session's closing and
      // VOD playlists are SOC writes onto the very feed the replacement is about to publish into.
      const stopping = orch.stopStream(RUNG_720P);
      // The retired session gets as far as its recording and stops there, holding the drain open.
      await waitFor(() => vodIndex !== null, SETTLE_CEILING_MS);

      // The transcoder comes back inside that drain and is registered as a replacement, onto the same
      // derived topic.
      orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO, undefined, ADMIN_SESSION);
      orch.handleSegment(RUNG_720P, 1, 2, Buffer.from('seg'));
      const heldAt = mediaPlaylists().length;
      orch.handleSegment(RUNG_720P, 2, 2, Buffer.from('seg'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        mediaPlaylists().length,
        heldAt,
        'the replacement published onto a feed its predecessor had not finished writing',
      );

      // The predecessor finishes, and the next segment is the one that re-attempts. The replacement
      // reads the head its predecessor left and writes above it rather than over it.
      releaseTheDrain();
      await waitFor(() => vodIndex !== null && writes.some((write) => write.index === vodIndex), SETTLE_CEILING_MS);
      await stopping;
      orch.handleSegment(RUNG_720P, 3, 2, Buffer.from('seg'));
      await waitFor(() => mediaPlaylists().some((write) => write.index > vodIndex!), SETTLE_CEILING_MS);
    } finally {
      releaseTheDrain();
      await orch.cleanup();
    }
  });
});
