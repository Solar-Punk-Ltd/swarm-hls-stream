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
    // config.ts reads these at import time and throws if absent; inject dummies for tests.
    env: {
      VITE_READER_BEE_URL: 'http://127.0.0.1:1633',
      VITE_APP_OWNER: '0x0000000000000000000000000000000000000000',
      VITE_APP_RAW_TOPIC: 'test-topic',
    },
  },
});
