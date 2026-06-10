import { FeedIndex, Topic } from '@ethersphere/bee-js';
import Pqueue from 'p-queue';

import { makeFeedIdentifier } from '@/utils/bee';
import { config } from '@/utils/config';

export interface Segment {
  extinf: string;
  uri: string;
}

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
const HLS_EXTINF = '#EXTINF';
const HLS_PLAYLIST_TYPE = '#EXT-X-PLAYLIST-TYPE';
const HLS_PLAYLIST_TYPE_EVENT = '#EXT-X-PLAYLIST-TYPE:EVENT';
const HLS_MEDIA_SEQUENCE = '#EXT-X-MEDIA-SEQUENCE';
const HLS_MEDIA_SEQUENCE_ZERO = '#EXT-X-MEDIA-SEQUENCE:0';

const manifestQueue = new Pqueue({ concurrency: 1 });

const FOLLOWUP_FETCH_TIMEOUT_MS = 10_000;

class FetchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function parseManifest(text: string): { headers: string[]; segments: Segment[]; isFinalized: boolean } {
  const lines = text.trim().split('\n');
  const headers: string[] = [];
  const segments: Segment[] = [];
  let isFinalized = false;
  let headersDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === HLS_ENDLIST) {
      isFinalized = true;
      continue;
    }

    if (line.startsWith(HLS_EXTINF)) {
      headersDone = true;
      const uri = lines[i + 1]?.trim();
      if (uri && !uri.startsWith('#')) {
        segments.push({ extinf: line, uri });
        i++;
      }
      continue;
    }

    if (!headersDone && line) {
      headers.push(line);
    }
  }

  return { headers, segments, isFinalized };
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
  private inFlight = new Set<string>();

  constructor(private readonly stateManager: ManifestStateManager = ManifestStateManager.getInstance()) {}

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
    const hexTopic = topic.toString();

    if (!this.inFlight.has(hexTopic)) {
      // Pin the slot being fetched — advancing via getIndex().next() in the callback
      // would double-advance (and skip a slot) when two responses for the same slot land.
      const targetIndex = this.stateManager.getIndex(hexTopic)!.next();
      const nextId = makeFeedIdentifier(topic, targetIndex).toString();

      this.inFlight.add(hexTopic);
      this.fetchResource(`soc/${owner}/${nextId}`, FOLLOWUP_FETCH_TIMEOUT_MS)
        .then((res) =>
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
              this.stateManager.setIndex(hexTopic, targetIndex);
            }
          }),
        )
        .catch((error) => {
          // 404 just means the publisher has not written this slot yet — the next poll retries it.
          if (!(error instanceof FetchError && error.status === 404)) {
            console.error('Error fetching follow-up manifest:', error);
          }
        })
        .finally(() => {
          this.inFlight.delete(hexTopic);
        });
    }

    return this.stateManager.serialize(hexTopic, `${this._beeUrl}/bytes`);
  }

  private async fetchResource(path: string, timeoutMs?: number): Promise<Response> {
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetch(`${this._beeUrl}/${path}`, { signal });
    if (!response.ok) {
      throw new FetchError(`Failed to fetch: ${path}`, response.status);
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
