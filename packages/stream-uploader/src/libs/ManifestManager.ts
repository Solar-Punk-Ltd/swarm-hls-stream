import { buildExtinf } from '@swarm-hls-stream/shared';

import { SegmentEntry } from '../types.js';
import {
  HLS_DISCONTINUITY,
  HLS_ENDLIST,
  HLS_M3U,
  HLS_MEDIA_SEQUENCE,
  HLS_PLAYLIST_TYPE_VOD,
  HLS_TARGET_DURATION,
  HLS_VERSION,
} from '../utils/hlsTags.js';

import { Logger } from './Logger.js';

/**
 * The most bytes a live manifest may occupy, which is one single-owner chunk.
 *
 * bee-js writes a feed payload straight into the chunk while it fits in one, and past that uploads
 * the payload separately, downloads its root chunk back, and wraps that instead
 * (`updateFeedWithPayload`, against its own `MAX_PAYLOAD_SIZE`). So crossing this turns one round
 * trip per publish into three, on a path that runs once per segment. It is a cost cliff rather than
 * a failure, and it is not ours to move. Spelled out rather than imported because bee-js exports the
 * constant from `chunk/cac` and not from the package root.
 *
 * The window is budgeted against it rather than counted in segments because a count is a different
 * amount of media at every segment length, and in the wrong direction: ten segments was 20 seconds
 * at a 2.0s segment and 2.5 at the 0.25s profile, so the configuration whose viewers have least time
 * to recover was given the least to recover with. Ten segments also spent 864 of these bytes, so the
 * headroom was already paid for.
 */
export const LIVE_WINDOW_MAX_BYTES = 4096;

/**
 * The bytes a manifest of these lines occupies once joined, without joining them.
 *
 * `\n` separates every line and terminates the last, so each line costs its own length plus one.
 */
function manifestBytes(lines: string[]): number {
  return lines.reduce((total, line) => total + Buffer.byteLength(line, 'utf-8') + 1, 0);
}

function joinManifest(lines: string[]): string {
  return lines.join('\n') + '\n';
}

/**
 * Builds the playlists a broadcast publishes, naming every segment by its bare Swarm reference.
 *
 * ## ⛔⛔ A segment line names no gateway, and that is the product decision
 *
 * A manifest line is a content address and nothing else, so the viewer's own client decides which
 * gateway fetches it. This used to be configurable through `MANIFEST_ACCESS_URL`, which wrote
 * `http://<host>:<port>/bytes/<ref>` into every line, and an absolute URI is passed straight through
 * by every reader: the publisher therefore chose the gateway for the entire audience, and that
 * gateway was a single point of load and failure for every viewer of the broadcast no matter what
 * they had configured. Owner decision of 2026-08-13, asked directly: **each viewer fetches
 * themselves**.
 *
 * ⭐ It was invisible from the viewer side, which is why it survived so long. On 2026-08-13 both arms
 * of a funded-versus-unfunded smoke reported their own gateway honestly and truthfully while fetching
 * all 253 of their video segments from one node. Nothing in the viewer-facing output disagreed.
 *
 * ⚠️ Recordings published before this carry absolute URIs permanently, so the client keeps passing an
 * absolute segment URI through untouched. That path is for old content, not for new.
 *
 * ## One rung’s media playlist
 *
 ** One rung's media playlist.
 **
 ** `EXT-X-MEDIA-SEQUENCE` carries the engine's own sequence number for the playlist's first
 ** segment, not a count of what this uploader has seen. On a single-rendition stream the two are
 ** interchangeable; across an ABR ladder they are not, and the difference is what makes a switch
 ** land where it should. Every rung is transcoded from the same source with keyframes forced to the
 ** same media timestamps, so segment N of 360p and segment N of 1080p cover the same interval —
 ** which is the only thing telling hls.js that two levels share a timeline, since these playlists
 ** carry no `EXT-X-PROGRAM-DATE-TIME`. A count would drift the moment one rung's uploader started a
 ** fragment later than another's, and a switch would then jump by however far apart they were.
 */
export class ManifestManager {
  private segments: SegmentEntry[] = [];
  private hlsHeaders: string[] = [HLS_M3U, `${HLS_VERSION}:3`];
  private targetDuration = 0;
  private logger = Logger.getInstance();

  public addSegment(index: number, duration: number, ref: string, discontinuity = false): void {
    this.segments.push({ index, duration, ref, discontinuity });
    this.segments.sort((a, b) => a.index - b.index);

    const newTarget = Math.ceil(duration);
    if (newTarget > this.targetDuration) {
      this.targetDuration = newTarget;
    }

    this.logger.debug(`[ManifestManager] Added segment ${index}, total: ${this.segments.length}`);
  }

  public buildLiveManifest(): string {
    const lines = this.liveManifestLines();
    return lines.length === 0 ? '' : joinManifest(lines);
  }

  /**
   * The live manifest with its playlist ended, published when the broadcast stops.
   *
   * A viewer walking the feed reads this as the next update of the playlist they are already
   * playing, so it has to stay that playlist: same media sequence, same segments, now closed. The
   * VOD manifest cannot do this job, because it renumbers from zero, and a media sequence moving
   * backwards is what hls.js reports as a parsing error rather than as an ending. That error is
   * escalated to fatal on a single-variant stream, and the client answers a fatal parsing error by
   * remounting the player, which restarts playback at the beginning of the recording.
   */
  public buildClosingLiveManifest(): string {
    const lines = this.liveManifestLines();
    return lines.length === 0 ? '' : joinManifest([...lines, HLS_ENDLIST]);
  }

  private liveManifestLines(): string[] {
    if (this.segments.length === 0) {
      return [];
    }

    const windowSegments = this.segments.slice(this.segments.length - this.liveWindowLength());

    // The engine's own sequence number for the window's first segment, not a count of what this
    // uploader has seen. On a single-rendition stream the two are interchangeable; across an ABR
    // ladder they are not, and the difference is what makes a level switch land where it should.
    // Every rung forces keyframes to the same media timestamps, so segment N means the same interval
    // on every rung, and that is the only thing telling hls.js the levels share a timeline — these
    // playlists carry no `EXT-X-PROGRAM-DATE-TIME`. A count would drift the moment one rung's
    // uploader started a fragment later than another's.
    const mediaSequence = windowSegments.length > 0 ? windowSegments[0].index : 0;

    return [...this.liveHeaderLines(mediaSequence), ...windowSegments.flatMap((seg) => this.segmentLines(seg))];
  }

  public buildVODManifest(): string {
    if (this.segments.length === 0) {
      return '';
    }

    return joinManifest([
      ...this.hlsHeaders,
      `${HLS_TARGET_DURATION}:${this.targetDuration}`,
      HLS_PLAYLIST_TYPE_VOD,
      `${HLS_MEDIA_SEQUENCE}:${this.segments[0].index}`,
      '',
      ...this.segments.flatMap((seg) => this.segmentLines(seg)),
      HLS_ENDLIST,
    ]);
  }

  /**
   * The newest segment the live window reaches, which is the newest segment there is.
   *
   * Read together with {@link buildLiveManifest} and before anything is awaited, since `addSegment`
   * runs between awaits: an index read after the publish returns would name a segment the published
   * manifest did not hold.
   */
  public liveWindowNewestIndex(): number | null {
    return this.segments.length === 0 ? null : this.segments[this.segments.length - 1].index;
  }

  /**
   * Segments held here that start before the live window and after `announcedThrough`.
   *
   * These were uploaded, so their bytes are in Swarm and any viewer handed the address could fetch
   * them. The window slid past them before a manifest naming them was published, and a viewer learns
   * of a segment only from a manifest, so nothing will ever tell one that they exist. No
   * discontinuity is armed either, because `pendingDiscontinuity` answers a failed segment upload
   * rather than a window that outran its own publishing.
   *
   * Counted over the segments actually held rather than as an index range, so a segment whose upload
   * failed and which was therefore never added is not counted a second time here on top of
   * `recordSegmentDropped`.
   */
  public segmentsNeverNamed(announcedThrough: number): number {
    const windowStart = this.segments.length - this.liveWindowLength();
    return this.segments.slice(0, windowStart).filter((seg) => seg.index > announcedThrough).length;
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
      this.targetDuration = Math.ceil(Math.max(...this.segments.map((s) => s.duration)));
    }

    this.logger.info(`[ManifestManager] Restored state with ${this.segments.length} segments`);
  }

  /**
   * How many of the newest segments fit in {@link LIVE_WINDOW_MAX_BYTES}, and never fewer than one.
   *
   * Counted backwards from the live edge, so the work is the window's rather than the broadcast's:
   * `segments` holds every segment ever published, because the VOD manifest is built from the same
   * array, and this runs once per segment for the life of the stream.
   *
   * A segment that overruns the budget on its own is still emitted. A manifest naming nothing is
   * worse than a manifest costing an extra round trip. A segment line is now a duration and a
   * reference, so no live sequence can reach that state: {@link restoreState} can, because it takes
   * its headers from a recovered manifest, and a header long enough to spend the budget leaves every
   * segment overrunning what is left.
   */
  private liveWindowLength(): number {
    // Reserved against the largest media sequence there could be. That used to be the segment
    // count, because the sequence was a count; it is now the engine's own index for the window's
    // first segment, which can exceed the count outright — a restarted uploader, or an engine that
    // did not begin at zero. The newest index is the real upper bound, and under-reserving here
    // spends a budget that is one bee chunk. Its own digits are part of the header, and reserving
    // this way avoids a second pass over a header whose length depends on the answer.
    const newestIndex = this.segments.length === 0 ? 0 : this.segments[this.segments.length - 1].index;
    const budget = LIVE_WINDOW_MAX_BYTES - manifestBytes(this.liveHeaderLines(newestIndex));

    let spent = 0;
    let length = 0;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      spent += manifestBytes(this.segmentLines(this.segments[i]));
      if (spent > budget && length > 0) {
        break;
      }
      length++;
    }

    return length;
  }

  private liveHeaderLines(mediaSequence: number): string[] {
    return [
      ...this.hlsHeaders,
      `${HLS_TARGET_DURATION}:${this.targetDuration}`,
      `${HLS_MEDIA_SEQUENCE}:${mediaSequence}`,
      '',
    ];
  }

  private segmentLines(seg: SegmentEntry): string[] {
    const discontinuity = seg.discontinuity ? [HLS_DISCONTINUITY] : [];
    return [...discontinuity, buildExtinf(seg.duration), seg.ref];
  }
}
