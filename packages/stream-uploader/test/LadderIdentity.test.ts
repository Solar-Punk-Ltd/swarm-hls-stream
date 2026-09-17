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
 * The catalog keys a ladder's entry on `(owner, group)`: four rungs fold into a single row and
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

    // The engine comes back and re-announces its rungs, seconds apart as a transcoder does.
    nowMs = restartedAtMs;
    orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    nowMs = restartedAtMs + 3_000;
    orch.startStream(RUNG_360P, MEDIA_TYPE_VIDEO);

    assert.deepEqual(
      ladderOf(orch, BASE)?.epochs,
      [{ fromSequence: 0, atMs: restartedAtMs }],
      'the rungs re-anchored one ladder twice, so each of them dates the same media on its own clock',
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
    nowMs = restartedAtMs;
    before.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);
    assert.ok(ladderOf(before, BASE)?.epochs?.length, 'the re-announce did not re-anchor, so nothing is being carried');

    const after = bootWithLadder(root);
    after.startStream(RUNG_720P, MEDIA_TYPE_VIDEO);

    assert.deepEqual(
      ladderOf(after, BASE)?.epochs,
      [{ fromSequence: 0, atMs: restartedAtMs }],
      'the reboot came back on the dating the broadcast opened with, so it re-dated everything after the restart',
    );

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
   * must not be folded into it.
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
   * The rung comes back on a fresh feed topic, which is deliberate and unchanged: a rung that
   * restarts must never be handed the topic it just finished writing, or it overwrites it from SOC
   * index 0. Only the group is stable, and the group is what decides how many recordings there are.
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
 * ⛔ **The declared topic becomes the ladder's GROUP, and a rung's own feed topic stays random.** The
 * group is the master playlist's feed topic, and the master is what a viewer opens: the admin hands
 * out the declared topic before anything has published, so the two have to be the same string or the
 * admin's catalog entry points at a feed nothing ever writes. Handing the rung that topic as well
 * would put four rungs and the master on one feed, all claiming the same indexes.
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
      assert.equal(identity.group, DECLARED_TOPIC, 'the ladder is folded under the topic the admin points viewers at');
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
   * which declaration this rung belonged to and of which ladder it was folded into. Without the id the
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
      // session's does, under the same declaration, or the recovered tail of the broadcast is folded
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
   * ⛔ A rung is not handed its predecessor's drain, and this is what says so. The gate exists because
   * two admin-mode sessions share one declared feed; a rung's manifest feed is its own, so holding its
   * playlist for a finalize would freeze one quality of a live ladder and buy nothing.
   */
  it('lets a re-announced rung publish without waiting for the session it replaced', async () => {
    const root = makeTempRoot();
    const published: number[] = [];
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
        uploadPayload: async (index) => {
          published.push(index);
          return { reference: { toHex: () => `soc${index}` } };
        },
      },
    );

    try {
      orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO, undefined, ADMIN_SESSION);
      orch.handleSegment(RUNG_720P, 0, 2, Buffer.from('seg'));
      await waitFor(() => published.length > 0, SETTLE_CEILING_MS);
      const before = published.length;

      // The transcoder restarts and re-announces the same rung. The retired session drains in the
      // background; the replacement must not be waiting on it.
      orch.startStream(RUNG_720P, MEDIA_TYPE_VIDEO, undefined, ADMIN_SESSION);
      orch.handleSegment(RUNG_720P, 0, 2, Buffer.from('seg'));

      await waitFor(() => published.length > before, SETTLE_CEILING_MS);
    } finally {
      await orch.cleanup();
    }
  });
});
