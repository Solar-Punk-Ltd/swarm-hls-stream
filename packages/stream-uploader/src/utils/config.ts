import { optional, optionalInt, required } from './env.js';

export const config = {
  beeUrl: required('BEE_URL'),
  stamp: required('STAMP'),
  streamKey: required('STREAM_KEY'),
  streamListTopic: required('STREAM_LIST_TOPIC'),
  apiAuthToken: required('API_AUTH_TOKEN'),
  manifestAccessUrl: optional('MANIFEST_ACCESS_URL', ''),
  // Zero is a real port here: it asks the OS for an ephemeral one. Every other floor is 1, because
  // zero would disable the thing the variable configures rather than tune it.
  apiPort: optionalInt('API_PORT', 3000, { min: 0, max: 65535 }),
  stateDir: optional('STATE_DIR', './state'),
  maxQueueSize: optionalInt('MAX_QUEUE_SIZE', 100, { min: 1 }),
  recoveryTimeout: optionalInt('RECOVERY_TIMEOUT', 60000, { min: 1 }),
  segmentStallMs: optionalInt('SEGMENT_STALL_MS', 30000, { min: 1 }),
  /**
   * How long a live stream may receive nothing before it is finalized as a VOD, on the assumption
   * that its engine died without sending `on_unpublish`. See #86.
   *
   * **Deliberately its own value rather than either neighbour above, and lowering it is dangerous.**
   * `SEGMENT_STALL_MS` is a health *reporting* threshold at half this, and ending a broadcast on it
   * would kill streams that recover: a twenty second write outage has been measured freezing a
   * viewer and then resuming correctly. `RECOVERY_TIMEOUT` is the right size but the wrong knob,
   * because it is tuned for how fast a *restarted process* gives up on streams it restored, and an
   * operator shortening it for crisper restarts would silently start reaping live broadcasts over
   * ordinary engine hiccups.
   *
   * The floor to keep it above is the longest silence a healthy broadcast can produce, which is the
   * engine's own retry window. Both shipped engines use 60s.
   */
  orphanReapMs: optionalInt('ORPHAN_REAP_MS', 60000, { min: 1 }),
  // Deliberately far above anything reachable: what an engine can re-deliver is bounded by its
  // playlist window, which is single digits of segments. The number exists to bound memory, not to
  // tune behaviour, so it is set where changing it can never change what is accepted. See CON-8.
  segmentDedupWindow: optionalInt('SEGMENT_DEDUP_WINDOW', 10000, { min: 1 }),
  engine: optional('ENGINE', ''),
};
