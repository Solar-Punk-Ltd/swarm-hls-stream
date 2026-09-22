// One definition, in the shared package, because the client reads the same catalog entries this
// writes and the two used to carry their own copies of these literals. Re-exported here rather than
// imported at every call site so the move stays invisible to the rest of the package. See ARCH-1.
export {
  MEDIA_TYPE_AUDIO,
  MEDIA_TYPE_VIDEO,
  type MediaType,
  type Rendition,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_VOD,
  type StreamStatus,
} from '@swarm-hls-stream/shared';

import type { MediaType } from '@swarm-hls-stream/shared';

/**
 * A previous session's recording, carried verbatim so this session's own recording opens with the
 * whole broadcast rather than with this session alone.
 *
 * ⛔ **`lines` is the previous playlist's own text and nothing here re-derives any of it.** Not the
 * dates, not the numbering, not the references. A rung's feed outlives its sessions, so the head this
 * was read off is a playlist somebody may already be playing, and a prefix that re-dated or
 * renumbered it would be this session inventing a history for media it never saw. The uploader's own
 * anchor and sequence apply to the segments this session placed, and stop at the seam.
 *
 * @see ManifestManager.inherit
 */
export interface InheritedTimeline {
  /** The `#EXT-X-MEDIA-SEQUENCE` the prefix's first entry is numbered from, which the glued recording declares. */
  mediaSequence: number;
  /** The `#EXT-X-TARGETDURATION` the prefix was published with, which the glued recording takes the max of. */
  targetDuration: number;
  /**
   * The `#EXT-X-DISCONTINUITY-SEQUENCE` the prefix declared, which is the breaks that had already
   * slid out of ITS window. Zero for a recording, which names the broadcast from its start.
   *
   * ⛔ Carried, because a session that dropped it published a discontinuity sequence LOWER than the
   * head a viewer had just been handed. See `ManifestManager.inheritedDiscontinuities`.
   */
  discontinuitySequence: number;
  /** The seconds of media the prefix holds, summed off its `#EXTINF` values, for the reported duration. */
  durationSeconds: number;
  /** Every timeline line of the prefix, in order, from its first timeline tag to before its `#EXT-X-ENDLIST`. */
  lines: string[];
}

export interface StreamState {
  streamId: string;
  streamRawTopic: string;
  mediatype: MediaType;
  socIndex: number | null;
  segments: SegmentEntry[];
  hlsHeaders: string[];
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
  pendingDiscontinuity?: boolean;
  liveManifestStale?: boolean;
  updatedAt: number;
  /** Absent on state written before the ABR ladder existed, and on non-ladder streams. */
  ladder?: LadderMembership;
  bitrate?: BitrateSample;
  /** Absent on state written before playlists carried a wall clock. See {@link BroadcastAnchor}. */
  anchor?: BroadcastAnchor;
  /**
   * What this session adds to every sequence it publishes, because it opened over a feed that already
   * held one. Absent means zero, which is every entry written before a feed outlived its session.
   *
   * ⛔ Persisted rather than read off the feed again after a crash. The head this was derived from is
   * this session's own live playlist by then, so re-deriving it would add this session's own length
   * to its own numbering and every recovered segment would jump forward by a whole broadcast. See
   * `ManifestManager.continueFrom`.
   */
  sequenceOffset?: number;
  /**
   * The previous session's recording, which this session's own recording opens with. Absent means
   * the feed was empty, which is every entry written before recordings were glued.
   *
   * ⛔ Persisted for the same reason {@link StreamState.sequenceOffset} is, and it is the same head
   * that both were read off. By the time a recovered session runs, the feed head is this session's
   * own live playlist, so re-reading it would glue this session's own window in front of itself.
   * See `ManifestManager.inherit`.
   *
   * ⚠️ **What it costs, measured rather than estimated.** `RecoveryStore` writes this whole entry
   * synchronously once per segment, and the prefix grows by a session every time the broadcaster
   * restarts. Over four sessions of 30 minutes at 2s segments the entry measured 150 KB, 269 KB,
   * 388 KB and 507 KB, the prefix being 357 KB of the last. The entry was already six figures at the
   * first session, because `segments` holds every segment the broadcast ever published, so this
   * roughly triples a write that was never small. Accepted at this size; a deployment seeing entries
   * approach a megabyte should make the write incremental rather than trim what it records.
   */
  inherited?: InheritedTimeline;
  /**
   * Whether the encoder came back inside the reconnect window and the first segment of the resumed
   * run has not landed yet, so that segment still owes a break and a re-anchored dating. Absent
   * means no, which is every entry written before a disconnect held a session open.
   *
   * ⛔ Persisted for a sharper version of the reason {@link StreamState.pendingDiscontinuity} is: the
   * interval this covers is one in which the encoder has announced itself and sent nothing yet, which
   * is the likeliest moment in a broadcast for a restart to land. A recovered session that lost it
   * publishes its first returning segment as a continuation of the media on the far side of the
   * outage, dated where the broadcast would have been had nothing happened.
   *
   * ⛔ It is the ONLY thing a reconnect arms. `pendingDiscontinuity` is left alone, so a return that
   * never delivers a segment arms no break at all. See `ManifestManager.resumeAfterReconnect`.
   */
  resumingAfterReconnect?: boolean;
  /**
   * The admin's id for this broadcast, when the service is in admin mode. See {@link AdminSession}.
   *
   * ⛔ Persisted rather than resolved again after a crash, and it has to be. A recovered session is
   * rebuilt from this entry alone — no engine re-announces it, so nothing looks the draft up a second
   * time — and without the id there is nothing to address the VOD report to. The broadcast would then
   * finalize correctly into its feed and stay `live` in the admin's list for ever.
   */
  adminStreamId?: string;
}

/**
 * The broadcast a resolved ingest session belongs to, in admin mode. See `engines/adminGate.ts`.
 *
 * Two fields because two things move out of this service when an admin owns the stream list: the feed
 * topic, which the admin minted when the stream was declared and which the uploader must publish
 * into rather than minting one of its own, and the admin's own id for the stream, which every state
 * report names.
 */
export interface AdminSession {
  id: string;
  /** Raw feed topic, exactly as handed to `Topic.fromString`. */
  topic: string;
}

/**
 * What fixes a broadcast's playlists to a wall clock, so all four rungs date the same media alike.
 *
 * ⛔ **A segment's date is this anchor plus the media held in front of it, and never a clock read
 * per segment.** Four rung uploaders stamping each segment with the time it happened to reach them
 * would disagree by their own upload jitter, and hls.js would read that disagreement as the rungs
 * covering different media. So the derivation is the point, and `broadcastDating.ts` holds it.
 *
 * `startedAtMs` is where the dating begins: one instant for the whole ladder, minted when the
 * broadcast is admitted, outliving every session of that broadcast including one rebuilt from a
 * recovery entry.
 *
 * `fragmentSeconds` is what the deployment declared through `HLS_FRAGMENT`. It is the grid the
 * media is read against rather than a step taken blind: a segment measuring within
 * `DATING_SNAP_TOLERANCE` of it is dated as exactly this length, so a ladder whose rungs are cut on
 * one keyframe grid dates one piece of media identically on all four. A segment outside the tolerance is
 * dated by what it really held, because a single rendition's segment is decided by the publisher's
 * own keyframe interval and dating a 10 second one as 2 leaves the recording's clock behind its
 * media for ever. It is never persisted with the broadcast, so a redeployment under a new
 * `HLS_FRAGMENT` reads the grid it is now cutting at.
 */
export interface BroadcastAnchor {
  /** Epoch milliseconds of the broadcast's first fragment, shared by every rung of the ladder. */
  startedAtMs: number;
  /** Nominal seconds of media per fragment, from `HLS_FRAGMENT`. */
  fragmentSeconds: number;
  /**
   * Where the dating was moved on to the wall clock again, in `fromSequence` order. Absent until the
   * engine has restarted inside this broadcast. See {@link BroadcastEpoch}.
   */
  epochs?: BroadcastEpoch[];
}

/**
 * One re-anchoring of a broadcast's dating, which an engine restart inside the broadcast produces.
 *
 * ⛔ Owner decision of 2026-09-03. The dating used to be a single instant, so the media after a
 * restart carried a time behind real time by the whole length of the gap, without bound over a long
 * broadcast. It is a list of epochs now: the media before the restart keeps the dates it was
 * published with, and the media after it is dated from the wall clock the engine came back at.
 *
 * ⛔ **Minted once for the whole ladder, by whichever rung crosses the restart first.** Every other
 * rung materialises that same line at its own resuming sequence, so the mapping from sequence to
 * date stays one function for the ladder. That is the property the tag is here for, and it is why
 * the shared thing is the line rather than the point it is written down at.
 */
export interface BroadcastEpoch {
  /** The first playlist sequence this epoch dates. Everything below it keeps the epoch it had. */
  fromSequence: number;
  /** Epoch milliseconds that sequence's first frame is presented at. */
  atMs: number;
}

/** One rung of the encoder's ABR ladder, as configured via ABR_LADDER. */
export interface LadderRung {
  /** Suffix the engine appends to the stream name, e.g. '720p'. */
  name: string;
  width: number;
  height: number;
  /** The encoder's target, in kbps. Stands in until enough segments have been measured. */
  configuredKbps: number;
}

/** What ties one rung's uploader to the other three. */
export interface LadderMembership {
  /** Stable id for the ladder, shared by every rung and used as the catalog entry's identity. */
  group: string;
  rung: LadderRung;
}

/** Running bitrate measurement, carried across a restart so a recovery does not reset it. */
export interface BitrateSample {
  totalBytes: number;
  totalDuration: number;
  peakBps: number;
  /** Trailing segments the peak is measured across. See {@link PEAK_WINDOW_SEGMENTS}. */
  window?: SegmentSize[];
}

export interface SegmentSize {
  bytes: number;
  duration: number;
}

/**
 * One rung as the player sees it: enough to build an EXT-X-STREAM-INF and to find the feed
 * carrying that rung's media playlist.
 */

export interface SegmentEntry {
  /** The engine's own running counter for this segment, which every uploader log line names. */
  index: number;
  duration: number;
  ref: string;
  discontinuity?: boolean;
  /**
   * Where this segment sits in the playlist this broadcast publishes, counting from 0.
   *
   * Not the same number as `index` and deliberately so: see {@link BroadcastAnchor} and
   * `ManifestManager.placeInBroadcast`. Absent on entries persisted before the two were separated, where
   * the offset between them is recovered from the first segment held.
   */
  sequence?: number;
  /**
   * When this segment is presented, in epoch milliseconds, decided once as it was placed.
   *
   * Stored rather than derived on every build, so a recovered session republishes the dates a viewer
   * was already handed and a slice of the held segments carries its own. Absent on entries persisted
   * before the dating followed the media, where the anchor's own arithmetic is not a guess but the
   * very date the entry went out with. See `broadcastDating.ts`.
   */
  presentedAtMs?: number;
}

/**
 * Who announced a stream, as far as the path that took the announce could tell.
 *
 * The address alone, deliberately, and not the `address:port` socket the OME admission guard matches
 * on. The two are asking different questions of the same field: that guard has to tell one *session*
 * from another, and a reconnecting publisher always arrives on a fresh source port, so the port is
 * exactly what it needs. This one has to tell one *publisher* from another, and the port changes for
 * the legitimate broadcaster too, so including it would make every reconnect look like a stranger.
 */
export interface StreamClaimant {
  /**
   * The publisher's address as the engine reported it, or `null` when the announce did not carry one.
   *
   * Null is wider than the field being absent, in the same way `SessionIdentity`'s halves are: this
   * is parsed from a webhook body, so an omitted field arrives as `null` and an empty string is not
   * an address. Each of those says "no evidence", and no evidence must not read as evidence of a
   * stranger.
   */
  address: string | null;
  /**
   * Whether the announce presented the publish key for the stream it named. See SEC-28.
   *
   * **Two states, unlike `address`, and that is why this one is optional where that one is not.** An
   * address distinguishes "no evidence" from "this address", so it needs a null and a value. A key is
   * either proven or it is not: an announce that presented nothing and an announce that presented the
   * wrong key are the same announce as far as any guard here is concerned, so there is no third
   * reading for an absent field to carry.
   *
   * Absent therefore means `false`, and that is the safe direction in both roles it appears in. A
   * newcomer without it is judged by SEC-26's address rule, and an incumbent without it is protected
   * by SEC-26's address rule. A caller that forgets the field loses SEC-28 and keeps SEC-26, which is
   * the same fail-open bargain the `claimant` parameter's own default makes, for the same reason:
   * this must not take a broadcaster off the air over a field nobody filled in.
   */
  isAuthenticated?: boolean;
}

/**
 * An announce that named nobody, which every guard here has to treat as no evidence rather than as
 * proof. `isAuthenticated` is spelled out rather than left off, because this constant is the one
 * place where naming nobody is a positive statement rather than an omission.
 */
export const ANONYMOUS_CLAIMANT: StreamClaimant = { address: null, isAuthenticated: false };

export const REJECT_QUEUE_FULL = 'queue_full' as const;
export const REJECT_UNKNOWN_STREAM = 'unknown_stream' as const;
export const REJECT_DUPLICATE = 'duplicate' as const;
/** The stream is finalizing. Distinct from `unknown_stream`: it existed, and its manifest is closed. */
export const REJECT_DRAINING = 'draining' as const;
/** The declared duration is not a number a manifest or a running total can hold. */
export const REJECT_UNUSABLE_DURATION = 'unusable_duration' as const;

export type RejectReason =
  | typeof REJECT_QUEUE_FULL
  | typeof REJECT_UNKNOWN_STREAM
  | typeof REJECT_DUPLICATE
  | typeof REJECT_DRAINING
  | typeof REJECT_UNUSABLE_DURATION;

export type SegmentResult = { accepted: true } | { accepted: false; reason: RejectReason };

export const PRESSURE_LOW = 'low' as const;
export const PRESSURE_MEDIUM = 'medium' as const;
export const PRESSURE_HIGH = 'high' as const;

export type QueuePressure = typeof PRESSURE_LOW | typeof PRESSURE_MEDIUM | typeof PRESSURE_HIGH;

export const HEALTH_OK = 'ok' as const;
export const HEALTH_DEGRADED = 'degraded' as const;
/**
 * The boot has not finished, because the half of it that needs a Bee node is still waiting for one.
 *
 * Distinct from `degraded` on purpose, and the distinction is what an operator acts on: degraded is a
 * reading about a service that is running, while this one says nothing has run yet. See
 * `libs/NodeWait.ts` for what the service is doing while it answers this.
 */
export const HEALTH_WAITING_FOR_NODE = 'waiting_for_node' as const;

export type HealthStatus = typeof HEALTH_OK | typeof HEALTH_DEGRADED | typeof HEALTH_WAITING_FOR_NODE;

export const HEALTH_REASON_STALE_MANIFEST = 'stale_manifest' as const;
export const HEALTH_REASON_SEGMENT_UPLOAD_FAILURE = 'segment_upload_failure' as const;
export const HEALTH_REASON_QUEUE_PRESSURE = 'queue_pressure' as const;
export const HEALTH_REASON_SEGMENT_STALL = 'segment_stall' as const;
export const HEALTH_REASON_SEGMENT_LOSS = 'segment_loss' as const;
export const HEALTH_REASON_UNLISTED_STREAM = 'unlisted_stream' as const;
export const HEALTH_REASON_STATE_NOT_PERSISTED = 'state_not_persisted' as const;
export const HEALTH_REASON_INGEST_REFUSED = 'ingest_refused' as const;
export const HEALTH_REASON_UNRECOVERABLE_STREAM = 'unrecoverable_stream' as const;
export const HEALTH_REASON_FRAGMENT_MISMATCH = 'fragment_mismatch' as const;
export const HEALTH_REASON_FRAGMENT_PUBLISHER_GOP = 'fragment_publisher_gop' as const;
export const HEALTH_REASON_POSTAGE_REFUSED = 'postage_refused' as const;
export const HEALTH_REASON_NODE_UNAVAILABLE = 'node_unavailable' as const;
export const HEALTH_REASON_START_GATE_WARNED = 'start_gate_warned' as const;

export type HealthReason =
  | typeof HEALTH_REASON_STALE_MANIFEST
  | typeof HEALTH_REASON_SEGMENT_UPLOAD_FAILURE
  | typeof HEALTH_REASON_QUEUE_PRESSURE
  | typeof HEALTH_REASON_SEGMENT_STALL
  | typeof HEALTH_REASON_SEGMENT_LOSS
  | typeof HEALTH_REASON_UNLISTED_STREAM
  | typeof HEALTH_REASON_STATE_NOT_PERSISTED
  | typeof HEALTH_REASON_INGEST_REFUSED
  | typeof HEALTH_REASON_UNRECOVERABLE_STREAM
  | typeof HEALTH_REASON_FRAGMENT_MISMATCH
  | typeof HEALTH_REASON_FRAGMENT_PUBLISHER_GOP
  | typeof HEALTH_REASON_POSTAGE_REFUSED
  | typeof HEALTH_REASON_NODE_UNAVAILABLE
  | typeof HEALTH_REASON_START_GATE_WARNED;

/**
 * A startup gate that warned instead of refusing, as `/health` reports it.
 *
 * ⛔ The gate's own message is deliberately not here. `/health` takes no credential and is published
 * on every interface the deployment binds, and those messages name node URLs and postage batch ids.
 * The gate's name and the rung are enough to act on, and the log has the rest.
 */
export interface StartGateWarning {
  /** The gate's class name, `ChequebookGate` or `PostageGate`. */
  readonly gate: string;
  /** The ABR rung, absent on a single-node deployment and on a gate that threw before reading one. */
  readonly rung?: string;
}

/**
 * What the boot is waiting for, as `/health` reports it while the node has not answered.
 *
 * `waitingSince` is the whole wait rather than the current attempt, because the question a person
 * asks of a page showing this is how long it has been like that. `lastError` is absent until the
 * first attempt has failed: a boot reports that it is waiting before it has tried anything, so that
 * a probe reaching the service in its first second is told the truth rather than `ok`.
 */
export interface NodeWaitReport {
  /**
   * The node this wait is about, with any credential stripped.
   *
   * The coordinator until something fails, since that is the node every boot read reaches. After a
   * failure it is the node that failure was about where it named one, because on a pool of four a
   * refusal about the 1080p rung reported against a coordinator that is answering sends an operator
   * to the wrong machine.
   */
  readonly url: string;
  /** ISO 8601, so it survives the JSON that carries it and reads the same to a person and a page. */
  readonly waitingSince: string;
  readonly attempts: number;
  readonly lastError?: string;
}

export const RECOVERY_ENTRY_MISSING = 'missing' as const;
export const RECOVERY_ENTRY_LOADED = 'loaded' as const;
export const RECOVERY_ENTRY_UNREADABLE = 'unreadable' as const;

/**
 * What the recovery store found on disk for one stream id.
 *
 * ⛔ The three cases are kept apart because collapsing two of them cost a broadcast. `load` answers
 * `null` for a stream that was never saved and for one whose file will not parse, and the recovery
 * pass read that single `null` as permission to delete the file. Anything deciding what to *do* with
 * an entry needs `unreadable` and `missing` to be different answers.
 */
export type RecoveryEntry =
  | { kind: typeof RECOVERY_ENTRY_MISSING }
  | { kind: typeof RECOVERY_ENTRY_LOADED; state: StreamState }
  | { kind: typeof RECOVERY_ENTRY_UNREADABLE };

/**
 * One stream the publisher rather than `HLS_FRAGMENT` is segmenting, with both lengths in seconds.
 *
 * `measuredSeconds` is the median of the first {@link FRAGMENT_SAMPLE_COUNT} segments whose own
 * timestamps were readable, never a duration an engine declared.
 */
export interface PublisherGopStream {
  streamId: string;
  configuredSeconds: number;
  measuredSeconds: number;
}

export interface HealthSignals {
  activeStreams: number;
  staleManifestStreams: number;
  maxConsecutiveManifestFailures: number;
  maxConsecutiveSegmentFailures: number;
  queuePressure: QueuePressure;
  /**
   * Age of the least recently active stream that is expected to be producing segments, so the worst
   * stream sets the number rather than the busiest one. `null` when no such stream is registered,
   * which is how an idle uploader, a draining stream and a stream awaiting recovery all avoid
   * looking stalled.
   */
  msSinceStreamActivity: number | null;
  /**
   * Age of the most recent segment the engine could not deliver at all, across every registered
   * stream. `null` when none has been reported.
   *
   * An age rather than a count because a loss is permanent and instantaneous: there is no later
   * event that makes it untrue, so a counter that clears on the next success reports nothing. The
   * next success is also the common case, since a puller writes a segment off and then downloads the
   * one behind it in the same pass.
   */
  msSinceSegmentLoss: number | null;
  /**
   * How long the longest-waiting live stream has been absent from the catalog, or `null` while every
   * one of them is listed. The catalog entry is the only thing that makes a broadcast discoverable,
   * so this is a stream publishing every segment on time that no viewer can find.
   *
   * On the wall clock rather than the orchestrator's injected one, because the uploader that owns the
   * instant has no clock seam. Nothing in the policy compares it against a faked time.
   */
  msSinceCatalogAnnounceFailed: number | null;
  /**
   * How long this service has been unable to write the state it needs to survive a restart, across
   * the recovery store and the catalog index, or `null` while every write is landing. Both write into
   * `STATE_DIR`, so one number covers them.
   *
   * Nothing is wrong with the running process while this is set, which is what made it invisible: the
   * damage is done by the next restart, which resumes a stream from stale segments or a catalog feed
   * from an index readers have already passed.
   */
  msSinceStatePersistFailed: number | null;
  /**
   * Playing time still waiting to upload for the worst stream, in seconds, which is how far behind
   * live a viewer of it is.
   *
   * `queuePressure` is a ratio against `MAX_QUEUE_SIZE`, and that ceiling has no relationship to how
   * stale a playlist a viewer will tolerate: a 39 deep backlog reported `low` at roughly 78 seconds
   * behind live. This is the number the policy can actually judge. See OBS-9.
   */
  queueBacklogSeconds: number;
  /**
   * Age of the most recent request a credential gate refused, across every gate in the process, or
   * `null` while none has been refused.
   *
   * Fed two ways, and it needs both. `createAuthRejectionObserver` watches for HTTP 401, which
   * covers every gate that answers one, including OME's signature check: that refuses inside its own
   * router rather than at a mounted gate, which is the very path `on_publish` arrives on, so
   * observing the response is what reaches it. The publish-key refusals call
   * `recordAuthRejection` themselves.
   *
   * **The self-reporting half is not redundancy, and this said the opposite until it was measured.**
   * Both engines answer a refused publish key with **200** carrying an engine-protocol body, because
   * that is what their protocols require: OME wants an admission verdict and SRS reads any non-zero
   * status as a failure to retry. The observer therefore cannot see them. On a live deployment on
   * 2026-08-03 a keyless publish was correctly refused and logged while this stayed `null`, so the
   * one credential separating a broadcaster from anyone who knows the stream name could be probed
   * with no signal at all. See OBS-15 and SEC-28.
   */
  msSinceAuthRejection: number | null;
  /**
   * Every live stream whose encoder has disconnected and has not come back, in no particular order.
   * Empty on a service whose broadcasters are all connected.
   *
   * ⛔ **A list rather than a count, because the answer an operator needs is WHICH.** On a four rung
   * ladder a whole-encoder disconnect puts all four rungs here within a second of each other, and one
   * rung here on its own is a transcoder that died while the broadcast carried on — which is a
   * different fault with a different remedy, and a count cannot tell them apart.
   *
   * ⛔ **It raises no health reason, deliberately.** A disconnect is an ordinary event with a designed
   * answer: the session is held for one reap window, and an encoder that comes back inside it resumes.
   * Turning that into `degraded` would flag every ten second OBS restart, and a disconnect that does
   * NOT come back already reaches `segment_stall` on the ordinary clock and then ends at the window.
   * What this is for is the moment in between, which was invisible: a session held open with nothing
   * feeding it looked, from every endpoint, exactly like one whose publisher was merely slow.
   */
  disconnectedStreams: string[];
  /**
   * Whether any segment has ever reached Swarm in this process's lifetime.
   *
   * A one-way latch, and the discriminator that makes a refusal judgeable at all: an anonymous
   * caller getting a 401 is ordinary noise on a service that is working, and the same 401 on a
   * service that has never once ingested media is indistinguishable from a credential this
   * deployment has wrong.
   */
  hasIngestedMedia: boolean;
  /**
   * Segments discarded on purpose by the CON-20 handover floor, for this process's lifetime.
   *
   * Carries no threshold and raises no reason, because a skip during a handover is the floor working.
   * It is here so that a floor matching zero segments and a floor holding correctly stop being
   * indistinguishable from outside, which is the whole of OBS-16.
   */
  segmentsSkipped: number;
  /**
   * Opening segments withheld because the broadcast had not produced video yet, for this process's
   * lifetime.
   *
   * Carries no threshold and raises no reason, for the same reason {@link segmentsSkipped} does not:
   * withholding is the guard working, and the compose healthcheck acts on the status this feeds. What
   * it is here for is the pair. Withheld climbing while `segmentsUploadedTotal` stays at zero is a
   * publisher that has sent no frames at all, and those two readings were indistinguishable from
   * outside before this existed. See task #41.
   */
  openingSegmentsWithheld: number;
  /**
   * Segments uploaded that no manifest will ever name, for this process's lifetime.
   *
   * The quietest way a broadcast loses a piece of itself. The bytes are in Swarm and any caller
   * handed the address could fetch them, but a viewer learns of a segment only from a manifest, and
   * the live window slid past these before one naming them was published. So the media is simply
   * missing from every playlist, with not even a gap entry marking the hole, since their sequences are
   * filled, and no failed upload to count. It happens when the window outruns its own publishing, which the manifest retry window
   * permits while the segment queue keeps running.
   *
   * ⛔ **Carries no threshold and raises no reason, and that is a decision rather than an
   * oversight.** The compose healthcheck acts on the status this feeds, so a broadcast that lost a
   * few segments could take a running stack down. It is here to be READ, exactly as
   * {@link segmentsSkipped} is. Giving it a threshold is a product call.
   */
  segmentsNeverNamed: number;
  /**
   * Recovery entries this process found on disk and could not parse, so moved aside rather than
   * resumed. Counted at boot and never cleared, because nothing that happens afterwards makes a
   * stranded recording recoverable.
   *
   * Each one is a broadcast that was live when this service last died and that it cannot finalize:
   * the recording it was building is never sealed and its catalog entry says `live` until someone
   * repairs the quarantined file by hand. See task #38.
   */
  quarantinedRecoveryEntries: number;
  /**
   * Live rungs whose measured segments are not the length `HLS_FRAGMENT` says they are, on a stage
   * where the two cannot legitimately differ.
   *
   * A count rather than a flag because one rung disagreeing and all four disagreeing are different
   * deployments: the first is one container of a per-rung split left behind, the second is the
   * engine. Latched for the life of each stream and cleared when it ends, since the next broadcast
   * is a new measurement. See `libs/fragmentAgreement.ts`.
   */
  fragmentMismatchStreams: number;
  /**
   * Live streams whose segments measure longer than `HLS_FRAGMENT` on a stage carrying one rendition,
   * where the publisher's keyframe interval rather than the configured value decides the segment.
   *
   * The two lengths rather than a count, because the count alone names no lever. An operator reading
   * this has to choose between bringing the publisher's keyframe interval to the configured value and
   * turning the ladder on, and both of those are decided by how far apart the two numbers are.
   *
   * ⛔ **The consequence is the same as {@link fragmentMismatchStreams} and the cause is not.**
   * Nothing here is mis-deployed: `HLS_FRAGMENT` is a floor without a ladder and the stage is working
   * as designed. The dates follow the media, so the recording keeps the right clock either way. What
   * both reasons name is a stage cutting a length the deployment never declared, and the declared
   * length is still what every `#EXT-X-GAP` entry is dated and sized at, so a lost segment leaves a
   * hole of the wrong size. A live single-rendition stream was measured on 2026-09-15 cutting 2.067
   * to 10.033 seconds against a configured 2, and nothing said so. Latched for the life of each
   * stream, since the next broadcast is a new publisher. See `libs/fragmentAgreement.ts`.
   */
  publisherGopStreams: PublisherGopStream[];
  /**
   * Publishers, meaning a Bee node and the postage batch a rung spends on it, that have answered a
   * paid write with a status the upload policy will not retry. Counted for this process's lifetime.
   *
   * A count of publishers rather than of refusals, because the same batch refuses a growing share of
   * segments over a minute or two as it fills and every one of those answers describes the one dead
   * batch. What an operator needs is how many rungs have lost their postage, and which.
   *
   * ⛔ **Never clears, and nothing in this process can clear it.** `BEE_PUBLISHERS` is read once at
   * start, so the batch a rung spends is fixed until a redeploy replaces the process. See
   * {@link StreamUploader.reportBatchRefusal} for why a segment landing afterwards is the ramp rather
   * than a recovery.
   */
  postageRefusedPublishers: number;
  /**
   * The startup gates that warned instead of refusing, as the last gate pass left them.
   *
   * Empty on a boot whose gates all cleared, and on every deployment running
   * `UPLOADER_START_GATES=refuse`, where a refusal is rethrown rather than collected.
   * Replaced by each gate pass rather than added to, because the gates are read again on every
   * attempt while the boot waits for its node, and only the last pass describes the service that is
   * now running. Nothing re-runs them once the boot has finished, so from there it is fixed for the
   * life of the process, like `postageRefusedPublishers`.
   */
  startGateWarnings: StartGateWarning[];
}

export interface HealthReport {
  status: HealthStatus;
  reasons: HealthReason[];
}

export const STREAM_LIFECYCLE_LIVE = 'live' as const;
export const STREAM_LIFECYCLE_DRAINING = 'draining' as const;
export const STREAM_LIFECYCLE_FINALIZED = 'finalized' as const;
export const STREAM_LIFECYCLE_FAILED = 'failed' as const;
/** Never registered, or settled long enough ago that its outcome has been swept. */
export const STREAM_LIFECYCLE_UNKNOWN = 'unknown' as const;

export type StreamLifecycle =
  | typeof STREAM_LIFECYCLE_LIVE
  | typeof STREAM_LIFECYCLE_DRAINING
  | typeof STREAM_LIFECYCLE_FINALIZED
  | typeof STREAM_LIFECYCLE_FAILED
  | typeof STREAM_LIFECYCLE_UNKNOWN;

/**
 * What became of a stream, for a caller that was answered `202` by `POST /stream/stop` and needs to
 * find out whether the VOD it asked for exists.
 */
/** The drain ran past its deadline. The finalize may still be in flight, so a VOD may yet appear. */
export const STOP_FAILURE_DRAIN_TIMEOUT = 'drain_timeout' as const;
/** The finalize rejected. Nothing further will happen for this stream without an operator. */
export const STOP_FAILURE_FINALIZE_FAILED = 'finalize_failed' as const;

/**
 * Why a stop did not finalize, as a closed set rather than free text.
 *
 * A union and not a `string` on purpose. This field is served to the caller by `GET /stream/status`,
 * and it used to carry `getErrorMessage()` of whatever the finalize rejected with, which is a Bee
 * URL, a host and port, a filesystem path or an internal timeout constant depending on the failure.
 * Typing it closed means no message built inside `src/libs/` can reach a response body by accident,
 * which a sanitizer on the way out would not guarantee. The detail still goes to the log. See S1.7.
 */
export type StopFailureReason = typeof STOP_FAILURE_DRAIN_TIMEOUT | typeof STOP_FAILURE_FINALIZE_FAILED;

export interface StreamStatusReport {
  streamId: string;
  state: StreamLifecycle;
  /** Why the finalize did not complete. Present only for `failed`. */
  reason?: StopFailureReason;
  /** When the stop settled, epoch milliseconds. Absent while the stream is live or draining. */
  settledAt?: number;
}
