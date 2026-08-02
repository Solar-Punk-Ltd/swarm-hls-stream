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

import { makeFeedIdentifier } from '@/utils/bee';
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
 * A feed slot the publisher has not written yet, which is what a viewer who has caught up sees on
 * nearly every poll. Ordinary, so it is not logged as a failure and the next poll asks again.
 */
const SLOT_NOT_WRITTEN_YET = 404;

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

  clear(topicId?: string): void {
    if (topicId) {
      this.topics.delete(topicId);
    } else {
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
    private readonly delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

    let res: TimedResponse;
    try {
      res = await this.fetchResource(`feeds/${owner}/${hexTopic}`);
    } catch (error) {
      // Every status counts here, 404 included. On the follow-up path a 404 means the publisher has
      // not written the next slot yet, which is ordinary; this request asks for the feed's head, so
      // nothing being there is the gateway having no answer at all.
      this.feedHealth.recordGatewayFailure(hexTopic);
      throw error;
    }
    // Reachable rather than served. This endpoint answers with the publisher's last update, so it
    // answers the same for a live broadcast and one that stopped an hour ago, and treating it as a
    // served slot would erase an unserved run on the one path every restart takes.
    this.feedHealth.recordGatewayReachable(hexTopic);

    const parsed = parseManifest(res.text);
    const shouldContinue = this.stateManager.updateManifest(
      hexTopic,
      parsed.headers,
      parsed.segments,
      parsed.isFinalized,
    );
    if (shouldContinue) {
      this.stateManager.setIndex(hexTopic, this.extractIndex(res));
    }

    return this.stateManager.serialize(hexTopic, `${this._beeUrl}/bytes`);
  }

  private async handleFollowupFetch(owner: string, topic: Topic): Promise<string> {
    const hexTopic = topic.toString();

    // One outstanding follow-up per topic. This method is fire and forget by design: it returns the
    // already serialised state at once and leaves the fetch running, so hls.js schedules its next
    // level reload on the ordinary cadence while the previous fetch is still open. See CON-29.
    if (!this.inFlight.has(hexTopic) && this.feedHealth.backoffRemainingMs(hexTopic) === 0) {
      // Pinned here rather than read again in the callback. Two callbacks that each advance from
      // whatever index they find advance twice for one slot fetched, and the slot in between is
      // never requested at all, so its segments never reach the viewer. The second callback used to
      // reach that line rather than stopping short, because `updateManifest` answers `true` to a
      // duplicate parse, where "nothing new, keep polling" and "this slot was consumed" are the same
      // value read two ways.
      const fromIndex = this.stateManager.getIndex(hexTopic)!;
      const targetIndex = fromIndex.next();
      const targetId = makeFeedIdentifier(topic, targetIndex).toString();

      this.inFlight.add(hexTopic);
      this.fetchResource(`soc/${owner}/${targetId}`)
        .then((res) => {
          return manifestQueue.add(() => {
            // Nothing cancels this request. `SwarmHlsPlayer`'s effect cleanup calls
            // `ManifestStateManager.clear(topic)` and then `hls.destroy()`, on unmount and on every
            // `restartTrigger` bump, which is the recovery path for a fatal player error and so
            // fires exactly when a fetch is already slow. A response that lands after that would
            // otherwise recreate the topic it was issued against and stamp a pre-teardown index on
            // it, and an index that exists is what routes the next mount into this method instead
            // of `handleInitialFetch`, the only path that resyncs to the live head. So the write
            // only applies to the state it was computed from.
            if (this.stateManager.getIndex(hexTopic)?.toBigInt() !== fromIndex.toBigInt()) {
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
              this.stateManager.setIndex(hexTopic, targetIndex);
            }
          });
        })
        .catch((error) => {
          if (error instanceof ManifestFetchError && error.status === SLOT_NOT_WRITTEN_YET) {
            this.reportStalledFeed(hexTopic, targetIndex);
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
        // or one poll that outran the publisher would end the broadcast for this viewer, and a
        // caught-up viewer gets a 404 on nearly every poll. That comes from sitting after the
        // `catch` rather than from `finally`, which by then has no rejection left to see.
        .finally(() => {
          this.inFlight.delete(hexTopic);
        });
    }

    return this.stateManager.serialize(hexTopic, `${this._beeUrl}/bytes`);
  }

  /**
   * A single unserved slot is the ordinary case and says nothing. A long run of them is a different
   * event wearing the same status code: a chunk that never synced, a lapsed stamp, or a gateway that
   * will not serve this slot. The feed is then stuck there for good while later slots exist, and the
   * only symptom that reaches anyone is the buffer running dry, which the player reports as a media
   * error rather than a feed one.
   *
   * Run length is the axis, because the status code is not one. The run is not backed off, because a
   * viewer who has merely caught up with the publisher sees one of these on nearly every poll and
   * has to keep asking at full cadence to see the next segment the moment it lands. Reported once
   * per run, since the poll that reports it is followed by another a target duration later.
   */
  private reportStalledFeed(hexTopic: string, slot: FeedIndex): void {
    const polls = this.feedHealth.recordUnservedSlot(hexTopic);

    if (polls === UNSERVED_SLOT_POLL_LIMIT) {
      console.error(
        `Feed ${hexTopic} has not advanced past slot ${slot.toBigInt()} in ${polls} polls. ` +
          'The publisher may have stopped, or this gateway may not hold that slot.',
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
