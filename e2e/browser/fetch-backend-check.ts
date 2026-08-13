/**
 * `pnpm browser:fetch-backend-check` — prove, for free, that a byte-source sitting is possible here.
 *
 * ⛔⛔⛔ THE FAILURE THIS EXISTS TO CATCH IS WORSE THAN THE GATEWAY ONE.
 *
 * If the deployed client was not built with `VITE_EXPOSE_PLAYER`, there is no switch to move. Every
 * arm then reads segments through the gateway, both columns hold the same path, and the sitting
 * reports that **an in-tab Swarm node holds a live edge exactly as well as a gateway does**. That is
 * the most attractive headline available to this line of work, and it would have been produced by
 * nothing happening at all.
 *
 * ⭐ It also boots a real node, and that is the point rather than a bonus. Everything else here can be
 * satisfied by a client that publishes a working switch onto a host where weeb-3 can never reach a
 * peer: the arms would then differ, honestly, in that one of them fetches no video. The join is the
 * single most likely reason a paid sitting comes back empty, it costs about ten seconds and 4.5 MB,
 * and it costs no BZZ, so there is no reason to learn it during a broadcast instead of before one.
 *
 * ⚠️ A2 measured the join at 9.4-10.5s in a desktop Chrome on a home connection. This runs in the
 * browser image on the deployment host, which is where a sitting would run it.
 */

import {
  GATEWAY_BYTES,
  prewarmByteSource,
  readByteSource,
  selectByteSource,
  WEEB3_BYTES,
} from '../src/browser/fetchBackendSweep.js';
import { requireEnv } from '../src/browser/runFiles.js';
import { launchViewer, VIEWPORT } from '../src/browser/viewer.js';

/** The client publishes its switch from a mount effect, so the handle appears a tick after the app does. */
const HANDLE_TIMEOUT_MS = 30_000;
const HANDLE_POLL_MS = 250;

/**
 * Generous on purpose. The client's own `ready()` gives up at 30s, so anything longer here is the
 * wasm download rather than the dialling, and a host that cannot manage it in two minutes cannot run
 * a sitting either way.
 */
const PREWARM_TIMEOUT_MS = 120_000;

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
    let before = await readByteSource(page);
    while (before.failure !== null && Date.now() < deadline) {
      await sleep(HANDLE_POLL_MS);
      before = await readByteSource(page);
    }
    if (before.failure !== null) {
      throw new Error(`the deployed client publishes no byte-source switch: ${before.failure}`);
    }
    console.log(`fetch-backend-check: the client reports its bytes come from ${before.byteSource}`);

    // Both directions, because a sitting needs to go back as well as forward, and read back rather
    // than trusting the setter's own answer: a `select` that only echoed its argument would satisfy
    // any check of its return value and move nothing.
    for (const source of [WEEB3_BYTES, GATEWAY_BYTES, WEEB3_BYTES] as const) {
      const moved = await selectByteSource(page, source);
      if (moved.failure !== null) {
        throw new Error(`the switch refused ${source}: ${moved.failure}`);
      }
      const readBack = await readByteSource(page);
      if (readBack.byteSource !== source) {
        throw new Error(
          `the switch is published but does not move the client: asked for ${source} and it reports ` +
            `${readBack.byteSource ?? 'nothing'}. Every arm of a sitting would read the same path.`,
        );
      }
    }
    console.log(`fetch-backend-check: the switch moves the client both ways`);

    // ⛔ A switch that accepted anything would let a driver typo run a whole arm on the default while
    // the log said otherwise. The client throws, and that throw has to survive minification.
    const nonsense = await selectByteSource(page, 'weeb-3' as never);
    if (nonsense.failure === null) {
      throw new Error(
        `the switch accepted the byte source "weeb-3", which is not one. A driver typo would run an ` +
          `arm on whatever the build defaults to and file it under the name it was given.`,
      );
    }
    console.log(`fetch-backend-check: the switch refuses a byte source it does not know`);

    await selectByteSource(page, GATEWAY_BYTES);

    console.log(`fetch-backend-check: booting a real node, which is what a sitting cannot do for free later`);
    const startedAtMs = Date.now();
    const failure = await Promise.race([
      prewarmByteSource(page),
      sleep(PREWARM_TIMEOUT_MS).then(() => `the node did not reach the network within ${PREWARM_TIMEOUT_MS}ms`),
    ]);
    if (failure !== null) {
      throw new Error(`no weeb-3 arm is possible on this host: ${failure}`);
    }
    console.log(`fetch-backend-check: the in-tab node joined in ${Date.now() - startedAtMs}ms, so arms are possible`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
