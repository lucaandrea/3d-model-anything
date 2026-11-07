// Keeps the server's files in Replit App Storage when hosted there (STORAGE=replit), because a published Replit app
// must not rely on its own filesystem: it is rebuilt from a snapshot on every publish and restart.
//
// The app keeps working on plain files. At start, restore() downloads what is missing locally from the bucket; after
// each write, persist(file) uploads that file. Locally (STORAGE unset) both do nothing.
//
// Bucket layout (object names):
//   rooms/<room>/modeled_room.glb, room.json, viewer.json   the private home model revision (uploaded once by hand)
//   app/<room>/...                                          corrections, saved layouts, Claude transcripts
//   generated/<id>.json                                     AI-made 3D models
//
// Uses @replit/object-storage (Client: downloadToFilename, uploadFromFilename, list; results are {ok, value, error}).
// The package is loaded only when STORAGE=replit, so it is not a dependency anywhere else.
import fs from 'node:fs';
import path from 'node:path';

const ON = process.env.STORAGE === 'replit';
let client = null;
const roots = []; // [{prefix, dir}]

async function store() {
  if (!client) {
    const {Client} = await import('@replit/object-storage');
    client = new Client();
    // the Repl's default bucket unless REPLIT_BUCKET_ID names another (App Storage > Settings > Bucket ID)
    if (process.env.REPLIT_BUCKET_ID) await client.init(process.env.REPLIT_BUCKET_ID);
  }
  return client;
}

/** Declares that files under dir are stored under prefix/ in the bucket. */
export function mirror(prefix, dir) {
  roots.push({prefix: prefix.replace(/\/+$/, ''), dir: path.resolve(dir)});
}

/** Downloads every object under the declared prefixes that is missing locally. Call once before reading files. */
export async function restore() {
  if (!ON) return;
  const c = await store();
  for (const {prefix, dir} of roots) {
    const res = await c.list({prefix: `${prefix}/`});
    if (!res.ok) throw new Error(`App Storage list ${prefix}: ${res.error?.message || res.error}`);
    let n = 0;
    for (const obj of res.value) {
      const rel = obj.name.slice(prefix.length + 1);
      if (!rel || rel.includes('..')) continue;
      const dest = path.join(dir, rel);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), {recursive: true});
      const r = await c.downloadToFilename(obj.name, dest);
      if (!r.ok) throw new Error(`App Storage download ${obj.name}: ${r.error?.message || r.error}`);
      n++;
    }
    if (n) console.log(`  restored ${n} file${n > 1 ? 's' : ''} from App Storage ${prefix}/`);
  }
}

/** Uploads a file the server just wrote, if it lies under a declared directory. Failures are logged, not thrown. */
export function persist(file) {
  if (!ON) return;
  const abs = path.resolve(file);
  const root = roots.find((r) => abs.startsWith(r.dir + path.sep));
  if (!root) return;
  const name = `${root.prefix}/${path.relative(root.dir, abs).split(path.sep).join('/')}`;
  store()
    .then((c) => c.uploadFromFilename(name, abs))
    .then((r) => r.ok || console.warn(`[persist] ${name}: ${r.error?.message || r.error}`))
    .catch((e) => console.warn(`[persist] ${name}: ${e.message}`));
}
