#!/usr/bin/env node
// One-time setup on Replit: copies the private files (the home model revision and this app's per-home files) from
// the Repl's workspace into Replit App Storage under the exact object names server/persist.mjs restores from, then
// lists them back with their sizes. Run it in the Repl's shell after uploading the files into the workspace:
//
//   <repo>/data/scans/loft-refinements-2026-11-01/modeled_room.glb, room.json, viewer.json        (git-ignored)
//   <repo>/apps/home-teardown/private/loft-refinements-2026-11-01/teardown-corrections.json,
//                                                                 teardown-layouts.json            (git-ignored)
//
//   cd apps/home-teardown && npm install @replit/object-storage && node tools/replit-upload-private.mjs
//
// LOFT_ROOM picks another revision; REPLIT_BUCKET_ID another bucket than the Repl's default. Nothing is deleted.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(APP, '../..');
const ROOM = process.env.LOFT_ROOM || 'loft-refinements-2026-11-01';
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(REPO, 'data/scans');
const PRIV = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(APP, 'private');
const files = [
  ...['modeled_room.glb', 'room.json', 'viewer.json'].map((f) => ({src: path.join(DATA, ROOM, f), name: `rooms/${ROOM}/${f}`, required: true})),
  ...['teardown-corrections.json', 'teardown-layouts.json'].map((f) => ({src: path.join(PRIV, ROOM, f), name: `app/${ROOM}/${f}`, required: false})),
];

const missing = files.filter((f) => f.required && !fs.existsSync(f.src));
if (missing.length) {
  console.error(`Missing required files (upload them into the workspace first):\n  ${missing.map((f) => f.src).join('\n  ')}`);
  process.exit(1);
}
const {Client} = await import('@replit/object-storage');
const client = new Client();
if (process.env.REPLIT_BUCKET_ID) await client.init(process.env.REPLIT_BUCKET_ID);
for (const f of files) {
  if (!fs.existsSync(f.src)) {
    console.log(`skip   ${f.name} (no ${path.relative(REPO, f.src)})`);
    continue;
  }
  const mb = (fs.statSync(f.src).size / 1048576).toFixed(2);
  process.stdout.write(`upload ${f.name} (${mb} MB) ... `);
  const r = await client.uploadFromFilename(f.name, f.src);
  if (!r.ok) {
    console.log('FAILED');
    console.error(r.error);
    process.exit(1);
  }
  console.log('ok');
}
// read back what the server will restore
for (const prefix of [`rooms/${ROOM}/`, `app/${ROOM}/`]) {
  const r = await client.list({prefix});
  if (!r.ok) {
    console.error(`list ${prefix} failed:`, r.error);
    process.exit(1);
  }
  console.log(`${prefix}: ${r.value.map((o) => o.name.slice(prefix.length)).join(', ') || '(empty)'}`);
}
console.log('Done. Start the server with STORAGE=replit and it restores these on start.');
