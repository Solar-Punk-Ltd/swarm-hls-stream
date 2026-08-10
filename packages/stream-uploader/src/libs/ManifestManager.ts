import { SegmentEntry } from '../types.js';

import { Logger } from './Logger.js';

const LIVE_WINDOW_SIZE = 10;

/**
 * One rung's media playlist.
 *
 * `EXT-X-MEDIA-SEQUENCE` carries the engine's own sequence number for the playlist's first
 * segment, not a count of what this uploader has seen. On a single-rendition stream the two are
 * interchangeable; across an ABR ladder they are not, and the difference is what makes a switch
 * land where it should. Every rung is transcoded from the same source with keyframes forced to the
 * same media timestamps, so segment N of 360p and segment N of 1080p cover the same interval —
 * which is the only thing telling hls.js that two levels share a timeline, since these playlists
 * carry no `EXT-X-PROGRAM-DATE-TIME`. A count would drift the moment one rung's uploader started a
 * fragment later than another's, and a switch would then jump by however far apart they were.
 */
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

    const mediaSequence = windowSegments[0].index;

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
      `#EXT-X-MEDIA-SEQUENCE:${this.segments[0].index}`,
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
