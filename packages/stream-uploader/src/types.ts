// One definition, in the shared package, because the client reads the same catalog entries this
// writes and the two used to carry their own copies of these literals. Re-exported here rather than
// imported at every call site so the move stays invisible to the rest of the package. See ARCH-1.
export {
  MEDIA_TYPE_AUDIO,
  MEDIA_TYPE_VIDEO,
  type MediaType,
  STREAM_STATUS_LIVE,
  STREAM_STATUS_VOD,
  type StreamStatus,
} from '@swarm-hls-stream/shared';

import type { MediaType } from '@swarm-hls-stream/shared';

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
}

export interface SegmentEntry {
  index: number;
  duration: number;
  ref: string;
  discontinuity?: boolean;
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

export type HealthStatus = typeof HEALTH_OK | typeof HEALTH_DEGRADED;

export const HEALTH_REASON_STALE_MANIFEST = 'stale_manifest' as const;
export const HEALTH_REASON_SEGMENT_UPLOAD_FAILURE = 'segment_upload_failure' as const;
export const HEALTH_REASON_QUEUE_PRESSURE = 'queue_pressure' as const;
export const HEALTH_REASON_SEGMENT_STALL = 'segment_stall' as const;
export const HEALTH_REASON_SEGMENT_LOSS = 'segment_loss' as const;
export const HEALTH_REASON_UNLISTED_STREAM = 'unlisted_stream' as const;
export const HEALTH_REASON_STATE_NOT_PERSISTED = 'state_not_persisted' as const;
export const HEALTH_REASON_INGEST_REFUSED = 'ingest_refused' as const;

export type HealthReason =
  | typeof HEALTH_REASON_STALE_MANIFEST
  | typeof HEALTH_REASON_SEGMENT_UPLOAD_FAILURE
  | typeof HEALTH_REASON_QUEUE_PRESSURE
  | typeof HEALTH_REASON_SEGMENT_STALL
  | typeof HEALTH_REASON_SEGMENT_LOSS
  | typeof HEALTH_REASON_UNLISTED_STREAM
  | typeof HEALTH_REASON_STATE_NOT_PERSISTED
  | typeof HEALTH_REASON_INGEST_REFUSED;

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
   * Every gate is covered by observing the refusal rather than each gate reporting itself, because
   * OME signs the request body and so refuses inside its router rather than at a mounted gate, which
   * is the very path `on_publish` arrives on. See OBS-15.
   */
  msSinceAuthRejection: number | null;
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
