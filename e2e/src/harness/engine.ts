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

import { containerName, type E2EConfig, type EngineName } from '../config.js';

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
  srtIngestUrl: (cfg, streamPath) => `srt://${cfg.publicHost}:${cfg.ports.srt}?streamid=#!::r=${streamPath},m=publish`,
  publishedMarker: /\[SRS\] Stream published/,
  unpublishedMarker: /\[SRS\] Stream unpublished/,
  reconnectGraceMs: 10_000,
};

const OME: EngineProfile = {
  name: 'ome',
  mediaContainer: (cfg) => cfg.omeContainer,
  srtIngestUrl: (cfg, streamPath) => {
    // OME derives app/stream from the SRT streamid. The uploader's admission parser (parseAppStream)
    // reads app/stream from a full srt:// URL in the streamid, so we embed one — robust whether OME
    // forwards the resolved path or the raw streamid to the admission webhook. Confirmed live in the
    // OME verification run; if OME needs a percent-encoded streamid, that is a one-line change here.
    const endpoint = `srt://${cfg.publicHost}:${cfg.omeSrtPort}`;
    return `${endpoint}?streamid=${endpoint}/${streamPath}`;
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
