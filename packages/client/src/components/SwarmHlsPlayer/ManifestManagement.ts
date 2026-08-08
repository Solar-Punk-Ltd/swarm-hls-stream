import { FeedIndex, Topic } from '@ethersphere/bee-js';
import Pqueue from 'p-queue';

import { Rendition } from '@/types/stream';
import { makeFeedIdentifier } from '@/utils/bee';
import { config } from '@/utils/config';

import { buildMasterPlaylist, parseManifest, parseSwarmUri, Segment } from './playlist';

export type { Segment } from './playlist';
export { buildMasterPlaylist, buildSwarmUri, parseManifest, parseSwarmUri } from './playlist';

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

interface TopicState {
  index: FeedIndex | null;
  headers: string[];
  segments: Segment[];
  segmentUris: Set<string>;
  isFinalized: boolean;
  dirty: boolean;
  cachedManifest: string;
}

const HLS_ENDLIST = '#EXT-X-ENDLIST';
const HLS_PLAYLIST_TYPE = '#EXT-X-PLAYLIST-TYPE';
const HLS_PLAYLIST_TYPE_EVENT = '#EXT-X-PLAYLIST-TYPE:EVENT';
const HLS_MEDIA_SEQUENCE = '#EXT-X-MEDIA-SEQUENCE';
const HLS_MEDIA_SEQUENCE_ZERO = '#EXT-X-MEDIA-SEQUENCE:0';

const manifestQueue = new Pqueue({ concurrency: 1 });

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
  private ladders = new Map<string, LadderResolver>();

  constructor(private readonly stateManager: ManifestStateManager = ManifestStateManager.getInstance()) {}

  get beeUrl(): string {
    return this._beeUrl;
  }

  set beeUrl(url: string) {
    this._beeUrl = url;
  }

  /**
   * Declares that the stream loaded from `sourceUrl` is a ladder, so the loader answers its
   * top-level playlist request with a master rather than with that feed's media playlist.
   */
  registerLadder(sourceUrl: string, resolve: LadderResolver): void {
    this.ladders.set(sourceUrl, resolve);
  }

  unregisterLadder(sourceUrl: string): void {
    this.ladders.delete(sourceUrl);
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

    if (!this.stateManager.getIndex(topic.toString())) {
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
      this.stateManager.setIndex(hexTopic, this.extractIndex(res));
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

  private extractIndex(response: Response): FeedIndex {
    const hex = response.headers.get('Swarm-Feed-Index');
    if (!hex) {
      throw new Error('Missing feed index header');
    }
    return FeedIndex.fromBigInt(BigInt(`0x${hex}`));
  }
}
