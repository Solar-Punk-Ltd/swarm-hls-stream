import { Topic } from '@ethersphere/bee-js';
import Pqueue from 'p-queue';

import { Rendition } from '@/types/stream';
import { extractFeedIndex, makeFeedIdentifier } from '@/utils/bee';
import { config } from '@/utils/config';

import { LadderFeedPoller } from './LadderFeedPoller';
import { ManifestStateManager } from './ManifestState';
import { absoluteBytesBase, buildMasterPlaylist, parseManifest, parseSwarmUri } from './playlist';

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

/** What was registered, alongside the topics that were actually handed to the poller. */
interface RegisteredLadder {
  resolve: LadderResolver;
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
   * Declares that the stream loaded from `sourceUrl` is a ladder.
   *
   * Two things follow. The loader answers that source's top-level playlist request with a master
   * rather than with a media playlist, and every rung's feed starts being walked immediately —
   * including the three hls.js is not playing, which is what makes switching to one of them cheap.
   */
  registerLadder(sourceUrl: string, resolve: LadderResolver): void {
    const ladder = resolve();
    const topics = ladderTopics(ladder);

    // The topics are recorded, not re-derived on the way out. React assigns refs during render,
    // which happens before the previous effect's cleanup runs, so a resolver read at unregister
    // time already sees the *next* stream's ladder — which would stop the rungs just started and
    // leave the previous stream's walk loops running forever.
    this.ladders.set(sourceUrl, { resolve, topics });
    this.poller.start(ladder.owner, topics);
  }

  unregisterLadder(sourceUrl: string): void {
    const registered = this.ladders.get(sourceUrl);
    this.ladders.delete(sourceUrl);

    if (registered) {
      this.poller.stop(registered.topics);
    }
  }

  /** The master playlist for a registered ladder, or null when this source is single-rendition. */
  masterFor(sourceUrl: string): string | null {
    const ladder = this.ladders.get(sourceUrl)?.resolve();
    if (!ladder || ladder.renditions.length === 0) {
      return null;
    }

    const master = buildMasterPlaylist(ladder.owner, ladder.renditions);

    // Logged because it is otherwise unobservable. The master never becomes a request — it is
    // built here and handed straight to hls.js — so devtools' network panel, which is the first
    // place anyone looks for a playlist, shows nothing at all. Once per distinct master, which for
    // a live session is once.
    if (master !== this.lastLoggedMaster) {
      this.lastLoggedMaster = master;
      console.log(`[SwarmHls] master playlist for ${sourceUrl}\n${master}`);
    }

    return master;
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
    const text = await res.text();
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
