import { type CrashLine, uncaughtExceptionLines, unhandledRejectionLines } from './crashReport.js';
import { Logger } from './Logger.js';

/** The lifecycle, as signal handling needs it. Narrow so a test does not have to build a real one. */
export interface ShutdownTarget {
  shutdown(signal: string): Promise<void>;
}

/** What a crash line is written to. Matches `Logger`, narrowed to the one method used here. */
export interface CrashLogger {
  error(message: string, value?: unknown): void;
}

/**
 * The part of `process` this module attaches to. Injected because the alternative is a module that
 * can only be exercised by the process it installs handlers on.
 */
export interface ProcessEvents {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/**
 * How a supervisor asks for a graceful stop.
 *
 * `SIGTERM` is what `docker stop` and Kubernetes send, and handling it is what decides whether a
 * broadcast's last segments are flushed on every deploy. Left unhandled, Node's default is to
 * terminate at once, so the drain never runs and the supervisor sees a clean exit either way.
 */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Routes each shutdown signal into the lifecycle, passing on which signal arrived so the operator can
 * tell an orchestrated deploy from someone pressing ctrl-c.
 *
 * ## Why this is not still in `index.ts`
 *
 * It was, and nothing had ever executed it: `index.ts` calls `start()` at module scope, so importing
 * it launches the service, and the file scored 0.00% under mutation with all 25 of its mutants
 * surviving. Twelve of them were here, including both signal names, which could be blanked with the
 * whole suite staying green. See [[ServiceLifecycle]] for the same extraction on shutdown itself.
 */
export function registerShutdownSignals(lifecycle: ShutdownTarget, events: ProcessEvents = process): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    events.on(signal, () => void lifecycle.shutdown(signal));
  }
}

/**
 * Reports a crash line by line rather than as one object, because a `Promise` and an `Error` both
 * serialize to `{}` through `JSON.stringify`. See `crashReport.ts`, where that is the whole point.
 */
export function registerCrashHandlers(
  logger: CrashLogger = Logger.getInstance(),
  events: ProcessEvents = process,
): void {
  const report = (lines: CrashLine[]): void => {
    for (const { label, value } of lines) {
      logger.error(label, value);
    }
  };

  events.on('uncaughtException', (error) => report(uncaughtExceptionLines(error)));
  events.on('unhandledRejection', (reason) => report(unhandledRejectionLines(reason)));
}
