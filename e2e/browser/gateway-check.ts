/**
 * `pnpm browser:gateway-check` — prove, for free, that a sitting could move a viewer between gateways.
 *
 * ⛔⛔⛔ THE FAILURE THIS EXISTS TO CATCH IS THE WORST ONE THE FUNDING SITTING HAS.
 *
 * If the deployed client was not built with `VITE_EXPOSE_PLAYER`, there is no switch to move and no
 * key worth seeding. Every arm then reads through whichever gateway the build defaults to, both
 * columns hold the same node, every metric agrees, and the sitting reports **"funding makes no
 * difference to a viewer"**. That is a wrong answer rather than a missing one, and it is exactly what
 * an optimist expects to see, so nothing about it looks suspicious afterwards.
 *
 * The per-arm readback catches it too, but only once a broadcast is running and paid for. This costs
 * a browser start and no BZZ, needs no live stream, and is the difference between learning about a
 * build flag before a sitting and during one.
 *
 * ⭐ It checks the switch WORKS, not merely that the handle is present. A `current()` that answers
 * while `select()` does nothing would pass any check of existence and fail every arm.
 */

import { readGateway, selectGateway } from '../src/browser/gatewaySweep.js';
import { requireEnv } from '../src/browser/runFiles.js';
import { launchViewer, VIEWPORT } from '../src/browser/viewer.js';

/** Never fetched from. It only has to be a url the client will accept and report back unchanged. */
const PROBE_GATEWAY = 'http://127.0.0.1:65535';

/** The client publishes its switch from a mount effect, so the handle appears a tick after the app does. */
const HANDLE_TIMEOUT_MS = 30_000;
const HANDLE_POLL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const clientUrl = requireEnv('BROWSER_CLIENT_URL');
  const browser = await launchViewer();

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    // The client root rather than a watch url: the switch is published by the app provider, so this
    // needs the page to mount and needs no broadcast to exist at all.
    await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });

    const deadline = Date.now() + HANDLE_TIMEOUT_MS;
    let before = await readGateway(page);
    while (before.failure !== null && Date.now() < deadline) {
      await sleep(HANDLE_POLL_MS);
      before = await readGateway(page);
    }
    if (before.failure !== null) {
      throw new Error(`the deployed client publishes no gateway switch: ${before.failure}`);
    }
    console.log(`gateway-check: the client reports ${before.gatewayUrl}`);

    const moved = await selectGateway(page, PROBE_GATEWAY);
    if (moved.gatewayUrl !== PROBE_GATEWAY) {
      throw new Error(
        `the switch is published but does not move the client: asked for ${PROBE_GATEWAY} and it ` +
          `reports ${moved.gatewayUrl ?? 'nothing'}. Every arm of a funding sitting would read the same node.`,
      );
    }

    // Read again rather than trusting the setter's own return value, since a `select` that only
    // echoed its argument would satisfy the check above and still move nothing.
    const after = await readGateway(page);
    if (after.gatewayUrl !== PROBE_GATEWAY) {
      throw new Error(`the switch reported ${moved.gatewayUrl} and the client now says ${after.gatewayUrl}`);
    }

    console.log(`gateway-check: the switch moved the client to ${after.gatewayUrl}, so arms are possible`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
