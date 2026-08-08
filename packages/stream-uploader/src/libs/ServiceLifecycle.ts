import { type ApiServerHandle } from '../api/server.js';

import { Logger } from './Logger.js';

/** The orchestrator, as shutdown needs it. Narrow so a test does not have to build a real one. */
export interface StreamCleanup {
  cleanup(): Promise<void>;
}

/**
 * How the process ends. Injected because the alternative is a module that calls `process.exit` and can
 * therefore only be run once, by the process it kills.
 */
export type ExitProcess = (code: number) => void;

/**
 * Everything the service is holding, and the order it has to let go of them in.
 *
 * ## Why this is not still in `index.ts`
 *
 * It was, and nothing had ever executed it: `index.ts` calls `start()` at module scope, so importing
 * it launches the service. Under mutation the file scored **0.00%**, 62 mutants and 62 survivors, of
 * which 18 were here. This is the part of the entry point that decides whether a broadcast's last
 * segments are flushed when the uploader is stopped, which happens on every deploy.
 *
 * The three behaviours that had nothing asserting them are the re-entry guard, the order, and the exit
 * code. A second signal must not start a second cleanup over the top of the first. The orchestrator
 * must stop before the api server, because the reverse accepts a segment there is no longer anything
 * to write it with. And a shutdown that threw must exit non-zero, or an orchestrator that failed to
 * flush is reported to the supervisor as a clean stop.
 */
export class ServiceLifecycle {
  private isShuttingDown = false;
  private orchestrator: StreamCleanup | undefined;
  private apiServer: ApiServerHandle | undefined;

  constructor(private readonly exit: ExitProcess, private readonly logger = Logger.getInstance()) {}

  /** Handed over as `start` builds them, rather than at construction, since the signal handlers are
   *  registered before either exists and a signal may arrive in between. */
  public trackOrchestrator(orchestrator: StreamCleanup): void {
    this.orchestrator = orchestrator;
  }

  public trackApiServer(apiServer: ApiServerHandle): void {
    this.apiServer = apiServer;
  }

  public async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress...');
      return;
    }

    this.isShuttingDown = true;
    this.logger.info(`Received ${signal}. Shutting down gracefully...`);

    try {
      if (this.orchestrator) {
        await this.orchestrator.cleanup();
        this.logger.info('All streams stopped');
      }

      if (this.apiServer) {
        await this.apiServer.close();
        this.apiServer = undefined;
      }

      this.logger.info('Graceful shutdown completed');
      this.exit(0);
    } catch (error) {
      this.logger.error('Error during graceful shutdown:', error);
      this.exit(1);
    }
  }
}
