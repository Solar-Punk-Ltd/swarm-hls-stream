import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { makeFeedIdentifier } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';

import {
  backoffDelayMs,
  FEED_STATE_ENDED,
  FEED_STATE_LIVE,
  FEED_STATE_RECONNECTING,
  FeedHealthTracker,
  FeedState,
} from '../src/components/SwarmHlsPlayer/feedState.js';
import { LadderFeedPoller } from '../src/components/SwarmHlsPlayer/LadderFeedPoller.js';
import { ManifestFetchError, ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestManagement.js';
import { parseManifest } from '../src/components/SwarmHlsPlayer/playlist.js';
import { TimedResponse } from '../src/utils/fetchWithTimeout.js';
import { RequestJitter } from '../src/utils/requestJitter.js';

const OWNER = 'aabbcc';
const POLL_MS = 2;

/** Far enough down the schedule that the doubling has flattened, whatever the cap is set to. */
const SETTLED_SCHEDULE_ATTEMPT = 32;

/** A cumulative live manifest, the shape the uploader publishes at each feed index. */
function manifest(segments: number, finalized = false): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < segments; i++) {
    lines.push('#EXTINF:1.5,', `ref-${i}`);
  }
  if (finalized) {
    lines.push('#EXT-X-ENDLIST');
  }
  return lines.join('\n');
}

function socPath(topic: Topic, index: number): string {
  return `soc/${OWNER}/${makeFeedIdentifier(topic, FeedIndex.fromBigInt(BigInt(index))).toString()}`;
}

function feedHeadPath(topic: Topic): string {
  return `feeds/${OWNER}/${topic.toString()}`;
}

/**
 * Serves whatever has been published so far and 404s the rest, which is exactly how a feed behaves
 * while a stream is running: the next index does not exist yet, and then it does.
 */
class FakeGateway {
  public readonly responses = new Map<string, string>();
  public readonly requests: string[] = [];
  /** Reproduces a proxy that drops the header extractFeedIndex needs, which makes it throw. */
  public stripFeedIndexHeader = false;
  /**
   * Status a missing path is refused with. Set to 404 to model a slot the publisher has not written
   * yet, the way the real fetcher does; left undefined it throws a transport-style error, which is a
   * gateway that is not answering at all.
   */
  public missingSlotStatus?: number;
  /**
   * Feed head paths the gateway will not answer at all, whatever is published against them.
   *
   * Models the case the sibling release exists for, one rung failing while another is being served,
   * which `missingSlotStatus` cannot express because it is a property of the gateway rather than of
   * a feed. Only the head path is refusable, and only the head path is needed: a rung refused here
   * never bootstraps, so it never asks for anything else.
   */
  public readonly unreachableHeads = new Set<string>();

  private readonly held = new Map<string, Promise<void>>();

  publishFeedHead(topic: Topic, index: number, body: string): void {
    this.responses.set(feedHeadPath(topic), body);
    this.responses.set(`__index__${topic.toString()}`, index.toString(16));
  }

  publishSoc(topic: Topic, index: number, body: string): void {
    this.responses.set(socPath(topic, index), body);
  }

  /** Blocks one path until the returned function is called, to pin a request in flight. */
  hold(path: string): () => void {
    let release = () => {};
    this.held.set(
      path,
      new Promise<void>((resolve) => {
        release = () => {
          this.held.delete(path);
          resolve();
        };
      }),
    );
    return () => release();
  }

  /**
   * A `TimedResponse`, which is what the poller is handed in production: `ManifestFetcher` reads
   * through `fetchWithTimeout`, so the body arrives already read and inside the bounded window. A
   * fake returning a `Response` would leave `text` a method the poller never calls.
   */
  fetchResource = async (path: string): Promise<TimedResponse> => {
    this.requests.push(path);

    const blocked = this.held.get(path);
    if (blocked) {
      await blocked;
    }

    if (this.unreachableHeads.has(path)) {
      throw new Error(`Failed to fetch: ${path}`);
    }

    const body = this.responses.get(path);
    if (body === undefined) {
      if (this.missingSlotStatus !== undefined) {
        throw new ManifestFetchError(path, this.missingSlotStatus);
      }
      throw new Error(`Failed to fetch: ${path}`);
    }

    const headers = new Headers();
    const feedMatch = /^feeds\/[^/]+\/(.+)$/.exec(path);
    if (feedMatch && !this.stripFeedIndexHeader) {
      headers.set('Swarm-Feed-Index', this.responses.get(`__index__${feedMatch[1]}`) ?? '0');
    }

    return { ok: true, status: 200, headers, text: body };
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function segmentCount(state: ManifestStateManager, topic: Topic): number {
  const serialized = state.serialize(topic.toString(), '');
  return serialized ? parseManifest(serialized).segments.length : 0;
}

describe('LadderFeedPoller', () => {
  let state: ManifestStateManager;

  beforeEach(() => {
    state = ManifestStateManager.getInstance();
    state.clear();
  });

  it('bootstraps at the feed head and then walks forward one index at a time', async () => {
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));
    gateway.publishSoc(topic, 1, manifest(2));
    gateway.publishSoc(topic, 2, manifest(3));

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS);
    poller.start(OWNER, [topic]);

    try {
      await waitFor(() => segmentCount(state, topic) === 3, 'three segments');
      assert.equal(state.getIndex(topic.toString())?.toBigInt(), 2n);
    } finally {
      poller.stop([topic]);
    }
  });

  it('consumes a backlog in one pass rather than one index per playlist refresh', async () => {
    // The reason this exists: a rung nobody is playing still has to reach the live edge, and
    // walking it at hls.js's refresh rate would take minutes.
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));
    for (let i = 1; i <= 20; i++) {
      gateway.publishSoc(topic, i, manifest(i + 1));
    }

    const poller = new LadderFeedPoller(state, gateway.fetchResource, 10_000);
    poller.start(OWNER, [topic]);

    try {
      // A 10s poll interval means a second pass cannot have happened: everything below was
      // consumed by the first one.
      await waitFor(() => segmentCount(state, topic) === 21, 'the whole backlog');
    } finally {
      poller.stop([topic]);
    }
  });

  it('keeps every rung current, not just one', async () => {
    const topics = ['group-1-360p', 'group-1-720p', 'group-1-1080p'].map((t) => Topic.fromString(t));
    const gateway = new FakeGateway();
    for (const topic of topics) {
      gateway.publishFeedHead(topic, 0, manifest(1));
      gateway.publishSoc(topic, 1, manifest(2));
    }

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS);
    poller.start(OWNER, topics);

    try {
      await waitFor(() => topics.every((t) => segmentCount(state, t) === 2), 'all rungs at index 1');
    } finally {
      poller.stop(topics);
    }
  });

  it('stops walking a rung once its playlist is finalized', async () => {
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));
    gateway.publishSoc(topic, 1, manifest(2, true));

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS);
    poller.start(OWNER, [topic]);

    try {
      await waitFor(() => segmentCount(state, topic) === 2, 'the final playlist');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const afterStop = gateway.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(gateway.requests.length, afterStop, 'no further requests after ENDLIST');
    } finally {
      poller.stop([topic]);
    }
  });

  /**
   * The ended overlay listens on the GROUP topic and finalization arrives one RUNG at a time. The
   * single-rendition walk records both against the same topic, so only the ladder has to bridge
   * them — and the first live V5 run proved it did not: the broadcast finalized as a VOD and the
   * viewer sat on `live` over a frozen frame for the rest of the watch.
   */
  describe('telling the viewer the broadcast ended', () => {
    const groupHex = Topic.fromString('group-1').toString();

    it('records ended on the group once every rung is finalized', async () => {
      const topics = ['group-1-360p', 'group-1-720p'].map((t) => Topic.fromString(t));
      const gateway = new FakeGateway();
      const tracker = new FeedHealthTracker();
      for (const topic of topics) {
        gateway.publishFeedHead(topic, 0, manifest(1));
        gateway.publishSoc(topic, 1, manifest(2, true));
      }

      const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
      poller.start(OWNER, topics, groupHex);

      try {
        await waitFor(() => tracker.state(groupHex) === FEED_STATE_ENDED, 'the group to end');
      } finally {
        poller.stop(topics);
      }
    });

    /**
     * All rungs rather than any, mirroring the uploader's own rule (a ladder goes to VOD only once
     * every announced rung has finalized): one finalized rung beside live ones is a rung retired,
     * not a broadcast over.
     */
    it('does not record ended while any rung is still live', async () => {
      const finalized = Topic.fromString('group-1-360p');
      const live = Topic.fromString('group-1-720p');
      const gateway = new FakeGateway();
      const tracker = new FeedHealthTracker();
      gateway.missingSlotStatus = 404;
      gateway.publishFeedHead(finalized, 0, manifest(2, true));
      gateway.publishFeedHead(live, 0, manifest(1));

      const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
      poller.start(OWNER, [finalized, live], groupHex);

      try {
        await waitFor(() => segmentCount(state, finalized) === 2, 'the finalized rung read');
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(tracker.state(groupHex), FEED_STATE_LIVE);
      } finally {
        poller.stop([finalized, live]);
      }
    });

    it('records nothing when the walk was started without a group', async () => {
      const topic = Topic.fromString('group-1-360p');
      const gateway = new FakeGateway();
      const tracker = new FeedHealthTracker();
      gateway.publishFeedHead(topic, 0, manifest(2, true));

      const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
      poller.start(OWNER, [topic]);

      try {
        await waitFor(() => segmentCount(state, topic) === 2, 'the finalized rung read');
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(tracker.state(groupHex), FEED_STATE_LIVE);
      } finally {
        poller.stop([topic]);
      }
    });
  });

  it('keeps retrying an index that has not been published yet', async () => {
    const topic = Topic.fromString('group-1-480p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS);
    poller.start(OWNER, [topic]);

    try {
      await waitFor(() => gateway.requests.filter((p) => p.startsWith('soc/')).length >= 3, 'repeated attempts');
      assert.equal(segmentCount(state, topic), 1, 'a miss must not lose what is already there');

      // The uploader publishes the next index; the walk picks it up without being asked to.
      gateway.publishSoc(topic, 1, manifest(2));
      await waitFor(() => segmentCount(state, topic) === 2, 'the newly published index');
    } finally {
      poller.stop([topic]);
    }
  });

  it('resolves ready() once a rung has a playlist, and on stop so nothing awaits forever', async () => {
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS);
    poller.start(OWNER, [topic]);

    await poller.ready(topic.toString());
    assert.equal(segmentCount(state, topic), 1);

    const stalled = Topic.fromString('group-1-1080p');
    poller.start(OWNER, [stalled]);
    const pending = poller.ready(stalled.toString());
    poller.stop([stalled, topic]);

    await pending;
  });

  it('survives a throw that is not a failed fetch, rather than dying silently', async () => {
    // A gateway behind a proxy that strips Swarm-Feed-Index, or a truncated body, throws from
    // outside the fetch. Before this was handled, the walk's promise rejected, the rung stayed in
    // `polled` so nothing restarted it, and ready() never settled — the loader then awaited a
    // level that would never load or error.
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));
    gateway.stripFeedIndexHeader = true;

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS);
    poller.start(OWNER, [topic]);

    try {
      await waitFor(() => gateway.requests.length >= 3, 'the walk to keep retrying');

      gateway.stripFeedIndexHeader = false;
      gateway.publishSoc(topic, 1, manifest(2));
      await waitFor(() => segmentCount(state, topic) === 2, 'recovery once the gateway behaves');
    } finally {
      poller.stop([topic]);
    }
  });

  it('does not write state from a response that lands after teardown', async () => {
    // The player stops the walk and clears the topic synchronously. A response still in flight
    // must not recreate that state: a resurrected index makes the next session skip bootstrap and
    // resume minutes behind live, replaying the previous session's segments.
    const topic = Topic.fromString('group-1-480p');
    const gateway = new FakeGateway();
    gateway.publishFeedHead(topic, 0, manifest(1));

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS);
    poller.start(OWNER, [topic]);

    await waitFor(() => state.getIndex(topic.toString()) !== null, 'bootstrap');

    // Arm the block before publishing, so the walk cannot consume index 1 before it is held —
    // otherwise there is nothing in flight at teardown and the test proves nothing.
    const held = socPath(topic, 1);
    const attemptsBeforeHold = gateway.requests.filter((p) => p === held).length;
    const release = gateway.hold(held);
    gateway.publishSoc(topic, 1, manifest(2));

    await waitFor(
      () => gateway.requests.filter((p) => p === held).length > attemptsBeforeHold,
      'a request pinned in flight',
    );

    poller.stop([topic]);
    state.clear(topic.toString());

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(state.getIndex(topic.toString()), null, 'teardown must stay torn down');
    assert.equal(segmentCount(state, topic), 0);
  });

  it('reports a topic as unpolled once stopped, so the loader falls back to reading it itself', () => {
    const topic = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS);

    assert.equal(poller.isPolling(topic.toString()), false);

    poller.start(OWNER, [topic]);
    assert.equal(poller.isPolling(topic.toString()), true);

    poller.stop([topic]);
    assert.equal(poller.isPolling(topic.toString()), false);
  });
});

describe('LadderFeedPoller feed health', () => {
  let state: ManifestStateManager;

  beforeEach(() => {
    state = ManifestStateManager.getInstance();
    state.clear();
  });

  it('records a gateway failure and backs off when a rung read hits a real fault', async () => {
    const topic = Topic.fromString('group-1-720p');
    // Nothing published and no 404 status set, so every read throws a transport-style error: the
    // gateway is not answering, which is the outage the backoff exists for.
    const gateway = new FakeGateway();

    // Clock pinned so the backoff neither elapses nor is jittered away mid-assertion.
    const health = new FeedHealthTracker(() => 0);
    const backoffAsked: string[] = [];
    const backoffMs = (hexTopic: string): number => {
      backoffAsked.push(hexTopic);
      return health.backoffRemainingMs(hexTopic);
    };

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, health, backoffMs);
    poller.start(OWNER, [topic]);

    try {
      await waitFor(
        () => health.state(topic.toString()) === FEED_STATE_RECONNECTING,
        'the rung to record its gateway down',
      );
      assert.ok(health.backoffRemainingMs(topic.toString()) > 0, 'a failing rung must earn a backoff');
      assert.ok(backoffAsked.includes(topic.toString()), 'the poller must consult the backoff before a pass');

      // The load half of the fix: a backed-off rung stops polling the dead gateway rather than
      // hammering it at the flat interval, which was around 160 requests per 30s across four rungs.
      const requestsWhileBackedOff = gateway.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(gateway.requests.length, requestsWhileBackedOff, 'a backed-off rung must stop asking');
    } finally {
      poller.stop([topic]);
    }
  });

  it('reaches the overlay: a ladder outage a subscriber hears as reconnecting', async () => {
    const topic = Topic.fromString('group-1-1080p');
    const gateway = new FakeGateway();
    const health = new FeedHealthTracker(() => 0);

    const seen: FeedState[] = [];
    const unsubscribe = health.subscribe(topic.toString(), (feedState) => seen.push(feedState));

    // Backoff held at zero so the outage is reached quickly; this test is about the state reaching a
    // subscriber, not the pacing, which the test above covers.
    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, health, () => 0);
    poller.start(OWNER, [topic]);

    try {
      await waitFor(() => seen.includes(FEED_STATE_RECONNECTING), 'the overlay to hear reconnecting');
    } finally {
      poller.stop([topic]);
      unsubscribe();
    }

    assert.equal(seen[0], FEED_STATE_LIVE, 'a fresh subscriber starts from live');
    assert.ok(seen.includes(FEED_STATE_RECONNECTING), 'a ladder outage must reach the overlay, not stay silent');
  });

  /**
   * ⭐ The measured defect. Three unrelated faults under a watching ladder viewer on 2026-08-29 each
   * froze the picture for 58.5 to 59.0 seconds, an eight second writer-bee pause included, because
   * every rung that had reached the cap was asleep on a committed timer and could not find out the
   * fault was over. The clock is frozen in both tests below, so nothing any rung is owed can elapse
   * on its own: every millisecond of recovery has to come from a sibling being served.
   */
  describe('coming back from a backoff a fault is already over', () => {
    /** Drives a rung to where the schedule flattens, the way an outage drives it. */
    function holdAtTheCap(health: FeedHealthTracker, hexTopic: string): number {
      const capMs = backoffDelayMs(SETTLED_SCHEDULE_ATTEMPT);
      while (health.backoffRemainingMs(hexTopic) < capMs) {
        health.recordGatewayFailure(hexTopic);
      }
      return capMs;
    }

    it('wakes a rung held at the cap as soon as a sibling rung is served', async () => {
      const served = Topic.fromString('group-1-360p');
      const held = Topic.fromString('group-1-1080p');
      const gateway = new FakeGateway();
      // Both rungs are serveable: the fault is over, which is the whole point. The follow-up 404 is
      // the ordinary case for a viewer who has caught up, and never a fault.
      gateway.missingSlotStatus = 404;
      gateway.publishFeedHead(served, 0, manifest(1));
      gateway.publishFeedHead(held, 0, manifest(1));

      const health = new FeedHealthTracker(() => 0);
      holdAtTheCap(health, held.toString());

      const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, health, (hexTopic) =>
        health.backoffRemainingMs(hexTopic),
      );
      poller.start(OWNER, [served, held]);

      try {
        await waitFor(() => segmentCount(state, served) === 1, 'the sibling rung to be served');
        await waitFor(
          () => segmentCount(state, held) === 1,
          'the held rung to come back on the sibling evidence rather than on its own timer',
        );
      } finally {
        poller.stop([served, held]);
      }
    });

    /**
     * ⛔ The trap in slicing a wait. What the poller is handed is not a deadline, it is a *fresh
     * draw*: `ManifestFetcher` wires it to `RequestJitter.spread`, which randomises a quarter off
     * the top on every call. A loop that re-reads it once per slice therefore re-rolls the dice
     * once per slice, and the separation between two viewers who lost the same gateway in the same
     * instant collapses from a quarter of the whole backoff to a quarter of one slice. That is the
     * decorrelation quietly going away while every test still passes.
     *
     * So the wait is drawn once and counted down locally, and the tracker is asked a different and
     * unjittered question each slice: not how long, but whether the hold still stands.
     */
    it('draws the spread once per backoff, not once per slice of one', async () => {
      const topic = Topic.fromString('group-1-720p');
      const gateway = new FakeGateway();
      gateway.missingSlotStatus = 404;
      gateway.publishFeedHead(topic, 0, manifest(1));

      // Frozen, so the hold stands for the whole of the wait below and nothing returns early. What
      // the poller is owed counts down separately, in real time, so both shapes terminate and what
      // separates them is how often the spread was drawn rather than whether the loop ends.
      const health = new FeedHealthTracker(() => 0);
      health.recordGatewayFailure(topic.toString());

      let draws = 0;
      const jitter = new RequestJitter(0, () => {
        draws++;
        return 1;
      });
      const OWED_MS = 60;
      const SLICE_MS = 5;
      const startedAt = performance.now();
      // Gated on the tracker exactly as production is, so that a hold which has been lifted owes
      // nothing and no second backoff starts. The countdown itself is independent of the tracker's
      // frozen clock, which is what lets the shape this guards against terminate and be counted
      // rather than hang.
      const owedMs = () =>
        health.backoffRemainingMs(topic.toString()) === 0 ? 0 : Math.max(0, OWED_MS - (performance.now() - startedAt));

      const poller = new LadderFeedPoller(state, gateway.fetchResource, SLICE_MS, health, () =>
        jitter.spread(owedMs()),
      );
      poller.start(OWNER, [topic]);

      try {
        await waitFor(() => segmentCount(state, topic) === 1, 'the rung to finish waiting and read');
        assert.equal(draws, 1, `the spread was drawn ${draws} times across one backoff`);
      } finally {
        poller.stop([topic]);
      }
    });

    /**
     * The brake on the wake. Sibling evidence clears the wait but not the failure count, so a rung
     * with a fault of its own is asked again promptly and then no faster than the walk loop asks
     * anything: a rung that keeps failing beside one that keeps succeeding must cost the gateway
     * what one healthy rung costs it, not more.
     */
    it('does not ask a rung with a fault of its own more often than a healthy rung', async () => {
      const served = Topic.fromString('group-1-360p');
      const broken = Topic.fromString('group-1-1080p');
      const gateway = new FakeGateway();
      gateway.missingSlotStatus = 404;
      gateway.publishFeedHead(served, 0, manifest(1));
      gateway.publishFeedHead(broken, 0, manifest(1));
      gateway.unreachableHeads.add(feedHeadPath(broken));

      const health = new FeedHealthTracker(() => 0);
      holdAtTheCap(health, broken.toString());

      const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, health, (hexTopic) =>
        health.backoffRemainingMs(hexTopic),
      );
      poller.start(OWNER, [served, broken]);

      try {
        await waitFor(() => segmentCount(state, served) === 1, 'the sibling rung to be served');
        const brokenAsks = () => gateway.requests.filter((path) => path === feedHeadPath(broken)).length;
        const healthyAsks = () => gateway.requests.filter((path) => path.startsWith('soc/')).length;

        // ⛔ Counted over the whole run rather than over a window opened after the first success,
        // and the reason is a property of the release rather than of the clock. Sibling evidence is
        // recorded on a served READ, and the only served read here is the head: everything after it
        // is a 404 for a slot the publisher has not written, which records nothing either way. So
        // the broken rung is released once, at that first success, and a window opened afterwards
        // can only catch it by luck. It was flaky three runs in eight measured that way.
        const WINDOW_HEALTHY_ASKS = 10;
        await waitFor(
          () => healthyAsks() >= WINDOW_HEALTHY_ASKS,
          `the healthy rung asked ${WINDOW_HEALTHY_ASKS} times`,
        );

        assert.ok(brokenAsks() > 0, 'a rung whose gateway is answering for its siblings was never re-asked');
        assert.ok(
          brokenAsks() <= healthyAsks() + 2,
          `the broken rung was asked ${brokenAsks()} times against ${healthyAsks()} for a healthy one`,
        );
      } finally {
        poller.stop([served, broken]);
      }
    });
  });

  it('does not back off a rung that has merely caught up with the publisher', async () => {
    const topic = Topic.fromString('group-1-480p');
    const gateway = new FakeGateway();
    // The head answers, the next slot 404s: the publisher has not written it yet, the ordinary case
    // for a viewer at the live edge and never a gateway fault.
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const health = new FeedHealthTracker(() => 0);
    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, health, () => 0);
    poller.start(OWNER, [topic]);

    try {
      await waitFor(() => segmentCount(state, topic) === 1, 'the rung to bootstrap');
      await waitFor(() => gateway.requests.filter((p) => p.startsWith('soc/')).length >= 3, 'repeated caught-up polls');

      assert.equal(
        health.state(topic.toString()),
        FEED_STATE_LIVE,
        'a slot not written yet must not read as an outage',
      );
      assert.equal(
        health.backoffRemainingMs(topic.toString()),
        0,
        'a caught-up rung must keep polling at full cadence',
      );
    } finally {
      poller.stop([topic]);
    }
  });
});

/**
 * ⛔ **The half of the overlay a ladder could not reach.** V6, live, 2026-08-29: a viewer's gateway
 * was taken away, the picture froze for 26.6 seconds, and the client rendered nothing at all, which
 * is how it says the feed is live. The viewer was told everything was fine over a frozen frame.
 *
 * The tracker fold is tested in `feedState.test.ts`. This is the wiring, and it is the half that
 * actually failed: the fold is worth nothing unless the poller declares which rungs belong to the
 * group the overlay subscribes to.
 */
describe('LadderFeedPoller telling the viewer the gateway is gone', () => {
  const groupHex = Topic.fromString('group-1').toString();
  let state: ManifestStateManager;

  beforeEach(() => {
    state = new ManifestStateManager();
  });

  it('reports a dark gateway against the group, which is the topic the overlay watches', async () => {
    const topics = ['group-1-360p', 'group-1-720p'].map((t) => Topic.fromString(t));
    const gateway = new FakeGateway();
    const tracker = new FeedHealthTracker();
    const seen: FeedState[] = [];
    tracker.subscribe(groupHex, (feedState) => seen.push(feedState));

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
    poller.start(OWNER, topics, groupHex);

    try {
      await waitFor(() => tracker.state(groupHex) === FEED_STATE_RECONNECTING, 'the group to go reconnecting');
      assert.deepEqual(seen, [FEED_STATE_LIVE, FEED_STATE_RECONNECTING]);
    } finally {
      poller.stop(topics);
    }
  });

  /** A rung still being served is proof the gateway answers, so the overlay must stay down. */
  it('stays quiet while one rung is still being served', async () => {
    const served = Topic.fromString('group-1-360p');
    const dark = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    // An unwritten next slot is a 404 rather than a transport error, which is what "being served"
    // means for a viewer who has caught up with the publisher. Left as the default it would make
    // this rung a second dark one and the test would pass for the wrong reason.
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(served, 0, manifest(1));
    gateway.unreachableHeads.add(feedHeadPath(dark));

    const tracker = new FeedHealthTracker();
    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
    poller.start(OWNER, [served, dark], groupHex);

    try {
      await waitFor(() => tracker.state(dark.toString()) === FEED_STATE_RECONNECTING, 'the dark rung to notice');
      assert.equal(tracker.state(groupHex), FEED_STATE_LIVE);
    } finally {
      poller.stop([served, dark]);
    }
  });

  /** A source torn down and rebuilt starts the new rungs before it stops the old ones. */
  it('keeps the membership while any rung of the group is still walking', async () => {
    const kept = Topic.fromString('group-1-360p');
    const dropped = Topic.fromString('group-1-720p');
    const gateway = new FakeGateway();
    const tracker = new FeedHealthTracker();

    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
    poller.start(OWNER, [kept, dropped], groupHex);
    poller.stop([dropped]);

    try {
      await waitFor(() => tracker.state(groupHex) === FEED_STATE_RECONNECTING, 'the group to still be reporting');
    } finally {
      poller.stop([kept]);
    }
  });
});

/**
 * ⛔⛔⛔ **`stalled` was dead code on every ladder broadcast.** `recordUnservedSlot` appeared zero
 * times in this file until 2026-08-29, so the counter the state reads was permanently zero and no
 * threshold could have made it fire. Sibling of the `reconnecting` fault in `feedState.test.ts`:
 * that one recorded the right thing under a name nobody read, this one never recorded it at all.
 *
 * The two are the whole difference between the faults measured live on 2026-08-29. When the
 * VIEWER's gateway dies the reads fail and the client says `reconnecting`. When the WRITER stops,
 * the viewer's gateway is healthy and simply has nothing new, which is this, and the client said
 * nothing at all for 52.9s, 53.9s and 53.8s across three separate faults.
 */
describe('LadderFeedPoller telling the viewer the publisher has gone quiet', () => {
  const groupHex = Topic.fromString('group-1').toString();
  let state: ManifestStateManager;

  beforeEach(() => {
    state = new ManifestStateManager();
  });

  it('counts a rung whose next slot is not written yet, so the state can be reached at all', async () => {
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const tracker = new FeedHealthTracker();
    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
    poller.start(OWNER, [topic], groupHex);

    try {
      await waitFor(() => tracker.unservedPollsRecorded(topic.toString()) > 0, 'the rung to record its unserved slot');
    } finally {
      poller.stop([topic]);
    }
  });

  /** A 404 is the publisher being behind. It must never be counted as the gateway failing. */
  it('does not turn an unwritten slot into a gateway fault', async () => {
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const tracker = new FeedHealthTracker();
    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
    poller.start(OWNER, [topic], groupHex);

    try {
      await waitFor(() => tracker.unservedPollsRecorded(topic.toString()) > 2, 'a run of unserved polls to build up');
      assert.equal(tracker.state(groupHex), FEED_STATE_LIVE, 'a caught-up viewer was told something was wrong');
      assert.equal(tracker.backoffRemainingMs(topic.toString()), 0, 'a caught-up rung was backed off');
    } finally {
      poller.stop([topic]);
    }
  });

  it('ends the run when the rung is served again', async () => {
    const topic = Topic.fromString('group-1-360p');
    const gateway = new FakeGateway();
    gateway.missingSlotStatus = 404;
    gateway.publishFeedHead(topic, 0, manifest(1));

    const tracker = new FeedHealthTracker();
    const poller = new LadderFeedPoller(state, gateway.fetchResource, POLL_MS, tracker);
    poller.start(OWNER, [topic], groupHex);

    // A long run before the slot lands, and a generous drop after it. At this poll interval the
    // walk is back on the NEXT unwritten slot within milliseconds, so watching for the count to
    // reach exactly zero is watching for a window that closes before it can be observed.
    const LONG_RUN = 20;

    try {
      await waitFor(() => tracker.unservedPollsRecorded(topic.toString()) > LONG_RUN, 'a long run to build up');
      gateway.publishSoc(topic, 1, manifest(2));
      await waitFor(
        () => tracker.unservedPollsRecorded(topic.toString()) < LONG_RUN / 2,
        'the served slot to end the unserved run',
      );
    } finally {
      poller.stop([topic]);
    }
  });
});
