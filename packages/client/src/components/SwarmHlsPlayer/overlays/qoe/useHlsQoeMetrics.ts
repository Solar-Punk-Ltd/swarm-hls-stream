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
