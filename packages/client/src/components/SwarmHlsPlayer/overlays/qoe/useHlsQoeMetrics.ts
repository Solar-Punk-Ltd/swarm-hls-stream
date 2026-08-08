import Hls, { ErrorTypes, Events } from 'hls.js';

export interface QoeMetrics {
  // Startup
  startupTimeMs: number | null;
  firstFrameTimeMs: number | null;
  startupFailed: boolean;

  // Rebuffering
  rebufferingCount: number;
  rebufferingDurationMs: number;
  rebufferingRatio: number;
  hadRebuffering: boolean;

  // Quality
  bitrateKbps: number | null;
  resolution: string | null;
  qualitySwitchCount: number;
  qualitySwitchPerMin: number;
  droppedFrames: number;

  // ABR
  /** Whether hls.js is choosing the level, or it is pinned. */
  abrEnabled: boolean;
  /** The rung ABR has selected, by height — not necessarily what is on screen yet. */
  selectedHeight: number | null;
  /** hls.js's own throughput estimate. Over Swarm this is the number expected to oscillate. */
  bandwidthEstimateKbps: number | null;
  /**
   * How long a level switch took: from hls.js deciding, to the first fragment of the new rung
   * being buffered. This is the measurement the ABR-over-Swarm POC exists to produce — it is
   * where a stale rung's feed walk would show up.
   */
  lastSwitchLatencyMs: number | null;
  avgSwitchLatencyMs: number | null;
  maxSwitchLatencyMs: number | null;
  switchLatencySamples: number;

  // Reliability
  fatalErrorCount: number;
  sessionCompleted: boolean;
  reconnectAttempts: number;
  reconnectSuccesses: number;
  reconnectSuccessRate: number;
  lastRecoveryTimeMs: number | null;

  // Live
  liveLatencySec: number | null;

  // Session
  playbackTimeMs: number;
}

export const initialMetrics = (): QoeMetrics => ({
  startupTimeMs: null,
  firstFrameTimeMs: null,
  startupFailed: false,
  rebufferingCount: 0,
  rebufferingDurationMs: 0,
  rebufferingRatio: 0,
  hadRebuffering: false,
  bitrateKbps: null,
  resolution: null,
  qualitySwitchCount: 0,
  qualitySwitchPerMin: 0,
  droppedFrames: 0,
  abrEnabled: false,
  selectedHeight: null,
  bandwidthEstimateKbps: null,
  lastSwitchLatencyMs: null,
  avgSwitchLatencyMs: null,
  maxSwitchLatencyMs: null,
  switchLatencySamples: 0,
  fatalErrorCount: 0,
  sessionCompleted: false,
  reconnectAttempts: 0,
  reconnectSuccesses: 0,
  reconnectSuccessRate: 0,
  lastRecoveryTimeMs: null,
  liveLatencySec: null,
  playbackTimeMs: 0,
});

export const attachQoeTracking = (
  video: HTMLMediaElement,
  hls: Hls | null,
  onUpdate: (metrics: QoeMetrics) => void,
): (() => void) => {
  const sessionStart = performance.now();
  const metrics: QoeMetrics = initialMetrics();

  let playbackStartTime: number | null = null;
  let accPlaybackMs = 0;
  let rebufferStart: number | null = null;
  let recoveryStart: number | null = null;
  let firstPlaying = false;

  const flush = () => onUpdate({ ...metrics });

  const onLoadedData = () => {
    if (metrics.firstFrameTimeMs === null) {
      metrics.firstFrameTimeMs = performance.now() - sessionStart;
      flush();
    }
  };

  const onPlaying = () => {
    if (!firstPlaying) {
      firstPlaying = true;
      metrics.startupTimeMs = performance.now() - sessionStart;
    }
    if (rebufferStart !== null) {
      metrics.rebufferingDurationMs += performance.now() - rebufferStart;
      rebufferStart = null;
    }
    if (recoveryStart !== null) {
      metrics.lastRecoveryTimeMs = performance.now() - recoveryStart;
      metrics.reconnectSuccesses += 1;
      recoveryStart = null;
    }
    playbackStartTime = performance.now();
    flush();
  };

  const onWaiting = () => {
    if (firstPlaying && rebufferStart === null) {
      rebufferStart = performance.now();
      metrics.rebufferingCount += 1;
      metrics.hadRebuffering = true;
    }
    if (playbackStartTime !== null) {
      accPlaybackMs += performance.now() - playbackStartTime;
      playbackStartTime = null;
    }
    flush();
  };

  const onPause = () => {
    if (playbackStartTime !== null) {
      accPlaybackMs += performance.now() - playbackStartTime;
      playbackStartTime = null;
    }
  };

  const onEnded = () => {
    metrics.sessionCompleted = true;
    flush();
  };

  video.addEventListener('loadeddata', onLoadedData);
  video.addEventListener('playing', onPlaying);
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('pause', onPause);
  video.addEventListener('ended', onEnded);

  const onLevelSwitched = () => {
    metrics.qualitySwitchCount += 1;
    flush();
  };

  // A switch is measured from the moment hls.js commits to a rung until a fragment of that rung is
  // buffered — the interval in which a rung whose feed had gone stale would have to catch up.
  let switchStartedAt: number | null = null;
  let switchTargetLevel: number | null = null;
  let switchLatencyTotalMs = 0;
  let hasBufferedOnce = false;

  const onLevelSwitching = (_event: unknown, data: { level: number }) => {
    // The first selection is startup, not a switch; startupTimeMs already covers it.
    if (!hasBufferedOnce) {
      return;
    }
    switchStartedAt = performance.now();
    switchTargetLevel = data.level;
  };

  const onFragBuffered = (_event: unknown, data: { frag: { level: number } }) => {
    hasBufferedOnce = true;

    if (switchStartedAt === null || data.frag.level !== switchTargetLevel) {
      return;
    }

    const elapsed = performance.now() - switchStartedAt;
    switchStartedAt = null;
    switchTargetLevel = null;

    switchLatencyTotalMs += elapsed;
    metrics.switchLatencySamples += 1;
    metrics.lastSwitchLatencyMs = elapsed;
    metrics.avgSwitchLatencyMs = switchLatencyTotalMs / metrics.switchLatencySamples;
    metrics.maxSwitchLatencyMs = Math.max(metrics.maxSwitchLatencyMs ?? 0, elapsed);
    flush();
  };

  const fragBitrateSamples: number[] = [];
  const onFragLoaded = (_event: unknown, data: { frag: { duration: number; stats?: { loaded?: number } } }) => {
    const { frag } = data;
    const loaded: number = frag.stats?.loaded ?? 0;
    if (frag.duration > 0 && loaded > 0) {
      const bps = (loaded * 8) / frag.duration;
      fragBitrateSamples.push(bps);
      if (fragBitrateSamples.length > 3) {
        fragBitrateSamples.shift();
      }
      const avg = fragBitrateSamples.reduce((a, b) => a + b, 0) / fragBitrateSamples.length;
      metrics.bitrateKbps = Math.round(avg / 1000);
      flush();
    }
  };

  const onHlsError = (_event: unknown, data: { fatal: boolean; type: string }) => {
    if (!data.fatal) return;
    metrics.fatalErrorCount += 1;
    if (!firstPlaying) {
      metrics.startupFailed = true;
    }
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      metrics.reconnectAttempts += 1;
      recoveryStart = performance.now();
    }
    flush();
  };

  if (hls) {
    hls.on(Events.LEVEL_SWITCHED, onLevelSwitched);
    hls.on(Events.LEVEL_SWITCHING, onLevelSwitching);
    hls.on(Events.FRAG_BUFFERED, onFragBuffered);
    hls.on(Events.FRAG_LOADED, onFragLoaded);
    hls.on(Events.ERROR, onHlsError);
  }

  const interval = setInterval(() => {
    let total = accPlaybackMs;
    if (playbackStartTime !== null) {
      total += performance.now() - playbackStartTime;
    }
    metrics.playbackTimeMs = total;

    if (video instanceof HTMLVideoElement && video.videoWidth && video.videoHeight) {
      metrics.resolution = `${video.videoWidth}×${video.videoHeight}`;
    }

    metrics.rebufferingRatio = total > 0 ? metrics.rebufferingDurationMs / total : 0;
    const elapsedMin = total / 60_000;
    metrics.qualitySwitchPerMin = elapsedMin > 0 ? metrics.qualitySwitchCount / elapsedMin : 0;

    if (video instanceof HTMLVideoElement) {
      const vq = video.getVideoPlaybackQuality?.();
      if (vq) {
        metrics.droppedFrames = vq.droppedVideoFrames;
      }
    }

    metrics.reconnectSuccessRate =
      metrics.reconnectAttempts > 0 ? metrics.reconnectSuccesses / metrics.reconnectAttempts : 0;

    if (hls) {
      const latency = hls.latency;
      metrics.liveLatencySec = typeof latency === 'number' && Number.isFinite(latency) && latency > 0 ? latency : null;

      metrics.abrEnabled = hls.autoLevelEnabled;
      metrics.selectedHeight = hls.levels[hls.currentLevel]?.height ?? null;

      const estimate = hls.bandwidthEstimate;
      metrics.bandwidthEstimateKbps = Number.isFinite(estimate) && estimate > 0 ? Math.round(estimate / 1000) : null;
    }

    flush();
  }, 500);

  return () => {
    video.removeEventListener('loadeddata', onLoadedData);
    video.removeEventListener('playing', onPlaying);
    video.removeEventListener('waiting', onWaiting);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('ended', onEnded);
    if (hls) {
      hls.off(Events.LEVEL_SWITCHED, onLevelSwitched);
      hls.off(Events.LEVEL_SWITCHING, onLevelSwitching);
      hls.off(Events.FRAG_BUFFERED, onFragBuffered);
      hls.off(Events.FRAG_LOADED, onFragLoaded);
      hls.off(Events.ERROR, onHlsError);
    }
    clearInterval(interval);
  };
};
