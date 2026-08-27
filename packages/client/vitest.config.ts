import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    // 30s, not vitest's 5s default, and now a backstop against a hang rather than a margin anything
    // relies on. It was raised because three tests failed the repo gate on time alone under a loaded
    // box, and the cause has since been removed at the source: the poll loops in
    // ManifestFetcher.test.ts pumped a fixed budget of macrotask ticks per poll, which Node floors at
    // about a millisecond each, so their cost was proportional to the poll count and inflated 8x under
    // `pnpm verify`. They await the walk's own completion signal instead. The slowest case in this
    // package is now 239ms and the whole package runs in 1.77s, so nothing here sits near any cap.
    testTimeout: 30_000,
    // config.ts reads these at import time and throws if absent; inject dummies for tests.
    env: {
      VITE_READER_BEE_URL: 'http://127.0.0.1:1633',
      VITE_APP_OWNER: '0x0000000000000000000000000000000000000000',
      VITE_APP_RAW_TOPIC: 'test-topic',
    },
  },
});
