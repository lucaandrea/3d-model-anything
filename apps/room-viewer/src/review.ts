import { zipSync, strToU8 } from 'fflate';
import { AREAS, CATEGORIES, REVIEW_FORMAT, MAX_IMAGE_BYTES, MAX_REVIEW_BYTES, MAX_IMAGES, imageExtension, imagePath, reviewBytes, validateReview, type ReviewRequest, type ReviewNote, type ReviewImage, type ModelSummary, type ReviewReceipt, type ImageRole } from '../../../packages/loft-review/contract';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const api = '/__review';
const html = (s: string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const uuid = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c)/4).toString(16));
const bytesLabel = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const emptyNote = (view = ''): ReviewNote => ({id:uuid(),area:'Entrance & office',title:'',notes:'',category:'Other',object:'',measurements:'',view,images:[]});
const fresh = (): ReviewRequest => ({format:REVIEW_FORMAT,id:uuid(),createdAt:new Date().toISOString(),model:{id:'',revision:''},notes:[emptyNote()]});
let draft = fresh(), selected = draft.notes[0].id, selectedImage = '', models: ModelSummary[] = [], connection: {addresses:string[];hostname:string;code:string} | undefined;
let db: IDBDatabase | undefined, volatile = new Map<string,Blob>(), urls = new Map<string,string>(), receipt: ReviewReceipt | undefined;
let busy = false, pendingRole: ImageRole = 'annotated-screenshot', aborter: AbortController | undefined, storageTail: Promise<void> = Promise.resolve();
let restored = false, version = 0, uploadVersion = -1, undo: {note:ReviewNote;index:number}|undefined;
type SavedDraft = {draft:ReviewRequest;selected:string;selectedImage:string;receipt?:ReviewReceipt;version:number;uploadVersion:number};
const snapshotDraft = (): SavedDraft => structuredClone({draft,selected,selectedImage,receipt,version,uploadVersion});
const hasContent = () => draft.notes.some(n=>n.images.length || n.title.trim() || n.notes.trim());
const selectedNote = () => draft.notes.find(n=>n.id === selected)!;
function notice(message: string, error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').classList.toggle('error',error); }
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${api}${path}`,{...options,signal:options?.signal ?? AbortSignal.timeout(20000)}); }
  catch { throw Error('The Mac is not reachable. Keep it awake and on the same Wi-Fi, then retry. Your draft is retained.'); }
  const result = await response.json().catch(()=>({error:'The Mac review service is not running. Start npm run review on the Mac.'}));
  if (!response.ok) throw Error(result.error || `Could not save review (${response.status}).`);
  return result as T;
}
const post = (value: unknown, signal?: AbortSignal): RequestInit => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal});
async function openDatabase() {
  return new Promise<IDBDatabase>((resolve,reject)=>{
    const req = indexedDB.open('loft-review',1);
    req.onupgradeneeded=()=>{req.result.createObjectStore('draft');req.result.createObjectStore('images');};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
}
async function getStored<T>(store:string,key:string): Promise<T|undefined> {
  if (!db) return undefined;
  return new Promise((resolve,reject)=>{const r=db!.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
async function putStored(store:string,key:string,value:unknown) {
  if (!db) throw Error('Device storage unavailable.');
  await new Promise<void>((resolve,reject)=>{const t=db!.transaction(store,'readwrite');t.objectStore(store).put(value,key);t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});
}
function saveDraft() {
  const snapshot = snapshotDraft();
  $('draft-state').textContent='Saving draft on this device…';
  storageTail = storageTail.catch(()=>{}).then(()=>putStored('draft','active',snapshot)).then(()=>{
    $('draft-state').textContent='Draft saved on this device.';
  }).catch(()=>{
    $('draft-state').textContent='Device storage is unavailable or full. Send or download your review before closing this page.';
  });
  return storageTail;
}
async function imageBlob(id:string) { return volatile.get(id) || await getStored<Blob>('images',id); }
async function imageURL(id:string) {
  if (urls.has(id)) return urls.get(id)!;
  const blob=await imageBlob(id);if(!blob)return '';
  const url=URL.createObjectURL(blob);urls.set(id,url);return url;
}
function changed() { version++; receipt=undefined; void saveDraft(); renderList(); renderSummary(); }
function renderList() {
  $('note-count').textContent=`${draft.notes.length} ${draft.notes.length===1?'note':'notes'}`;
  $('note-list').replaceChildren();
  for(const [i,n] of draft.notes.entries()) {
    const button=document.createElement('button');button.type='button';button.className='note-choice';button.setAttribute('aria-current',String(n.id===selected));
    button.innerHTML=`<span class="note-thumb" aria-hidden="true">${i+1}</span><span class="note-copy"><strong>${html(n.title || 'New correction')}</strong><small>${html(n.area)} · ${n.images.length} ${n.images.length===1?'image':'images'}</small></span>`;
    if(n.images[0])void imageURL(n.images[0].id).then(url=>{if(!url)return;const img=new Image();img.className='note-thumb';img.alt='';img.src=url;button.firstChild?.replaceWith(img);});
    button.onclick=()=>{selected=n.id;selectedImage=n.images[0]?.id || '';renderEditor();renderList();void renderImages();void saveDraft();};
    $('note-list').append(button);
  }
}
function renderEditor() {
  const n=selectedNote();
  for(const key of ['area','title','notes','category','object','measurements'] as const) $<HTMLInputElement>(key).value=n[key];
  $('saved-view').innerHTML=n.view ? `<a href="/${html(n.view)}" target="_blank" rel="noopener">Open saved model view ↗</a><br>This view was saved when you opened the review. Your uploaded screenshot is the reference for later camera changes.` : 'No camera view attached. Your marked-up screenshot identifies the correction.';
}
let previewEpoch=0;
async function renderImages() {
  const epoch=++previewEpoch,n=selectedNote();
  const image=n.images.find(i=>i.id===selectedImage) || n.images[0];selectedImage=image?.id || '';
  $('image-count').textContent=`${n.images.length}/8 images`;
  $('image-role').textContent=image?.role==='reference-photo'?'Real reference photo':'Annotated screenshot';
  $('preview-title').textContent=image ? image.name : 'Show what needs changing.';
  $('image-stage').classList.toggle('has-image',!!image);
  if(image) {
    const src=await imageURL(image.id);if(epoch!==previewEpoch)return;
    const img=new Image();img.alt=image.role==='reference-photo'?'Real room reference':'Your annotated model screenshot';img.src=src;
    $('image-stage').replaceChildren(img);
    if(!src)notice('An attachment is missing from device storage. Remove it and add the original image again.',true);
  } else {
    $('image-stage').innerHTML='<div class="empty-image"><span class="paper-icon" aria-hidden="true">↗</span><h3>Your marked-up screenshot goes here.</h3><p>Add it from Photos or Files. Keep your arrows, sketches and written notes in the image.</p><button class="primary" id="empty-add">Add annotated screenshot</button><p class="helper">PNG, JPEG or WebP · up to 20 MB per image</p></div>';
    $('empty-add').onclick=()=>chooseImages('annotated-screenshot');
  }
  $('image-strip').replaceChildren();
  for(const attachment of n.images) {
    const src=await imageURL(attachment.id);if(epoch!==previewEpoch)return;
    const wrap=document.createElement('div');wrap.className=`attachment ${attachment.id===selectedImage?'active':''}`;
    const button=document.createElement('button');button.type='button';button.setAttribute('aria-label',`View ${attachment.name}`);button.innerHTML=`<img src="${html(src)}" alt="">`;button.onclick=()=>{selectedImage=attachment.id;void renderImages();};
    const remove=document.createElement('button');remove.type='button';remove.className='remove-image';remove.textContent='×';remove.setAttribute('aria-label',`Remove ${attachment.name}`);remove.onclick=()=>{n.images=n.images.filter(i=>i.id!==attachment.id);changed();void renderImages();};
    const label=document.createElement('small');label.textContent=attachment.role==='reference-photo'?'Real photo':'Marked-up';wrap.append(button,remove,label);$('image-strip').append(wrap);
  }
}
function chooseImages(role:ImageRole) { if(busy)return;pendingRole=role;$<HTMLInputElement>('image-input').click(); }
async function attachFiles(files:File[]) {
  const note=selectedNote(), role=pendingRole;let error='';
  for(const file of files) {
    if(note.images.length>=8 || draft.notes.flatMap(n=>n.images).length>=MAX_IMAGES) {error='Use up to 8 images per note and 40 per review. Send this batch before adding more.';break;}
    if(!imageExtension(file.type) || file.size>MAX_IMAGE_BYTES || !file.size) {error=`${file.name}: choose PNG, JPEG or WebP, up to 20 MB. In Photos, save or export a screenshot as PNG or JPEG.`;continue;}
    if(reviewBytes(draft)+file.size>MAX_REVIEW_BYTES){error='This review has reached 120 MB. Send it, then start another review.';break;}
    const url=URL.createObjectURL(file);
    try {
      await new Promise<void>((resolve,reject)=>{const i=new Image();i.onload=()=>{i.width*i.height<=60_000_000?resolve():reject(Error('Image is over 60 megapixels.'));};i.onerror=()=>reject(Error('Image cannot be opened.'));i.src=url;});
      const id=uuid();volatile.set(id,file);urls.set(id,url);
      try{await putStored('images',id,file);}catch{notice('Your image is available for this visit, but device storage is full. Send or download before closing.',true);}
      note.images.push({id,name:file.name.slice(0,200),type:file.type,size:file.size,role});selectedImage=id;
    }catch{URL.revokeObjectURL(url);error=`${file.name} could not be opened. Save it as a PNG or JPEG and add it again.`;}
  }
  changed();await renderImages();if(error)notice(error,true);
}
function validation() {try{validateReview(draft);return '';}catch(e){return (e as Error).message;}}
function renderSummary() {
  $('workspace').inert=busy;
  const count=draft.notes.flatMap(n=>n.images).length;
  $('summary').textContent=`${draft.notes.length} ${draft.notes.length===1?'correction':'corrections'} · ${count} ${count===1?'image':'images'} · ${bytesLabel(reviewBytes(draft))}`;
  $<HTMLButtonElement>('send-review').disabled=busy || !count || !draft.model.revision || !!receipt;
  $<HTMLButtonElement>('export-review').disabled=busy || !count || !!receipt;
  $<HTMLSelectElement>('model-select').disabled=busy || !!receipt;
  $<HTMLButtonElement>('add-note').disabled=busy || draft.notes.length>=30;
}
function updateModel() {
  const found=models.find(m=>m.id===draft.model.id);
  $('revision-label').textContent=draft.model.revision ? `Revision ${draft.model.revision.slice(0,10)} · saved with every note` : 'Connect to the Mac to select a home model.';
  const query=new URLSearchParams({room:draft.model.id});
  $<HTMLAnchorElement>('model-link').href=draft.model.id ? `/?${query}` : '/';
  if(found && found.revision!==draft.model.revision)notice('A newer model is available. This draft still refers to the older revision. Download it before starting a new review.',true);
}
function newestModel() {
  // The Mac supplies authored on each context entry. Prefer the newest dated
  // reconstruction, not an older model whose name happens to sort last.
  const authored = models.filter(m => 'authored' in m && m.authored === true);
  const date = (model: ModelSummary) => model.id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
  return [...(authored.length ? authored : models)].sort((a,b) => date(b).localeCompare(date(a)))[0];
}
async function connect() {
  try {
    const c=await request<{models:ModelSummary[];onMac:boolean;connection?:typeof connection}>('/context');models=c.models;connection=c.connection;
    $('connection').textContent=c.onMac?'Mac inbox ready':'Connected to your Mac';$('ipad-connect').hidden=!c.onMac;
    const select=$<HTMLSelectElement>('model-select');select.replaceChildren();
    for(const m of models){const option=new Option(m.label,m.id);select.add(option);}
    const wanted=new URLSearchParams(location.search).get('room');
    if(!draft.model.id) {
      const m=models.find(m=>m.id===wanted) || newestModel();
      if(m){draft.model={id:m.id,revision:m.revision};void saveDraft();}
    }
    if(draft.model.id && !models.some(m=>m.id===draft.model.id))select.add(new Option(`Unavailable model · ${draft.model.id}`,draft.model.id));
    select.value=draft.model.id;updateModel();renderSummary();await loadHistory();
  }catch(e){$('connection').textContent='Mac connection unavailable';notice((e as Error).message,true);}
}
async function archiveCurrentDraft() {
  if(!receipt && hasContent()) {
    for(const i of draft.notes.flatMap(n=>n.images)) {
      const blob=await imageBlob(i.id);if(!blob)throw Error('An original image is missing.');
      await putStored('images',i.id,blob);
    }
    await putStored('draft',`archive:${draft.id}`,snapshotDraft());
  }
}
function restoreState(saved:SavedDraft) {
  draft=saved.draft;selected=saved.selected;selectedImage=saved.selectedImage;receipt=saved.receipt;version=saved.version;uploadVersion=saved.uploadVersion;
  if(!draft.notes.some(n=>n.id===selected))selected=draft.notes[0].id;
  $('received').hidden=true;$('workspace').hidden=false;$('send-status').textContent='Original screenshots stay on your device.';
  $<HTMLSelectElement>('model-select').value=draft.model.id;
  renderList();renderEditor();void renderImages();renderSummary();updateModel();void saveDraft();
}
async function loadDraftHistory() {
  if(!db)return;
  const all=await new Promise<SavedDraft[]>((resolve,reject)=>{const request=db!.transaction('draft').objectStore('draft').getAll(IDBKeyRange.bound('archive:','archive;'));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  $('saved-drafts').hidden=!all.some(saved=>saved.draft.id!==draft.id);$('draft-history').replaceChildren();
  for(const saved of all.reverse()) {
    if(saved.draft.id===draft.id)continue;
    const b=document.createElement('button');b.type='button';b.textContent=`${saved.draft.notes[0]?.title || 'Untitled review'} · ${saved.draft.notes.length} notes`;
    b.onclick=async()=>{try{await archiveCurrentDraft();restoreState(saved);notice('Saved draft restored.');await loadDraftHistory();}catch{notice('Could not preserve the current draft. Send or download it before switching.',true);}};
    $('draft-history').append(b);
  }
}
async function newReview() {
  try{await archiveCurrentDraft();}catch{notice('Device storage is full. Send or download this review before starting another.',true);return;}
  const model=models.find(m=>m.id===draft.model.id)||newestModel(),next=fresh();if(model)next.model={id:model.id,revision:model.revision};
  for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();volatile.clear();
  restoreState({draft:next,selected:next.notes[0].id,selectedImage:'',version:0,uploadVersion:-1});notice('Previous unsent reviews are kept in Saved drafts on this device.');await loadDraftHistory();
}
async function loadHistory() {
  try{
    const history=await request<ReviewReceipt[]>('/reviews');$('history-count').textContent=history.length ? `(${history.length})` : '';
    $('history-list').replaceChildren();
    for(const r of history){const a=document.createElement('a');a.href=`${api}/reviews/${r.id}/package.zip`;a.textContent=`${new Date(r.receivedAt).toLocaleString()} · ${r.noteCount} notes · ${r.id.slice(0,8)} ↧`;a.title='Download received review with images';$('history-list').append(a);}
    if(!history.length)$('history-list').innerHTML='<p class="helper">Nothing sent yet.</p>';
  }catch{ /* Draft editing remains available while disconnected. */ }
}
function showReceipt(r:ReviewReceipt) {
  receipt=r;$('received').hidden=false;$('workspace').hidden=true;
  $('receipt-detail').textContent=`${r.noteCount} ${r.noteCount===1?'correction':'corrections'} and ${r.imageCount} ${r.imageCount===1?'image':'images'} · Review ${r.id.slice(0,8)} · ${new Date(r.receivedAt).toLocaleString()}`;
  $<HTMLAnchorElement>('receipt-download').href=`${api}/reviews/${r.id}/package.zip`;
  $('send-status').textContent='Saved on Mac. Ready for Codex when you return to the chat.';renderSummary();void saveDraft();
}
async function uploadImage(reviewID:string,image:ReviewImage,blob:Blob,progress:(n:number)=>void,signal:AbortSignal) {
  await new Promise<void>((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('PUT',`${api}/reviews/${reviewID}/images/${image.id}`);xhr.setRequestHeader('Content-Type',image.type);xhr.timeout=120000;
    const cancel=()=>xhr.abort();signal.addEventListener('abort',cancel,{once:true});
    xhr.upload.onprogress=e=>progress(e.loaded);
    xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300)resolve();else{let message='Upload failed. Retry to continue.';try{message=JSON.parse(xhr.responseText).error || message;}catch{}reject(Error(message));}};
    xhr.onerror=()=>reject(Error('Wi-Fi was interrupted. Keep the Mac awake and retry; received images will be reused.'));
    xhr.ontimeout=()=>reject(Error('The image upload timed out. Retry to continue.'));
    xhr.onabort=()=>reject(Error('Upload paused. Your draft and received images are retained.'));
    xhr.onloadend=()=>signal.removeEventListener('abort',cancel);
    if(signal.aborted){reject(Error('Upload paused.'));return;}xhr.send(blob);
  });
}
async function sendReview() {
  if(busy)return;
  const problem=validation();if(problem){notice(problem,true);return;}
  if(uploadVersion!==version){draft.id=uuid();uploadVersion=version;}
  await saveDraft();busy=true;aborter=new AbortController();document.body.classList.add('busy');notice('');renderSummary();
  const progress=$<HTMLProgressElement>('upload-progress');progress.hidden=false;progress.value=0;$('cancel-upload').hidden=false;
  try{
    const snapshot=validateReview(draft),all=snapshot.notes.flatMap(n=>n.images),total=reviewBytes(snapshot);
    $('send-status').textContent='Checking the Mac and preparing your review…';
    const begin=await request<{uploaded:string[];receipt:ReviewReceipt|null}>('/reviews',post(snapshot,aborter.signal));
    if(begin.receipt){showReceipt(begin.receipt);return;}
    let sent=all.filter(i=>begin.uploaded.includes(i.id)).reduce((n,i)=>n+i.size,0);
    for(const [index,image] of all.entries()){
      if(begin.uploaded.includes(image.id))continue;
      const blob=await imageBlob(image.id);if(!blob)throw Error(`The original ${image.name} is missing from device storage. Add it again before sending.`);
      await uploadImage(snapshot.id,image,blob,n=>{progress.value=(sent+n)/total*100;$('send-status').textContent=`Sending image ${index+1} of ${all.length} · ${bytesLabel(sent+n)} / ${bytesLabel(total)}`;},aborter.signal);
      sent+=image.size;
    }
    $('send-status').textContent='All images sent. The Mac is verifying and saving the package…';progress.value=100;
    const r=await request<ReviewReceipt>(`/reviews/${snapshot.id}/complete`,post({},aborter.signal));showReceipt(r);notice('');await loadHistory();
  }catch(e){notice((e as Error).message,true);$('send-status').textContent='Not yet confirmed on Mac. Your draft is retained; retry or download a ZIP.';}
  finally{busy=false;document.body.classList.remove('busy');$('cancel-upload').hidden=true;progress.hidden=true;renderSummary();}
}
async function exportReview() {
  const problem=validation();if(problem){notice(problem,true);return;}
  busy=true;renderSummary();$('send-status').textContent='Preparing your ZIP with screenshots and notes…';
  try{
    const snapshot=validateReview(draft);const files:Record<string,Uint8Array>={};
    for(const image of snapshot.notes.flatMap(n=>n.images)){
      const blob=await imageBlob(image.id);if(!blob)throw Error(`${image.name} is missing. Add the original again.`);
      files[imagePath(image)]=new Uint8Array(await blob.arrayBuffer());
    }
    const manifest={...snapshot,status:'exported-on-device',notes:snapshot.notes.map(n=>({...n,images:n.images.map(i=>({...i,path:imagePath(i)}))})),provenance:'User-uploaded screenshots and notes. Not measured geometry or physical calibration.'};
    files['review.json']=strToU8(JSON.stringify(manifest,null,2));files['README.txt']=strToU8('Loft review: review.json + images/.\nExported on the device; not confirmed received by the Mac.\nGive this ZIP to Codex with your request to apply the corrections.\n');
    const data=zipSync(files,{level:0}), url=URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>],{type:'application/zip'}));
    const a=document.createElement('a');a.href=url;a.download=`Loft-Review-${draft.id.slice(0,8)}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    $('send-status').textContent='ZIP prepared. Save it to Files or AirDrop it to the Mac. This does not confirm a Mac upload.';
  }catch(e){notice((e as Error).message,true);}finally{busy=false;renderSummary();}
}

async function start() {
  window.name='loft-review';
  for(const a of AREAS)$<HTMLSelectElement>('area').add(new Option(a,a));
  for(const c of CATEGORIES)$<HTMLSelectElement>('category').add(new Option(c,c));
  try{
    db=await openDatabase();const saved=await getStored<SavedDraft>('draft','active');
    if(saved?.draft?.format===REVIEW_FORMAT && saved.draft.notes.length){draft=saved.draft;selected=saved.selected;selectedImage=saved.selectedImage;receipt=saved.receipt;version=saved.version||0;uploadVersion=saved.uploadVersion??-1;restored=true;if(!draft.notes.some(n=>n.id===selected))selected=draft.notes[0].id;}
  }catch{$('draft-state').textContent='Device storage unavailable. Send or download before closing.';}
  const suppliedView=new URLSearchParams(location.search).get('from');
  if(suppliedView && /^\?room=[a-z0-9-]+(?:&(?:view|camera|source|walls)=[a-zA-Z0-9.,%_-]+)*$/.test(suppliedView)) {
    if(!restored)draft.notes[0].view=suppliedView;
    else if(!receipt)notice('Your existing draft is restored. Add a correction to attach the view you just opened.');
  }
  for(const key of ['area','title','notes','category','object','measurements'] as const){$<HTMLInputElement>(key).oninput=()=>{selectedNote()[key]=$<HTMLInputElement>(key).value;changed();};}
  $('note-form').onsubmit=e=>e.preventDefault();
  $('add-note').onclick=()=>{const view=suppliedView && new URLSearchParams(suppliedView.slice(1)).get('room')===draft.model.id ? suppliedView : '';const n=emptyNote(view);n.area=selectedNote().area;draft.notes.push(n);selected=n.id;selectedImage='';changed();renderEditor();void renderImages();};
  $('remove-note').onclick=()=>{
    const i=draft.notes.findIndex(n=>n.id===selected);undo={note:draft.notes[i],index:i};draft.notes.splice(i,1);if(!draft.notes.length)draft.notes.push(emptyNote());selected=draft.notes[Math.min(i,draft.notes.length-1)].id;changed();renderEditor();void renderImages();notice('Correction removed.');
    const b=document.createElement('button');b.textContent='Undo';b.onclick=()=>{if(!undo)return;draft.notes.splice(undo.index,0,undo.note);selected=undo.note.id;undo=undefined;changed();renderEditor();void renderImages();notice('');};$('notice').append(b);
  };
  $('add-screenshot').onclick=()=>chooseImages('annotated-screenshot');$('add-reference').onclick=()=>chooseImages('reference-photo');
  $<HTMLInputElement>('image-input').onchange=e=>{const input=e.target as HTMLInputElement;const files=Array.from(input.files||[]);input.value='';void attachFiles(files);};
  $('image-stage').ondragover=e=>{e.preventDefault();};$('image-stage').ondrop=e=>{e.preventDefault();pendingRole='annotated-screenshot';if(!busy)void attachFiles(Array.from(e.dataTransfer?.files||[]));};
  $('send-review').onclick=()=>void sendReview();$('export-review').onclick=()=>void exportReview();$('cancel-upload').onclick=()=>aborter?.abort();
  $<HTMLSelectElement>('model-select').onchange=()=>{
    const m=models.find(m=>m.id===$<HTMLSelectElement>('model-select').value);if(!m)return;
    if(draft.notes.some(n=>n.images.length||n.title.trim())){notice('This draft already belongs to a model. Send or download it before starting a review of another model.',true);$<HTMLSelectElement>('model-select').value=draft.model.id;return;}
    draft.model={id:m.id,revision:m.revision};for(const n of draft.notes)n.view='';changed();updateModel();renderEditor();
  };
  $('new-review').onclick=()=>void newReview();$('save-new-review').onclick=()=>void newReview();
  $('ipad-connect').onclick=()=>{
    if(!connection)return;$('connection-addresses').replaceChildren();
    for(const address of connection.addresses.length?connection.addresses:[connection.hostname]){const a=document.createElement('a');a.href=address;a.textContent=address;$('connection-addresses').append(a);}
    $<HTMLInputElement>('access-code').value=connection.code;$<HTMLDialogElement>('connect-dialog').showModal();
  };
  $('close-connect').onclick=()=>$<HTMLDialogElement>('connect-dialog').close();
  window.addEventListener('online',()=>void connect());window.addEventListener('offline',()=>{$('connection').textContent='Offline · draft retained';});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && !busy)void connect();});
  window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();}});
  renderList();renderEditor();await renderImages();renderSummary();if(receipt)showReceipt(receipt);await connect();await loadDraftHistory();
}
void start().catch(e=>notice(`Could not open the review: ${(e as Error).message}. Reload this page to try again.`,true));
