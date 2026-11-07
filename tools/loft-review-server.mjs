import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, realpath, stat, lstat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { createHash, createHmac, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { validateReview, imagePath, isUUID, isModelID, AREAS, CATEGORIES, MAX_IMAGE_BYTES } from '../packages/loft-review/contract.ts';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const digest = data => createHash('sha256').update(data).digest('hex');
const hashFile = async file => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
const fail = (status, message) => Object.assign(Error(message), { status });
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const loopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const localHost = host => /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host || '');
const equal = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
async function atomicJSON(file, value) { const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, file); }
async function readJSON(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function confined(root, relative) {
  const base = await realpath(root), path = await realpath(resolve(root, relative));
  if (!path.startsWith(base + sep) || !(await stat(path)).isFile()) throw fail(404, 'File not found.');
  return path;
}
async function body(req, max) {
  if (req.destroyed) throw fail(400, 'Upload interrupted. Retry when connected.');
  if (Number(req.headers['content-length']) > max) throw fail(413, 'This upload is too large.');
  const buffers = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw fail(413, 'This upload is too large.'); buffers.push(chunk); }
  return Buffer.concat(buffers);
}
async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(415, 'Expected a JSON review.');
  try { return JSON.parse((await body(req, 512 * 1024)).toString()); } catch (e) { if (e.status) throw e; throw fail(400, 'The review data could not be read.'); }
}
/** Check the actual file signature and a bounded pixel count, not its supplied extension. */
export function inspectImage(b, type) {
  let width = 0, height = 0;
  if (type === 'image/png' && b.length > 32 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16) === 'IHDR') { width = b.readUInt32BE(16); height = b.readUInt32BE(20); }
  if (type === 'image/jpeg' && b[0] === 255 && b[1] === 216) {
    let p = 2;
    while (p + 4 < b.length) {
      if (b[p++] !== 255) break;
      while (b[p] === 255) p++;
      const marker = b[p++]; if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = b.readUInt16BE(p); if (length < 2 || p + length > b.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) { height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5); break; }
      p += length;
    }
  }
  if (type === 'image/webp' && b.length > 30 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') {
    const kind = b.toString('ascii',12,16);
    if (kind === 'VP8X') { width = 1 + b.readUIntLE(24,3); height = 1 + b.readUIntLE(27,3); }
    else if (kind === 'VP8L' && b[20] === 47) { width = 1 + (((b[22] & 63) << 8) | b[21]); height = 1 + (((b[24] & 15) << 10) | (b[23] << 2) | (b[22] >> 6)); }
    else if (kind === 'VP8 ' && b.subarray(23,26).equals(Buffer.from([157,1,42]))) { width = b.readUInt16LE(26) & 16383; height = b.readUInt16LE(28) & 16383; }
  }
  if (!width || !height || width * height > 60_000_000 || width > 16000 || height > 16000) throw fail(415, 'Use a valid PNG, JPEG or WebP image up to 60 megapixels.');
  return { width, height };
}

export async function createReviewServer({ repository, port = 5190, host = '0.0.0.0', inbox = resolve(repository, 'data/reviews'), staticRoot = resolve(repository, 'apps/room-viewer/dist-review') }) {
  const scans = resolve(repository, 'data/scans');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  let access;
  try { access = await readJSON(resolve(inbox, '.access.json')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; access = { key: randomBytes(32).toString('hex'), code: randomBytes(9).toString('base64url') }; await writeFile(resolve(inbox, '.access.json'), JSON.stringify(access), { flag: 'wx', mode: 0o600 }); }
  const sign = v => createHmac('sha256', access.key).update(v).digest('hex');
  const sessions = req => {
    const c = /(?:^|;\s*)loft_review=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
    const [exp, nonce, mac] = c.split('.'); return Number(exp) > Date.now() && Number(exp) < Date.now() + 8 * 86400_000 && nonce?.length === 32 && equal(sign(`${exp}.${nonce}`), mac);
  };
  const attempts = new Map(), locks = new Map(), modelCache = new Map(); let activeUploads = 0;
  const addresses = () => Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)).map(a => a.address);
  const allowedHost = h => localHost(h) || [hostname().toLowerCase().replace(/\.local$/, '') + '.local', ...addresses()].some(n => h === `${n}:${port}`);
  const onMac = req => loopback(req.socket.remoteAddress) && localHost(req.headers.host);
  const authenticated = req => onMac(req) || sessions(req);
  async function models() {
    const result = [];
    for (const e of await readdir(scans, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !isModelID(e.name)) continue;
      try {
        const meta = await readJSON(await confined(scans, `${e.name}/viewer.json`));
        if (meta.id !== e.name || typeof meta.label !== 'string') continue;
        const file = await confined(scans, `${e.name}/${meta.model === 'modeled_room.glb' ? 'modeled_room.glb' : 'scan_room.glb'}`), info = await stat(file);
        const key = `${info.mtimeMs}:${info.size}`; let cache = modelCache.get(file);
        if (!cache || cache.key !== key) { cache = { key, revision: await hashFile(file) }; modelCache.set(file, cache); }
        result.push({ id: e.name, label: meta.label, revision: cache.revision, authored:meta.model === 'modeled_room.glb' });
      } catch { /* Incomplete model revisions are not review targets. */ }
    }
    return result;
  }
  async function locked(id, work) {
    const earlier = locks.get(id) || Promise.resolve();
    let release; const next = new Promise(r => { release = r; }); locks.set(id, next);
    await earlier;
    try { return await work(); } finally { release(); if (locks.get(id) === next) locks.delete(id); }
  }
  async function folder(id) {
    if (!isUUID(id)) throw fail(404, 'Review not found.');
    const p = resolve(inbox, id), info = await lstat(p).catch(() => null);
    if (info?.isSymbolicLink()) throw fail(403, 'Review directory is not available.');
    if (!info?.isDirectory()) throw fail(404, 'Review not found.');
    return p;
  }
  async function safeJSON(dir, name) { return readJSON(await confined(dir, name)); }
  async function uploadState(dir, request) {
    const uploaded = [];
    for (const image of request.notes.flatMap(n => n.images)) {
      try { const file = await confined(dir, imagePath(image)); if ((await stat(file)).size === image.size) uploaded.push(image.id); } catch { /* Retriable incomplete upload. */ }
    }
    return uploaded;
  }
  async function streamFile(req, res, file) {
    const info = await stat(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  }
  const login = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to your loft</title><style>html{color-scheme:dark;font:17px/1.5 system-ui;background:#111816;color:#f3f3e9}body{margin:0;min-height:100dvh;display:grid;place-items:center}main{padding:28px;max-width:420px}h1{font-size:34px;letter-spacing:-.04em}p{color:#bac6bd}label{display:block}input,button{box-sizing:border-box;width:100%;font:inherit;min-height:48px;border-radius:12px;padding:12px;margin:12px 0}input{background:#1c2822;color:inherit;border:1px solid #667c6c}button{background:#cce8af;color:#172018;border:0;font-weight:650}#message{color:#ffd6a3}</style><main><p>YOUR PRIVATE LOFT</p><h1>Connect to your Mac.</h1><p>In the Mac review page, choose <b>Open on iPad</b> to find your access code. Keep both devices on the same Wi-Fi.</p><form><label for="code">Access code</label><input id="code" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required><button>Connect</button><p id="message" role="status"></p></form></main><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=document.querySelector('button');b.disabled=true;document.querySelector('#message').textContent='Connecting…';try{const r=await fetch('/__review/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.querySelector('#code').value.trim()})});const d=await r.json();if(!r.ok)throw Error(d.error);location.reload()}catch(e){document.querySelector('#message').textContent=e.message}finally{b.disabled=false}};</script></html>`;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      const requestHost = (req.headers.host || '').toLowerCase();
      if (!allowedHost(requestHost)) throw fail(403, 'Use the Mac address shown in Open on iPad.');
      const url = new URL(req.url, `http://${requestHost}`), path = decodeURIComponent(url.pathname);
      if (!['GET','HEAD','POST','PUT'].includes(req.method)) throw fail(405, 'Method not allowed.');
      if (['POST','PUT'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin !== `http://${requestHost}` && !(onMac(req) && ['http://localhost:5188','http://127.0.0.1:5188'].includes(origin))) throw fail(403, 'Open this page directly on your Mac or paired iPad.');
      }
      if (path === '/__review/health' && req.method === 'GET') { json(res,200,{ app:'loft-review', ready:true }); return; }
      if (path === '/__review/pair' && req.method === 'POST') {
        const ip = req.socket.remoteAddress, now = Date.now(); let rate = attempts.get(ip);
        if (!rate || now - rate.start > 60000) { rate = { start:now, count:0 }; attempts.set(ip,rate); }
        if (++rate.count > 8) throw fail(429,'Too many attempts. Wait one minute and try again.');
        const b = await jsonBody(req); if (!equal(b?.code, access.code)) throw fail(401,'That code did not match. Check Open on iPad on the Mac.');
        const value = `${now + 7 * 86400_000}.${randomBytes(16).toString('hex')}`;
        res.setHeader('Set-Cookie', `loft_review=${value}.${sign(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`); json(res,200,{connected:true}); return;
      }
      if (!authenticated(req)) {
        if (req.method === 'GET' && (path === '/' || path.endsWith('.html'))) { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(login); return; }
        throw fail(401,'Reconnect to the Mac to send your review. Your local draft is safe.');
      }
      if (path === '/__review/context' && req.method === 'GET') {
        json(res,200,{ models:await models(), areas:AREAS, categories:CATEGORIES, onMac:onMac(req), connection:onMac(req) ? { addresses:addresses().map(a=>`http://${a}:${port}/review.html`), hostname:`http://${hostname().replace(/\.local$/,'')}.local:${port}/review.html`, code:access.code } : undefined }); return;
      }
      if (path === '/__review/reviews' && req.method === 'GET') {
        const receipts = [];
        for (const e of await readdir(inbox,{withFileTypes:true})) if (e.isDirectory() && isUUID(e.name)) { try { receipts.push(await safeJSON(await folder(e.name),'receipt.json')); } catch {} }
        json(res,200,receipts.sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)).slice(0,100)); return;
      }
      if (path === '/__review/reviews' && req.method === 'POST') {
        let request; try { request = validateReview(await jsonBody(req)); } catch (e) { throw fail(e.status || 400,e.message); }
        await locked(request.id,async()=>{
          const model = (await models()).find(m=>m.id === request.model.id);
          if (!model || model.revision !== request.model.revision) throw fail(409,'The home model has changed. Download this draft, then start a new review of the current model.');
          const dir = resolve(inbox,request.id), requestHash = digest(JSON.stringify(request));
          try {
            const old = await safeJSON(await folder(request.id),'request.json');
            if (old.requestHash !== requestHash) throw fail(409,'This review changed after its upload began. Create a new send attempt.');
          } catch (e) {
            if (e.status !== 404 && e.code !== 'ENOENT') throw e;
            await mkdir(resolve(dir,'images'),{recursive:true,mode:0o700});
            await atomicJSON(resolve(dir,'request.json'),{requestHash,model,request});
          }
          const receipt = await safeJSON(dir,'receipt.json').catch(()=>null);
          json(res,200,{id:request.id,uploaded:await uploadState(dir,request),receipt});
        }); return;
      }
      const match = /^\/__review\/reviews\/([a-f0-9-]+)(?:\/(.*))?$/.exec(path);
      if (match) {
        const id = match[1], action = match[2], dir = await folder(id);
        if (!action && req.method === 'GET') { json(res,200,await safeJSON(dir,'review.json')); return; }
        const imageMatch = /^images\/([a-f0-9-]+)$/.exec(action || '');
        if (imageMatch && req.method === 'PUT') {
          if (activeUploads >= 2) throw fail(503,'The Mac is receiving another image. Retry in a moment.');
          activeUploads++;
          try { await locked(id,async()=>{
            const {request} = await safeJSON(dir,'request.json');
            const image = request.notes.flatMap(n=>n.images).find(i=>i.id === imageMatch[1]);
            if (!image) throw fail(404,'Image not declared in this review.');
            if (await stat(resolve(dir,'receipt.json')).catch(()=>null)) throw fail(409,'This review is already received.');
            if (req.headers['content-type'] !== image.type) throw fail(415,'Image type does not match.');
            const bytes = await body(req,Math.min(image.size,MAX_IMAGE_BYTES));
            if (bytes.length !== image.size) throw fail(400,'Image upload was incomplete. Retry the review.');
            const dimensions = inspectImage(bytes,image.type), sha256 = digest(bytes);
            if (await realpath(resolve(dir,'images')) !== resolve(await realpath(dir),'images')) throw fail(403,'The image directory is not available.');
            const destination = resolve(dir,imagePath(image));
            if (await lstat(destination).catch(()=>null)) {
              const existing = await confined(dir,imagePath(image)); if (await hashFile(existing) !== sha256) throw fail(409,'A different image already uses this identifier.');
            } else {
              const temp = resolve(dir,`${randomUUID()}.upload`); await writeFile(temp,bytes,{mode:0o600,flag:'wx'}); await rename(temp,destination);
            }
            json(res,200,{id:image.id,sha256,...dimensions});
          }); } finally { activeUploads--; } return;
        }
        if (action === 'complete' && req.method === 'POST') {
          await jsonBody(req);
          await locked(id,async()=>{
            const existing = await safeJSON(dir,'receipt.json').catch(()=>null); if (existing) { json(res,200,existing); return; }
            const {request,model} = await safeJSON(dir,'request.json');
            const notes = [];
            for (const note of request.notes) {
              const images = [];
              for (const image of note.images) {
                let file; try { file = await confined(dir,imagePath(image)); } catch { throw fail(409,'Some images have not arrived. Retry the review.'); }
                const bytes = await readFile(file); if (bytes.length !== image.size) throw fail(409,'An image is incomplete. Retry the review.');
                images.push({...image,path:imagePath(image),sha256:digest(bytes),...inspectImage(bytes,image.type)});
              }
              notes.push({...note,images});
            }
            const receivedAt = new Date().toISOString();
            const manifest = {...request,model,notes,status:'received',receivedAt,provenance:'User-uploaded marked-up screenshots and notes. Not measured geometry or physical calibration.'};
            await atomicJSON(resolve(dir,'review.json'),manifest);
            await writeFile(resolve(dir,'README.txt'),`Loft review ${id}\nRead review.json and the images/ folder together.\nThese are user-supplied corrections to model revision ${model.revision}.\nPreserve the prior model, validate requested changes against photos or measurements, and return a before/after comparison.\nReceived means files are saved on this Mac. It does not mean Codex has read or applied them.\n`,{mode:0o600});
            const receipt = {id,receivedAt,noteCount:notes.length,imageCount:notes.flatMap(n=>n.images).length,model,manifestSHA256:await hashFile(resolve(dir,'review.json'))};
            await atomicJSON(resolve(dir,'receipt.json'),receipt); json(res,200,receipt);
          }); return;
        }
        if (action === 'package.zip' && req.method === 'GET') {
          await safeJSON(dir,'receipt.json'); const m = await safeJSON(dir,'review.json');
          const files = {'review.json':await readFile(await confined(dir,'review.json')),'README.txt':await readFile(await confined(dir,'README.txt')),'receipt.json':await readFile(await confined(dir,'receipt.json'))};
          for (const i of m.notes.flatMap(n=>n.images)) files[imagePath(i)] = await readFile(await confined(dir,imagePath(i)));
          res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="Loft-Review-${id.slice(0,8)}.zip"`}); res.end(zipSync(files,{level:0})); return;
        }
        throw fail(404,'Review action not found.');
      }
      if (!['GET','HEAD'].includes(req.method)) throw fail(405,'Method not allowed.');
      if (path === '/__local-scans/index.json') {
        const index = (await models()).map(m=>({id:m.id,label:m.label,measurements:`/__local-scans/${m.id}/room.json`,reference:`/__local-scans/${m.id}/scan_room.glb`,photos:`/__local-scans/${m.id}/photos/`,model:m.authored ? `/__local-scans/${m.id}/modeled_room.glb` : undefined})); json(res,200,index); return;
      }
      if (path.startsWith('/__local-scans/')) {
        const relative = path.slice('/__local-scans/'.length);
        if (!/^[a-z0-9-]+\/(room\.json|scan_room\.glb|modeled_room\.glb|photos\/\d{4}\.jpg|comparison\/(index\.html|(before|after)-\d{4}\.png)|catalog\/(index\.html|Loft-Photo-(Render|Corrections)-Catalog\.pdf|images\/(photo|render|before)-\d{2}\.jpg))$/.test(relative)) throw fail(404,'File not found.');
        await streamFile(req,res,await confined(scans,relative)); return;
      }
      const relative = path === '/' ? 'index.html' : path.slice(1);
      if (!MIME[extname(relative)] || relative.includes('..') || relative.includes('\\') || relative.startsWith('.')) throw fail(404,'Page not found.');
      await streamFile(req,res,await confined(staticRoot,relative));
    } catch (e) { if (!res.headersSent) json(res,e.status || (e.code === 'ENOENT' ? 404 : 500),{error:e.status ? e.message : e.code === 'ENOENT' ? 'File not found.' : 'The Mac could not save this request. Your draft is retained; try again.'}); else res.destroy(); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  return { server, listen:() => new Promise((ok,no)=>{server.once('error',no);server.listen(port,host,()=>{server.off('error',no);port=server.address().port;ok(server.address());});}), close:()=>new Promise(r=>server.close(r)) };
}
