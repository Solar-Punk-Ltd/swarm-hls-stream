import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams,spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Locator } from 'playwright-core';

import type { ContinuationPlayerTest, ContinuationWatchTest } from '../../../packages/client/test/fixtures/browser-continuation/window.js';

const E2E_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPOSITORY_ROOT = dirname(E2E_ROOT);
const FIXTURE_ROOT = join(REPOSITORY_ROOT, 'packages/client/test/fixtures/browser-continuation');
const VITE = join(REPOSITORY_ROOT, 'packages/client/node_modules/.bin/vite');
const CHROME_PATH = process.env.CHROME_BIN ?? process.env.BROWSER_CHROME_PATH ?? '/opt/google/chrome/chrome';
const DIAGNOSTIC_LIMIT = 8_000;
const MASTER_REFERENCE = 'a'.repeat(32) + 'b'.repeat(32);
const RUNG_REFERENCE = 'c'.repeat(32) + 'd'.repeat(32);

type CatalogEntry = {
  owner: string;
  topic: string;
  timestamp: number;
  mediatype: 'video';
  title: string;
  renditions: Array<{ name: string; width: number; height: number; topic: string; bandwidth: number; avgBandwidth: number }>;
  lifecycle: { version: 1; revision: number; runNumber: number; state: 'live' | 'vod' };
  completedRecording?: {
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

declare global {
  interface Window {
    __continuationWatchTest?: ContinuationWatchTest<CatalogEntry>;
    __continuationPlayerTest?: ContinuationPlayerTest;
  }
}

function recording(runNumber = 4): CatalogEntry['completedRecording'] {
  return {
    runNumber,
    master: { topic: 'master-topic', index: 18, reference: MASTER_REFERENCE, duration: 95 },
    expectedRenditions: ['720p'],
    renditions: [
      {
        name: '720p',
        topic: 'archived-rung',
        index: 7,
        reference: RUNG_REFERENCE,
        duration: 95,
        width: 1280,
        height: 720,
        bandwidth: 2_000_000,
        avgBandwidth: 1_800_000,
      },
    ],
  };
}

function catalog(
  state: 'live' | 'vod',
  runNumber = state === 'live' ? 5 : 4,
  completedRecording: CatalogEntry['completedRecording'] | null = recording(),
): CatalogEntry {
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
    lifecycle: { version: 1, revision: state === 'live' ? 10 : 9, runNumber, state },
    ...(completedRecording ? { completedRecording } : {}),
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

function appendDiagnostic(current: string, chunk: Buffer): string {
  return `${current}${chunk}`.slice(-DIAGNOSTIC_LIMIT);
}

function startFixture(port: number): {
  vite: ChildProcessWithoutNullStreams;
  diagnostics: () => string;
  failedToSpawn: () => boolean;
} {
  let stdout = '';
  let stderr = '';
  let spawnError: Error | null = null;
  const vite = spawn(VITE, ['--config', join(FIXTURE_ROOT, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port)], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      VITE_APP_OWNER: '0xfixture',
      VITE_APP_RAW_TOPIC: 'fixture-catalog-topic',
      VITE_READER_BEE_URL: 'http://127.0.0.1:1633',
    },
    stdio: 'pipe',
  });
  vite.stdout.on('data', (chunk: Buffer) => {
    stdout = appendDiagnostic(stdout, chunk);
  });
  vite.stderr.on('data', (chunk: Buffer) => {
    stderr = appendDiagnostic(stderr, chunk);
  });
  vite.on('error', (error) => {
    spawnError = error;
  });
  return {
    vite,
    failedToSpawn: () => spawnError !== null,
    diagnostics: () =>
      [
        `vite exit status: ${vite.exitCode ?? 'running'}`,
        spawnError ? `vite spawn error: ${spawnError.message}` : '',
        stdout ? `vite stdout:\n${stdout}` : '',
        stderr ? `vite stderr:\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
  };
}

async function waitForFixture(
  url: string,
  fixture: { vite: ChildProcessWithoutNullStreams; diagnostics: () => string; failedToSpawn: () => boolean },
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fixture.vite.exitCode !== null || fixture.failedToSpawn()) {
      throw new Error(`fixture stopped before it started at ${url}\n${fixture.diagnostics()}`);
    }
    try {
      if ((await fetch(url)).ok) {return;}
    } catch {
      // Vite has not accepted connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fixture did not start at ${url}\n${fixture.diagnostics()}`);
}

async function stopFixture(vite: ChildProcessWithoutNullStreams): Promise<void> {
  if (vite.exitCode !== null) {return;}
  vite.kill('SIGTERM');
  await Promise.race([once(vite, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (vite.exitCode === null) {
    vite.kill('SIGKILL');
    await once(vite, 'exit');
  }
}

async function launchBrowser(fixture: { diagnostics: () => string }): Promise<Browser> {
  try {
    return await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
    });
  } catch (error) {
    throw new Error(`could not launch Chromium at ${CHROME_PATH}: ${(error as Error).message}\n${fixture.diagnostics()}`);
  }
}

test('keeps a mounted replay through a catalogue refresh and remounts once only after Watch live', async () => {
  const port = await freePort();
  const fixtureUrl = `http://127.0.0.1:${port}`;
  const fixture = startFixture(port);
  let browser: Browser | undefined;

  try {
    await waitForFixture(fixtureUrl, fixture);
    browser = await launchBrowser(fixture);
    const page = await browser.newPage();
    await page.goto(`${fixtureUrl}/watch/video/0xviewer/stable-master-topic`, { waitUntil: 'networkidle' });
    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('vod'));
    const player = page.getByTestId('continuation-player');
    await player.waitFor({ state: 'attached' });
    await expectAttribute(player, 'data-master-reference', MASTER_REFERENCE);
    await expectAttribute(player, 'data-rendition-reference', RUNG_REFERENCE);
    await page.evaluate(() => {
      (document.querySelector('[data-testid="continuation-player"]') as HTMLVideoElement).currentTime = 41;
    });

    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('live'));
    await expectAttribute(player, 'data-master-reference', MASTER_REFERENCE);
    await expectAttribute(player, 'data-rendition-reference', RUNG_REFERENCE);
    await expectAttribute(player, 'data-rendition-topic', '');
    assert.equal(await player.evaluate((element: HTMLVideoElement) => element.currentTime), 41);
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 1, destroyed: 0 });

    await page.getByRole('button', { name: 'Stream resumed · Watch live' }).click();
    await expectAttribute(player, 'data-master-reference', '');
    await expectAttribute(player, 'data-rendition-topic', 'live-rung');
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 2, destroyed: 1 });
  } finally {
    await browser?.close();
    await stopFixture(fixture.vite);
  }
});

test('keeps live run A mounted through closure and run B until Watch live is selected', async () => {
  const port = await freePort();
  const fixtureUrl = `http://127.0.0.1:${port}`;
  const fixture = startFixture(port);
  let browser: Browser | undefined;

  try {
    await waitForFixture(fixtureUrl, fixture);
    browser = await launchBrowser(fixture);
    const page = await browser.newPage();
    await page.goto(`${fixtureUrl}/watch/video/0xviewer/stable-master-topic`, { waitUntil: 'networkidle' });
    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('live', 4, null));
    const player = page.getByTestId('continuation-player');
    await player.waitFor({ state: 'attached' });
    await page.evaluate(() => {
      (document.querySelector('[data-testid="continuation-player"]') as HTMLVideoElement).currentTime = 41;
    });

    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('vod', 4));
    await expectAttribute(player, 'data-pinned-master-reference', MASTER_REFERENCE);
    assert.equal(await player.evaluate((element: HTMLVideoElement) => element.currentTime), 41);
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 1, destroyed: 0 });

    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('live', 5));
    await expectAttribute(player, 'data-pinned-master-reference', MASTER_REFERENCE);
    assert.equal(await player.evaluate((element: HTMLVideoElement) => element.currentTime), 41);
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 1, destroyed: 0 });

    await page.getByRole('button', { name: 'Stream resumed · Watch live' }).click();
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 2, destroyed: 1 });
    await page.evaluate(() => {
      (document.querySelector('[data-testid="continuation-player"]') as HTMLVideoElement).currentTime = 41;
    });

    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('vod', 5, recording(5)));
    await expectAttribute(player, 'data-pinned-master-reference', MASTER_REFERENCE);
    assert.equal(await player.evaluate((element: HTMLVideoElement) => element.currentTime), 41);
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 2, destroyed: 1 });
    assert.equal(await page.getByRole('button', { name: 'Watch combined replay' }).count(), 0);
  } finally {
    await browser?.close();
    await stopFixture(fixture.vite);
  }
});

test('keeps replay A mounted until the viewer selects completed replay B', async () => {
  const port = await freePort();
  const fixtureUrl = `http://127.0.0.1:${port}`;
  const fixture = startFixture(port);
  let browser: Browser | undefined;

  try {
    await waitForFixture(fixtureUrl, fixture);
    browser = await launchBrowser(fixture);
    const page = await browser.newPage();
    await page.goto(`${fixtureUrl}/watch/video/0xviewer/stable-master-topic`, { waitUntil: 'networkidle' });
    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('vod', 4, recording(4)));
    const player = page.getByTestId('continuation-player');
    await player.waitFor({ state: 'attached' });
    await expectAttribute(player, 'data-replay-run', '4');
    await page.evaluate(() => {
      (document.querySelector('[data-testid="continuation-player"]') as HTMLVideoElement).currentTime = 41;
    });

    await page.evaluate((entry) => window.__continuationWatchTest!.setStreams([entry]), catalog('vod', 5, recording(5)));
    await expectAttribute(player, 'data-replay-run', '4');
    assert.equal(await player.evaluate((element: HTMLVideoElement) => element.currentTime), 41);
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 1, destroyed: 0 });

    await page.getByRole('button', { name: 'Watch combined replay' }).click();
    await expectAttribute(player, 'data-replay-run', '5');
    assert.deepEqual(await page.evaluate(() => window.__continuationPlayerTest), { created: 2, destroyed: 1 });
  } finally {
    await browser?.close();
    await stopFixture(fixture.vite);
  }
});

async function expectAttribute(
  locator: Locator,
  attribute: string,
  value: string,
): Promise<void> {
  assert.equal(await locator.getAttribute(attribute), value);
}
