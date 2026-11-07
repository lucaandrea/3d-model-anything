import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { unzipSync, strFromU8 } from 'fflate';
import { createReviewServer, inspectImage } from '../loft-review-server.mjs';
import { validateReview, MAX_IMAGE_BYTES } from '../../packages/loft-review/contract.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const sha=b=>createHash('sha256').update(b).digest('hex');
let root,service,base,remoteHost,model;
test.before(async()=>{
  root=await mkdtemp(resolve(tmpdir(),'loft-review-tests-'));
  await mkdir(resolve(root,'data/scans/test-loft'),{recursive:true});await mkdir(resolve(root,'apps/room-viewer/dist-review'),{recursive:true});
  await writeFile(resolve(root,'data/scans/test-loft/viewer.json'),JSON.stringify({id:'test-loft',label:'Test loft',model:'modeled_room.glb'}));
  await writeFile(resolve(root,'data/scans/test-loft/modeled_room.glb'),'model fixture');
  await writeFile(resolve(root,'apps/room-viewer/dist-review/review.html'),'<h1>Review fixture</h1>');
  service=await createReviewServer({repository:root,port:0,host:'127.0.0.1'});const addr=await service.listen();base=`http://127.0.0.1:${addr.port}`;remoteHost=`${hostname().toLowerCase().replace(/\.local$/,'')}.local:${addr.port}`;
  model=(await (await fetch(base+'/__review/context')).json()).models[0];
});
test.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
const draft=()=>({format:'loft-review/1',id:randomUUID(),createdAt:new Date().toISOString(),model:{id:model.id,revision:model.revision},notes:[{id:randomUUID(),area:'Entrance & office',title:'Test only: move cabinet',notes:'Move 20 cm toward the window.',category:'Position',object:'Cabinet',measurements:'20 cm',view:'?room=test-loft&view=orbit&camera=1,2,3,0,0,0,50',images:[{id:randomUUID(),name:'markup.png',type:'image/png',size:png.length,role:'annotated-screenshot'}]}]});
async function call(path,{method='GET',value,bytes,cookie,remote=false,origin,headers={}}={}){
  return new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method,headers:{...(method==='GET'?{}:{Origin:origin|| (remote?`http://${remoteHost}`:base)}),...(value?{'Content-Type':'application/json'}:{}),...(bytes?{'Content-Type':'image/png'}:{}),...(remote?{Host:remoteHost}:{}),...(cookie?{Cookie:cookie}:{}),...headers}},response=>{
      const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]))})));response.on('error',reject);
    });req.on('error',reject);req.end(value?JSON.stringify(value):bytes);
  });
}
async function begin(r){const response=await call('/__review/reviews',{method:'POST',value:r});assert.equal(response.status,200,await response.clone().text());return response.json();}
async function upload(r,b=png){return call(`/__review/reviews/${r.id}/images/${r.notes[0].images[0].id}`,{method:'PUT',bytes:b});}
test('receives images, verifies hashes, exports a self-contained ZIP and returns an idempotent receipt',async()=>{
  const r=draft();r.notes[0].view+='&walls=full';await begin(r);assert.equal((await upload(r)).status,200);
  const first=await call(`/__review/reviews/${r.id}/complete`,{method:'POST',value:{}});assert.equal(first.status,200);const receipt=await first.json();
  assert.equal(receipt.imageCount,1);assert.equal(receipt.noteCount,1);
  const repeat=await (await call(`/__review/reviews/${r.id}/complete`,{method:'POST',value:{}})).json();assert.deepEqual(receipt,repeat);
  const review=await (await call(`/__review/reviews/${r.id}`)).json();assert.equal(review.notes[0].images[0].sha256,sha(png));assert.equal(review.model.revision,model.revision);assert.equal(review.notes[0].view,r.notes[0].view);
  const zip=unzipSync(new Uint8Array(await (await call(`/__review/reviews/${r.id}/package.zip`)).arrayBuffer()));assert.deepEqual(Buffer.from(zip[review.notes[0].images[0].path]),png);assert.equal(JSON.parse(strFromU8(zip['receipt.json'])).id,r.id);
  const disk=await readFile(resolve(root,'data/reviews',r.id,'review.json'));assert.equal(sha(disk),receipt.manifestSHA256);
  assert.equal((await upload(r)).status,409);
});
test('incomplete uploads stay unreceived and retry reuses received images',async()=>{
  const r=draft();await begin(r);assert.equal((await call(`/__review/reviews/${r.id}/complete`,{method:'POST',value:{}})).status,409);
  assert.equal((await upload(r,png.subarray(0,20))).status,400);
  assert.equal((await upload(r)).status,200);assert.equal((await upload(r)).status,200);
  assert.deepEqual((await begin(r)).uploaded,[r.notes[0].images[0].id]);
  assert.ok(!(await (await call('/__review/reviews')).json()).some(i=>i.id===r.id));
});
test('rejects wrong model revisions and malformed or duplicate metadata',async()=>{
  const stale=draft();stale.model.revision='0'.repeat(64);assert.equal((await call('/__review/reviews',{method:'POST',value:stale})).status,409);
  const malformed=draft();malformed.notes[0].images[0].id='../escape';assert.throws(()=>validateReview(malformed));
  const duplicate=draft();duplicate.notes[0].images.push({...duplicate.notes[0].images[0]});assert.throws(()=>validateReview(duplicate),/Duplicate/);
  const noScreenshot=draft();noScreenshot.notes[0].images[0].role='reference-photo';assert.throws(()=>validateReview(noScreenshot),/annotated screenshot/);
  const large=draft();large.notes[0].images[0].size=MAX_IMAGE_BYTES+1;assert.throws(()=>validateReview(large));
  const wrongView=draft();wrongView.notes[0].view='?room=another-model';assert.throws(()=>validateReview(wrongView),/different model/);
});
test('rejects changed requests with the same identifier and concurrent conflicting uploads',async()=>{
  const r=draft();const both=await Promise.all([begin(r),begin(r)]);assert.equal(both.length,2);
  const modified=structuredClone(r);modified.notes[0].title='Changed';assert.equal((await call('/__review/reviews',{method:'POST',value:modified})).status,409);
  await upload(r);const changed=Buffer.from(png);changed[changed.length-1]^=1;assert.equal((await upload(r,changed)).status,409);
});
test('checks file signatures and pixel bounds',async()=>{
  assert.deepEqual(inspectImage(png,'image/png'),{width:1,height:1});assert.throws(()=>inspectImage(Buffer.from('<svg/>'),'image/png'));
  const huge=Buffer.from(png);huge.writeUInt32BE(50000,16);assert.throws(()=>inspectImage(huge,'image/png'));
  const r=draft();await begin(r);const bad=Buffer.alloc(png.length,65);assert.equal((await upload(r,bad)).status,415);
});
test('remote access requires pairing and excludes the access code from remote context',async()=>{
  assert.equal((await call('/__review/context',{remote:true})).status,401);
  assert.equal((await call('/__local-scans/index.json',{remote:true})).status,401);
  const login=await call('/review.html',{remote:true});assert.match(await login.text(),/Connect to your Mac/);
  assert.equal((await call('/__review/pair',{remote:true,method:'POST',value:{code:'wrong'}})).status,401);
  const local=await (await call('/__review/context')).json();
  const paired=await call('/__review/pair',{remote:true,method:'POST',value:{code:local.connection.code}});assert.equal(paired.status,200);
  const cookie=paired.headers.get('set-cookie').split(';')[0];assert.match(paired.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const remote=await (await call('/__review/context',{remote:true,cookie})).json();assert.equal(remote.onMac,false);assert.equal(remote.connection,undefined);assert.equal(remote.models[0].revision,model.revision);
  assert.equal((await call('/__review/context',{remote:true,cookie:cookie+'tampered'})).status,401);
});
test('rejects cross-origin writes, DNS rebinding and private source paths',async()=>{
  assert.equal((await call('/__review/reviews',{method:'POST',value:draft(),origin:'https://unrelated.example'})).status,403);
  assert.equal((await call('/__review/context',{headers:{Host:'unrelated.example'}})).status,403);
  for(const path of ['/__local-scans/test-loft/viewer.json','/tools/loft-review-server.mjs','/data/reviews/.access.json','/__local-scans/test-loft/%2e%2e%2f%2e%2e%2fsecret.json'])assert.equal((await call(path)).status,404,path);
});
test('rejects symlink escapes for models, uploads and review directories',async()=>{
  await writeFile(resolve(root,'secret.json'),'private');await symlink(resolve(root,'secret.json'),resolve(root,'data/scans/test-loft/room.json'));
  assert.equal((await call('/__local-scans/test-loft/room.json')).status,404);
  const r=draft();await symlink(root,resolve(root,'data/reviews',r.id));assert.equal((await call('/__review/reviews',{method:'POST',value:r})).status,403);
  const other=draft();await begin(other);await symlink(resolve(root,'secret.json'),resolve(root,'data/reviews',other.id,'images',`${other.notes[0].images[0].id}.png`));assert.equal((await upload(other)).status,404);
  const directory=draft();await begin(directory);await rm(resolve(root,'data/reviews',directory.id,'images'),{recursive:true});await symlink(root,resolve(root,'data/reviews',directory.id,'images'));assert.equal((await upload(directory)).status,403);
});
test('serves only the bounded catalog outputs behind the existing pairing gate',async()=>{
  const folder=resolve(root,'data/scans/test-loft/catalog');
  await mkdir(resolve(folder,'images'),{recursive:true});
  const files={'index.html':'<h1>Photo and render catalog</h1>','images/photo-01.jpg':'photo fixture','images/render-36.jpg':'render fixture','images/before-36.jpg':'previous model fixture','Loft-Photo-Render-Catalog.pdf':'%PDF-1.4 fixture','Loft-Photo-Corrections-Catalog.pdf':'%PDF-1.4 corrections fixture','manifest.json':'private source paths'};
  for(const [name,body] of Object.entries(files))await writeFile(resolve(folder,name),body);
  const prefix='/__local-scans/test-loft/catalog/';
  for(const name of Object.keys(files).filter(n=>n!=='manifest.json')){
    const response=await call(prefix+name);assert.equal(response.status,200,name);assert.equal(await response.text(),files[name]);
    const remote=await call(prefix+name,{remote:true});
    if(name.endsWith('.html')){assert.equal(remote.status,200);assert.match(await remote.text(),/Connect to your Mac/);}
    else assert.equal(remote.status,401,name);
  }
  const pdf=await call(prefix+'Loft-Photo-Render-Catalog.pdf',{method:'HEAD'});assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.equal(await pdf.text(),'');
  for(const name of ['manifest.json','scripts/render_catalog.py','work/diagnostics.json','images/photo-001.jpg'])assert.equal((await call(prefix+name)).status,404,name);
  await writeFile(resolve(root,'catalog-secret.jpg'),'private image outside scan root');
  await symlink(resolve(root,'catalog-secret.jpg'),resolve(folder,'images/render-99.jpg'));
  assert.equal((await call(prefix+'images/render-99.jpg')).status,404);
});
test('persists a completed receipt and pairing through a server restart',async()=>{
  const r=draft();await begin(r);await upload(r);await call(`/__review/reviews/${r.id}/complete`,{method:'POST',value:{}});
  const before=await readFile(resolve(root,'data/reviews/.access.json'),'utf8');await service.close();
  service=await createReviewServer({repository:root,port:0,host:'127.0.0.1'});const a=await service.listen();base=`http://127.0.0.1:${a.port}`;remoteHost=`${hostname().toLowerCase().replace(/\.local$/,'')}.local:${a.port}`;
  assert.equal(await readFile(resolve(root,'data/reviews/.access.json'),'utf8'),before);assert.ok((await (await call('/__review/reviews')).json()).some(i=>i.id===r.id));
});
