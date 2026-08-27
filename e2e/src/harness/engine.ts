/**
 * Per-engine behavior — the suite runs against exactly one media engine, selected by E2E_ENGINE.
 * SRS (default) and OME differ in three externally-observable ways the tests must adapt to:
 *
 *  - the SRT streamid the publisher dials,
 *  - the container fronting ingest (restarted mid-stream by the engine-restart scenario),
 *  - the lifecycle log markers the uploader emits (published/unpublished vs opening/closing).
 *
 * Everything downstream of the uploader — catalog, VOD finalize, /health shape — is engine-agnostic,
 * so it stays in the shared scenarios untouched.
 */

import { derivePublishKey, PUBLISH_KEY_PARAM } from '@swarm-hls-stream/shared/publishKey';

import { containerName, type E2EConfig, type EngineName } from '../config.js';

/**
 * `?key=<derived>` when the deployment authenticates publishers, empty when it does not. See SEC-28.
 *
 * Keyed on `streamPath` because that is the stream id verbatim: the uploader derives against
 * `buildStreamId(app, stream)`, which is the same `<app>/<name>` string this suite dials. A scenario
 * publishing to a second stream therefore gets that stream's own key, not the default one's.
 *
 * Both spellings below were measured against the pinned images on 2026-08-03 rather than read from
 * documentation, and they are not the same shape.
 */
function publishKeyQuery(cfg: E2EConfig, streamPath: string): string {
  if (!cfg.publishKeySecret) {
    return '';
  }
  return `?${PUBLISH_KEY_PARAM}=${derivePublishKey(cfg.publishKeySecret, streamPath)}`;
}

export interface EngineProfile {
  name: EngineName;
  /** The container fronting SRT ingest — restarted mid-stream by the engine-restart scenario. */
  mediaContainer(cfg: E2EConfig): string;
  /** SRT ingest URL the publisher (ffmpeg/OBS stand-in) dials for `streamPath`. */
  srtIngestUrl(cfg: E2EConfig, streamPath: string): string;
  /** Uploader log line emitted when a broadcaster session begins. */
  publishedMarker: RegExp;
  /** Uploader log line emitted when a broadcaster session ends (clean stop or drop). */
  unpublishedMarker: RegExp;
  /** How long to let the engine accept SRT again after a restart before the broadcaster reconnects. */
  reconnectGraceMs: number;
}

const SRS: EngineProfile = {
  name: 'srs',
  mediaContainer: (cfg) => containerName(cfg, 'srs'),
  // SRS's documented publish form; ffmpeg passes the literal '#!::r=...' streamid through to libsrt.
  // The key rides inside the `r=` value, which is where SRS looks for a query: measured on 2026-08-03,
  // `#!::r=live/demo?key=K,m=publish` arrives at the webhook as `param: "key=K"`, with **no** leading
  // `?`, unlike the same key over RTMP. Both `on_publish` and `on_unpublish` carry it.
  srtIngestUrl: (cfg, streamPath) =>
    `srt://${cfg.publicHost}:${cfg.ports.srt}?streamid=#!::r=${streamPath}${publishKeyQuery(
      cfg,
      streamPath,
    )},m=publish`,
  // Three shapes each, because a ladder deployment logs the source and its rungs distinctly and a
  // single-rendition one keeps the original wording. Any of them is the engine reporting the event.
  publishedMarker: /\[SRS\] (Stream published|Ladder source authenticated|Rung published)/,
  unpublishedMarker: /\[SRS\] (Stream unpublished|Ladder source unpublished|Rung unpublished)/,
  reconnectGraceMs: 10_000,
};

const OME: EngineProfile = {
  name: 'ome',
  mediaContainer: (cfg) => cfg.omeContainer,
  srtIngestUrl: (cfg, streamPath) => {
    // OME derives app/stream from the SRT streamid. The uploader's admission parser (parseAppStream)
    // reads app/stream from a full srt:// URL in the streamid, so we embed one, which holds whether
    // OME forwards the resolved path or the raw streamid to the admission webhook. Confirmed live in
    // the OME verification run.
    const endpoint = `srt://${cfg.publicHost}:${cfg.omeSrtPort}`;
    const inner = `${endpoint}/${streamPath}${publishKeyQuery(cfg, streamPath)}`;
    // Percent-encoded only when a key is present, which is deliberately not a uniform rule.
    //
    // The keyless form is left byte-for-byte as it was, because it is the one confirmed live in the
    // OME verification run and nothing here is worth regressing it for. The keyed form needs the
    // encoding: it puts a second `?` inside the outer URL's query value, and the encoded spelling is
    // the one measured working against real OME on 2026-08-03, which is also what
    // `deploy/scripts/publish-key.sh` prints for an operator to paste.
    return `${endpoint}?streamid=${cfg.publishKeySecret ? encodeURIComponent(inner) : inner}`;
  },
  publishedMarker: /\[OME\] Stream opening/,
  unpublishedMarker: /\[OME\] Stream closing/,
  // OME's container cold-starts slower than SRS, so give the SRT provider longer to come back.
  reconnectGraceMs: 20_000,
};

const PROFILES: Record<EngineName, EngineProfile> = { srs: SRS, ome: OME };

export function getEngine(cfg: E2EConfig): EngineProfile {
  return PROFILES[cfg.engine];
}

/** SRT ingest URL for the configured engine and stream path (defaults to the profile's streamPath). */
export function srtIngestUrl(cfg: E2EConfig, streamPath: string = cfg.streamPath): string {
  return getEngine(cfg).srtIngestUrl(cfg, streamPath);
}
