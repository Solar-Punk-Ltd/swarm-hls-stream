import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  // Load env from monorepo root
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const beeUrl = env.VITE_READER_BEE_URL || 'http://127.0.0.1:1633';

  return {
    base: './',
    envDir: path.resolve(__dirname, '../..'),
    plugins: [nodePolyfills(), react()],
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      proxy: {
        '/bee': {
          target: beeUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/bee/, ''),
        },
      },
    },
  };
});
