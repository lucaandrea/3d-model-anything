import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const address = 'http://127.0.0.1:5188';

async function existingViewer() {
  try {
    const response = await fetch(`${address}/__viewer/health`, { signal: AbortSignal.timeout(2000) });
    const health = await response.json();
    return health.app === '3d-model-anything' && health.repository === repository;
  } catch {
    return false;
  }
}

if (await existingViewer()) {
  console.log('\nYour viewer is already running. Open http://localhost:5188 in Safari.\n');
} else {
  const server = await createServer({ configFile: `${repository}/apps/room-viewer/vite.config.ts` });
  try {
    await server.listen();
    server.printUrls();
    server.bindCLIShortcuts({ print: true });
  } catch (error) {
    await server.close();
    // A simultaneous launch may have started our viewer while we were checking.
    if (await existingViewer()) {
      console.log('\nYour viewer is already running. Open http://localhost:5188 in Safari.\n');
    } else {
      console.error(`Could not start the viewer: ${error.message}`);
      console.error('If port 5188 belongs to another app, close that app before starting this viewer.');
      process.exitCode = 1;
    }
  }
}
