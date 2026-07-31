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
   * Called with the newest segment start observed so far, or null while none has been, every time a
   * playlist is parsed. The engine keeps this per stream rather than reading it off the puller at
   * handover, because a `closing` between two announces destroys the puller and would take the only
   * copy of the floor with it.
   */
  onSegmentTimeObserved?: (newest: number | null) => void;
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
}

export interface OmeEngineOptions {
  admissionSecret?: string;
  failOpen?: boolean;
  /** Passed straight to every puller this engine starts. See `PullerOptions.fetchTimeoutMs`. */
  fetchTimeoutMs?: number;
  /** Passed straight to every puller this engine starts. See `PullerOptions.fetcher`. */
  fetcher?: Fetcher;
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
  time?: string;
  new_url?: string;
  status?: 'opening' | 'closing';
}

export interface OmeAdmissionPayload {
  client?: { address?: string; port?: number };
  request: OmeAdmissionRequest;
}

export interface OmeAdmissionReply {
  allowed: boolean;
  new_url?: string | null;
  lifetime?: number;
  reason?: string;
}
