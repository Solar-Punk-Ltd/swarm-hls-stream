import { Logger } from '../libs/Logger.js';
import { loadEngineEnv } from '../utils/env.js';

import { engineRegistry } from './registry.js';
import { EngineFactoryDeps, EnginePlugin } from './types.js';

/** The engine name that means "generic API only" on purpose, as against one that is misspelled. */
export const ENGINE_NONE = 'none';

/** Injected so a test can choose an engine set without the real ones reading the real environment. */
export interface EngineLoaderDeps {
  registry: Record<string, (deps: EngineFactoryDeps) => EnginePlugin>;
  loadEnv: (engine: string) => void;
  logger: Pick<Logger, 'warn'>;
  /**
   * Handed to whichever engine is built. Not read here: this loader decides *which* engine runs and
   * nothing about what it needs, so the admin client passes straight through. See
   * {@link EngineFactoryDeps}.
   */
  adminApi: EngineFactoryDeps['adminApi'];
  /** Passed straight through with the admin client, for the same reason. */
  signerOwner: EngineFactoryDeps['signerOwner'];
}

/**
 * The engines this service will run, from the name it was configured with.
 *
 * ## Why an unknown name warns instead of throwing
 *
 * A misspelled engine leaves the service running with the generic API and nothing to ingest from, so
 * the one line saying why is the only difference between a puzzling silence and an obvious typo.
 * Refusing to start would turn a typo into an outage, which is the same reasoning `loggerOptionsFromEnv`
 * applies to an unusable `LOG_LEVEL`.
 *
 * `none` and an empty name are configurations rather than mistakes, so they are silent.
 */
export function loadEngines(engine: string, deps: Partial<EngineLoaderDeps> = {}): EnginePlugin[] {
  const {
    registry = engineRegistry,
    loadEnv = loadEngineEnv,
    logger = Logger.getInstance(),
    adminApi,
    signerOwner,
  } = deps;

  const createEngine = registry[engine];
  if (createEngine) {
    // Before constructing, because the engine reads its own settings out of the environment as it is
    // built, and a plugin built against an unloaded environment gets the defaults in silence.
    loadEnv(engine);
    return [createEngine({ adminApi, signerOwner })];
  }

  if (engine && engine !== ENGINE_NONE) {
    logger.warn(`[Engine] Unknown engine: ${engine}, running with generic API only`);
  }

  return [];
}
