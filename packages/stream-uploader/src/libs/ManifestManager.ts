import { buildExtinf, buildProgramDateTime } from '@swarm-hls-stream/shared';

import { BroadcastAnchor, SegmentEntry } from '../types.js';
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

const MS_PER_SECOND = 1000;

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

/** Where the broadcast's numbering starts: the engine index that publishes as `sequence`. */
interface SequenceAnchor {
  index: number;
  sequence: number;
}

/**
 * A segment's place in the broadcast, defaulting to its engine index.
 *
 * The default is for entries restored from a recovery entry written before the two numbers were
 * separated, where nothing on disk records the offset. {@link ManifestManager.restoreState} rewrites
 * those on the way in, so nothing built from them ever reaches this fallback, and it is kept because
 * the field stays optional on the persisted shape and a silent `NaN` here would sort the playlist
 * into nonsense.
 */
function sequenceOf(seg: SegmentEntry): number {
  return seg.sequence ?? seg.index;
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
 * ## One rung's media playlist, and the two numbers on it
 *
 * A segment reaches here under the **engine's own index**, a counter SRS runs per rung stream and
 * carries on across broadcasts for as long as its process lives. The playlist publishes a
 * **sequence** instead, which counts from 0 at the first segment of this broadcast, and an
 * `EXT-X-PROGRAM-DATE-TIME` derived from that sequence and the broadcast's anchor. Every uploader
 * log line still names the engine's index, because that is what correlates with the engine's own
 * logs and with what the e2e harness reads.
 *
 * What ties the rungs of a ladder together is that all four derive both numbers from **one anchor**:
 * every rung is transcoded from the same source with keyframes forced to the same media timestamps,
 * so segment N of 360p and segment N of 1080p cover the same interval, and both the sequence and the
 * date-time therefore agree across rungs for the same media. A per-rung count of what each uploader
 * happened to see would drift the moment one rung started a fragment later than another, and a level
 * switch would land that far off.
 *
 * @see BroadcastAnchor for why the date-time is derived rather than observed per segment.
 */
export class ManifestManager {
  private segments: SegmentEntry[] = [];
  private hlsHeaders: string[] = [HLS_M3U, `${HLS_VERSION}:3`];
  private targetDuration = 0;
  private logger = Logger.getInstance();

  /**
   * The engine index that publishes as {@link SequenceAnchor.sequence}, and that sequence.
   *
   * Null until the first segment arrives, because the first index a rung announces is what the
   * broadcast's numbering is measured from and nothing before then knows what it will be.
   */
  private sequenceAnchor: SequenceAnchor | null = null;

  /**
   * Whether a sequence number this manager assigned has already gone out in a playlist.
   *
   * The one thing that separates the two ways an index can arrive below the anchor. See
   * {@link sequenceFor}.
   */
  private sequenceHasBeenPublished = false;

  constructor(private readonly anchor: BroadcastAnchor) {}

  public addSegment(index: number, duration: number, ref: string, discontinuity = false): void {
    const sequence = this.sequenceFor(index);
    this.segments.push({ index, duration, ref, discontinuity, sequence });
    // By sequence rather than by index, which are the same order for the whole of an ordinary
    // broadcast and are not after an engine restart: the engine's counter goes back to 0 there and
    // sorting on it would file the media that comes after the restart in front of the media that
    // came before.
    this.segments.sort((a, b) => sequenceOf(a) - sequenceOf(b));

    const newTarget = Math.ceil(duration);
    if (newTarget > this.targetDuration) {
      this.targetDuration = newTarget;
    }

    this.logger.debug(`[ManifestManager] Added segment ${index}, total: ${this.segments.length}`);
  }

  /**
   * The playlist sequence this engine index publishes as, counting from 0 at the broadcast's first
   * segment.
   *
   * ⛔ **An index below the anchor is one of two different things, and getting them the wrong way
   * round breaks a real guarantee each time.**
   *
   * Before any playlist has gone out, it is a segment that arrived out of order, and the broadcast
   * simply began earlier than the first arrival said. Nothing has been promised to anyone yet, so
   * the anchor moves down and everything already held shifts up to keep media order.
   *
   * Afterwards it is the engine's counter having reset under a restart, which SRS does whenever it
   * disposes a stream. A number already published can never be reused or reduced: hls.js reads a
   * media sequence that moves backwards as a parsing error, escalates it to fatal on a
   * single-variant stream, and the client answers a fatal parsing error by remounting the player,
   * which restarts playback at the beginning. So the numbering re-anchors forwards instead and this
   * segment continues from the last one published. Its date-time follows the sequence rather than
   * the reset index, for the same reason.
   */
  private sequenceFor(index: number): number {
    if (this.sequenceAnchor === null) {
      this.sequenceAnchor = { index, sequence: 0 };
      return 0;
    }

    if (index >= this.sequenceAnchor.index) {
      return this.sequenceAnchor.sequence + (index - this.sequenceAnchor.index);
    }

    if (!this.sequenceHasBeenPublished) {
      const shift = this.sequenceAnchor.index - index;
      this.segments = this.segments.map((seg) => ({ ...seg, sequence: sequenceOf(seg) + shift }));
      this.sequenceAnchor = { index, sequence: this.sequenceAnchor.sequence };
      return this.sequenceAnchor.sequence;
    }

    const resumeAt = this.highestSequence() + 1;
    this.logger.warn(
      `[ManifestManager] Segment index ${index} arrived below the anchor at ${this.sequenceAnchor.index}, ` +
        `so the engine's counter has restarted. Continuing the playlist at sequence ${resumeAt} rather ` +
        'than moving it backwards',
    );
    this.sequenceAnchor = { index, sequence: resumeAt };
    return resumeAt;
  }

  /** The highest sequence assigned so far, which the segment list holds in its last entry. */
  private highestSequence(): number {
    const newest = this.segments[this.segments.length - 1];
    return newest === undefined ? 0 : sequenceOf(newest);
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
    // on every rung.
    const mediaSequence = windowSegments.length > 0 ? windowSegments[0].index : 0;

    this.sequenceHasBeenPublished = true;
    return [...this.liveHeaderLines(mediaSequence), ...windowSegments.flatMap((seg) => this.segmentLines(seg))];
  }

  public buildVODManifest(): string {
    if (this.segments.length === 0) {
      return '';
    }

    this.sequenceHasBeenPublished = true;
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

  /**
   * Take a previous run's segments back, numbering and all.
   *
   * ⛔ The numbering is restored rather than recomputed. Whatever this broadcast already published
   * is what a viewer's player is holding, so a recovered session that renumbered its own history
   * would move every sequence a viewer had already been handed. An entry written before the engine
   * index and the playlist sequence were separate numbers carries no sequence at all, and its offset
   * is recovered from the first segment it holds, which is what the sequence was then.
   */
  public restoreState(segments: SegmentEntry[], hlsHeaders: string[]): void {
    const firstIndex = segments[0]?.index ?? 0;
    this.segments = segments.map((seg) => ({ ...seg, sequence: seg.sequence ?? seg.index - firstIndex }));
    this.hlsHeaders = [...hlsHeaders];

    const newest = this.segments[this.segments.length - 1];
    this.sequenceAnchor = newest === undefined ? null : { index: newest.index, sequence: sequenceOf(newest) };
    // A restored run is one whose numbers are already on disk and, for all this session can tell,
    // already in a feed a viewer is reading. So its history is settled: an index arriving below the
    // anchor from here is the engine's counter restarting, never an out-of-order arrival.
    this.sequenceHasBeenPublished = this.segments.length > 0;

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

  /**
   * The lines one segment occupies, in the order RFC 8216 §4.3.2.6 wants them: the break first, then
   * the wall clock the media after the break resumes at, then the segment itself.
   */
  private segmentLines(seg: SegmentEntry): string[] {
    const discontinuity = seg.discontinuity ? [HLS_DISCONTINUITY] : [];
    return [...discontinuity, buildProgramDateTime(this.programDateTimeMsOf(seg)), buildExtinf(seg.duration), seg.ref];
  }

  /**
   * When a segment's first frame is presented, derived and never observed.
   *
   * Nominal on both terms. The anchor is the broadcast's admission instant rather than any segment's
   * arrival, and the step is the fragment length the deployment declared rather than the `#EXTINF`
   * this segment measured. Using either observation would make the four rungs of one ladder disagree
   * about the same media, which is the one thing this tag exists here to prevent.
   */
  private programDateTimeMsOf(seg: SegmentEntry): number {
    return this.anchor.startedAtMs + Math.round(sequenceOf(seg) * this.anchor.fragmentSeconds * MS_PER_SECOND);
  }
}
