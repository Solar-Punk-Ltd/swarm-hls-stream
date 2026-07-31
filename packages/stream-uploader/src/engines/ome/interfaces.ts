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
}

export interface AppStream {
  app: string;
  stream: string;
}

export interface PlaylistEntry {
  seq: number;
  duration: number;
  uri: string;
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
