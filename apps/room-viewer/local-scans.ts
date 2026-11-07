import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Private imports are served only by the local dev server, never copied into dist. */
export function localScans(repository: string): Plugin {
  const root = resolve(repository, 'data/scans');
  const prefix = '/__local-scans/';
  return {
    name: 'local-scans',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith(prefix)) return next();
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (!['GET', 'HEAD'].includes(request.method ?? '')) {
          response.writeHead(405).end(); return;
        }
        try {
          const relative = decodeURIComponent(request.url.slice(prefix.length).split('?')[0]);
          if (relative === 'index.json') {
            const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
            const rooms = [];
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
              if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) continue;
              try {
                const folder = `${prefix}${entry.name}`;
                const metadata = JSON.parse(await readFile(resolve(root, entry.name, 'viewer.json'), 'utf8'));
                if (typeof metadata.id !== 'string' || !/^[a-z0-9-]+$/.test(metadata.id) || typeof metadata.label !== 'string') continue;
                const model = metadata.model === 'modeled_room.glb'
                  && (await stat(resolve(root, entry.name, 'modeled_room.glb')).catch(() => null))?.isFile()
                  ? `${folder}/modeled_room.glb` : undefined;
                rooms.push({ id: metadata.id, label: metadata.label,
                  measurements: `${folder}/room.json`, reference: `${folder}/scan_room.glb`, photos: `${folder}/photos/`, model });
              } catch { /* A reconstruction is not listed until its viewer manifest is ready. */ }
            }
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(rooms)); return;
          }
          // Limit the endpoint to viewer outputs; keep raw exports and diagnostic files private.
          if (!/^[a-z0-9-]+\/(?:room\.json|scan_room\.glb|modeled_room\.glb|photos\/\d{4}\.jpg|comparison\/(?:index\.html|(?:before|after)-\d{4}\.png)|catalog\/(?:index\.html|Loft-Photo-(?:Render|Corrections)-Catalog\.pdf|images\/(?:photo|render|before)-\d{2}\.jpg))$/.test(relative)) {
            response.writeHead(404).end(); return;
          }
          const base = await realpath(root);
          const file = await realpath(resolve(root, relative));
          if (!file.startsWith(base + sep)) { response.writeHead(404).end(); return; }
          const info = await stat(file);
          if (!info.isFile()) { response.writeHead(404).end(); return; }
          response.setHeader('Content-Type', ({ '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8' })[extname(file)]!);
          response.setHeader('Content-Length', info.size);
          if (request.method === 'HEAD') { response.end(); return; }
          const stream = createReadStream(file);
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response);
        } catch {
          response.writeHead(404).end();
        }
      });
    },
  };
}
