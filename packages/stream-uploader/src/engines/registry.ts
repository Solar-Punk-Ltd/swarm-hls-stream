import { createOmeEngineFromEnv } from './ome.js';
import { createSrsEngineFromEnv } from './srs.js';
import { EngineFactoryDeps, EnginePlugin } from './types.js';

export const engineRegistry: Record<string, (deps: EngineFactoryDeps) => EnginePlugin> = {
  srs: createSrsEngineFromEnv,
  ome: createOmeEngineFromEnv,
};
