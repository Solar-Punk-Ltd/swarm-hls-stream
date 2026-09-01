import { Request, Router } from 'express';

import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';

export interface EnginePlugin {
  name: string;
  prefix: string;
  createRouter(streamOrchestrator: StreamOrchestrator): Router;
  /**
   * Resume ingest for a stream restored by crash-recovery. Pull-based engines (OME) must restart
   * their fetch loop here so the recovered stream keeps producing segments and its recovery timer is
   * cancelled; push-based engines (SRS) re-receive segments on their own and omit this.
   */
  resumeRecoveredStream?(streamOrchestrator: StreamOrchestrator, streamId: string): void;
}

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}
