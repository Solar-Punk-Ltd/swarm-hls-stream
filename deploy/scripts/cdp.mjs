/**
 * A Chrome that measures honestly, driven over raw CDP.
 *
 * ⭐⭐ RAW CDP RATHER THAN PLAYWRIGHT, AND THAT IS THE WHOLE POINT OF THIS FILE.
 *
 * Playwright passes `--disable-background-timer-throttling`,
 * `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding` from its own
 * hardcoded default switch list, and sends `Emulation.setFocusEmulationEnabled({enabled: true})` on
 * every main frame. Verified against the published playwright-core 1.61.1 tarball on 2026-08-11.
 * Under it a page reports `visible` with unthrottled timers whether or not the arrangement that makes
 * a run valid is present, so a harness that checks visibility through Playwright is quoting a
 * dependency's defaults back to itself. `e2e/src/browser/viewer.ts` has that defect today.
 *
 * Nothing here sends either. What the page reports is what the page got.
 *
 * ⛔⛔ REFUTED 2026-08-15. THE PARAGRAPH BELOW IS WRONG AND IS KEPT BECAUSE ACTING ON IT SHAPED
 * EVERY BROWSER ARM IN BOTH REPOS.
 *
 *   > ⛔ ONE weeb-3 NODE PER MACHINE, and a separate browser process is not an exemption: two nodes
 *   > starve each other's peer table whoever launched them. Measured 1 node 200 peers, 2 nodes 82,
 *   > 3 nodes 0, with no error surfaced anywhere.
 *
 * Six separate Chrome processes on one laptop each reached 200, then twelve did, then twelve penned
 * pens on a lab box each held all 40 nodes they were given, with per-pen CPU and memory flat from 1
 * to 12. There is no starvation between nodes on one machine.
 *
 * ⭐ What almost certainly produced the original numbers: the FIRST weeb-3 node started on a machine
 * can sit at 0 peers for over 120 seconds, and every node after it attaches within 30. A harness that
 * gates on a peer floor with a short timeout therefore records "starved" for what is only a slow
 * first contact, and records it more often the more nodes it starts. **Record time-to-attach as a
 * curve. Never gate a browser arm on a peer floor with a short timeout.**
 *
 * The loadlab write-ups are `docs/measurements/2026-08-15-b3-twelve-browser-nodes-on-one-host.md`
 * and `2026-08-15-a-penned-browser-node-holds-one-connection-per-node-we-give-it.md`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sampleChromeCpu } from './chrome-cpu.mjs';

/** macOS default. Overridable so a host that keeps Chrome elsewhere can run this. */
export const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PORT_RANGE_START = 9333;
const ENDPOINT_ATTEMPTS = 40;
const ENDPOINT_RETRY_MS = 250;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ⛔ Deliberately short, and deliberately not the flags every automation guide reaches for.
 *
 * `--headless=new` already reports `visibilityState: visible` and runs timers at full rate, verified
 * at 1.08x worst drift over 145s, so the throttling flags would buy nothing except the ability to
 * pass a visibility check while hidden. Leaving them out is what keeps that check meaningful.
 */
const chromeArgs = (port, profile) => [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
];

async function firstPageEndpoint(port) {
  for (let attempt = 0; attempt < ENDPOINT_ATTEMPTS; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        return page.webSocketDebuggerUrl;
      }
    } catch {
      /* the port is not listening yet, which is the ordinary case for the first few attempts */
    }
    await sleep(ENDPOINT_RETRY_MS);
  }
  throw new Error(`Chrome never opened a debugging page on ${port}`);
}

/** One socket, one in-flight map, no library. Reached off `globalThis` because it is a Node 22 global. */
export function connect(url) {
  const socket = new globalThis.WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed to open')), {
      once: true,
    });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message));
    } else {
      waiter.resolve(message.result);
    }
  });

  // ⛔⛔⛔ A CLOSED SOCKET MUST REJECT WHAT IT WILL NEVER ANSWER, and leaving this out cost a real
  // silent failure. Without it, a call in flight when Chrome goes away is neither resolved nor
  // rejected, its promise is orphaned, and a closed socket is not a handle that keeps Node alive. So
  // the process EXITS ZERO, mid-await, skipping every `finally` on the stack. Measured 2026-08-14: a
  // main-thread sampler pointed at a browser that then closed wrote two samples, no summary, no error,
  // and reported success. An instrument that dies silently and claims to have succeeded is worse than
  // one that never ran.
  const failPending = (why) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(why));
    }
    pending.clear();
  };
  socket.addEventListener('close', () => failPending('CDP socket closed while a call was in flight'));
  socket.addEventListener('error', () => failPending('CDP socket errored while a call was in flight'));

  return {
    async send(method, params = {}) {
      await open;
      if (socket.readyState !== globalThis.WebSocket.OPEN) {
        throw new Error(`CDP socket is not open, so ${method} can never be answered`);
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

/**
 * Evaluates in the page and returns the value, awaiting promises and surfacing thrown errors as
 * thrown errors rather than as an undefined that reads like a quiet null result.
 */
export async function evaluate(client, expression) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

/**
 * Clicks the page the way a person does, through the browser's own input pipeline.
 *
 * ⭐ NOT A BYPASS OF THE AUTOPLAY GATE. `Input.dispatchMouseEvent` is dispatched by the browser as
 * trusted input, so it grants real user activation, which is exactly what a viewer grants by clicking
 * play. A synthetic `new MouseEvent(...)` from page script would not, and would leave muted video
 * suspended while every other signal looked healthy.
 *
 * ⛔ The caller must assert activation afterwards rather than assume it. An unattended run that
 * silently failed to activate looks identical to a stream that never arrived: the first sustain run
 * driven this way sat at `state: 'attaching'` for ten minutes with 200 peers and a video element,
 * waiting for a click nobody was there to make.
 */
export async function clickPage(client) {
  const at = { x: 20, y: 20, button: 'left', clickCount: 1 };
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
  const activated = await evaluate(client, 'navigator.userActivation.hasBeenActive');
  if (!activated) {
    throw new Error('the synthesized click did not grant user activation, so autoplay would block');
  }
  return activated;
}

/**
 * Runs `body` against a fresh headless Chrome on `url`, then always tears the browser down.
 *
 * `body` receives the Chrome's own root PID, so a caller that wants to know what the browser cost can
 * sample the process tree beneath it. See `chrome-cpu.mjs` for why a PID on its own is not enough.
 *
 * ⭐ `idleMs` buys the null control for that measurement, and it has to happen HERE because it is the
 * only moment a caller cannot reach: Chrome is up, the page target exists, and nothing has been
 * navigated to yet. Without it a run has no way to separate what the page cost from what an empty
 * headless Chrome costs, and every figure would carry the browser's own floor inside it.
 *
 * @param {string} url
 * @param {(client: {send: Function}, context: {pid: number, idleCpu: import('./chrome-cpu.mjs').TreeCpu|null, idleSeconds: number}) => Promise<T>} body
 * @param {{idleMs?: number}} [options]
 * @returns {Promise<T>}
 * @template T
 */
export async function withPage(url, body, { idleMs = 0 } = {}) {
  const port = PORT_RANGE_START + Math.floor(process.pid % 100);
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const chrome = spawn(CHROME_PATH, chromeArgs(port, profile), { stdio: 'ignore' });
  chrome.on('error', (error) => {
    throw new Error(`Chrome failed to start at ${CHROME_PATH}: ${error.message}`);
  });
  let client;
  try {
    client = connect(await firstPageEndpoint(port));
    await client.send('Page.enable');

    let idleCpu = null;
    if (idleMs > 0) {
      const before = await sampleChromeCpu(chrome.pid);
      await sleep(idleMs);
      const after = await sampleChromeCpu(chrome.pid);
      idleCpu = {
        totalSeconds: after.totalSeconds - before.totalSeconds,
        processCount: after.processCount,
        byType: after.byType,
      };
    }

    await client.send('Page.navigate', { url });
    return await body(client, { pid: chrome.pid, idleCpu, idleSeconds: idleMs / 1000 });
  } finally {
    client?.close();
    chrome.kill();
  }
}
