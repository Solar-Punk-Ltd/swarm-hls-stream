import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { LadderGroupStore, RememberedLadder } from '../src/libs/LadderGroupStore.js';
import { buildLadderEntry, LadderIdentity, StreamEntry } from '../src/libs/StreamCatalog.js';
import { StreamOrchestrator } from '../src/libs/StreamOrchestrator.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

import { makeTestOrchestrator } from './helpers/fakes.js';
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
