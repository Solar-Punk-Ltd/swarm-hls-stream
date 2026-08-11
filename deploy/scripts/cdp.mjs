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
 * ⛔ ONE weeb-3 NODE PER MACHINE, and a separate browser process is not an exemption: two nodes
 * starve each other's peer table whoever launched them. Measured 1 node 200 peers, 2 nodes 82,
 * 3 nodes 0, with no error surfaced anywhere.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** macOS default. Overridable so a host that keeps Chrome elsewhere can run this. */
export const CHROME_PATH =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
function connect(url) {
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

  return {
    async send(method, params = {}) {
      await open;
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
 * @param {string} url
 * @param {(client: {send: Function}) => Promise<T>} body
 * @returns {Promise<T>}
 * @template T
 */
export async function withPage(url, body) {
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
    await client.send('Page.navigate', { url });
    return await body(client);
  } finally {
    client?.close();
    chrome.kill();
  }
}
