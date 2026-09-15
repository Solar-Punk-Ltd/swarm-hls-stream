import { buildExtinf, buildProgramDateTime, datingReanchored } from '@swarm-hls-stream/shared';

import { BroadcastAnchor, SegmentEntry } from '../types.js';
import {
  HLS_DISCONTINUITY,
  HLS_ENDLIST,
  HLS_GAP,
  HLS_M3U,
  HLS_MEDIA_SEQUENCE,
  HLS_PLAYLIST_TYPE_VOD,
  HLS_TARGET_DURATION,
  HLS_VERSION,
} from '../utils/hlsTags.js';

import {
  BroadcastDating,
  PlacedMedia,
  presentationMsOf,
  programDateTimeMsOf,
  soleRungDating,
  withEpoch,
} from './broadcastDating.js';
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

/** Where the broadcast's numbering starts: the engine index that publishes as `sequence`. */
interface SequenceAnchor {
  index: number;
  sequence: number;
}

/** Where a segment landed in the broadcast, and whether landing it moved the broadcast's own anchors. */
interface PlacedSegment {
  sequence: number;
  /**
   * Whether this segment is where the engine's counter restarted, so both the numbering and the
   * dating re-anchored at it. It carries the discontinuity that marks the join.
   */
  reanchored: boolean;
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
 * What a gap entry names, since RFC 8216bis requires a URI on every entry a playlist lists.
 *
 * The name has three jobs and this form does all of them. It has to be unique per hole, because the
 * client keys the segments it holds on the URI and two holes sharing one would collapse into a
 * single entry. It has to be identical every time the same hole is written out again, because that
 * same keying is what stops a re-poll appending the entry a second time. And it must not read as a
 * Swarm reference to anything downstream: a reference is 64 or 128 hex characters, and every reader
 * in this repository that turns a playlist line into a chunk address checks that shape, so a name
 * carrying a `gap-` prefix and a decimal sequence is refused by looking at it rather than by a
 * request that 404s.
 */
function gapUri(sequence: number): string {
  return `gap-${sequence}`;
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
 * `EXT-X-PROGRAM-DATE-TIME` decided once as the segment is placed, from the broadcast's anchor plus
 * the media held in front of it. Every uploader log line still names the engine's index, because
 * that is what correlates with the engine's own logs and with what the e2e harness reads.
 *
 * ⭐ **The two are separate numbers because SRS's is not a broadcast's.** Read in `ossrs/srs`
 * 6.0release: `SrsHlsMuxer::_sequence_no` is set to 0 in the muxer's constructor and nowhere else,
 * `on_publish` and `on_unpublish` do not touch it, and `hls_dispose` deletes the segments and the
 * m3u8 without resetting it. It goes back to 0 only when the whole `SrsLiveSource` is reaped and a
 * fresh muxer is built, which the idle timeout normally does a few seconds after a publisher leaves.
 * So a broadcast on a warm engine opens at whatever number the previous one ended on: six recordings
 * of this stage opened at 210, 317, 416, 580, 707 and 850. Abel's player wants a history starting at
 * 0, and it is the uploader's to give, because only the uploader knows where a broadcast began.
 *
 * What ties the rungs of a ladder together is that all four derive both numbers from **one anchor**:
 * every rung is transcoded from the same source with keyframes forced to the same media timestamps,
 * so segment N of 360p and segment N of 1080p cover the same interval, and both the sequence and the
 * date-time therefore agree across rungs for the same media. A per-rung count of what each uploader
 * happened to see would drift the moment one rung started a fragment later than another, and a level
 * switch would land that far off.
 *
 * ⭐ **The date follows the media, and a ladder's rungs still agree because of the snapping.** A
 * segment measuring within `DATING_SNAP_TOLERANCE` of `HLS_FRAGMENT` is dated as exactly that
 * length, and under a ladder every segment is, because the engine pins a keyframe every
 * `ABR_FPS x HLS_FRAGMENT` frames and only tick rounding separates the rungs' readings. On a single rendition the publisher's own keyframe interval
 * decides the segment: it measured 2.067 to 10.033 seconds against a configured 2 on 2026-09-15,
 * and dating every one of those at 2.000 put the recording's clock further behind its own media with
 * every segment, permanently. See `broadcastDating.ts`.
 *
 * An engine restart re-anchors the date-time as well as the numbering, on to the wall clock the
 * engine came back at, so the media after the gap carries the time it really happened. That
 * re-anchoring is minted once for the whole ladder, which is what keeps the rungs agreeing across
 * it. See {@link BroadcastEpoch} and `broadcastDating.ts`.
 *
 * ## A segment that was lost is said out loud, as a gap entry
 *
 * **Owner ruling of 2026-09-06, "Option A, say the gap".** A segment the engine closed while nothing
 * took it leaves a hole in the sequences this manager holds: a failed upload, a loss the engine
 * reported, or a loss inferred from the index that followed an uploader crash. HLS numbers the
 * entries a playlist lists consecutively from `#EXT-X-MEDIA-SEQUENCE`, so a playlist that simply left
 * the hole out would number every entry behind it one lower than its own sequence, and would number
 * them one higher again the moment the window slid past the hole. Two things break there. The
 * published rolling playlist renumbers media a viewer is already holding, and a viewer joining a rung
 * that lost a segment is one segment out of step with its siblings, which is the exact disagreement
 * the shared anchor exists to prevent.
 *
 * So every missing sequence between two held segments is listed, as `#EXT-X-GAP` plus the same
 * derived stamp, declared fragment length and a URI that every other entry carries. RFC 8216bis
 * §4.4.4.7 defines the tag as "the segment URI to which it applies does not contain media data and
 * SHOULD NOT be loaded by clients", and §6.3.3 tells a client to skip such an entry rather than fetch
 * it. hls.js 1.6.15, the version this project pins, reads it into `frag.gap` and skips the fragment.
 *
 * ⛔ **A gap entry never starts a window and never ends a playlist.** The window is a slice of the
 * segments actually held, so `#EXT-X-MEDIA-SEQUENCE` is always a held segment's own sequence, and a
 * hole that falls before the window's first held segment is behind the window and is not emitted at
 * all. The gaps are only ever between two entries that are both there.
 *
 * ⚠️ **A hole is NOT a discontinuity.** A lost segment does not restart the encoder's clock, so the
 * media after the hole is a continuation and its date carries on from the media in front of it.
 * `#EXT-X-DISCONTINUITY` is left for the two things that really are a break: the origin declaring
 * one, and the engine's counter restarting, which re-anchors the dating here.
 *
 * ⭐ **`#EXT-X-VERSION` stays at 3.** RFC 8216bis §8 lists no minimum protocol version for
 * `#EXT-X-GAP`: its bullets run from version 2 through 12 and none of them names the tag. Version 3
 * is what floating-point `#EXTINF` durations require, which is what these playlists already carry,
 * so nothing about the gap entries moves it.
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
   * {@link placeInBroadcast}.
   */
  private sequenceHasBeenPublished = false;

  /**
   * What dates this rung's segments, replaced rather than edited when a restart re-anchors it.
   *
   * Replaced, so a session that has been retired keeps the dating it published with while its
   * replacement moves on: the retired session's own finalize builds its recording from this.
   */
  private anchor: BroadcastAnchor;

  /** Where a restart's re-anchoring is minted, once for the whole ladder. See {@link BroadcastDating}. */
  private readonly dating: BroadcastDating;

  constructor(anchor: BroadcastAnchor, dating?: BroadcastDating) {
    this.anchor = anchor;
    this.dating = dating ?? soleRungDating(() => this.anchor);
  }

  /**
   * The dating this rung is publishing on, for the recovery entry to carry.
   *
   * Read from here rather than from the value the session was constructed with, which is the whole of
   * what makes a re-anchoring survive a crash: a session that restarted and then died would
   * otherwise come back on the dating the broadcast opened with and re-date every post-restart
   * segment into the lag.
   */
  public broadcastAnchor(): BroadcastAnchor {
    return this.anchor;
  }

  /**
   * Take a segment that landed, at the sequence its engine index publishes as.
   *
   * ⛔ `discontinuity` says the media here is not a continuation of what came before it, which is a
   * different statement from "something is missing". A segment that never landed leaves a hole, and
   * the hole is said by the gap entries {@link gapLines} writes for the sequences nothing fills. See
   * the gap-entry section of the class docblock.
   */
  public addSegment(index: number, duration: number, ref: string, discontinuity = false): void {
    const placed = this.placeInBroadcast(index);
    this.segments.push({
      index,
      duration,
      ref,
      // Armed by a re-anchoring as well as by the caller, and neither implies the other. The media
      // after an engine restart is not a continuation of what came before it, and the SRS webhook
      // path declares no break of its own, so on the shipped engine nothing else would mark the
      // join. A playlist that omits it tells a player the join is seamless, which is what a player
      // stalls on, and it is also what makes the date jumping the length of the outage legal rather
      // than a promise of media the playlist does not name.
      discontinuity: discontinuity || placed.reanchored,
      sequence: placed.sequence,
    });
    // By sequence rather than by index, which are the same order for the whole of an ordinary
    // broadcast and are not after an engine restart: the engine's counter goes back to 0 there and
    // sorting on it would file the media that comes after the restart in front of the media that
    // came before.
    this.segments.sort((a, b) => sequenceOf(a) - sequenceOf(b));
    this.datePlacements();

    const newTarget = Math.ceil(duration);
    if (newTarget > this.targetDuration) {
      this.targetDuration = newTarget;
    }

    this.logger.debug(`[ManifestManager] Added segment ${index}, total: ${this.segments.length}`);
  }

  /**
   * The playlist sequence this engine index publishes as, counting from 0 at the broadcast's first
   * segment, and whether placing it re-anchored the broadcast.
   *
   * ⛔ **An index that does not carry the numbering forward is one of two different things, and
   * getting them the wrong way round breaks a real guarantee each time.**
   *
   * Before any playlist has gone out, it is a segment that arrived out of order, and one below the
   * anchor means the broadcast began earlier than the first arrival said. Nothing has been promised
   * to anyone yet, so the segment takes its true place in media order and the anchor moves down to
   * meet it, everything already held shifting up.
   *
   * Afterwards it is the engine's counter having restarted. A number already published can never be
   * reused or reduced: hls.js reads a media sequence that moves backwards as a parsing error,
   * escalates it to fatal on a single-variant stream, and the client answers a fatal parsing error
   * by remounting the player, which restarts playback at the beginning. So the numbering re-anchors
   * forwards and this segment continues from the last one published. The dating re-anchors with it,
   * on to the wall clock the engine came back at. See {@link reanchorDating}.
   *
   * ⚠️ The test is against the highest sequence already assigned rather than against the anchor's
   * own index, because a broadcast whose first segment was index 0 is anchored at 0 and an engine
   * that restarts resets to 0: comparing indexes would read that reset as no movement at all and
   * hand a second segment the sequence the first one already has.
   */
  private placeInBroadcast(index: number): PlacedSegment {
    const anchor = this.sequenceAnchor;
    if (anchor === null) {
      this.sequenceAnchor = { index, sequence: 0 };
      return { sequence: 0, reanchored: false };
    }

    const candidate = anchor.sequence + (index - anchor.index);

    if (!this.sequenceHasBeenPublished) {
      if (index >= anchor.index) {
        return { sequence: candidate, reanchored: false };
      }

      const shift = anchor.index - index;
      this.segments = this.segments.map((seg) => ({ ...seg, sequence: sequenceOf(seg) + shift }));
      this.sequenceAnchor = { index, sequence: anchor.sequence };
      return { sequence: anchor.sequence, reanchored: false };
    }

    const highest = this.highestSequence();
    if (candidate > highest) {
      return { sequence: candidate, reanchored: false };
    }

    const resumeAt = highest + 1;
    this.logger.warn(
      `[ManifestManager] Segment index ${index} would publish at sequence ${candidate}, at or below the ` +
        `${highest} already published, so the engine's counter has restarted. Continuing the playlist at ` +
        `sequence ${resumeAt} rather than moving it backwards`,
    );
    this.sequenceAnchor = { index, sequence: resumeAt };
    this.reanchorDating(resumeAt);
    return { sequence: resumeAt, reanchored: true };
  }

  /**
   * Move the dating on to the wall clock the engine came back at, from `resumeAt` forwards.
   *
   * ⛔ Nothing already dated moves. The epoch starts at `resumeAt`, and a sequence below it keeps
   * the epoch it had, so the segments still in the live window carry the dates a viewer was handed.
   *
   * The floor offered is the date `resumeAt` would have carried had nothing restarted, which is one
   * segment's own media past the newest segment this rung has dated. It matters where the dating had
   * run ahead of the wall clock, which is what a segment longer than `HLS_FRAGMENT` accumulates:
   * minting at the clock there would pull a stamp backwards, and hls.js reads that as a parsing
   * error rather than as a restart.
   */
  private reanchorDating(resumeAt: number): void {
    const newest = this.segments[this.segments.length - 1];
    const wouldHaveBeen = presentationMsOf(
      this.anchor,
      resumeAt,
      newest === undefined ? null : this.placedMedia(newest),
    );
    const epoch = this.dating.epochFrom(resumeAt, wouldHaveBeen);
    this.anchor = withEpoch(this.anchor, epoch);
    // Composed in the shared log contract rather than written out here, because the e2e harness
    // counts this as one of the ways a discontinuity is armed and six suites assert that count is
    // zero on a clean broadcast. A line reworded here and not read there passes them for ever.
    this.logger.info(
      datingReanchored(resumeAt, new Date(wouldHaveBeen).toISOString(), new Date(epoch.atMs).toISOString()),
    );
  }

  /**
   * The highest sequence assigned so far, which the segment list holds in its last entry because it
   * is sorted by sequence.
   *
   * Only ever read with an anchor already set, so a segment list is always there to read it from.
   */
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

    // This broadcast's own sequence for the window's first segment, so the playlist a viewer joining
    // at the top reads starts at 0. Not the engine's index, which on a warm engine opens wherever
    // the previous broadcast ended, and not a count of what this uploader has seen either: a count
    // would drift across an ABR ladder the moment one rung started a fragment later than another,
    // and every level switch would land that far off. The sequence is derived from the anchor all
    // four rungs share, so it agrees across them by construction.
    const mediaSequence = windowSegments.length > 0 ? sequenceOf(windowSegments[0]) : 0;

    this.sequenceHasBeenPublished = true;
    return [...this.liveHeaderLines(mediaSequence), ...this.timelineLines(windowSegments)];
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
      // The same numbering the live playlists used, which for a recording naming every segment is 0.
      // It has to be the same one: a viewer whose live playlist ended is handed the closing playlist
      // and then the recording, and hls.js reports a media sequence that moves between them as a
      // parsing error rather than as a change of resource.
      `${HLS_MEDIA_SEQUENCE}:${sequenceOf(this.segments[0])}`,
      '',
      ...this.timelineLines(this.segments),
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
   * of a segment only from a manifest, so nothing will ever tell one that they exist. No gap entry
   * names them either: a gap entry is written for a sequence nothing fills, and these sequences are
   * filled by segments this manager is holding.
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
   * ⛔ The numbering and the dating are both restored rather than recomputed. Whatever this
   * broadcast already published is what a viewer's player is holding, so a recovered session that
   * derived its own history again would move every sequence and every date a viewer had been handed.
   * An entry written before the engine index and the playlist sequence were separate numbers carries
   * no sequence at all, and its offset is recovered from the first segment it holds, which is what
   * the sequence was then. An entry written before the date followed the media carries no instant,
   * and the anchor's own arithmetic is what that entry went out with.
   */
  public restoreState(segments: SegmentEntry[], hlsHeaders: string[]): void {
    const firstIndex = segments[0]?.index ?? 0;
    const renumbered = segments.map((seg) => ({ ...seg, sequence: seg.sequence ?? seg.index - firstIndex }));
    this.segments = renumbered.map((seg) => ({ ...seg, presentedAtMs: this.presentedAtMsOf(seg) }));
    this.hlsHeaders = [...hlsHeaders];

    const newest = this.segments[this.segments.length - 1];
    this.sequenceAnchor = newest === undefined ? null : { index: newest.index, sequence: sequenceOf(newest) };
    // A restored run is one whose numbers are already on disk and, for all this session can tell,
    // already in a feed a viewer is reading. So its history is settled: an index arriving below the
    // anchor from here is the engine's counter restarting, never an out-of-order arrival.
    this.sequenceHasBeenPublished = this.segments.length > 0;

    if (this.segments.length > 0) {
      // Folded rather than spread. `segments` holds every segment the broadcast ever published, so a
      // spread passes them all as arguments at once and throws `RangeError: Maximum call stack size
      // exceeded` somewhere past 110,000 of them, which is about 15 hours at the shipping
      // half-second profile. The throw reached the orchestrator's error handler, so a broadcast that
      // long simply failed to recover: its recording was never sealed, its catalog entry stayed
      // `live`, and no health reason fired, because the entry parses perfectly well and was
      // therefore never quarantined. Every later boot read it, threw, and moved on.
      this.targetDuration = Math.ceil(this.segments.reduce((longest, seg) => Math.max(longest, seg.duration), 0));
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
   *
   * ⛔ Extending the window over a hole costs the hole's gap entries as well as the segment on the
   * far side of it, and both are charged here. Uncounted, a broadcast that lost a run of segments
   * would publish a window over one chunk and pay three round trips per segment for as long as the
   * hole stayed inside it. A hole too wide to afford simply stops the window: the media before it is
   * older than what a joining viewer needs, and the floor of one held segment is never reached by
   * this, since a window of one segment has no pair to hold a hole between.
   */
  private liveWindowLength(): number {
    // Reserved against the largest media sequence there could be, whose own digits are part of the
    // header. Reserving this way avoids a second pass over a header whose length depends on the
    // answer, and under-reserving spends a budget that is one bee chunk. The newest sequence is the
    // upper bound rather than the segment count, because an engine restart re-anchors the numbering
    // forwards and leaves the sequence above the count.
    const newestSequence = this.segments.length === 0 ? 0 : sequenceOf(this.segments[this.segments.length - 1]);
    const budget = LIVE_WINDOW_MAX_BYTES - manifestBytes(this.liveHeaderLines(newestSequence));

    let spent = 0;
    let length = 0;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const successor = this.segments[i + 1];
      spent += manifestBytes(this.segmentLines(this.segments[i]));
      if (successor !== undefined) {
        spent += manifestBytes(this.gapLines(this.segments[i], successor));
      }
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
    return [...discontinuity, buildProgramDateTime(this.presentedAtMsOf(seg)), buildExtinf(seg.duration), seg.ref];
  }

  /**
   * Held segments with every sequence missing between two of them listed as a gap entry.
   *
   * Written by both the live window and the recording, over whatever slice of the held segments each
   * of them names, so a hole reads the same in the playlist a viewer is following and in the one they
   * are handed afterwards.
   */
  private timelineLines(held: readonly SegmentEntry[]): string[] {
    return held.flatMap((seg, position) =>
      position === 0 ? this.segmentLines(seg) : [...this.gapLines(held[position - 1], seg), ...this.segmentLines(seg)],
    );
  }

  /**
   * One entry per sequence the broadcast lost between these two held segments, in order, and nothing
   * at all where they are consecutive.
   *
   * The duration is the fragment length the deployment declared and never a measurement: nothing was
   * observed here, the media is gone. Taking the neighbouring segment's own `#EXTINF` would put one
   * rung's encoder rounding on a hole the whole ladder lost, and the four rungs would then disagree
   * about where the media after it starts. Where the run of gaps begins is a different question, and
   * that is the media that really ran in front of it, which is what `from` carries.
   */
  private gapLines(from: SegmentEntry, to: SegmentEntry): string[] {
    const lines: string[] = [];
    const previous = this.placedMedia(from);
    for (let sequence = sequenceOf(from) + 1; sequence < sequenceOf(to); sequence++) {
      lines.push(
        HLS_GAP,
        buildProgramDateTime(presentationMsOf(this.anchor, sequence, previous)),
        buildExtinf(this.anchor.fragmentSeconds),
        gapUri(sequence),
      );
    }
    return lines;
  }

  /**
   * When a held segment is presented, which was decided as it was placed and stored on the entry.
   *
   * The fallback covers an entry persisted before the instant was, where the anchor's own arithmetic
   * is not a guess: it is the very date that entry was published with.
   */
  private presentedAtMsOf(seg: SegmentEntry): number {
    return seg.presentedAtMs ?? programDateTimeMsOf(this.anchor, sequenceOf(seg));
  }

  private placedMedia(seg: SegmentEntry): PlacedMedia {
    return { sequence: sequenceOf(seg), presentedAtMs: this.presentedAtMsOf(seg), durationSeconds: seg.duration };
  }

  /**
   * Give the segments that have just been placed the instant they are presented at.
   *
   * ⛔ **An instant a playlist has gone out with is never decided twice.** Once a sequence has been
   * published, every placement is above every sequence held, either because the numbering carried
   * forward or because a restart resumed one past the highest, so only the arrival itself is dated
   * and a viewer's history keeps the dates it was handed. Before then nothing has been promised and
   * a segment can still arrive out of order or below the anchor, both of which change the media the
   * segments behind it are dated from, so the whole held list is dated again.
   */
  private datePlacements(): void {
    const settled = this.sequenceHasBeenPublished ? this.segments.length - 1 : 0;
    const dated = this.segments.slice(0, settled);

    for (const seg of this.segments.slice(settled)) {
      const previous = dated[dated.length - 1];
      dated.push({
        ...seg,
        presentedAtMs: presentationMsOf(
          this.anchor,
          sequenceOf(seg),
          previous === undefined ? null : this.placedMedia(previous),
        ),
      });
    }

    this.segments = dated;
  }
}
