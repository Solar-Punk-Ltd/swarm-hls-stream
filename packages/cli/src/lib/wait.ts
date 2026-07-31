import { Bee, type PostageBatch } from '@ethersphere/bee-js';

import { spinner } from './output.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Real default. Exposed as a parameter so a test can drive the same loop in milliseconds rather
// than waiting out a real batch propagation.
const POLL_INTERVAL_MS = 3000;

/**
 * Poll until the bee node answers a health check. Throws after the timeout.
 *
 * It does not inspect the response, so this establishes the node is up and serving, not that it is
 * connected to peers or that its status reads ok. The docstring claimed peer connectivity and never
 * checked it.
 */
export async function waitForNode(bee: Bee, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = POLL_INTERVAL_MS): Promise<void> {
  const s = spinner('Waiting for bee node to be ready...');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await bee.getHealth();
      s.stop('Bee node is healthy');
      return;
    } catch {
      // Node not ready yet
    }
    await sleep(pollMs);
  }

  s.stop();
  throw new Error(`Bee node did not become healthy within ${timeoutMs / 1000}s`);
}

/**
 * Poll until a specific stamp becomes usable.
 * Returns the usable batch.
 */
export async function waitForStamp(
  bee: Bee,
  batchId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = POLL_INTERVAL_MS,
): Promise<PostageBatch> {
  const s = spinner('Waiting for stamp to become usable (this can take a few minutes)...');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const batch = await bee.getPostageBatch(batchId);
      if (batch.usable) {
        s.stop('Stamp is usable');
        return batch;
      }
    } catch {
      // Stamp not propagated yet
    }
    await sleep(pollMs);
  }

  s.stop();
  throw new Error(`Stamp ${batchId} did not become usable within ${timeoutMs / 1000}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
