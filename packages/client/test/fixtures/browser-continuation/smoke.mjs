import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(fixtureRoot, '../../..');
const vite = join(clientRoot, 'node_modules/.bin/vite');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'could not allocate a fixture port');
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function main() {
  const port = await freePort();
  const server = spawn(
    vite,
    ['--config', join(fixtureRoot, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: clientRoot,
      stdio: 'pipe',
    },
  );
  let diagnostics = '';
  server.stdout.on('data', (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8_000);
  });
  server.stderr.on('data', (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8_000);
  });

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) {
        throw new Error(`fixture server exited ${server.exitCode}\n${diagnostics}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/main.tsx`);
        if (response.ok) {
          const module = await response.text();
          assert.match(module, /StreamWatcher/);
          return;
        }
      } catch {
        // Vite has not accepted connections yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`fixture server did not transform main.tsx\n${diagnostics}`);
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
  }
}

await main();
