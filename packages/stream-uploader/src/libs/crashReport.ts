/**
 * What to write when the process is about to be told something it cannot handle.
 *
 * ## Why these are functions rather than the handler bodies
 *
 * They lived inline in `index.ts`, which calls `start()` at module scope, so importing it launches the
 * service and nothing could execute them. Under mutation that file scored 0.00%.
 *
 * ⛔ Executing them found a line that had never said anything. The unhandled-rejection handler opened
 * with `JSON.stringify(promise, null, 2)`, and a Promise has no enumerable properties, so that argument
 * rendered as `{}` on **every** unhandled rejection this service has ever logged. It is the same defect
 * `Logger`'s own tests were written for, one layer up: an operator reading the log got a line whose
 * only content was that a line existed. The promise carries nothing identifying, so it is gone rather
 * than reformatted, and what remains is the reason and its stack.
 */

/** One log line: the label an operator scans for, and the value behind it. */
export interface CrashLine {
  label: string;
  value: unknown;
}

/**
 * A rejection nobody caught, as lines.
 *
 * The stack is a separate line rather than part of the reason because `Logger` renders an `Error` by
 * its message, deliberately, so the stack has to be asked for or it is not written at all.
 */
export function unhandledRejectionLines(reason: unknown): CrashLine[] {
  const lines: CrashLine[] = [{ label: 'Unhandled rejection:', value: reason }];

  if (reason instanceof Error) {
    lines.push({ label: 'Rejection stack:', value: reason.stack });
  }

  return lines;
}

/** An exception nobody caught. The process is unsound after this, and the log is all that survives. */
export function uncaughtExceptionLines(error: unknown): CrashLine[] {
  const lines: CrashLine[] = [{ label: 'Uncaught exception:', value: error }];

  if (error instanceof Error) {
    lines.push({ label: 'Exception stack:', value: error.stack });
  }

  return lines;
}
