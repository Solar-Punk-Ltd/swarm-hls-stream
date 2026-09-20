import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientSource = path.resolve(fixtureDirectory, '../../../src');

export default defineConfig({
  root: fixtureDirectory,
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@/providers/App', replacement: path.join(fixtureDirectory, 'App.tsx') },
      {
        find: '@/components/SwarmHlsPlayer/SwarmHlsPlayer',
        replacement: path.join(fixtureDirectory, 'SwarmHlsPlayer.tsx'),
      },
      { find: '@', replacement: clientSource },
    ],
  },
});
