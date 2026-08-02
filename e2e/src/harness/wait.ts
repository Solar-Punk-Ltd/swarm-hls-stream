export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  label: string;
}

/** Poll `condition` until it returns true or the timeout elapses (then throw with `label`). */
export async function waitFor(condition: () => Promise<boolean>, opts: WaitOptions): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${opts.timeoutMs}ms: ${opts.label}`);
    }
    await sleep(opts.intervalMs);
  }
}
