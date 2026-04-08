import { SegmentEntry } from '../types.js';

import { Logger } from './Logger.js';

const LIVE_WINDOW_SIZE = 10;

export class ManifestManager {
  private segments: SegmentEntry[] = [];
  private hlsHeaders: string[] = ['#EXTM3U', '#EXT-X-VERSION:3'];
  private targetDuration = 0;
  private logger = Logger.getInstance();

  constructor(private manifestBeeUrl: string) {}

  public addSegment(index: number, duration: number, ref: string): void {
    this.segments.push({ index, duration, ref });
    this.segments.sort((a, b) => a.index - b.index);

    const newTarget = Math.ceil(duration);
    if (newTarget > this.targetDuration) {
      this.targetDuration = newTarget;
    }

    this.logger.debug(`[ManifestManager] Added segment ${index}, total: ${this.segments.length}`);
  }

  public buildLiveManifest(): string {
    if (this.segments.length === 0) {
      return '';
    }

    const windowSegments =
      this.segments.length <= LIVE_WINDOW_SIZE
        ? this.segments
        : this.segments.slice(this.segments.length - LIVE_WINDOW_SIZE);

    const mediaSequence =
      this.segments.length <= LIVE_WINDOW_SIZE ? 0 : this.segments.length - LIVE_WINDOW_SIZE;

    const lines = [
      ...this.hlsHeaders,
      `#EXT-X-TARGETDURATION:${this.targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
      '',
    ];

    for (const seg of windowSegments) {
      lines.push(`#EXTINF:${seg.duration},`);
      lines.push(this.buildSegmentUri(seg.ref));
    }

    return lines.join('\n') + '\n';
  }

  public buildVODManifest(): string {
    if (this.segments.length === 0) {
      return '';
    }

    const lines = [
      ...this.hlsHeaders,
      `#EXT-X-TARGETDURATION:${this.targetDuration}`,
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '',
    ];

    for (const seg of this.segments) {
      lines.push(`#EXTINF:${seg.duration},`);
      lines.push(this.buildSegmentUri(seg.ref));
    }

    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }

  public getTotalDuration(): number {
    return this.segments.reduce((sum, seg) => sum + seg.duration, 0);
  }

  public hasSegments(): boolean {
    return this.segments.length > 0;
  }

  public getState(): { segments: SegmentEntry[]; hlsHeaders: string[] } {
    return {
      segments: [...this.segments],
      hlsHeaders: [...this.hlsHeaders],
    };
  }

  public restoreState(segments: SegmentEntry[], hlsHeaders: string[]): void {
    this.segments = [...segments];
    this.hlsHeaders = [...hlsHeaders];

    if (this.segments.length > 0) {
      this.targetDuration = Math.ceil(Math.max(...this.segments.map(s => s.duration)));
    }

    this.logger.info(`[ManifestManager] Restored state with ${this.segments.length} segments`);
  }

  private buildSegmentUri(ref: string): string {
    return this.manifestBeeUrl ? `${this.manifestBeeUrl}/${ref}` : ref;
  }
}
