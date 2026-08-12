/**
 * `pnpm browser:selfcheck` — is this browser fit to measure a viewer through, at all?
 *
 * Costs nothing: no broadcast, no postage, no BZZ. It loads the client's browse page and reports
 * whether the page was visible, whether timers kept their schedule and whether the build can decode
 * what a viewer is sent.
 *
 * Worth its own entry point because it answers the blocking question on its own. Browser validation
 * has been blocked since 2026-08-03 not for want of a browser but because the only one available
 * degraded what it measured, and "is that fixed" is a different question from "what is the latency".
 * Answering it separately means a broadcast is only ever spent on a browser already known to be
 * sound, and a failure here names the harness rather than looking like the deployment.
 */

import { describeProofs, judgeInstrument } from '../src/browser/instrument.js';
import {
  CLOCK_OVERLAY_ID,
  installClockOverlay,
  installTimerProbe,
  launchViewer,
  proveInstrumentCanFail,
  readInstrument,
  VIEWPORT,
} from '../src/browser/viewer.js';

/** Long enough for the timer probe to have fired many times and for the page to settle. */
const OBSERVE_MS = 5_000;

async function main(): Promise<void> {
  const clientUrl = process.env.BROWSER_CLIENT_URL;
  if (!clientUrl) {
    throw new Error('BROWSER_CLIENT_URL is required');
  }

  const browser = await launchViewer();
  console.log(`selfcheck: Chrome ${browser.version()}`);

  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    await installTimerProbe(page);
    await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });
    await installClockOverlay(page);
    await page.waitForTimeout(OBSERVE_MS);

    const reading = await readInstrument(page);
    const verdict = judgeInstrument(reading);

    // Checked here, where it costs nothing, because the alternative is finding out during a
    // broadcast that every screenshot carries one clock and nothing to compare it against.
    const clock = await page.evaluate(
      (id: string) => document.getElementById(id)?.textContent ?? null,
      CLOCK_OVERLAY_ID,
    );

    console.log(`  visibilityState  ${reading.visibilityState}`);
    console.log(`  timer drift      ${reading.timerDriftRatio.toFixed(2)}x requested`);
    console.log(`  viewer clock     ${clock ?? 'NOT RENDERED'}`);
    Object.entries(reading.codecSupport).forEach(([codec, supported]) => {
      console.log(`  ${supported ? 'decodes' : 'CANNOT DECODE'}  ${codec}`);
    });

    // ⛔ Run here, where it costs nothing, because it is the only part of the harness that a unit
    // test cannot reach: these bodies are serialised into the page, and esbuild's `keepNames` rewrite
    // of a function it can name is invisible until a real browser evaluates it. `proveVisibilityCanFail`
    // shipped with exactly that fault and was found by a buffer sweep, twenty minutes into a paid
    // broadcast, because nothing free had ever called it.
    const proofs = await proveInstrumentCanFail(browser);
    proofs.forEach((proof) => {
      console.log(`  ${proof.rejected ? 'rejects' : 'ACCEPTS'}  a page whose ${proof.degradation}`);
    });
    const unproven = describeProofs(proofs);
    unproven.forEach((note) => console.log(`  ⚠️ ${note}`));

    console.log(`\nselfcheck: ${verdict.sound ? 'SOUND' : 'VOID'}`);
    verdict.failures.forEach((failure) => console.log(`  ⛔ ${failure}`));
    if (!verdict.sound) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
