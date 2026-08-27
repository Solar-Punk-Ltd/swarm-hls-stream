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
    // 30s, not vitest's 5s default. This suite's slowest cases sit 4-6s on a quiet machine and ran
    // 25-29s per FILE while pnpm verify loaded the box, so at 5s the repo gate failed on three
    // different tests across two runs with zero real defects. This machine hosts several sessions
    // at once and a gate that fails under ordinary co-tenancy is a broken gate; 30s still catches a
    // hang. The deeper fix, driving the timing-adjacent cases with injected timers, is tracked
    // separately.
    testTimeout: 30_000,
    // config.ts reads these at import time and throws if absent; inject dummies for tests.
    env: {
      VITE_READER_BEE_URL: 'http://127.0.0.1:1633',
      VITE_APP_OWNER: '0x0000000000000000000000000000000000000000',
      VITE_APP_RAW_TOPIC: 'test-topic',
    },
  },
});
