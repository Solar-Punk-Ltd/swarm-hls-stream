import { Request, RequestHandler, Router } from 'express';

import { StreamOrchestrator } from '../libs/StreamOrchestrator.js';

export interface EnginePlugin {
  name: string;
  prefix: string;
  /**
   * Credential gate for this engine's prefix, mounted ahead of the body parsers so an anonymous
   * caller is refused before the process allocates anything for its body. Optional because it can
   * only be honoured by an engine whose credential is readable from the request line: OME signs the
   * body, so its check cannot run until the body has been parsed and it keeps its gate in the router.
   *
   * An engine that returns a gate here should still gate its own router, so mounting the router
   * without this one is safe.
   */
  createAuthMiddleware?(): RequestHandler;
  createRouter(streamOrchestrator: StreamOrchestrator): Router;
  /**
   * Resume ingest for a stream restored by crash-recovery. Pull-based engines (OME) must restart
   * their fetch loop here so the recovered stream keeps producing segments and its recovery timer is
   * cancelled; push-based engines (SRS) re-receive segments on their own and omit this.
   */
  resumeRecoveredStream?(streamOrchestrator: StreamOrchestrator, streamId: string): void;
  /**
   * Stop every ingest loop this engine owns. Pull-based engines (OME) hold a polling timer per live
   * stream that nothing outside the engine can reach, so without this there is no way to tell an
   * engine to stop fetching. Push-based engines (SRS) receive segments and own no loop, so they omit
   * it.
   *
   * ⚠️ Not on the shutdown path today, and worth knowing why before wiring it there.
   * `ServiceLifecycle.shutdown` stops the streams through the orchestrator and then calls
   * `process.exit(0)`, which takes the pull loops with it, so the service does not hang. What that
   * exit hides is a window: between `cleanup()` and the exit, a poll timer can still fire and fetch
   * from an origin whose stream has already been finalized.
   */
  stopIngest?(): void;
}

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}
