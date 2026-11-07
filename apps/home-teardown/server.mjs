#!/usr/bin/env node
// Local server for the loft teardown. Serves the built page, the private model straight from data/scans (it is never
// copied into the build), the walls and floors from room.json, and the Claude endpoint. Listens on 127.0.0.1 only and
// refuses requests from other origins, so no other website can reach the model or spend the API key.
//
//   node apps/home-teardown/server.mjs [--room loft-refinements-2026-11-01] [--port 5199]
//
// Hosting (Replit or any server) is configured by environment variables, all optional locally:
//   HOST            interface to listen on (default 127.0.0.1; 0.0.0.0 to serve the network)
//   PORT            port (default 5199)
//   PUBLIC_URL      the address people open, e.g. https://loft.example.com (its host and origin are accepted)
//   ALLOWED_HOSTS   more hosts to accept, comma-separated; an entry starting with "." matches any subdomain
//   APP_PASSCODE    required when HOST is not loopback: every page and API asks for it once (a signed cookie)
//   DATA_DIR        where the model revisions live (default <repo>/data/scans)
//   APP_DATA_DIR    where this app's own files live (default apps/home-teardown/private)
//   ANTHROPIC_API_KEY, PARALLEL_API_KEY   from the environment, else the repository's .env
//
// The model revision (data/scans/<room>/: modeled_room.glb, room.json, viewer.json) is read, never written. The app's
// own files for that revision (corrections, saved layouts, Claude transcripts) live in apps/home-teardown/private/<room>/,
// git-ignored; an older revision whose files were kept beside its model (data/scans/<room>/teardown-*) still reads them.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createThreadStore, MODEL, runArrange} from './server/arrange.mjs';
import {genericItems, normaliseItems} from './shared/catalog-index.js';
import {GEN_DIR, generateModel, genFile, generatedIds} from './server/model3d.mjs';
import {readKey} from './server/env.mjs';
import {mirror, persist, restore} from './server/persist.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
// the latest approved model revision (handoff of 2026-11-01); --room or LOFT_ROOM picks another, e.g. to roll back
const ROOM = arg('room', process.env.LOFT_ROOM || 'loft-refinements-2026-11-01');
const PORT = Number(arg('port', process.env.PORT || 5199));
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(HOST);
const PASSCODE = process.env.APP_PASSCODE || '';
if (!LOOPBACK && !PASSCODE && process.env.ALLOW_NO_PASSCODE !== '1') {
  // the private home model and both API keys would be open to anyone who finds the address
  console.error(`Refusing to listen on ${HOST} without APP_PASSCODE. Set APP_PASSCODE (or ALLOW_NO_PASSCODE=1 behind your own auth).`);
  process.exit(1);
}
if (!/^[a-z0-9-]+$/.test(ROOM)) throw new Error(`bad room id ${ROOM}`);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(REPO, 'data/scans');
const ROOM_DIR = path.join(DATA_DIR, ROOM);
const GLB = path.join(ROOM_DIR, 'modeled_room.glb');
const APP_DIR = path.join(process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(HERE, 'private'), ROOM);
// hosted on Replit (STORAGE=replit): bring back the model revision, this app's files and the AI models from App Storage
mirror(`rooms/${ROOM}`, ROOM_DIR);
mirror(`app/${ROOM}`, APP_DIR);
mirror('generated', GEN_DIR);
await restore();
const appFile = (name) => {
  const own = path.join(APP_DIR, name);
  const legacy = path.join(ROOM_DIR, name);
  return fs.existsSync(own) || !fs.existsSync(legacy) ? own : legacy;
};
const LAYOUTS = appFile('teardown-layouts.json');
const CORRECTIONS = appFile('teardown-corrections.json');
// conversations with Claude (append-only threads with every run's turns, usage and compactions), private
const THREADS = createThreadStore(appFile('teardown-agent'), {onSave: persist});
// the furniture catalogue: curated real products and open models (catalog/catalog.json) plus one generic piece per type
const CATALOG_FILE = path.join(HERE, 'catalog/catalog.json');
const ASSETS = path.join(HERE, 'catalog-assets');
// Read again whenever catalog.json or the set of AI-made models changes (a rebuilt catalogue or a new model shows on
// the next load), otherwise served from memory, with a gzipped copy for the page.
let catalogCache = null;
const loadCatalog = () => {
  const gen = generatedIds();
  let mtime = 0;
  try {
    mtime = fs.statSync(CATALOG_FILE).mtimeMs;
  } catch {}
  const key = `${mtime}|${gen.size}`;
  if (catalogCache?.key === key) return catalogCache.items;
  let raw = [];
  try {
    raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  } catch (e) {
    console.warn('catalog.json unreadable:', e.message);
  }
  // pieces whose AI-made 3D model exists on disk are marked "gen"
  const items = [...normaliseItems(raw), ...genericItems()].map((it) => (gen.has(it.id) ? {...it, gen: true} : it));
  const body = Buffer.from(JSON.stringify(items));
  catalogCache = {key, items, body, gz: zlib.gzipSync(body, {level: 6})};
  return items;
};
const PAGE = path.join(HERE, 'teardown-out/dist/loft-teardown.html');
// 3D generation: one run per piece at a time, at most three at once (each is one or two Claude Opus 5.5 calls)
const making = new Map();
let runningMakes = 0;
const waiting = [];
const makeModel = (item) => {
  if (making.has(item.id)) return making.get(item.id);
  const run = (async () => {
    while (runningMakes >= 3) await new Promise((r) => waiting.push(r));
    runningMakes++;
    try {
      const rec = await generateModel(item);
      persist(genFile(item.id));
      return rec;
    } finally {
      runningMakes--;
      waiting.shift()?.();
      making.delete(item.id);
    }
  })();
  making.set(item.id, run);
  return run;
};
for (const f of [GLB, path.join(ROOM_DIR, 'room.json')]) if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
const viewer = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOM_DIR, 'viewer.json'), 'utf8'));
  } catch {
    return {label: ROOM};
  }
})();

// the key: the environment first, then the repository's .env (only that one variable is read)
const KEY = readKey('ANTHROPIC_API_KEY');

// walls, floors and RoomPlan fronts only: photos, poses and provenance stay on disk
const room = JSON.parse(fs.readFileSync(path.join(ROOM_DIR, 'room.json'), 'utf8'));
const roomPublic = JSON.stringify({
  polygon: room.polygon,
  walls: room.walls,
  objects: (room.objects || []).map((o) => ({category: o.category, center: o.center, size: o.size, front: o.front})),
  reconstruction: {excludedWallIndices: room.reconstruction?.excludedWallIndices || []},
  upstairs: room.reconstruction?.upstairs ? {floorElevationM: room.reconstruction.upstairs.floorElevationM, floors: room.reconstruction.upstairs.floors} : null,
});

// requests must name a host this server answers for, and writes must come from its own pages (no other site can
// drive the API); a public address is added from PUBLIC_URL / ALLOWED_HOSTS
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const HOST_SUFFIXES = [];
if (process.env.PUBLIC_URL) HOSTS.add(new URL(process.env.PUBLIC_URL).host);
for (const h of (process.env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
  if (h.startsWith('.')) HOST_SUFFIXES.push(h);
  else HOSTS.add(h);
}
const hostOk = (h) => !!h && (HOSTS.has(h.toLowerCase()) || HOST_SUFFIXES.some((sfx) => h.toLowerCase().split(':')[0].endsWith(sfx)));
const originOk = (o) => {
  try {
    return hostOk(new URL(o).host);
  } catch {
    return false;
  }
};

// APP_PASSCODE: one shared passcode, exchanged once for a signed 30-day cookie; failed tries are slowed per address
const SESSION_KEY = crypto.createHash('sha256').update(`loft-teardown|${PASSCODE}|${ROOM}`).digest();
const sign = (v) => crypto.createHmac('sha256', SESSION_KEY).update(v).digest('base64url');
const newSession = () => {
  const v = `${Date.now()}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${v}.${sign(v)}`;
};
const sessionOk = (cookie) => {
  const m = /(?:^|;\s*)lt_session=([^;]+)/.exec(cookie || '');
  if (!m) return false;
  const parts = m[1].split('.');
  if (parts.length !== 3) return false;
  const v = `${parts[0]}.${parts[1]}`;
  const a = Buffer.from(sign(v));
  const b = Buffer.from(parts[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Date.now() - Number(parts[0]) < 30 * 86400e3;
};
const tries = new Map(); // ip -> {n, t}
const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loft Teardown</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#efe9df;font:15px Inter,system-ui,sans-serif;color:#2a2521">
<form style="background:#fcfaf6;padding:28px 30px;border-radius:8px;box-shadow:0 2px 12px rgba(120,90,50,.12);display:grid;gap:12px;width:280px">
<div style="font:700 22px Inter,system-ui">Loft Teardown</div><div style="color:#958a7c;font-size:13px">This home is private. Enter the passcode.</div>
<input name="p" type="password" autocomplete="current-password" autofocus style="font:inherit;padding:9px 10px;border:1px solid #dccfbd;border-radius:5px">
<button style="font:700 12px ui-monospace,monospace;letter-spacing:1.4px;padding:10px;border:0;border-radius:5px;background:#e3562a;color:#fff;cursor:pointer">OPEN</button><div id="e" style="color:#c8322b;font-size:13px"></div></form>
<script>document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:e.target.p.value})});if(r.ok)location.href='/'+location.search;else document.getElementById('e').textContent=(await r.json()).error||'Wrong passcode';};</script></body>`;
const readBody = (req, limit = 4 << 20) =>
  new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
const json = (res, code, obj) => {
  res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host)) return json(res, 421, {error: 'wrong host'});
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!originOk(req.headers.origin || '')) return json(res, 403, {error: 'cross-origin request refused'});
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, {error: 'expected JSON'});
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    if (p === '/healthz') return json(res, 200, {ok: true});
    if (PASSCODE) {
      if (p === '/login' && req.method === 'POST') {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
        const t = tries.get(ip) || {n: 0, t: Date.now()};
        if (Date.now() - t.t > 15 * 60e3) (t.n = 0), (t.t = Date.now());
        if (t.n >= 10) return json(res, 429, {error: 'Too many tries. Wait 15 minutes.'});
        const given = Buffer.from(sign(String(JSON.parse(await readBody(req, 2048)).passcode || '')));
        const want = Buffer.from(sign(PASSCODE));
        if (!crypto.timingSafeEqual(given, want)) {
          t.n++;
          tries.set(ip, t);
          return json(res, 401, {error: 'Wrong passcode'});
        }
        tries.delete(ip);
        const secure = req.headers['x-forwarded-proto'] === 'https' || !LOOPBACK ? '; Secure' : '';
        res.setHeader('Set-Cookie', `lt_session=${newSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
        return json(res, 200, {ok: true});
      }
      if (!sessionOk(req.headers.cookie)) {
        if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/login')) {
          res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
          return res.end(LOGIN_PAGE);
        }
        return json(res, 401, {error: 'sign in first'});
      }
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (!fs.existsSync(PAGE)) return json(res, 503, {error: 'page not built: run node apps/home-teardown/tools/build.mjs'});
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      return fs.createReadStream(PAGE).pipe(res);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/model.glb') {
      const st = fs.statSync(GLB);
      const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, {ETag: etag});
        return res.end();
      }
      res.writeHead(200, {'Content-Type': 'model/gltf-binary', 'Content-Length': st.size, ETag: etag, 'Cache-Control': 'private, no-cache'});
      if (req.method === 'HEAD') return res.end();
      const s = fs.createReadStream(GLB);
      s.on('error', () => res.destroy());
      res.on('close', () => s.destroy());
      return s.pipe(res);
    }
    if (req.method === 'GET' && p === '/room.json') {
      res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      return res.end(roomPublic);
    }
    if (req.method === 'GET' && p === '/corrections.json') {
      // read on every request, so edits to the file show on the next reload
      res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      return res.end(fs.existsSync(CORRECTIONS) ? fs.readFileSync(CORRECTIONS, 'utf8') : '{}');
    }
    if (req.method === 'GET' && p === '/catalog.json') {
      loadCatalog();
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(gz ? {'Content-Encoding': 'gzip'} : {})});
      return res.end(gz ? catalogCache.gz : catalogCache.body);
    }
    if (req.method === 'GET' && p.startsWith('/catalog-generated/')) {
      // an AI-made model: a part list the page builds into a mesh
      const file = genFile(decodeURIComponent(p.slice('/catalog-generated/'.length)).replace(/\.json$/, ''));
      if (!file || !fs.existsSync(file)) return json(res, 404, {error: 'not found'});
      res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-cache'});
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'POST' && p === '/api/model3d') {
      // make a 3D model for a catalogue piece that has none (Claude Opus 5.5 with the product photo and listed size)
      if (!KEY.key) return json(res, 503, {error: 'ANTHROPIC_API_KEY is not set for the server'});
      const body = JSON.parse(await readBody(req, 4096));
      const item = loadCatalog().find((x) => x.id === body.id);
      if (!item || item.generic) return json(res, 404, {error: 'unknown catalogue piece'});
      if (item.gen && !body.force) return json(res, 200, {ok: true, id: item.id, cached: true});
      try {
        const rec = await makeModel(item);
        return json(res, 200, {ok: true, id: item.id, usd: rec.usage.usd, rounds: rec.rounds, parts: rec.parts.length, issues: rec.issues});
      } catch (e) {
        console.warn('[model3d]', item.id, e.message);
        return json(res, 502, {error: e.message});
      }
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/catalog-assets/')) {
      // open-licensed models and their licence notes only: a fixed folder, plain names, known types
      const rel = decodeURIComponent(p.slice('/catalog-assets/'.length));
      if (!/^[a-z0-9_-]+(\/[a-z0-9_.-]+)*\.(glb|gltf|bin|png|jpg|jpeg|webp|txt|md)$/i.test(rel) || rel.includes('..')) return json(res, 404, {error: 'not found'});
      const file = path.join(ASSETS, rel);
      if (!file.startsWith(ASSETS + path.sep) || !fs.existsSync(file)) return json(res, 404, {error: 'not found'});
      const type = {glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8'}[path.extname(file).slice(1).toLowerCase()];
      res.writeHead(200, {'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=3600'});
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, {room: {id: ROOM, label: viewer.label || ROOM}, claude: {model: MODEL, ready: !!KEY.key}});
    if (p === '/api/layouts') {
      if (req.method === 'GET') {
        const data = fs.existsSync(LAYOUTS) ? JSON.parse(fs.readFileSync(LAYOUTS, 'utf8')) : {layouts: []};
        return json(res, 200, data);
      }
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        if (!Array.isArray(body.layouts)) return json(res, 400, {error: 'layouts must be an array'});
        fs.mkdirSync(path.dirname(LAYOUTS), {recursive: true});
        const tmp = `${LAYOUTS}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({savedAt: new Date().toISOString(), layouts: body.layouts}, null, 1));
        fs.renameSync(tmp, LAYOUTS);
        persist(LAYOUTS);
        return json(res, 200, {ok: true, n: body.layouts.length});
      }
    }
    if (req.method === 'POST' && p === '/api/arrange') {
      if (!KEY.key) return json(res, 503, {error: 'ANTHROPIC_API_KEY is not set for the server'});
      const body = JSON.parse(await readBody(req));
      if (typeof body.request !== 'string' || !body.request.trim() || body.request.length > 4000 || !body.scene?.items) return json(res, 400, {error: 'bad request'});
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort());
      const send = (ev) => res.writableEnded || res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const t0 = Date.now();
      console.log(`[arrange] "${body.request.slice(0, 80)}" (${body.effort || 'medium'})`);
      try {
        await runArrange({body, send, apiKey: KEY.from === '.env' ? KEY.key : null, signal: ctrl.signal, store: THREADS, catalog: loadCatalog()});
        console.log(`[arrange] done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          console.error('[arrange] failed:', e.status || '', e.message);
          send({type: 'error', message: e.status === 401 ? 'The API key was rejected (401).' : e.status === 429 ? 'Rate limited by the API (429); try again in a minute.' : e.message || String(e)});
        }
      }
      send({type: 'done'});
      return res.end();
    }
    json(res, 404, {error: 'not found'});
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, {error: e.message});
    else res.end();
  }
});
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Port ${PORT} is already in use: if that is this server, open http://127.0.0.1:${PORT}/ (or start with --port <n>).`);
  process.exit(0);
});
server.listen(PORT, HOST, () => {
  console.log(`Loft teardown: http://${LOOPBACK ? '127.0.0.1' : HOST}:${PORT}/${process.env.PUBLIC_URL ? ` · public ${process.env.PUBLIC_URL}` : ''}${PASSCODE ? ' · passcode required' : ''}`);
  console.log(`  model   ${path.relative(REPO, GLB)} (${(fs.statSync(GLB).size / 1048576).toFixed(0)} MB) · ${viewer.label || ROOM}`);
  console.log(`  layouts ${path.relative(REPO, LAYOUTS)}`);
  console.log(`  fixes   ${fs.existsSync(CORRECTIONS) ? path.relative(REPO, CORRECTIONS) : 'none'}`);
  console.log(`  threads ${path.relative(REPO, THREADS.dir)}/`);
  console.log(`  Claude  ${MODEL} · ${KEY.key ? `key from ${KEY.from}` : 'NO ANTHROPIC_API_KEY (rearrange disabled)'}`);
});
