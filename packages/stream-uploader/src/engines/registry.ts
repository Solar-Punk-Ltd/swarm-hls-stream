import { createOmeEngineFromEnv } from './ome.js';
import { createSrsEngineFromEnv } from './srs.js';
import { EnginePlugin } from './types.js';

export const engineRegistry: Record<string, () => EnginePlugin> = {
  srs: createSrsEngineFromEnv,
  ome: createOmeEngineFromEnv,
};
