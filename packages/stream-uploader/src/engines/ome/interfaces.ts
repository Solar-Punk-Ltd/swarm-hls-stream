/**
 * The subset of `fetch` the puller uses, injected so its network paths are testable. Typed as the
 * global so a caller can pass `fetch` itself and a test can pass anything shaped like it.
 */
export type Fetcher = typeof globalThis.fetch;

export interface PullerOptions {
  /** Called once when the puller gives up, so the engine can deregister the stream. */
  onHalt?: () => void;
  fetcher?: Fetcher;
  /**
   * Abort window applied to every HTTP call the puller makes. Node's fetch has no default timeout, so
   * without this a black-holed connection stalls the poll loop for as long as the socket stays open.
   */
  fetchTimeoutMs?: number;
  /**
   * How long a playlist may stay missing before the puller gives up and calls `onHalt`. Injectable
   * only so the halt path can be driven at all: at its default the sequence takes a minute of wall
   * clock, which is why nothing covered it.
   */
  haltAfterNotFoundMs?: number;
  /**
   * Segments starting at or before this epoch-millisecond instant belong to the session this puller
   * replaced, and are skipped rather than delivered. Set only for a replacement puller, from the
   * newest `#EXT-X-PROGRAM-DATE-TIME` observed for this stream before it was built. Both sides of the
   * comparison are parsed from the origin's own playlists, so a fixed offset between its clock and
   * this host's cancels. A playlist that omits the timezone is the exception, since RFC 8216 section
   * 6.3.3 has a client read that as local time. See CON-20.
   */
  staleBefore?: number;
  /**
   * How long every advertised segment may sit under `staleBefore`, with nothing delivered, before the
   * floor is abandoned as wrong. Injectable only so the abandon path can be driven in a test.
   */
  abandonFloorAfterMs?: number;
  /**
   * How long an unusable origin is retried at the ordinary poll interval before the puller slows to
   * one poll per this long. Injectable only so the slow path can be driven in a test.
   */
  slowPollAfterMs?: number;
  /**
   * Called with the newest segment start observed so far, or null while none has been, every time a
   * playlist is parsed. The engine keeps this per stream rather than reading it off the puller at
   * handover, because a `closing` between two announces destroys the puller and would take the only
   * copy of the floor with it.
   */
  onSegmentTimeObserved?: (newest: number | null) => void;
  /**
   * Arms the next poll. Injectable only so a test can read the delay the puller polls at rather than
   * timing the polls it produces, since counting polls inside a wall-clock window reports the load on
   * the machine instead. See TEST-34.
   *
   * The seam is the timer itself rather than a callback reporting the delay beside it, because those
   * two values can disagree and a test reading the report cannot tell. Flooring the armed delay while
   * still reporting the requested one left the whole suite green with the puller really polling once
   * every two seconds, which is a cadence that finalizes a recovering broadcast underneath its own
   * puller.
   */
  setTimer?: (onFire: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

export interface AppStream {
  app: string;
  stream: string;
}

export interface PlaylistEntry {
  seq: number;
  duration: number;
  uri: string;
  /**
   * Wall-clock start of this segment in epoch milliseconds, from `#EXT-X-PROGRAM-DATE-TIME`, or
   * undefined when the playlist carries no date-time the entry can be anchored to. It is the only
   * field that differs between two sessions of the same stream: OME restarts the media sequence at
   * zero and reuses its segment file names, so neither of those can say which broadcast a segment
   * belongs to.
   */
  programDateTime?: number;
  /**
   * Whether the origin declared an `#EXT-X-DISCONTINUITY` immediately before this segment, meaning the
   * media from here on is not a continuation of what came before it. Undefined for the ordinary case,
   * so a playlist without the tag parses to the shape it did before this field existed.
   */
  discontinuity?: boolean;
}

export interface OmeEngineOptions {
  admissionSecret?: string;
  /**
   * Master secret every stream's publish key is derived from. See SEC-28.
   *
   * Empty **disables** publisher authentication, unlike `admissionSecret`, whose empty value rejects
   * every admission. The two guard different things: that one authenticates OME itself, which an
   * operator configures on both ends at once, and this one authenticates the broadcaster publishing
   * into it, who has to be issued a key first. Defaulting it on would take every existing broadcaster
   * off the air on upgrade.
   */
  publishKeySecret?: string;
  failOpen?: boolean;
  /** Passed straight to every puller this engine starts. See `PullerOptions.fetchTimeoutMs`. */
  fetchTimeoutMs?: number;
  /** Passed straight to every puller this engine starts. See `PullerOptions.fetcher`. */
  fetcher?: Fetcher;
  /**
   * How long the engine remembers that a stream's session closed, so a repeat of that closing is not
   * acted on a second time. Injectable only so the expiry can be driven at all: at its default the
   * record outlives any test worth writing. See CON-22.
   */
  closedSessionTtlMs?: number;
}

/**
 * Seams the environment cannot supply, for tests that need to observe what the engine hands its
 * pullers. Deliberately holds no configuration: every operator-facing value still comes from the
 * environment, so a test cannot prove a plumbing path a deployment does not have.
 */
export interface OmeEngineSeams {
  fetcher?: Fetcher;
}

export interface OmeAdmissionRequest {
  direction: 'incoming' | 'outgoing';
  protocol: string;
  url: string;
  /**
   * When OME issued this admission, ISO 8601 with an offset. Declared optional by the protocol and
   * populated on every admission in the live SRT capture on 2026-08-01. Monotone across admissions,
   * which is what makes it a session discriminator the socket cannot be: a session's own closing is
   * issued after its opening, so a closing issued before the live session was admitted was sent for
   * some earlier one, however the two sockets compare. See CON-23.
   */
  time?: string;
  new_url?: string;
  status?: 'opening' | 'closing';
}

export interface OmeAdmissionPayload {
  /**
   * The publisher's socket. Optional because the protocol allows it to be absent, but every field
   * here was populated on every admission in a live SRT capture on 2026-08-01, including `real_ip`,
   * which this interface did not previously declare at all.
   *
   * `port` is the only session discriminator an admission carries: it matches its own session's
   * opening and closing and differs between two sessions of the same stream, where the stream id is
   * identical for both. See CON-21.
   */
  client?: { address?: string; port?: number; real_ip?: string };
  request: OmeAdmissionRequest;
}

export interface OmeAdmissionReply {
  allowed: boolean;
  new_url?: string | null;
  lifetime?: number;
  reason?: string;
}
