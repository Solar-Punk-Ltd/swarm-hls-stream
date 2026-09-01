import { Topic } from '@ethersphere/bee-js';
import Pqueue from 'p-queue';

import { Rendition } from '@/types/stream';
import { extractFeedIndex, makeFeedIdentifier } from '@/utils/bee';
import { config } from '@/utils/config';

import { LadderFeedPoller } from './LadderFeedPoller';
import { ManifestStateManager } from './ManifestState';
import {
  absoluteBytesBase,
  buildMasterPlaylist,
  isMasterPlaylist,
  masterVariants,
  parseManifest,
  parseSwarmUri,
} from './playlist';

/** A stream's ABR ladder, as the loader needs it: who owns the feeds, and what the rungs are. */
export interface LadderSource {
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
export type LadderResolver = () => LadderSource;

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

const manifestQueue = new Pqueue({ concurrency: 1 });

export class ManifestFetcher {
  private _beeUrl: string = config.beeUrl;
  private ladders = new Map<string, RegisteredLadder>();
  private poller: LadderFeedPoller;
  private lastLoggedMaster = '';

  constructor(private readonly stateManager: ManifestStateManager = ManifestStateManager.getInstance()) {
    // The poller fetches through this instance rather than holding a URL of its own, so switching
    // gateway mid-session moves the walk with it.
    this.poller = new LadderFeedPoller(stateManager, (path) => this.fetchResource(path));
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
    this.poller.start(ladder.owner, topics);
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

    const res = await this.fetchResource(`feeds/${source.owner}/${hexTopic}`);
    const text = await res.text();

    if (isMasterPlaylist(text)) {
      const variants = masterVariants(text);
      this.startVariants(url, source.owner, variants);
      this.logMaster(url, text, 'published');
      return text;
    }

    const synthesized = this.masterFor(url);
    if (synthesized) {
      this.logMaster(url, synthesized, 'synthesised from the catalog');
      return synthesized;
    }

    // Single rendition: the source feed *is* the media playlist, so the read above was the initial
    // fetch. Handing the response on rather than fetching again keeps this one request.
    return this.ingestManifest(hexTopic, text, res);
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
    // what is there — the only wait is for the very first response to arrive.
    if (this.poller.isPolling(hexTopic)) {
      await this.poller.ready(hexTopic);
      return this.stateManager.serialize(hexTopic, this.bytesBaseUrl());
    }

    if (!this.stateManager.getIndex(hexTopic)) {
      return this.handleInitialFetch(owner, topic);
    }
    return this.handleFollowupFetch(owner, topic);
  }

  private async handleInitialFetch(owner: string, topic: Topic): Promise<string> {
    const hexTopic = topic.toString();
    const res = await this.fetchResource(`feeds/${owner}/${hexTopic}`);
    return this.ingestManifest(hexTopic, await res.text(), res);
  }

  /** Folds a feed's newest media playlist into this topic's state and serialises what results. */
  private ingestManifest(hexTopic: string, text: string, res: Response): string {
    const parsed = parseManifest(text);

    const shouldContinue = this.stateManager.updateManifest(
      hexTopic,
      parsed.headers,
      parsed.segments,
      parsed.isFinalized,
    );
    if (shouldContinue) {
      this.stateManager.setIndex(hexTopic, extractFeedIndex(res));
    }

    return this.stateManager.serialize(hexTopic, this.bytesBaseUrl());
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
    this.poller.start(variants[0].owner || sourceOwner, topics);
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

  private async handleFollowupFetch(owner: string, topic: Topic): Promise<string> {
    const nextId = this.generateNextId(topic);
    const hexTopic = topic.toString();

    this.fetchResource(`soc/${owner}/${nextId}`)
      .then((res) => {
        manifestQueue.add(async () => {
          const text = await res.text();
          const parsed = parseManifest(text);
          const shouldContinue = this.stateManager.updateManifest(
            hexTopic,
            parsed.headers,
            parsed.segments,
            parsed.isFinalized,
          );
          if (shouldContinue) {
            const index = this.stateManager.getIndex(hexTopic)!;
            this.stateManager.setIndex(hexTopic, index.next());
          }
        });
      })
      .catch((error) => {
        console.error('Error fetching follow-up:', error);
      });

    return this.stateManager.serialize(hexTopic, this.bytesBaseUrl());
  }

  private generateNextId(topic: Topic): string {
    const currentIndex = this.stateManager.getIndex(topic.toString())!;
    return makeFeedIdentifier(topic, currentIndex.next()).toString();
  }

  /** Absolute, because it is written into a playlist. See {@link absoluteBytesBase}. */
  private bytesBaseUrl(): string {
    return absoluteBytesBase(this._beeUrl, window.location.origin);
  }

  private async fetchResource(path: string): Promise<Response> {
    const response = await fetch(`${this._beeUrl}/${path}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${path}`);
    }
    return response;
  }
}

function ladderTopics(ladder: LadderSource): Topic[] {
  return ladder.renditions.map((rendition) => Topic.fromString(rendition.topic));
}
