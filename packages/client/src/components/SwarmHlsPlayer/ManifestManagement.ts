import { FeedIndex, Topic } from '@ethersphere/bee-js';
import {
  extractFeedIndex,
  HLS_DISCONTINUITY,
  HLS_ENDLIST,
  HLS_GAP,
  HLS_PLAYLIST_TYPE,
  HLS_PLAYLIST_TYPE_EVENT,
  nextFeedRequest,
  parseManifest,
  type Segment,
} from '@swarm-hls-stream/shared';
import Pqueue from 'p-queue';

import { Rendition } from '@/types/stream';
import { config } from '@/utils/config';
import { fetchWithTimeout, TimedResponse } from '@/utils/fetchWithTimeout';
import { RequestJitter } from '@/utils/requestJitter';

import { FEED_RETURN_WATCH_INTERVAL_MS, FeedReturnWatch, feedReturnWatchWaitMs } from './feedReturn';
import { FeedHealthTracker, UNSERVED_POLLS_PROBE_CEILING } from './feedState';
import { LadderFeedPoller } from './LadderFeedPoller';
import { absoluteBytesBase, buildMasterPlaylist, isMasterPlaylist, masterVariants, parseSwarmUri } from './playlist';
import { isSlotNotWrittenYet, ManifestFetchError, probePastRefusal, shouldProbePastRefusal } from './refusedSlot';

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
  /**
   * The gateway {@link ManifestStateManager.serialize} built {@link cachedManifest} against.
   *
   * ⛔ Every segment line in a serialized playlist is prefixed with this, so a cached manifest is
   * only valid for the gateway that produced it. Without it, `serialize` takes the gateway as an
   * argument and then ignores it on every cache hit.
   */
  cachedBytesUrl: string;
}

const manifestQueue = new Pqueue({ concurrency: 1 });

/**
 * How many feed slots one poll may walk before handing control back.
 *
 * A poll walks until the publisher's head, so this is reached only by a viewer catching up on a
 * backlog: a hidden tab, a slow gateway, a stretch of failed polls. Live it is never approached,
 * because hls.js reloads a live playlist about once per segment and the publisher writes about one
 * slot in that time.
 *
 * The cost of a large value is that the topic stays marked in flight for the whole walk, and the
 * teardown that a fatal error triggers lands in the middle of one. Sixteen slots at the round trips
 * measured on this deployment, 51 to 72ms, is about a second of walking, and it recovers four
 * seconds of a 0.25s stream per poll, which outruns a publisher writing in real time by enough to
 * close any backlog within a few polls.
 */
export const MAX_SLOTS_PER_POLL = 16;

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

export class ManifestStateManager {
  private static instance: ManifestStateManager;
  private topics: Map<string, TopicState> = new Map();
  private generations: Map<string, number> = new Map();
  /** What to call when each topic is next torn down. See {@link onTeardown}. */
  private teardowns: Map<string, Set<() => void>> = new Map();

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

  /**
   * Whether this topic holds anything a player could be handed.
   *
   * Read rather than inferred from `updateManifest`'s answer, which is "keep polling" and is `true`
   * for a topic still holding nothing. {@link LadderFeedPoller} waits on this before reporting a
   * rung ready, so a first playlist request blocks until there is a playlist rather than being
   * answered with an empty string.
   */
  hasSegments(topicId: string): boolean {
    return (this.topics.get(topicId)?.segments.length ?? 0) > 0;
  }

  updateManifest(topicId: string, headers: string[], segments: Segment[], isFinalized: boolean): boolean {
    const state = this.getOrCreateTopicState(topicId);

    if (state.isFinalized) {
      return false;
    }

    // Above the finalized branch, because a viewer who opens a broadcast that already ended never
    // meets an open playlist at all: the feed head is the recording, so a finished manifest is the
    // only thing they will ever be offered a header by. Taken from one, `serialize` emits a body
    // with no `#EXTM3U`, which hls.js refuses whole as `Missing format identifier #EXTM3U` and
    // reports as a fatal error, and the player answers a fatal error by remounting into the same
    // manifest. A viewer sees a recording that never starts.
    //
    // Kept exactly as the uploader wrote them rather than renumbered. The header that matters is
    // EXT-X-MEDIA-SEQUENCE, the sequence the publisher gave the oldest segment in this first
    // playlist. It used to be rewritten to zero, which reads fine for one playlist on its own but is
    // wrong across a ladder: the publisher derives that number and each segment's
    // EXT-X-PROGRAM-DATE-TIME from one anchor the whole ladder shares, so a viewer renumbering its
    // own copy per rung puts four rungs back into disagreement about the same media. A viewer who
    // joined mid-broadcast holds a window that starts later than one who joined at the top, and
    // rewriting both to zero is exactly the claim that they cover the same instant.
    if (state.headers.length === 0) {
      state.headers = [...headers];
    }

    if (isFinalized) {
      // Extended, never replaced. The captured headers carry the engine's media sequence for the
      // first segment this viewer held, and everything appended after it is contiguous, so that
      // number stays the sequence of the playlist's first segment for the whole session. Changing
      // the front of the list would change what every number already handed to hls.js refers to,
      // which it reports as a media sequence mismatch, and both finished playlists would cause it:
      // the closing one is a live window and starts later than a viewer who joined earlier, while the
      // recording names every segment and starts earlier than a viewer who joined partway through.
      this.appendAfterLastHeld(state, segments);
      state.isFinalized = true;
      state.dirty = true;
      return false;
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

  /**
   * Add whatever a playlist carries after the last segment this viewer already holds.
   *
   * The overlap is found by segment address rather than by position, because the two lists start in
   * different places: a finished playlist that shares no segment with this one is a different
   * playlist of the same broadcast, and is ignored rather than concatenated onto the end.
   *
   * A gap entry works as an overlap point like any other. The publisher names each hole `gap-` and
   * its own sequence, so the address is unique to that hole and identical in every playlist naming
   * it, which is what both this and the URI keying in {@link updateManifest} rely on.
   */
  private appendAfterLastHeld(state: TopicState, segments: Segment[]): void {
    const lastHeld = state.segments[state.segments.length - 1]?.uri;
    const overlap = lastHeld === undefined ? -1 : segments.findIndex((seg) => seg.uri === lastHeld);
    if (lastHeld !== undefined && overlap === -1) {
      return;
    }

    for (const seg of segments.slice(overlap + 1)) {
      state.segments.push(seg);
      state.segmentUris.add(seg.uri);
    }
  }

  serialize(topicId: string, bytesUrl: string): string {
    const state = this.topics.get(topicId);
    if (!state || state.segments.length === 0) {
      return '';
    }

    // ⛔⛔⛔ The gateway is part of the cache key, not just an argument. A viewer who changes gateway
    // through `setGatewayUrl` is covered by `markAllDirty`, but anything that changes it another way
    // was silently served the previous gateway's playlist. On 2026-08-13 that put every segment of
    // both arms of a funded-versus-unfunded sitting on the SAME node while the client truthfully
    // reported two different gateways, which would have reported that funding does not matter.
    if (!state.dirty && state.cachedBytesUrl === bytesUrl) {
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
      // Written back or hls.js loads the entry. The publisher lists a sequence it lost as an entry
      // rather than leaving it out, so the numbering behind the hole never moves, and this tag is the
      // only thing saying the entry names no media. Without it hls.js builds an ordinary fragment,
      // fetches a URI that resolves to nothing, and the viewer meets a load error where the publisher
      // had already said there was nothing to load. With it, `frag.gap` is set and the fragment is
      // skipped.
      if (seg.gap) {
        lines.push(HLS_GAP);
      }
      // Passed through exactly as the publisher wrote it, never recomputed. It is the publisher's
      // one statement of when this media happened, derived there from a single anchor the whole
      // ladder shares, and a viewer rebuilding it from its own arrival times would hand hls.js four
      // rungs that disagree about the same segment. Absent on a recording published before the
      // uploader stamped them, where there is nothing to pass on.
      if (seg.programDateTime) {
        lines.push(seg.programDateTime);
      }
      lines.push(seg.extinf);
      lines.push(seg.gap ? seg.uri : this.buildUri(seg.uri, bytesUrl));
    }

    if (state.isFinalized) {
      lines.push(HLS_ENDLIST);
    }

    state.cachedManifest = lines.join('\n');
    state.cachedBytesUrl = bytesUrl;
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

  /**
   * Have `onTornDown` called the next time this topic is torn down, once.
   *
   * ⛔ The push half of what {@link generation} answers by pull, for the one kind of work a pull cannot
   * reach. A fetch in flight compares generations when it lands, which is enough for anything that
   * runs to its end. A timer between two ticks runs nothing that could compare anything, so work that
   * only pulled would stay scheduled past a teardown for as long as its interval. A finished feed's
   * watch waits thirty seconds between asks, and this is what ends it at the teardown itself.
   *
   * @returns Lets go of the callback, for work that ends on its own before the topic is torn down.
   */
  onTeardown(topicId: string, onTornDown: () => void): () => void {
    const forTopic = this.teardowns.get(topicId) ?? new Set<() => void>();
    forTopic.add(onTornDown);
    this.teardowns.set(topicId, forTopic);

    return () => {
      forTopic.delete(onTornDown);
      if (forTopic.size === 0 && this.teardowns.get(topicId) === forTopic) {
        this.teardowns.delete(topicId);
      }
    };
  }

  clear(topicId?: string): void {
    if (topicId) {
      this.topics.delete(topicId);
      this.generations.set(topicId, this.generation(topicId) + 1);
      this.endWorkOf([topicId]);
    } else {
      for (const id of this.topics.keys()) {
        this.generations.set(id, this.generation(id) + 1);
      }
      this.topics.clear();
      // Every topic with work bound to it, whether or not it holds state, since the work is what has
      // to end and holding state is a separate fact about a topic.
      this.endWorkOf([...this.teardowns.keys()]);
    }
  }

  /** Ends whatever {@link onTeardown} bound to these topics, after the teardown itself is done. */
  private endWorkOf(topicIds: string[]): void {
    for (const topicId of topicIds) {
      const forTopic = this.teardowns.get(topicId);
      this.teardowns.delete(topicId);
      for (const onTornDown of [...(forTopic ?? [])]) {
        try {
          onTornDown();
        } catch (error) {
          // One piece of work failing to end must not keep the rest of the teardown from ending theirs.
          console.error(`Ending work bound to ${topicId} threw:`, error);
        }
      }
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
        cachedBytesUrl: '',
      });
    }
    return this.topics.get(topicId)!;
  }

  /**
   * Re-hosts a segment against this viewer's gateway, which is what makes the gateway theirs to pick.
   *
   * ⛔⛔ The absolute and rooted branches look dead and are not. The uploader writes a bare reference
   * and has done since 2026-08-13, but a recording keeps the manifest it was published with, so every
   * broadcast recorded before then names an absolute `http://<host>/bytes/<ref>` for ever. Deleting
   * these branches would send those segments to `<viewer gateway>/bytes/http://...`.
   *
   * ⚠️ It is also why those recordings still fetch from the publisher's gateway no matter what their
   * viewer configured. That cannot be repaired from this side: the address is in the published bytes.
   *
   * ⛔ A gap entry never reaches here. Its URI names nothing fetchable, so re-hosting it would put a
   * real host in front of a token that stands for missing media, and every later reader would have to
   * strip the host back off to see what it was. {@link serialize} passes it through instead.
   */
  private buildUri(uri: string, bytesUrl: string): string {
    if (!bytesUrl || uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('/bytes/')) {
      return uri;
    }
    return `${bytesUrl}/${uri}`;
  }
}

/** A stream's ABR ladder, as the loader needs it: who owns the feeds, and what the rungs are. */
interface LadderSource {
  owner: string;
  renditions: Rendition[];
}

/**
 * Resolved when the master is actually asked for, not when the ladder is registered.
 *
 * The uploader keeps correcting each rung's measured bandwidth, and those corrections are worth
 * having — but only up to the moment hls.js reads the master, which for a live stream is once. A
 * supplier picks up whatever has landed by then; a snapshot taken at registration could not.
 */
type LadderResolver = () => LadderSource;

/**
 * A source known to be a ladder, and the topics actually handed to the poller.
 *
 * `resolve` is present only on the fallback path, where the ladder came from the stream catalog
 * rather than from a published master. `topics` is recorded rather than re-derived, because it is
 * what has to be stopped again — see {@link ManifestFetcher.registerLadder}.
 */
interface RegisteredLadder {
  resolve?: LadderResolver;
  topics: Topic[];
}

/** A finished single-rendition feed's watch, and the teardown registration that would end it. */
interface HeldReturnWatch {
  watch: FeedReturnWatch;
  /** Called when the watch ends some other way, so the topic's teardown does not end it again. */
  letGoOfTeardown: () => void;
}

/**
 * How many of the poller's own polls a level request waits for a rung's first playlist.
 *
 * ⛔ **The wait it bounds had no bound at all, and a bound is the whole fix.** A rung is served out
 * of what {@link LadderFeedPoller} has already read, so a level request for a rung that has read
 * nothing yet waits on `ready()`, which resolves on the first playlist and on a teardown and on
 * nothing else. A gateway that cannot resolve one rung's feed therefore left that promise pending
 * for the life of the session, and our loader is the only thing hls.js has: it starts no timer of
 * its own, so hls.js was given no timeout, no retry and no error for that level. The viewer got a
 * black player, no spinner and no message, with three healthy rungs one level switch away.
 *
 * ## Why twenty polls
 *
 * Counted in polls rather than milliseconds because the poller's cadence is what decides how often
 * a rung gets a chance to become ready. A deployment that slows the poll interval slows this in
 * step, which a wall time written here would not.
 *
 * It has to clear one whole read of the feed, since a first read that is merely slow still succeeds
 * and must not be cut off: `fetchWithTimeout` gives a single read 10s, which is 13.3 polls at the
 * shipped 750ms interval. Twenty polls is 15s there, so it clears that ceiling with five seconds
 * over, and stays under the 20s hls.js itself allows a playlist load before its own loader would
 * have errored, so the level error arrives no later than the stock loader's would have.
 *
 * Expiry costs a level rather than the session: hls.js retries a playlist error twice before it
 * switches level, each retry re-enters this wait with a fresh deadline, and the poller's walk keeps
 * running throughout, so a rung that becomes readable later is picked up by the next retry.
 */
export const RUNG_READY_DEADLINE_POLLS = 20;

/**
 * A rung that had produced no playlist by the time {@link RUNG_READY_DEADLINE_POLLS} polls had
 * passed.
 *
 * Its own type rather than a {@link ManifestFetchError}, because no response was refused and no
 * status was read. Nothing arrived at all.
 */
export class RungNotReadyError extends Error {
  constructor(readonly hexTopic: string, readonly deadlineMs: number) {
    super(`Rung ${hexTopic} had no playlist within ${deadlineMs}ms`);
    this.name = 'RungNotReadyError';
  }
}

export class ManifestFetcher {
  private _beeUrl: string = config.beeUrl;
  private ladders = new Map<string, RegisteredLadder>();
  private poller: LadderFeedPoller;
  private lastLoggedMaster = '';

  /**
   * Topics with a follow-up fetch outstanding, each mapped to the walk itself. Keyed by hex topic,
   * since each feed advances alone. The walk is held rather than just its name so {@link settled}
   * can await it, which is the only way anything outside this class can observe a walk that
   * {@link handleFollowupFetch} deliberately does not return.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  /**
   * The single-rendition feeds being watched for their broadcaster coming back, by hex topic.
   *
   * One per topic, and bound to the topic generation it started in: the teardown that ends that
   * generation ends the watch with it, through {@link ManifestStateManager.onTeardown}. A ladder's rungs
   * are watched by {@link LadderFeedPoller} instead, which already owns their teardown.
   */
  private readonly returnWatches = new Map<string, HeldReturnWatch>();

  constructor(
    private readonly stateManager: ManifestStateManager = ManifestStateManager.getInstance(),
    /** Shared with whatever renders the state, so both halves see one reading. */
    readonly feedHealth: FeedHealthTracker = new FeedHealthTracker(),
    /** Injected only by tests, so a backoff is asserted rather than waited out. */
    private readonly delay: (ms: number) => Promise<void> = waitMs,
    /**
     * Keeps this viewer's requests off the instant every other viewer picked. Injected only by
     * tests, so a stagger is asserted rather than sampled.
     */
    private readonly jitter: RequestJitter = new RequestJitter(),
    /**
     * Injected only by tests, so a rung's catch-up is driven rather than waited out. Production takes
     * the poller's own default, which is tuned against a segment interval.
     */
    pollIntervalMs?: number,
    /**
     * The longest a finished feed waits between asks for its broadcaster, on both paths, with every
     * wait drawn inside it through {@link jitter}. Injected only by tests, so a return is driven rather
     * than waited out. See {@link FEED_RETURN_WATCH_INTERVAL_MS}.
     */
    private readonly returnWatchIntervalMs: number = FEED_RETURN_WATCH_INTERVAL_MS,
  ) {
    // The poller fetches through this instance rather than holding a URL of its own, so switching
    // gateway mid-session moves the walk with it. It also shares this instance's feed health and
    // computes its backoff through the same jitter, so a ladder outage records and paces exactly as
    // the single-rendition path does rather than polling a dead gateway flat. A finished rung's watch
    // draws its waits through that jitter too, as the single rendition's does.
    this.poller = new LadderFeedPoller(
      stateManager,
      (path) => this.fetchResource(path),
      pollIntervalMs,
      this.feedHealth,
      (hexTopic) => this.jitter.spread(this.feedHealth.backoffRemainingMs(hexTopic)),
      () => this.drawReturnWatchWaitMs(),
    );
  }

  get beeUrl(): string {
    return this._beeUrl;
  }

  set beeUrl(url: string) {
    this._beeUrl = url;
  }

  /**
   * Declares that the stream loaded from `sourceUrl` has a ladder in the stream catalog.
   *
   * This is the fallback path, for an entry whose `topic` points at the lowest rung because it was
   * written before the uploader published masters. It pre-starts the rung walks from the catalog's
   * rendition list so such a stream is still a ladder; {@link fetchSource} then answers the
   * top-level request with a locally built master when the feed turns out to hold a media playlist.
   *
   * Registering costs nothing when the source *does* have a published master: the topics are the
   * same ones, and starting a walk that is already running is a no-op.
   */
  registerLadder(sourceUrl: string, resolve: LadderResolver): void {
    const ladder = resolve();
    const topics = ladderTopics(ladder);

    // The topics are recorded, not re-derived on the way out. React assigns refs during render,
    // which happens before the previous effect's cleanup runs, so a resolver read at unregister
    // time already sees the *next* stream's ladder — which would stop the rungs just started and
    // leave the previous stream's walk loops running forever.
    this.trackLadder(sourceUrl, topics, resolve);
    this.poller.start(ladder.owner, topics, groupHexOf(sourceUrl));
  }

  /**
   * Stops every rung this source was walking and discards what they accumulated.
   *
   * The clearing belongs here rather than in the player, because with a published master the rung
   * topics are discovered from the playlist and the player never sees them — it would have nothing
   * to clear, and the next session would resume the previous one's playlists. Done synchronously
   * with the stop, so a response still in flight cannot recreate the state it lands after.
   */
  unregisterLadder(sourceUrl: string): void {
    const registered = this.ladders.get(sourceUrl);
    this.ladders.delete(sourceUrl);

    if (!registered) {
      return;
    }

    this.poller.stop(registered.topics);
    for (const topic of registered.topics) {
      this.stateManager.clear(topic.toString());
    }
  }

  /**
   * Answers the top-level playlist request for `url` — the one hls.js makes once, from
   * `loadSource`.
   *
   * The source feed is read first and its content decides what this is. A multivariant playlist
   * means the uploader published a master for a ladder, and it is returned as it stands; the rungs
   * it names start being walked here, before hls.js has parsed it and asked for any of them. A
   * media playlist means either a single-rendition stream, or a catalog entry from before masters
   * existed — the fallback in {@link registerLadder} covers the second.
   */
  async fetchSource(url: string): Promise<string> {
    const source = parseSwarmUri(url);
    const topic = Topic.fromString(source.topic);
    const hexTopic = topic.toString();

    // Guarded exactly as {@link handleInitialFetch} is, and for the same reasons. Once a stream can
    // be a ladder this is the head read every mount makes, and the restart a fatal player error
    // triggers comes back through here rather than through there — so an unguarded read here would
    // be an unbounded restart loop against a dead gateway, with nothing recorded for the overlay to
    // report and no backoff accumulating to slow it down.
    const generation = this.stateManager.generation(hexTopic);
    await this.awaitFeedBackoff(hexTopic);

    const { path } = nextFeedRequest(source.owner, topic, null);
    try {
      const res = await this.fetchResource(path);
      const text = res.text;

      if (isMasterPlaylist(text)) {
        // Before the pollers are started, for the reason the generation was pinned above: a teardown
        // during the head read has already run `unregisterLadder` against no rungs, so starting four
        // walks here would leave four orphans that nothing can stop, `unregisterLadder` being their
        // only stopper and already spent. The single-rendition branch below guards the same way.
        this.assertTopicSurvived(hexTopic, generation);
        const variants = masterVariants(text);
        this.startVariants(url, source.owner, variants);
        this.logMaster(url, text, 'published');
        this.feedHealth.recordGatewayReachable(hexTopic);
        return text;
      }

      const synthesized = this.masterFor(url);
      if (synthesized) {
        this.logMaster(url, synthesized, 'synthesised from the catalog');
        this.feedHealth.recordGatewayReachable(hexTopic);
        return synthesized;
      }

      // Single rendition: the source feed *is* the media playlist, so the read above was the initial
      // fetch. Handing the response on rather than fetching again keeps this one request.
      this.assertTopicSurvived(hexTopic, generation);
      const manifest = this.ingestManifest(source.owner, topic, res, path);
      this.feedHealth.recordGatewayReachable(hexTopic);
      return manifest;
    } catch (error) {
      this.feedHealth.recordGatewayFailure(hexTopic);
      throw error;
    }
  }

  /** The master playlist for a registered ladder, or null when this source is single-rendition. */
  masterFor(sourceUrl: string): string | null {
    const ladder = this.ladders.get(sourceUrl)?.resolve?.();
    if (!ladder || ladder.renditions.length === 0) {
      return null;
    }

    return buildMasterPlaylist(ladder.owner, ladder.renditions);
  }

  async fetch(url: string): Promise<string> {
    const { owner, topic: topicPart } = parseSwarmUri(url);
    const topic = Topic.fromString(topicPart);
    const hexTopic = topic.toString();

    // A rung the poller owns is already being kept current, so a playlist request is a read of
    // what is there. The only wait is for the very first response to arrive, and it is bounded,
    // because a rung whose feed this gateway cannot resolve never has one. See
    // {@link RUNG_READY_DEADLINE_POLLS}.
    if (this.poller.isPolling(hexTopic)) {
      await this.awaitRungReady(hexTopic);
      return this.stateManager.serialize(hexTopic, this.bytesBaseUrl());
    }

    // Which request follows is `nextFeedRequest`'s to decide, on the same input, for everything in
    // this repository that reads a feed. The bench used to decide it separately and decided it
    // differently, which is what put every latency figure the project published on a lookup that is
    // frozen half the time. See `packages/shared/src/feedFollow.ts`.
    const knownIndex = this.stateManager.getIndex(hexTopic);
    if (knownIndex === null) {
      return this.handleInitialFetch(owner, topic);
    }
    return this.handleFollowupFetch(owner, topic, knownIndex);
  }

  /**
   * Waits for a rung to hold a playlist, and gives up rather than waiting for ever.
   *
   * The expiry is a rejection because that is the only answer hls.js can act on: our loader hands a
   * rejection to `callbacks.onError`, which errors the level, retries it and then switches away from
   * it. Resolving with the empty playlist the state manager would serialize reaches hls.js as a
   * fatal parse error instead, which restarts the whole player rather than leaving the three rungs
   * that are fine playing.
   *
   * The poller's promise is raced as it is rather than wrapped in a `then`, and that is what settles
   * the case where both are due in the same tick: a rung that is already ready has an already
   * resolved promise, and an expiry one hop behind it cannot overtake it.
   *
   * A teardown during the wait ends it rather than being caught by it. `LadderFeedPoller.stop`
   * resolves `ready` for every rung it stops, so the wait returns and this topic's cleared state
   * serializes exactly as it did before there was a deadline. Nothing is left holding the rung: the
   * expiry's own timer fires into a race that has already settled, and its rejection is one the race
   * subscribed to.
   */
  private async awaitRungReady(hexTopic: string): Promise<void> {
    const deadlineMs = RUNG_READY_DEADLINE_POLLS * this.poller.pollIntervalMs;
    const expired = this.delay(deadlineMs).then(() => {
      throw new RungNotReadyError(hexTopic, deadlineMs);
    });

    try {
      await Promise.race([this.poller.ready(hexTopic), expired]);
    } catch (error) {
      // The only rejection reachable here. The poller resolves `ready` and never rejects it, so a
      // line at this point is the deadline and nothing else. Logged where it fires rather than left
      // to hls.js, because the level error it becomes names a URL and not the rung that went quiet.
      console.warn(
        `Rung ${hexTopic} produced no playlist in ${deadlineMs}ms, so this level is failed rather ` +
          'than waited on. This gateway may not hold that rung.',
      );
      throw error;
    }
  }

  /**
   * Resolves once no walk is outstanding.
   *
   * Injected only by tests, like {@link delay}, and for the same reason: a walk is fire and forget by
   * design, so a test that cannot await one has to guess a duration instead. A guess that runs short
   * lets an abandoned walk record its next request against whichever test runs next, and a guess that
   * runs long is what makes it run short, because a loop of them outruns the test timeout.
   */
  async settled(): Promise<void> {
    // Cannot spin: each stored promise resolves only after its own entry is deleted, so a second lap
    // means a new walk started while this one was waiting, which is a thing that happened rather than
    // a thing to re-check.
    while (this.inFlight.size > 0) {
      await Promise.all(this.inFlight.values());
    }
  }

  /**
   * The path every mount takes when the source is known to be a single media playlist, and every
   * restart with it, since the player's effect cleanup clears the topic. A gateway outage causes a
   * fatal error, a fatal error causes a restart, so this is where an outage is most likely to be
   * met, not the follow-up path it was first guarded on.
   *
   * The backoff is waited out rather than skipped. This method is awaited by the loader and there is
   * no serialised state to answer with in its place, and an empty manifest is a fatal parse error
   * that restarts the player straight back into here. Taking longer is what actually slows it down.
   */
  private async handleInitialFetch(owner: string, topic: Topic): Promise<string> {
    const hexTopic = topic.toString();

    // Read before the wait rather than after it. Everything from here to the write is one window,
    // and the backoff can hold it open for seconds — so a teardown landing during the wait has to be
    // caught by the same guard that catches one landing during the fetch. See
    // {@link assertTopicSurvived}.
    const generation = this.stateManager.generation(hexTopic);
    await this.awaitFeedBackoff(hexTopic);

    // Every status counts as a failure here, 404 included. On the follow-up path a 404 means the
    // publisher has not written the next slot yet, which is ordinary; this request asks for the
    // feed's head, so nothing being there is the gateway having no answer at all.
    //
    // So does anything else that stops this call producing a playlist. The alternative is worse than
    // it looks: an empty manifest reaches hls.js as a fatal parse error, which restarts the player
    // straight back into this method, and a gateway recorded as healthy imposes no backoff on that
    // loop and says nothing to the viewer. A 200 carrying a captive portal's HTML does exactly that.
    const { path } = nextFeedRequest(owner, topic, null);
    try {
      const res = await this.fetchResource(path);
      this.assertTopicSurvived(hexTopic, generation);

      const manifest = this.ingestManifest(owner, topic, res, path);

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
   * The wait this topic's gateway has earned, spread so viewers do not return in lockstep.
   *
   * This is the one wait where alignment is guaranteed rather than merely possible. The backoff is a
   * pure function of the failure count, so every viewer that lost the same gateway at the same
   * moment waits the identical 2s, then 4s, then 8s, and arrives back together every time. Spreading
   * it costs nothing, since the viewer is already waiting, and it only ever brings the attempt
   * forward.
   */
  private async awaitFeedBackoff(hexTopic: string): Promise<void> {
    const backoffMs = this.jitter.spread(this.feedHealth.backoffRemainingMs(hexTopic));
    if (backoffMs > 0) {
      await this.delay(backoffMs);
    }
  }

  /**
   * Refuses to write to a topic that was torn down while the head read was in flight.
   *
   * The follow-up path pins an index and refuses to write across a teardown. A head read has no
   * index to pin, so it pins the generation instead, and it needs the guard more: the backoff can
   * hold the read open for seconds, and the outage that sets that backoff is what drives the restart
   * that tears the topic down. Writing anyway recreates the cleared topic at a pre-teardown head,
   * and an index that exists is what routes the next mount into the follow-up path, which never
   * resyncs to the live edge.
   */
  private assertTopicSurvived(hexTopic: string, generation: number): void {
    if (this.stateManager.generation(hexTopic) !== generation) {
      throw new Error(`Topic ${hexTopic} was torn down while its first fetch was in flight`);
    }
  }

  /**
   * Folds a feed's newest media playlist into this topic's state and serialises what results.
   *
   * Shared by the two paths that read a feed's head: {@link fetchSource}, which has to read the body
   * before it can tell a master playlist from a media one, and {@link handleInitialFetch}, which
   * already knows. Both are a path a mount takes, so the refusals below belong to both rather than
   * to whichever one happened to be written first.
   *
   * A head that is already finished is a recording being opened, and it is watched for its
   * broadcaster coming back exactly as a finish read live is. See {@link watchForReturn}.
   */
  private ingestManifest(owner: string, topic: Topic, response: TimedResponse, path: string): string {
    const hexTopic = topic.toString();
    const parsed = parseManifest(response.text);

    const shouldContinue = this.stateManager.updateManifest(
      hexTopic,
      parsed.headers,
      parsed.segments,
      parsed.isFinalized,
    );

    // Checked before the index is committed, not after. An index is what routes the next poll to the
    // follow-up path, so committing one for a response that yielded no playlist strands the topic
    // there, answering every poll with the same empty string and never asking the head again.
    const manifest = this.stateManager.serialize(hexTopic, this.bytesBaseUrl());
    if (!manifest) {
      throw new ManifestFetchError(path, response.status);
    }
    if (shouldContinue) {
      this.stateManager.setIndex(hexTopic, extractFeedIndex(response.headers));
      // A mount's first read found the feed open, so an end still recorded against it was left by an
      // earlier mount and is over. Forgotten without announcing a return, and only once the read has
      // proved usable. See `FeedHealthTracker.forgetStaleEnd`.
      this.feedHealth.forgetStaleEnd(hexTopic);
    } else if (parsed.isFinalized) {
      // Read only here, and forgivingly. A finished head was never asked for its index before, and a
      // gateway that leaves the header off still has a recording worth playing, so a missing index
      // costs the watch and not the playlist.
      const finishedAt = feedIndexOrNull(response.headers);
      if (finishedAt !== null) {
        this.watchForReturn(owner, topic, finishedAt);
      }
    }

    return manifest;
  }

  /**
   * `run` held back by the request stagger, as one promise that covers both the wait and the work.
   *
   * A zero stagger runs `run` synchronously, so turning the jitter off leaves the walk starting in
   * exactly the tick it started in before this existed. A teardown landing during the wait needs no
   * handling of its own: the walk still checks the topic generation before it writes anything, which
   * is the same guard that already covered a teardown landing mid-walk.
   */
  private afterStagger(run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.jitter.stagger(() => {
        run().then(resolve, reject);
      });
    });
  }

  /**
   * @param fromIndex The newest slot already read, taken by the caller in the same tick that routed
   *   here rather than read again inside the walk. Two walks that each advance from whatever index
   *   they find advance twice for one slot fetched, and the slot in between is never requested at
   *   all, so its segments never reach the viewer. The second one used to get that far rather than
   *   stopping short, because `updateManifest` answers `true` to a duplicate parse, where "nothing
   *   new, keep polling" and "this slot was consumed" are the same value read two ways.
   */
  private handleFollowupFetch(owner: string, topic: Topic, fromIndex: FeedIndex): string {
    const hexTopic = topic.toString();

    // One outstanding walk per topic. This method is fire and forget by design: it returns the
    // already serialised state at once and leaves the walk running, so hls.js schedules its next
    // level reload on the ordinary cadence while the previous one is still open. See CON-29.
    if (!this.inFlight.has(hexTopic) && this.feedHealth.backoffRemainingMs(hexTopic) === 0) {
      // Staggered, because hls.js derives its reload cadence from the playlist's target duration and
      // its newest segment, and every viewer of one broadcast reads the same two. So the cadence that
      // is nobody's to control is also the one every viewer shares, and the walk it triggers is what
      // actually reaches the gateway. Registered below on the same tick either way, so one walk per
      // topic still holds while a stagger is outstanding.
      const walk = this.afterStagger(() => this.walkToPublisher(owner, topic, fromIndex))
        .catch((error) => console.error('Error following the feed:', error))
        // Released only once the walk has finished, on the failure path as well, or one poll that
        // outran the publisher would end the broadcast for this viewer, and a caught-up viewer gets
        // a 404 on nearly every poll.
        .finally(() => {
          this.inFlight.delete(hexTopic);
        });
      // Recorded after the chain is built rather than before, so what is stored is the promise that
      // resolves after the release above. Nothing can observe the gap: a promise callback is a
      // microtask and this runs to completion first, so neither the guard nor the release can land
      // between the walk starting and it being recorded.
      this.inFlight.set(hexTopic, walk);
    }

    return this.stateManager.serialize(hexTopic, this.bytesBaseUrl());
  }

  /**
   * Read forward from `fromIndex` until the publisher's head, one slot at a time.
   *
   * ## Why a walk and not a single read
   *
   * This used to consume exactly one slot per call, and hls.js reloads a live playlist about once
   * per segment duration plus the round trip it just measured. So the media a viewer could play
   * advanced at `duration / (duration + roundTrip)` of real time, and the rest of the wall clock was
   * spent frozen. Watched in a real browser on 2026-08-05, over 897 logged requests: **0.82x at a
   * 0.25s segment with 17.3% of the clock frozen, 0.90x at 0.5s, 0.98x at 1.0s**, each within 0.02
   * of that ratio. Shorter segments made it worse rather than better, because a shorter segment does
   * not make the client faster, it makes it ask more often at a fixed cost per ask. See
   * `docs/bench/what-starves-the-viewer-2026-08-05.md`.
   *
   * Asking more often was the wrong fix: the cadence belongs to hls.js, and a poll loop of this
   * side's own would be a second thing to tear down and a second thing to get wrong. Reading every
   * slot the publisher has written costs one extra request per poll, the 404 that says there is
   * nothing more, and makes the rate a viewer can sustain independent of how finely the stream is
   * cut.
   *
   * Each slot is applied before the next is requested, so the index it is written against is the one
   * it was read from, and a teardown anywhere in the walk stops it rather than being walked over.
   */
  private async walkToPublisher(owner: string, topic: Topic, fromIndex: FeedIndex): Promise<void> {
    const hexTopic = topic.toString();
    let readIndex = fromIndex;

    for (let consumed = 0; consumed < MAX_SLOTS_PER_POLL; consumed++) {
      const { path, index: targetIndex } = nextFeedRequest(owner, topic, readIndex);

      let response: TimedResponse;
      try {
        response = await this.fetchResource(path);
      } catch (error) {
        if (isSlotNotWrittenYet(error)) {
          // Where every healthy poll ends: the walk has caught the publisher up. Counted as an
          // unserved poll only when this poll read nothing, because the run that count belongs to is
          // a run of polls that did not advance, and a poll that read four slots and then met the
          // publisher's head advanced.
          if (consumed === 0) {
            const polls = this.reportStalledFeed(hexTopic, targetIndex);
            if (shouldProbePastRefusal(polls)) {
              await this.stepPastRefusal(owner, topic, readIndex, targetIndex);
            }
          }
          return;
        }
        // Deliberately outside the guard in `applySlot`. A gateway that did not answer is a fact
        // about the gateway rather than about the topic generation, and it is the fact worth keeping
        // across a teardown, because the restart that discards the topic is itself what a fatal
        // network error triggers.
        this.feedHealth.recordGatewayFailure(hexTopic);
        console.error('Error fetching follow-up manifest:', error);
        return;
      }

      const advanced = await manifestQueue.add(() => this.applySlot(owner, topic, response, readIndex, targetIndex));
      if (advanced !== true) {
        return;
      }
      readIndex = targetIndex;
    }
  }

  /**
   * Fold one slot's manifest into the topic's state, if that state is still the one it was read from.
   *
   * @returns Whether the feed advanced, which is also whether the walk may ask for another slot.
   */
  private applySlot(
    owner: string,
    topic: Topic,
    response: TimedResponse,
    readIndex: FeedIndex,
    targetIndex: FeedIndex,
  ): boolean {
    const hexTopic = topic.toString();
    // Nothing cancels a request already in flight. `SwarmHlsPlayer`'s effect cleanup calls
    // `ManifestStateManager.clear(topic)` and then `hls.destroy()`, on unmount and on every
    // `restartTrigger` bump, which is the recovery path for a fatal player error and so fires
    // exactly when a fetch is already slow. A response that lands after that would otherwise
    // recreate the topic it was issued against and stamp a pre-teardown index on it, and an index
    // that exists is what routes the next mount into `handleFollowupFetch` instead of
    // `handleInitialFetch`, the only path that resyncs to the live head. So the write only applies
    // to the state it was computed from.
    if (this.stateManager.getIndex(hexTopic)?.toBigInt() !== readIndex.toBigInt()) {
      return false;
    }

    // Inside the guard, unlike the failure in the caller. A response that outlived its topic says
    // the gateway was answering before a teardown this fetch is older than, and the mount that
    // replaced it has its own initial fetch to say whether it still is.
    this.feedHealth.recordGatewayResponse(hexTopic);

    const parsed = parseManifest(response.text);
    if (parsed.isFinalized) {
      this.feedHealth.recordFeedEnded(hexTopic);
      // Inside the guard with the end itself, so only a finish this topic's current state was read
      // from starts a watch, and the watch then belongs to that state's generation.
      this.watchForReturn(owner, topic, targetIndex);
    }

    const shouldContinue = this.stateManager.updateManifest(
      hexTopic,
      parsed.headers,
      parsed.segments,
      parsed.isFinalized,
    );
    if (!shouldContinue) {
      return false;
    }

    this.stateManager.setIndex(hexTopic, targetIndex);
    return true;
  }

  /**
   * Keep asking whether the broadcaster has come back to a single-rendition feed that just finished.
   *
   * ⛔ **This path had nothing left that would ever ask again.** hls.js stops reloading a playlist that
   * carries ENDLIST, and this fetcher only reads a feed when hls.js asks it to, so a finished feed was
   * never read after the read that finished it. A declared stream continues the same feed at the next
   * index when its broadcaster comes back, and a viewer who had watched the end was told it had ended
   * for as long as they stayed. Measured live 2026-09-24 on the ladder, which shares the defect.
   *
   * One watch per topic, bound to the generation it started in. The teardown that ends that
   * generation ends it too, synchronously, so no timer outlives a remount. A return is recorded rather
   * than joined, because this viewer's copy of the playlist is finished and nothing can be appended to
   * it: the player's restart is what joins the broadcast again. See {@link FeedReturnWatch}.
   *
   * @param finishedAt The slot whose playlist finished the feed.
   */
  private watchForReturn(owner: string, topic: Topic, finishedAt: FeedIndex): void {
    const hexTopic = topic.toString();
    if (this.returnWatches.has(hexTopic)) {
      return;
    }

    const watch = new FeedReturnWatch({
      fetchResource: (path) => this.fetchResource(path),
      owner,
      topic,
      finishedAt,
      onReturned: () => {
        this.stopWatchingForReturn(hexTopic);
        this.feedHealth.recordFeedResumed(hexTopic);
      },
      nextWaitMs: () => this.drawReturnWatchWaitMs(),
    });
    this.returnWatches.set(hexTopic, {
      watch,
      letGoOfTeardown: this.stateManager.onTeardown(hexTopic, () => this.stopWatchingForReturn(hexTopic)),
    });
    watch.start();
  }

  /**
   * The wait before one ask of any watch this fetcher runs, a ladder rung's or a single rendition's.
   * Drawn through {@link jitter} on every call, so viewers who saw one broadcast end drift apart.
   */
  private drawReturnWatchWaitMs(): number {
    return feedReturnWatchWaitMs(this.jitter, this.returnWatchIntervalMs);
  }

  /** Ends this topic's watch, whichever of the teardown or the return got there first. */
  private stopWatchingForReturn(hexTopic: string): void {
    const held = this.returnWatches.get(hexTopic);
    if (!held) {
      return;
    }

    this.returnWatches.delete(hexTopic);
    held.watch.stop();
    held.letGoOfTeardown();
  }

  /**
   * Records a ladder against its source, merging topics rather than replacing them.
   *
   * Both paths can fire for one source — the catalog registers the ladder as the player mounts, and
   * the published master names the same rungs a moment later. Replacing would leave whichever set
   * lost the race running with nothing to stop it at teardown.
   */
  private trackLadder(sourceUrl: string, topics: Topic[], resolve?: LadderResolver): void {
    const existing = this.ladders.get(sourceUrl);
    const known = new Set(existing?.topics.map((t) => t.toString()));
    const merged = [...(existing?.topics ?? []), ...topics.filter((t) => !known.has(t.toString()))];

    this.ladders.set(sourceUrl, { resolve: resolve ?? existing?.resolve, topics: merged });
  }

  private startVariants(sourceUrl: string, sourceOwner: string, variants: { owner: string; topic: string }[]): void {
    if (variants.length === 0) {
      return;
    }

    const topics = variants.map((variant) => Topic.fromString(variant.topic));
    this.trackLadder(sourceUrl, topics);
    this.poller.start(variants[0].owner || sourceOwner, topics, groupHexOf(sourceUrl));
  }

  /**
   * Logged because a master is otherwise hard to see. The published one arrives as a feed read that
   * looks like every other feed read, and the synthesised one never becomes a request at all — so
   * devtools' network panel, the first place anyone looks for a playlist, shows nothing useful
   * either way. Once per distinct master, which for a live session is once.
   */
  private logMaster(sourceUrl: string, master: string, origin: string): void {
    if (master === this.lastLoggedMaster) {
      return;
    }

    this.lastLoggedMaster = master;
    console.log(`[SwarmHls] master playlist for ${sourceUrl} (${origin})\n${master}`);
  }

  /**
   * Take whatever {@link probePastRefusal} found behind the slot the walk is waiting on.
   *
   * @param readIndex The slot the walk actually holds, which the jump is written against rather
   *   than the one it could not fetch. That keeps the teardown guard in {@link applySlot}
   *   meaningful: the jump applies to the state it was computed from or not at all.
   */
  private async stepPastRefusal(owner: string, topic: Topic, readIndex: FeedIndex, missing: FeedIndex): Promise<void> {
    const hexTopic = topic.toString();
    const found = await probePastRefusal((path) => this.fetchResource(path), owner, topic, missing);

    if (found.kind === 'gatewayFailed') {
      this.feedHealth.recordGatewayFailure(hexTopic);
      console.error('Error probing past a refused manifest slot:', found.error);
      return;
    }
    if (found.kind === 'nothing') {
      return;
    }

    await manifestQueue.add(() => this.applySlot(owner, topic, found.response, readIndex, found.index));
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
   *
   * @returns The length of the run this poll extends, which is what decides whether it is long
   *   enough to be worth asking what is behind the slot.
   */
  private reportStalledFeed(hexTopic: string, slot: FeedIndex): number {
    const polls = this.feedHealth.recordUnservedSlot(hexTopic);

    if (polls === UNSERVED_POLLS_PROBE_CEILING) {
      console.error(
        `Feed ${hexTopic} has not advanced past slot ${slot.toBigInt()} in ${polls} polls. ` +
          'The publisher may have stopped, or this gateway may not hold that slot.',
      );
    }
    return polls;
  }

  /** Absolute, because it is written into a playlist. See {@link absoluteBytesBase}. */
  private bytesBaseUrl(): string {
    return absoluteBytesBase(this._beeUrl, pageOrigin());
  }

  private async fetchResource(path: string): Promise<TimedResponse> {
    const response = await fetchWithTimeout(`${this._beeUrl}/${path}`);
    if (!response.ok) {
      throw new ManifestFetchError(path, response.status);
    }
    return response;
  }
}

function ladderTopics(ladder: LadderSource): Topic[] {
  return ladder.renditions.map((rendition) => Topic.fromString(rendition.topic));
}

/**
 * The topic the player's overlay subscribes to for this source, hex-encoded exactly as
 * `SwarmHlsPlayer` derives it, so a signal recorded against it is one the overlay hears. Null when
 * the URL does not parse, which is a source no overlay can be subscribed to under any key either.
 */
function groupHexOf(sourceUrl: string): string | null {
  try {
    return Topic.fromString(parseSwarmUri(sourceUrl).topic).toString();
  } catch {
    return null;
  }
}

/** The slot a head read resolved to, or null where the response does not say. */
function feedIndexOrNull(headers: Headers): FeedIndex | null {
  try {
    return extractFeedIndex(headers);
  } catch {
    return null;
  }
}

/**
 * The origin a playlist's URIs are made absolute against.
 *
 * Read here rather than taken from `window.location` at the call site because this class is
 * exercised outside a browser, where touching `window` is a `ReferenceError` rather than a
 * `undefined`. The fallback is only ever the base of an already absolute gateway URL, which `URL`
 * discards, so it cannot reach a playlist a viewer reads.
 */
function pageOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
}
