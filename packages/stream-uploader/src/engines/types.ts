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
}

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}
