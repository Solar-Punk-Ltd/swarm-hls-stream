import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, type Browser, type Locator } from 'playwright-core';

const E2E_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = dirname(E2E_ROOT);
const FIXTURE_ROOT = join(E2E_ROOT, 'test/fixtures/browser-continuation');
const VITE = join(E2E_ROOT, 'node_modules/.bin/vite');
const CHROME_PATH = process.env.BROWSER_CHROME_PATH ?? '/opt/google/chrome/chrome';

type CatalogEntry = {
  owner: string;
  topic: string;
  timestamp: number;
  mediatype: 'video';
  title: string;
  renditions: Array<{ name: string; width: number; height: number; topic: string; bandwidth: number; avgBandwidth: number }>;
  lifecycle: { version: 1; revision: number; runNumber: number; state: 'live' | 'vod' };
  completedRecording: {
    runNumber: number;
    master: { topic: string; index: number; reference: string; duration: number };
    expectedRenditions: string[];
    renditions: Array<{
      name: string;
      topic: string;
      index: number;
      reference: string;
      duration: number;
      width: number;
      height: number;
      bandwidth: number;
      avgBandwidth: number;
    }>;
  };
};

function recording(): CatalogEntry['completedRecording'] {
  return {
    runNumber: 4,
    master: { topic: 'master-topic', index: 18, reference: 'master-reference-a', duration: 95 },
    expectedRenditions: ['720p'],
    renditions: [
      {
        name: '720p',
        topic: 'archived-rung',
        index: 7,
        reference: 'archived-rung-reference-a',
        duration: 95,
        width: 1280,
        height: 720,
        bandwidth: 2_000_000,
        avgBandwidth: 1_800_000,
      },
    ],
  };
}

function catalog(state: 'live' | 'vod'): CatalogEntry {
  return {
    owner: '0xviewer',
    topic: 'stable-master-topic',
    timestamp: 1,
    mediatype: 'video',
    title: state === 'live' ? 'Resumed broadcast' : 'Archived broadcast',
    renditions: [
      {
        name: '720p',
        width: 1280,
        height: 720,
        topic: state === 'live' ? 'live-rung' : 'archived-rung',
        bandwidth: 2_000_000,
        avgBandwidth: 1_800_000,
      },
    ],
    lifecycle: { version: 1, revision: state === 'live' ? 10 : 9, runNumber: state === 'live' ? 5 : 4, state },
    completedRecording: recording(),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('could not allocate a fixture port');
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForFixture(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite has not accepted connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fixture did not start at ${url}`);
}

async function stopFixture(vite: ChildProcessWithoutNullStreams): Promise<void> {
  if (vite.exitCode !== null) return;
  vite.kill('SIGTERM');
  await once(vite, 'exit');
}

test('keeps a mounted replay through a catalogue refresh and remounts once only after Watch live', async () => {
  const port = await freePort();
  const fixtureUrl = `http://127.0.0.1:${port}`;
  const vite = spawn(VITE, ['--config', join(FIXTURE_ROOT, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port)], {
    cwd: REPOSITORY_ROOT,
    stdio: 'pipe',
  });
  let browser: Browser | undefined;

  try {
    await waitForFixture(fixtureUrl);
    browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
    const page = await browser.newPage();
    await page.goto(`${fixtureUrl}/watch/video/0xviewer/stable-master-topic`, { waitUntil: 'networkidle' });
    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('vod'));
    const player = page.getByTestId('continuation-player');
    await player.waitFor();
    await expectAttribute(player, 'data-master-reference', 'master-reference-a');
    await expectAttribute(player, 'data-rendition-reference', 'archived-rung-reference-a');
    await page.evaluate(() => {
      (document.querySelector('[data-testid="continuation-player"]') as HTMLVideoElement).currentTime = 41;
    });

    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('live'));
    await expectAttribute(player, 'data-master-reference', 'master-reference-a');
    await expectAttribute(player, 'data-rendition-reference', 'archived-rung-reference-a');
    await expectAttribute(player, 'data-rendition-topic', '');
    assert.equal(await player.evaluate((element: HTMLVideoElement) => element.currentTime), 41);
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 1, destroyed: 0 });

    await page.getByRole('button', { name: 'Stream resumed · Watch live' }).click();
    await expectAttribute(player, 'data-master-reference', '');
    await expectAttribute(player, 'data-rendition-topic', 'live-rung');
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 2, destroyed: 1 });
  } finally {
    await browser?.close();
    await stopFixture(vite);
  }
});

async function expectAttribute(
  locator: Locator,
  attribute: string,
  value: string,
): Promise<void> {
  assert.equal(await locator.getAttribute(attribute), value);
}
