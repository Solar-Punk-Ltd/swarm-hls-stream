import { FeedIndex, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { LadderFeedPoller } from '../src/components/SwarmHlsPlayer/LadderFeedPoller.js';
import { ManifestStateManager } from '../src/components/SwarmHlsPlayer/ManifestState.js';
import { parseManifest } from '../src/components/SwarmHlsPlayer/playlist.js';
import { makeFeedIdentifier } from '../src/utils/bee.js';

const OWNER = 'aabbcc';
const POLL_MS = 2;

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

/**
 * Serves whatever has been published so far and 404s the rest, which is exactly how a feed behaves
 * while a stream is running: the next index does not exist yet, and then it does.
 */
class FakeGateway {
  public readonly responses = new Map<string, string>();
  public readonly requests: string[] = [];
  /** Reproduces a proxy that drops the header extractFeedIndex needs, which makes it throw. */
  public stripFeedIndexHeader = false;

  private readonly held = new Map<string, Promise<void>>();

  publishFeedHead(topic: Topic, index: number, body: string): void {
    this.responses.set(`feeds/${OWNER}/${topic.toString()}`, body);
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

  fetchResource = async (path: string): Promise<Response> => {
    this.requests.push(path);

    const blocked = this.held.get(path);
    if (blocked) {
      await blocked;
    }

    const body = this.responses.get(path);
    if (body === undefined) {
      throw new Error(`Failed to fetch: ${path}`);
    }

    const headers = new Headers();
    const feedMatch = /^feeds\/[^/]+\/(.+)$/.exec(path);
    if (feedMatch && !this.stripFeedIndexHeader) {
      headers.set('Swarm-Feed-Index', this.responses.get(`__index__${feedMatch[1]}`) ?? '0');
    }

    return new Response(body, { status: 200, headers });
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
