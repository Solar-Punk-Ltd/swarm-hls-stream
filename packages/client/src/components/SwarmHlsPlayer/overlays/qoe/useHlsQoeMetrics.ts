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
      hls.off(Events.FRAG_LOADED, onFragLoaded);
      hls.off(Events.ERROR, onHlsError);
    }
    clearInterval(interval);
  };
};
