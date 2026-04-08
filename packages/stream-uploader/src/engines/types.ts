import { Router } from 'express';

import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';

export interface EnginePlugin {
  name: string;
  prefix: string;
  createRouter(streamOrchestrator: StreamOrchestrator): Router;
}
