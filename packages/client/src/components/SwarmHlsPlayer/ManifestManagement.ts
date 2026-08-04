import { FeedIndex, Topic } from '@ethersphere/bee-js';
import {
  HLS_DISCONTINUITY,
  HLS_ENDLIST,
  HLS_MEDIA_SEQUENCE,
  HLS_MEDIA_SEQUENCE_ZERO,
  HLS_PLAYLIST_TYPE,
  HLS_PLAYLIST_TYPE_EVENT,
  parseManifest,
  type Segment,
} from '@swarm-hls-stream/shared';
import Pqueue from 'p-queue';

import { config } from '@/utils/config';
import { fetchWithTimeout, TimedResponse } from '@/utils/fetchWithTimeout';

import { FeedHealthTracker, UNSERVED_SLOT_POLL_LIMIT } from './feedState';

// The parser and the segment shape now live beside the tags the uploader builds with, so the two
// halves of the manifest contract cannot drift apart. Re-exported because the player's own modules
// and tests import them from here. See ARCH-1.
export { parseManifest, type Segment };

interface TopicState {
  index: FeedIndex | null;
  headers: string[];
  segments: Segment[];
  segmentUris: Set<string>;
  isFinalized: boolean;
  dirty: boolean;
  cachedManifest: string;
}

const manifestQueue = new Pqueue({ concurrency: 1 });

/**
 * The gateway has no head for this feed at the moment, on a topic whose head this player has already
 * read at least once. Ordinary rather than an error, so it is not logged as a failure and it sets no
 * backoff: the viewer has to keep asking at full cadence to see the next segment the moment it lands.
 */
const FEED_HEAD_UNRESOLVED = 404;

/**
 * The wait the fetcher ships with, named so that something can run it.
 *
 * As an inline default parameter it was the one code path every backoff test injected over, so a
 * default that returned immediately left the whole suite green while a page of players hammered a
 * gateway that was already down.
 */
export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A response that arrived and was refused, as opposed to a transport failure or a timeout. */
class ManifestFetchError extends Error {
  constructor(path: string, readonly status: number) {
    super(`Failed to fetch: ${path}`);
    this.name = 'ManifestFetchError';
  }
}

export class ManifestStateManager {
  private static instance: ManifestStateManager;
  private topics: Map<string, TopicState> = new Map();
  private generations: Map<string, number> = new Map();

  private constructor() {}

  static getInstance(): ManifestStateManager {
    if (!ManifestStateManager.instance) {
      ManifestStateManager.instance = new ManifestStateManager();
    }
    return ManifestStateManager.instance;
  }

  getIndex(topicId: string): FeedIndex | null {
    return this.topics.get(topicId)?.index ?? null;
  }

  setIndex(topicId: string, index: FeedIndex | null): void {
    this.getOrCreateTopicState(topicId).index = index;
  }

  updateManifest(topicId: string, headers: string[], segments: Segment[], isFinalized: boolean): boolean {
    const state = this.getOrCreateTopicState(topicId);

    if (state.isFinalized) {
      return false;
    }

    if (isFinalized) {
      state.headers = headers;
      state.segments = segments;
      state.segmentUris = new Set(segments.map((s) => s.uri));
      state.isFinalized = true;
      state.dirty = true;
      return false;
    }

    if (state.headers.length === 0) {
      state.headers = this.normalizeHeaders(headers);
    }

    const newSegments = segments.filter((s) => !state.segmentUris.has(s.uri));
    if (newSegments.length === 0) {
      return true;
    }

    for (const seg of newSegments) {
      state.segments.push(seg);
      state.segmentUris.add(seg.uri);
    }
    state.dirty = true;

    return true;
  }

  serialize(topicId: string, bytesUrl: string): string {
    const state = this.topics.get(topicId);
    if (!state || state.segments.length === 0) {
      return '';
    }

    if (!state.dirty) {
      return state.cachedManifest;
    }

    const lines: string[] = [...state.headers];

    if (!state.headers.some((h) => h.startsWith(HLS_PLAYLIST_TYPE))) {
      lines.push(HLS_PLAYLIST_TYPE_EVENT);
    }

    for (const seg of state.segments) {
      if (seg.discontinuity) {
        lines.push(HLS_DISCONTINUITY);
      }
      lines.push(seg.extinf);
      lines.push(this.buildUri(seg.uri, bytesUrl));
    }

    if (state.isFinalized) {
      lines.push(HLS_ENDLIST);
    }

    state.cachedManifest = lines.join('\n');
    state.dirty = false;
    return state.cachedManifest;
  }

  markAllDirty(): void {
    for (const state of this.topics.values()) {
      state.dirty = true;
    }
  }

  /**
   * How many times this topic has been torn down.
   *
   * The one thing about a topic that has to outlive the topic, so that a fetch issued before a
   * teardown can tell that it was. The follow-up path can compare feed indices instead, because it
   * pins one before it starts; the initial path has no index yet by definition, and after a teardown
   * a resurrected topic and a genuinely new one are otherwise identical.
   */
  generation(topicId: string): number {
    return this.generations.get(topicId) ?? 0;
  }

  clear(topicId?: string): void {
    if (topicId) {
      this.topics.delete(topicId);
      this.generations.set(topicId, this.generation(topicId) + 1);
    } else {
      for (const id of this.topics.keys()) {
        this.generations.set(id, this.generation(id) + 1);
      }
      this.topics.clear();
    }
  }

  private getOrCreateTopicState(topicId: string): TopicState {
    if (!this.topics.has(topicId)) {
      this.topics.set(topicId, {
        index: null,
        headers: [],
        segments: [],
        segmentUris: new Set(),
        isFinalized: false,
        dirty: true,
        cachedManifest: '',
      });
    }
    return this.topics.get(topicId)!;
  }

  private normalizeHeaders(headers: string[]): string[] {
    return headers.map((h) => (h.startsWith(HLS_MEDIA_SEQUENCE) ? HLS_MEDIA_SEQUENCE_ZERO : h));
  }

  private buildUri(uri: string, bytesUrl: string): string {
    if (!bytesUrl || uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('/bytes/')) {
      return uri;
    }
    return `${bytesUrl}/${uri}`;
  }
}

export class ManifestFetcher {
  private _beeUrl: string = config.beeUrl;

  /** Topics with a follow-up fetch outstanding. Keyed by hex topic, since each feed advances alone. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly stateManager: ManifestStateManager = ManifestStateManager.getInstance(),
    /** Shared with whatever renders the state, so both halves see one reading. */
    readonly feedHealth: FeedHealthTracker = new FeedHealthTracker(),
    /** Injected only by tests, so a backoff is asserted rather than waited out. */
    private readonly delay: (ms: number) => Promise<void> = waitMs,
  ) {}

  get beeUrl(): string {
    return this._beeUrl;
  }

  set beeUrl(url: string) {
    this._beeUrl = url;
  }

  async fetch(url: string): Promise<string> {
    const [owner, topicPart] = url.split('/');
    const topic = Topic.fromString(topicPart);

    if (!this.stateManager.getIndex(topic.toString())) {
      return this.handleInitialFetch(owner, topic);
    }
    return this.handleFollowupFetch(owner, topic);
  }

  /**
   * The path every mount takes, and every restart with it, since the player's effect cleanup clears
   * the topic. A gateway outage causes a fatal error, a fatal error causes a restart, so this is
   * where an outage is most likely to be met, not the follow-up path it was first guarded on.
   *
   * The backoff is waited out rather than skipped. This method is awaited by the loader and there is
   * no serialised state to answer with in its place, and an empty manifest is a fatal parse error
   * that restarts the player straight back into here. Taking longer is what actually slows it down.
   */
  private async handleInitialFetch(owner: string, topic: Topic): Promise<string> {
    const hexTopic = topic.toString();

    const backoffMs = this.feedHealth.backoffRemainingMs(hexTopic);
    if (backoffMs > 0) {
      await this.delay(backoffMs);
    }

    // Every status counts as a failure here, 404 included. Both paths now ask for the head, but this
    // one is the first thing a mount does and has no serialised state to fall back on, so a gateway
    // with no answer is this player having nothing to play rather than a poll that came up empty.
    //
    // So does anything else that stops this call producing a playlist. The alternative is worse than
    // it looks: an empty manifest reaches hls.js as a fatal parse error, which restarts the player
    // straight back into this method, and a gateway recorded as healthy imposes no backoff on that
    // loop and says nothing to the viewer. A 200 carrying a captive portal's HTML does exactly that.
    const path = `feeds/${owner}/${hexTopic}`;
    const generation = this.stateManager.generation(hexTopic);
    try {
      const res = await this.fetchResource(path);

      // The follow-up path pins an index and refuses to write across a teardown. This path has no
      // index to pin, so it pins the generation instead, and it needs the guard more: the wait above
      // can hold it open for the whole backoff, and the outage that sets that backoff is what drives
      // the restart that tears the topic down. Writing anyway recreates the cleared topic at a
      // pre-teardown head, and an index that exists is what routes the next mount into the follow-up
      // path, which never resyncs to the live edge.
      if (this.stateManager.generation(hexTopic) !== generation) {
        throw new Error(`Topic ${hexTopic} was torn down while its first fetch was in flight`);
      }

      const parsed = parseManifest(res.text);
      const shouldContinue = this.stateManager.updateManifest(
        hexTopic,
        parsed.headers,
        parsed.segments,
        parsed.isFinalized,
      );

      // Checked before the index is committed, not after. An index is what routes the next poll to
      // the follow-up path, so committing one for a response that yielded no playlist strands the
      // topic there, answering every poll with the same empty string and never asking the head again.
      const manifest = this.stateManager.serialize(hexTopic, `${this._beeUrl}/bytes`);
      if (!manifest) {
        throw new ManifestFetchError(path, res.status);
      }
      if (shouldContinue) {
        this.stateManager.setIndex(hexTopic, this.extractIndex(res));
      }

      // Reachable rather than served. This endpoint answers with the publisher's last update, so it
      // answers the same for a live broadcast and one that stopped an hour ago, and treating it as a
      // served slot would erase an unserved run on the one path every restart takes.
      this.feedHealth.recordGatewayReachable(hexTopic);
      return manifest;
    } catch (error) {
      this.feedHealth.recordGatewayFailure(hexTopic);
      throw error;
    }
  }

  /**
   * Every poll after the first, asking the feed endpoint for whatever the head is now rather than
   * computing the address of the slot after the one already held.
   *
   * **Asking a bee node for a feed index before the publisher has written it makes that index
   * unretrievable for 30 to 45 seconds after it is written**, which is what this method used to do on
   * nearly every poll. Measured across four consecutive freezes: the slot being hammered answered 404
   * in a constant 196ms, slots two to ten past it that nothing had ever asked for answered 200 in
   * about 230ms, and slots twenty and forty past it, which genuinely did not exist, took about 900ms
   * to say so. Three timing classes, and the constant one is a remembered answer rather than a
   * search. A viewer who has caught up with the publisher asks for the next slot before it is
   * written, so this poisoned nearly every slot of its own stream and the feed froze for 30 to 45
   * seconds on a 63 second cycle. Segments were never affected because they are only fetched after a
   * manifest names them. See LAT-10.
   *
   * Reading the head also removes the ceiling the speculative walk carried. One slot consumed per
   * poll against one slot written per segment is zero margin by construction, so a viewer who fell
   * behind stayed exactly that far behind for the rest of the broadcast and every freeze added to it.
   * A head read clears the whole backlog on the next poll that succeeds.
   */
  private async handleFollowupFetch(owner: string, topic: Topic): Promise<string> {
    const hexTopic = topic.toString();

    // One outstanding follow-up per topic. This method is fire and forget by design: it returns the
    // already serialised state at once and leaves the fetch running, so hls.js schedules its next
    // level reload on the ordinary cadence while the previous fetch is still open. See CON-29.
    if (!this.inFlight.has(hexTopic) && this.feedHealth.backoffRemainingMs(hexTopic) === 0) {
      // Pinned here rather than read again in the callback, so that the write below applies only to
      // the state it was computed from. See the teardown guard it feeds.
      const fromIndex = this.stateManager.getIndex(hexTopic)!;

      this.inFlight.add(hexTopic);
      this.fetchResource(`feeds/${owner}/${hexTopic}`)
        .then((res) => {
          // Before the queue, because a response with no readable index is a fact about the response
          // rather than about the state, and it belongs to the gateway-failure path below.
          const headIndex = this.extractIndex(res);

          return manifestQueue.add(() => {
            // Nothing cancels this request. `SwarmHlsPlayer`'s effect cleanup calls
            // `ManifestStateManager.clear(topic)` and then `hls.destroy()`, on unmount and on every
            // `restartTrigger` bump, which is the recovery path for a fatal player error and so
            // fires exactly when a fetch is already slow. A response that lands after that would
            // otherwise recreate the topic it was issued against and stamp a pre-teardown index on
            // it, which strands the next mount behind a head this response can no longer vouch for.
            if (this.stateManager.getIndex(hexTopic)?.toBigInt() !== fromIndex.toBigInt()) {
              return;
            }

            // A head that has not moved is the ordinary case for a viewer who has caught up, and it
            // is the case the 404 used to be before this asked for the head. Counted as an unserved
            // poll rather than a served one, because the gateway answering says nothing about
            // whether the feed is advancing: it answers identically for a broadcast in progress and
            // one that stopped an hour ago. `<=` rather than `!==` so a gateway answering from a
            // stale cache can never drag the player backwards.
            if (headIndex.toBigInt() <= fromIndex.toBigInt()) {
              this.reportStalledFeed(hexTopic, headIndex);
              return;
            }

            // Inside the guard, unlike the failure below. A response that outlived its topic says
            // the gateway was answering before a teardown this fetch is older than, and the mount
            // that replaced it has its own initial fetch to say whether it still is.
            this.feedHealth.recordGatewayResponse(hexTopic);

            const parsed = parseManifest(res.text);
            const shouldContinue = this.stateManager.updateManifest(
              hexTopic,
              parsed.headers,
              parsed.segments,
              parsed.isFinalized,
            );
            if (shouldContinue) {
              this.stateManager.setIndex(hexTopic, headIndex);
            }
          });
        })
        .catch((error) => {
          if (error instanceof ManifestFetchError && error.status === FEED_HEAD_UNRESOLVED) {
            this.reportStalledFeed(hexTopic, fromIndex);
            return;
          }
          // Deliberately outside the generation guard the success path sits inside. A gateway that
          // did not answer is a fact about the gateway rather than about the topic generation, and
          // it is the fact worth keeping across the teardown, because the restart that discards the
          // topic is itself what a fatal network error triggers.
          this.feedHealth.recordGatewayFailure(hexTopic);
          console.error('Error fetching follow-up manifest:', error);
        })
        // Released only once the state update has run, since the queue's promise is what the chain
        // above resolves on. Releasing at response time would cost a duplicate request rather than a
        // wrong index, because the index is pinned. It has to be released on the failure path too,
        // or one poll that met a gateway with no head for the feed would end the broadcast for this
        // viewer. That comes from sitting after the `catch` rather than from `finally`, which by
        // then has no rejection left to see.
        .finally(() => {
          this.inFlight.delete(hexTopic);
        });
    }

    return this.stateManager.serialize(hexTopic, `${this._beeUrl}/bytes`);
  }

  /**
   * A single poll that brought back no new head is the ordinary case and says nothing. A long run of
   * them is a different event wearing the same shape: a publisher that stopped, a lapsed stamp, or a
   * gateway that cannot resolve this feed. The only symptom that reaches anyone otherwise is the
   * buffer running dry, which the player reports as a media error rather than a feed one.
   *
   * Run length is the axis, because neither the status nor the index is one on its own. The run is
   * not backed off, because a viewer who has merely caught up with the publisher sees one of these
   * on nearly every poll and has to keep asking at full cadence to see the next segment the moment
   * it lands. Reported once per run, since the poll that reports it is followed by another a target
   * duration later.
   */
  private reportStalledFeed(hexTopic: string, head: FeedIndex): void {
    const polls = this.feedHealth.recordUnservedSlot(hexTopic);

    if (polls === UNSERVED_SLOT_POLL_LIMIT) {
      console.error(
        `Feed ${hexTopic} has not advanced past slot ${head.toBigInt()} in ${polls} polls. ` +
          'The publisher may have stopped, or this gateway may not be able to resolve the feed.',
      );
    }
  }

  private async fetchResource(path: string): Promise<TimedResponse> {
    const response = await fetchWithTimeout(`${this._beeUrl}/${path}`);
    if (!response.ok) {
      throw new ManifestFetchError(path, response.status);
    }
    return response;
  }

  private extractIndex(response: TimedResponse): FeedIndex {
    const hex = response.headers.get('Swarm-Feed-Index');
    if (!hex) {
      throw new Error('Missing feed index header');
    }
    return FeedIndex.fromBigInt(BigInt(`0x${hex}`));
  }
}
