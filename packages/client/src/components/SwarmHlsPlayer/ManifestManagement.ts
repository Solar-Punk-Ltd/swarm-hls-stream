import { Topic } from '@ethersphere/bee-js';
import Pqueue from 'p-queue';

import { Rendition } from '@/types/stream';
import { extractFeedIndex, makeFeedIdentifier } from '@/utils/bee';
import { config } from '@/utils/config';

import { LadderFeedPoller } from './LadderFeedPoller';
import { ManifestStateManager } from './ManifestState';
import { buildMasterPlaylist, parseManifest, parseSwarmUri } from './playlist';

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

const manifestQueue = new Pqueue({ concurrency: 1 });

export class ManifestFetcher {
  private _beeUrl: string = config.beeUrl;
  private ladders = new Map<string, LadderResolver>();
  private poller: LadderFeedPoller;

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
    this.ladders.set(sourceUrl, resolve);

    const ladder = resolve();
    this.poller.start(ladder.owner, ladderTopics(ladder));
  }

  unregisterLadder(sourceUrl: string): void {
    const ladder = this.ladders.get(sourceUrl)?.();
    this.ladders.delete(sourceUrl);

    if (ladder) {
      this.poller.stop(ladderTopics(ladder));
    }
  }

  /** The master playlist for a registered ladder, or null when this source is single-rendition. */
  masterFor(sourceUrl: string): string | null {
    const ladder = this.ladders.get(sourceUrl)?.();
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
      return this.stateManager.serialize(hexTopic, `${this._beeUrl}/bytes`);
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

    return this.stateManager.serialize(hexTopic, `${this._beeUrl}/bytes`);
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

    return this.stateManager.serialize(hexTopic, `${this._beeUrl}/bytes`);
  }

  private generateNextId(topic: Topic): string {
    const currentIndex = this.stateManager.getIndex(topic.toString())!;
    return makeFeedIdentifier(topic, currentIndex.next()).toString();
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
