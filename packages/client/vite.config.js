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
    build: {
      // Stated rather than inherited, because the bundler default is not stable
      // across majors and moving it is silent: vite 5 defaulted to this list and
      // vite 8 defaults to `baseline-widely-available`, which emits
      // `@media (width>=500px)` range syntax that older engines drop whole,
      // taking the rule with it and reporting nothing. Raising this floor is a
      // product decision, so it belongs in a commit that says so.
      target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
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
