import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { localScans } from './local-scans.ts';

const app = import.meta.dirname;
const repository = resolve(app, '../..');
const privateReview = process.env.PRIVATE_REVIEW === '1';

export default defineConfig({
  root: app,
  base: process.env.VIEWER_BASE || '/',
  define: { 'import.meta.env.PRIVATE_REVIEW': JSON.stringify(privateReview) },
  plugins: [localScans(repository), {
    name: 'local-viewer-health',
    configureServer(server) {
      server.middlewares.use('/__viewer/health', (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ app: '3d-model-anything', repository }));
      });
    },
  }],
  optimizeDeps: { include: ['three/addons/objects/Reflector.js'] },
  publicDir: resolve(repository, 'data/web-assets'),
  server: {
    host: '127.0.0.1', port: 5188, strictPort: true, fs: { allow: [repository] },
    proxy: { '/__review': { target: 'http://127.0.0.1:5190', changeOrigin: true } },
    forwardConsole: { unhandledErrors: true, logLevels: ['error', 'warn'] },
    // Render evidence is output, not application source. Publishing a preview
    // image must not reload every viewer/capture in the middle of a build.
    watch: { ignored: ['**/data/captures/**', '**/data/recordings/**', '**/data/web-assets/office-v4/live/**'] },
  },
  build: {
    outDir: resolve(app, privateReview ? 'dist-review' : 'dist'),
    rolldownOptions: {
      input: {
        main: resolve(app, 'index.html'),
        review: resolve(app, 'review.html'),
        play: resolve(app, 'play.html'),
        capture: resolve(app, 'tools/capture.html'),
      },
    },
  },
});
