// The loft as a page you drive. TEARDOWN takes every part out in order, REASSEMBLE puts every part back on its
// recorded pose, REARRANGE asks Claude for new layouts and new furniture and lets you drag pieces yourself.
// Left alone, the page tours itself (teardown, trays, reassembly) with a pointer; a click, drag, wheel or key hands
// control over and 25 s of quiet hands it back. One input, u, poses every part in the first two modes.
import * as THREE from 'three';
import {warmUp} from 'teardown-kit/warm.js';
import {checkLayout, findSpace, fitsAt, normDeg} from '../shared/layout-check.js';
import {createCatalogPanel} from './catalog-panel.js';
import {createArrange} from './arrange.js';
import {buildCatalogPiece, buildFurniture, CATALOG, thumbnail} from './catalog.js';
import {threeD} from '../shared/catalog-index.js';
import {createChoreo, stageAt} from './choreo.js';
import {C, createConsole, DISPLAY, esc, VIEWS} from './console.js';
import {exportScene, loadModel, ROOMS, UPPER_Y} from './model.js';
import {createStage} from './stage.js';

// the design frame: 1600 x 900 on a 16:9 window, wider on a wider one and taller (to 5:4) on a narrower one, so the
// side columns sit at the window's edges and the 3D view fills the rest; fit() sets it, everything else reads it
let W = 1600;
let H = 900;
const IDLE = 25;
const DUR = 26;
const D2R = Math.PI / 180;
const UPY = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoother = (x) => {
  const u = clamp(x, 0, 1);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const ss = (a, b, t) => smoother((t - a) / (b - a));
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const SPEED = [0.25, 3];

// camera views, degrees and metres; u = seconds since the view was picked
const VIEW_FN = {
  hero: (t) => ({tx: 0, ty: 0.8, tz: 0.2, az: 128 + 1.2 * t, el: 34, d: 33, sx: 0, sy: -24}),
  ground: (t) => ({tx: 0, ty: 0.2, tz: 0.2, az: 124 + 0.8 * t, el: 52, d: 30, sx: 0, sy: -18}),
  upper: (t) => ({tx: 0, ty: 2.6, tz: -1.6, az: 136 + 0.8 * t, el: 58, d: 30, sx: 0, sy: -26}),
  plan: () => ({tx: 0, ty: 0, tz: 0, az: 270, el: 89.4, d: 34, sx: 0, sy: -12}),
  // fitted to the laid-out site (trays, piles and the slab), which depends on the layout
  trays: (t) => {
    const s = SITE;
    return {tx: (s.x0 + s.x1) / 2, ty: 0, tz: (s.z0 + s.z1) / 2, az: 190 + 0.4 * t, el: 54, d: Math.max((s.x1 - s.x0) * 1.78, (s.z1 - s.z0) * 1.7), sx: 0, sy: -30};
  },
};
let SITE = {x0: -16, x1: 16, z0: -11, z1: 11};
const blendCam = (a, b, k) => {
  const o = {};
  for (const key in b) o[key] = key === 'az' ? a.az + wrap(b.az - a.az) * k : a[key] + (b[key] - a[key]) * k;
  return o;
};
const AR_CAM = {
  plan: (floor) => (floor === 'upper' ? {tx: -0.2, ty: UPPER_Y, tz: -1.6, az: 270, el: 89.4, d: 26, sx: -56, sy: -10} : {tx: 0, ty: 0, tz: 0, az: 270, el: 89.4, d: 32, sx: -56, sy: -10}),
  '3d': (floor) => (floor === 'upper' ? {tx: -0.2, ty: UPPER_Y, tz: -1.4, az: 122, el: 50, d: 21, sx: -56, sy: -8} : {tx: 0, ty: 0, tz: 0.2, az: 122, el: 50, d: 28, sx: -56, sy: -8}),
};
const TOUR = [
  {t: 0, act: 'reset'},
  {t: 1.4, act: 'play', spot: 'play'},
  {t: 12.5, act: 'view', v: 'trays', spot: 'trays'},
  {t: 30.5, act: 'mode', m: 'reassemble', spot: 'mode:reassemble'},
  {t: 45.5, act: 'view', v: 'hero', spot: 'hero'},
  {t: 59, act: 'end'},
];
const TOUR_DUR = 61;

export async function runLive() {
  const style = document.createElement('style');
  style.textContent = `html,body{background:${'#efe9df'};overflow:hidden}
#app{position:absolute!important;inset:auto!important;left:0;top:0;width:1600px;height:900px;transform-origin:0 0}
#gl{touch-action:none;cursor:grab}
#gl.drag{cursor:grabbing}
#gl.move{cursor:move}`;
  document.head.appendChild(style);
  const app = document.getElementById('app');
  const canvas = document.createElement('canvas');
  canvas.id = 'gl';
  app.appendChild(canvas);
  const st = createStage(canvas);
  const ui = createConsole(app);

  // ------------------------------------------------------------ scale and quality tiers
  const TIERS = [{shadow: 4096, pr: 2}, {shadow: 2048, pr: 1.5}, {shadow: 1024, pr: 1}, {shadow: 0, pr: 0.85}];
  let tier = matchMedia('(pointer: coarse)').matches ? 2 : 0;
  let scale = 1;
  const onResize = []; // later parts (slider drag areas, the tour pointer) re-place themselves here
  const fit = () => {
    const aspect = innerWidth / Math.max(1, innerHeight);
    W = Math.round(Math.max(1600, 900 * aspect));
    H = Math.round(Math.max(900, Math.min(1600 / aspect, 1280)));
    scale = Math.min(innerWidth / W, innerHeight / H);
    app.style.width = `${W}px`;
    app.style.height = `${H}px`;
    app.style.setProperty('--dw', `${W - 1600}px`);
    app.style.setProperty('--dh', `${H - 900}px`);
    app.style.transform = `translate(${(innerWidth - W * scale) / 2}px, ${(innerHeight - H * scale) / 2}px) scale(${scale})`;
    ui.resize(W, H);
    st.resize(W, H, clamp((devicePixelRatio || 1) * scale, 0.75, TIERS[tier].pr));
    for (const f of onResize) f();
  };
  const applyTier = () => {
    st.setQuality(TIERS[tier]);
    fit();
  };
  applyTier();
  addEventListener('resize', fit);
  const toStage = (cx, cy) => {
    const r = app.getBoundingClientRect();
    return [(cx - r.left) / scale, (cy - r.top) / scale];
  };

  // ------------------------------------------------------------ load
  const q = new URLSearchParams(location.search);
  let config = {room: {label: 'Loft'}, claude: {ready: false, model: 'claude-opus-5-5'}};
  let roomJson;
  let corrections = {};
  let catalogItems = [];
  try {
    config = await (await fetch('/api/config')).json();
    roomJson = await (await fetch('/room.json')).json();
    corrections = await (await fetch('/corrections.json')).json().catch(() => ({}));
    catalogItems = await (await fetch('/catalog.json')).json().catch(() => []);
  } catch (e) {
    ui.setLoader(0, 'Open this page from the local server: node apps/home-teardown/server.mjs');
    throw e;
  }
  const phaseText = {download: 'Downloading the model', parse: 'Reading the glTF', group: 'Finding the objects', build: 'Building the parts'};
  const model = await loadModel({
    url: '/model.glb',
    roomJson,
    corrections,
    onStatus: (s) => {
      const base = {download: 0, parse: 0.62, group: 0.7, build: 0.72}[s.phase];
      const span = {download: 0.62, parse: 0.08, group: 0.02, build: 0.24}[s.phase];
      const mb = s.total ? ` · ${(s.got / 1048576).toFixed(0)} / ${(s.total / 1048576).toFixed(0)} MB` : '';
      ui.setLoader(base + span * (s.k || 0), `${phaseText[s.phase]}${s.phase === 'download' ? mb : ''}`);
    },
  });
  st.scene.add(model.root);
  const {groups, byId} = model;
  for (const g of groups) g.localBox = g.box.clone().translate(g.pivot.clone().negate());
  const choreo = createChoreo(model);
  const scene0 = exportScene(model);
  const sidToGid = new Map(groups.filter((g) => g.sid).map((g) => [g.sid, g.id]));
  console.info('[loft] objects', model.stats, 'draw calls', model.drawCalls);
  window.LOFT = {model, choreo, scene0, thumb: (id, cb) => thumbnail(catalogItems.find((c) => c.id === id), null, cb), catalog: () => catalogItems};

  const itemGroups = groups.filter((g) => g.type === 'item');
  // the model revision's date, from its folder name (loft-refinements-2026-11-01 -> "1 NOV ")
  const revisionDate = (id) => {
    const m = /(\d{4})-(\d{2})-(\d{2})$/.exec(id || '');
    return m ? `${Number(m[3])} ${'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ')[Number(m[2]) - 1]} ` : '';
  };
  const movable = (g) => g && (g.isNew || g.cls === 'movable' || g.cls === 'textile');
  const removable = (g) => g && (g.isNew || g.type === 'item');
  ui.setStatic({
    subtitleText: `${(config.room.label || 'LOFT').toUpperCase()} · 2 FLOORS · ${itemGroups.length} OBJECTS · ${model.stats.roots} PARTS`,
    claude: `${config.claude.ready ? `<span style="color:${C.green}">●</span> CLAUDE OPUS 5.5 READY` : `<span style="color:${C.red}">●</span> NO ANTHROPIC_API_KEY`}<br>${model.stats.movable} MOVABLE · ${model.stats.walls} WALLS`,
    footText: `PARTS FROM THE ${revisionDate(config.room.id)}RECONSTRUCTION <span style="color:${C.or}">//////</span>`,
  });
  const roomStats = ui.setRooms(Object.entries(ROOMS).map(([id, r]) => ({id, label: r.label, n: 0, home: 0})));

  // ------------------------------------------------------------ layouts
  const ORIGINAL = {id: 'original', title: 'Original', summary: 'The home as reconstructed.', place: {}, removed: [], added: []};
  let layouts = [ORIGINAL];
  let activeId = 'original';
  const extras = new Map(); // added-piece id -> pseudo group
  let previewL = null; // Claude's draft while it works, never saved
  let previewPrev = null;
  const layoutById = (id) => (id === 'preview' && previewL ? previewL : layouts.find((l) => l.id === id) || ORIGINAL);
  const catalogById = new Map(catalogItems.map((c) => [c.id, c]));
  const specKey = (a) => JSON.stringify([a.catalog_id || '', a.type, a.width, a.depth, a.height, a.color, a.accent, a.material]);
  const extraFor = (a) => {
    let g = extras.get(a.id);
    if (g && g.key === specKey(a)) {
      g.label = a.label;
      return g;
    }
    if (g) st.scene.remove(g.holder);
    // a catalogue piece shows its open model (fitted to the real size) when it has one, else the procedural stand-in
    const item = a.catalog_id ? catalogById.get(a.catalog_id) : null;
    const tag = (grp) => grp.traverse((m) => (m.userData.group = a.id));
    const built = item ? buildCatalogPiece({...item, w: a.width ?? item.w, d: a.depth ?? item.d, h: a.height ?? item.h}, a.color, tag) : buildFurniture({...a});
    const holder = new THREE.Group();
    holder.add(built.group);
    tag(built.group);
    const fy = a.floor === 'upper' ? UPPER_Y : 0;
    const box = new THREE.Box3(new THREE.Vector3(-built.w / 2, 0, -built.d / 2), new THREE.Vector3(built.w / 2, built.h, built.d / 2));
    g = {
      id: a.id, key: specKey(a), type: 'item', isNew: true, label: a.label, kind: built.kind, cls: 'movable', floor: a.floor, floorY: fy, room: model.roomOf(a.floor, a.x, a.z), facing: 0,
      w: built.w, d: built.d, h: built.h, size: box.getSize(new THREE.Vector3()), box: box.clone().translate(new THREE.Vector3(a.x, fy, a.z)), localBox: box,
      center: new THREE.Vector3(a.x, fy + built.h / 2, a.z), pivot: new THREE.Vector3(a.x, fy, a.z), holder, content: built.group, parts: 1,
      rest: {p: new THREE.Vector3(a.x, fy, a.z), q: new THREE.Quaternion()}, slot: {p: new THREE.Vector3(), q: new THREE.Quaternion()}, win: [2, 3], extras: {}, spec: a,
    };
    holder.position.copy(g.pivot);
    st.scene.add(holder);
    extras.set(a.id, g);
    return g;
  };
  let activeExtras = [];
  const all = () => groups.concat(activeExtras);
  const posesFor = (v) => {
    const poses = new Map();
    const put = (g, p, q, floor, removed = false) => {
      poses.set(g.id, {p, q, floor, room: model.roomOf(floor, p.x, p.z), removed});
      for (const rid of g.riders || []) {
        const r = byId.get(rid);
        if (!r) continue;
        const rel = r.pivot.clone().sub(g.pivot).applyQuaternion(q);
        poses.set(rid, {p: p.clone().add(rel), q: q.clone(), floor, room: model.roomOf(floor, p.x, p.z), removed});
      }
    };
    for (const [gid, P] of Object.entries(v.place)) {
      const g = byId.get(gid);
      if (!g) continue;
      const fy = P.floor === 'upper' ? UPPER_Y : 0;
      put(g, new THREE.Vector3(P.x, fy, P.z), new THREE.Quaternion().setFromAxisAngle(UPY, (P.facing - g.facing) * D2R), P.floor);
    }
    for (const gid of v.removed) {
      const g = byId.get(gid);
      if (g) put(g, g.pivot.clone(), new THREE.Quaternion(), g.floor, true);
    }
    for (const a of v.added) {
      const fy = a.floor === 'upper' ? UPPER_Y : 0;
      poses.set(a.id, {p: new THREE.Vector3(a.x, fy, a.z), q: new THREE.Quaternion().setFromAxisAngle(UPY, a.facing * D2R), floor: a.floor, room: model.roomOf(a.floor, a.x, a.z)});
    }
    return poses;
  };
  /** Everything as footprints, for the checker: original movable pieces where this layout puts them, plus new ones. */
  const placedFor = (v) => {
    const out = [];
    for (const g of groups) {
      if (!movable(g) || v.removed.includes(g.id)) continue;
      const P = v.place[g.id];
      out.push({id: g.id, label: g.label, kind: g.kind, floor: P?.floor ?? g.floor, cx: P?.x ?? g.center.x, cz: P?.z ?? g.center.z, w: g.w, d: g.d, h: g.h, facing: P?.facing ?? g.facing, changed: !!P, pieces: g.pieces});
    }
    for (const a of v.added) {
      const T = CATALOG[a.type] || {};
      out.push({id: a.id, label: a.label, kind: T.kind || 'other', floor: a.floor, cx: a.x, cz: a.z, w: a.width || T.w, d: a.depth || T.d, h: a.height || T.h, facing: a.facing, changed: true});
    }
    return out;
  };
  let issueIds = new Set();
  // built-ins the layout removed stop being obstacles
  const sceneFor = (v) => (v.removed.length ? {...scene0, fixed: scene0.fixed.filter((f) => !v.removed.includes(f.id))} : scene0);
  const refreshIssues = (v) => {
    const iss = checkLayout(sceneFor(v), placedFor(v));
    issueIds = new Set(iss.map((i) => i.id));
    return iss;
  };

  // arrange transitions: parts fly from wherever they are drawn to their new rest
  let trans = null;
  const applyLayout = (id, animate = true) => {
    const v = layoutById(id);
    const before = new Map(all().map((g) => [g.id, {p: g.holder.position.clone(), q: g.holder.quaternion.clone()}]));
    activeExtras = v.added.map(extraFor);
    for (const [eid, g] of extras) g.holder.visible = activeExtras.includes(g);
    choreo.setLayout(posesFor(v), activeExtras);
    SITE = choreo.site;
    st.setTrays(choreo.trays, choreo.piles, choreo.padOf());
    if (animate) {
      const items = new Map();
      let n = 0;
      for (const g of all()) {
        const b = before.get(g.id);
        // pieces that were not in the scene before arrive from above; everything else flies from where it was drawn
        const from = b || {p: g.rest.p.clone().add(new THREE.Vector3(0, 5, 0)), q: g.rest.q.clone()};
        if (from.p.distanceTo(g.rest.p) < 1e-3 && from.q.angleTo(g.rest.q) < 1e-3) continue;
        items.set(g, {p: from.p, q: from.q, delay: Math.min(0.9, n++ * 0.05), arc: 0.6 + Math.min(2.5, from.p.distanceTo(g.rest.p) * 0.18)});
      }
      trans = items.size ? {t0: T, items} : null;
    }
    refreshIssues(v);
  };
  const shownLayout = () => (comparing ? ORIGINAL : layoutById(activeId));

  // ------------------------------------------------------------ state
  let T = 0;
  let mode = 'teardown';
  let u = 0;
  let tau = 0;
  let paused = true;
  let speed = 1;
  let seekTo = null; // fast-forward u before a mode starts
  let view = 'hero';
  let viewAt0 = 0;
  const disp = {labels: 1, ceilings: 0, cutaway: 1, orbit: 0, orbitT: 0};
  const off = {az: 0, el: 0, k: 1, px: 0, pz: 0};
  const cam = {...VIEW_FN.hero(0)};
  let selected = null;
  let arFloor = 'ground';
  let arView = 'plan';
  let comparing = false;
  let effort = 'medium';
  let lastInput = -99;
  let camOverride = null; // review hook: LIVE.set({camera: {...}})

  const setMode = (m) => {
    if (m === mode && !(m === 'teardown' && u >= 0.999)) return;
    mode = m;
    Object.assign(off, {az: 0, el: 0, k: 1, px: 0, pz: 0});
    if (m === 'teardown') {
      if (u >= 0.999) u = 0;
      tau = u * DUR;
      paused = false;
      seekTo = null;
    } else if (m === 'reassemble') {
      if (u < 0.999) seekTo = {u: 1, rate: 0.45, then: () => ((tau = 0), (paused = false))};
      else (tau = 0), (paused = false);
    } else {
      if (comparing) comparing = false;
      if (u > 0.001) seekTo = {u: 0, rate: 0.6, then: () => {}};
      paused = true;
      applyLayout(activeId, false);
    }
    if (m !== 'rearrange') {
      view = m === 'reassemble' && u > 0.5 ? 'trays' : 'hero';
      viewAt0 = T;
    }
  };

  // ------------------------------------------------------------ framing on wider frames
  // The views were tuned on 1600 x 900. On a wider (or taller) frame the camera comes closer, until the subject fills
  // the clear area between the panels as it did there: the house, or the laid-out site as the hero view pulls back to it.
  let houseBox = null;
  const siteBox = new THREE.Box3();
  const subject = new THREE.Box3();
  const wideZoom = (tgt) => {
    if (!houseBox) {
      houseBox = new THREE.Box3();
      for (const g of groups) if (g.type !== 'item') houseBox.union(g.box);
    }
    const arr = mode === 'rearrange';
    const kb = arr ? 0 : view === 'trays' ? 1 : view === 'hero' ? ss(0.08, 0.5, u) : 0;
    siteBox.set(new THREE.Vector3(SITE.x0, 0, SITE.z0), new THREE.Vector3(SITE.x1, 3, SITE.z1));
    subject.min.lerpVectors(houseBox.min, siteBox.min, kb);
    subject.max.lerpVectors(houseBox.max, siteBox.max, kb);
    const rad = {...tgt, az: tgt.az * D2R, el: tgt.el * D2R};
    const area = (w, h, l) => ({l, r: w - (arr ? 442 : 330), t: 120, b: h - 140});
    const ref = st.fitIn({...rad, sx: arr ? -56 : rad.sx}, subject, 1600, 900, area(1600, 900, 330));
    // closer on a wider frame; further back when the open catalogue leaves less room than the frame was tuned for
    return ref > 0 ? clamp(st.fitIn(rad, subject, W, H, area(W, H, arr ? ui.leftEdge() : 330)) / ref, 0.55, 2.5) : 1;
  };

  // ------------------------------------------------------------ the tour
  const AP = {on: false, t0: 0, last: -1, loop: 0};
  const stagePos = (n) => {
    let x = 0;
    let y = 0;
    for (let e = n; e && e !== app; e = e.offsetParent) {
      x += e.offsetLeft;
      y += e.offsetTop;
    }
    return [x + n.offsetWidth / 2, y + n.offsetHeight / 2];
  };
  const spotOf = (k) => (k.startsWith('mode:') ? stagePos(ui.modeBtn[k.slice(5)]) : stagePos(ui.btn[k]));
  let cursorAt = () => ({x: -99, y: -99, press: false, ring: 0, ringX: 0, ringY: 0});
  const buildCursor = () => {
    const EV = TOUR.filter((e) => e.spot).map((e) => ({t: e.t, spot: spotOf(e.spot)}));
    const mx = (W - 1600) / 2;
    const my = (H - 900) / 2;
    const REST = [[860, 470], [760, 420], [940, 520], [820, 380]].map(([x, y]) => [x + mx, y + my]);
    const WP = [[0, 900 + mx, 600 + my]];
    EV.forEach((e, i) => {
      WP.push([e.t - 0.6, ...e.spot], [e.t + 0.25, ...e.spot], [e.t + 1.6, ...REST[i % REST.length]]);
    });
    WP.push([TOUR_DUR, 900 + mx, 600 + my]);
    WP.sort((a, b) => a[0] - b[0]);
    cursorAt = (t) => {
      let i = 0;
      while (i < WP.length - 2 && t > WP[i + 1][0]) i++;
      const [t0, x0, y0] = WP[i];
      const [t1, x1, y1] = WP[i + 1];
      const k = ss(t0, t1, t);
      let press = false;
      let ring = 0;
      let rx = 0;
      let ry = 0;
      for (const e of EV) {
        if (t >= e.t - 0.07 && t < e.t + 0.09) press = true;
        if (t >= e.t && t < e.t + 0.55) {
          ring = 1 - (t - e.t) / 0.55;
          [rx, ry] = e.spot;
        }
      }
      return {x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, press, ring, ringX: rx, ringY: ry};
    };
  };
  const startTour = () => {
    if (mode === 'rearrange') return;
    AP.on = true;
    AP.t0 = T;
    AP.last = -1;
    buildCursor();
  };
  onResize.push(() => AP.on && buildCursor());
  const takeOver = () => {
    lastInput = T;
    AP.on = false;
  };
  const runTour = () => {
    const c = (T - AP.t0) % TOUR_DUR;
    if (c < AP.last) AP.last = -1;
    for (const e of TOUR) {
      if (e.t <= AP.last || e.t > c) continue;
      if (e.act === 'reset') {
        mode = 'teardown';
        seekTo = u > 0.001 ? {u: 0, rate: 1.2, then: () => {}} : null;
        tau = 0;
        paused = true;
        view = 'hero';
        viewAt0 = T;
        Object.assign(off, {az: 0, el: 0, k: 1, px: 0, pz: 0});
      } else if (e.act === 'play') {
        seekTo = null;
        u = 0;
        tau = 0;
        paused = false;
      } else if (e.act === 'view') {
        view = e.v;
        viewAt0 = T;
      } else if (e.act === 'mode') setMode(e.m);
    }
    AP.last = c;
    return cursorAt(c);
  };
  ui.tourChip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    lastInput = T;
    if (AP.on) takeOver();
    else startTour();
  });

  // ------------------------------------------------------------ controls
  for (const m of ['teardown', 'reassemble', 'rearrange'])
    ui.modeBtn[m].addEventListener('click', () => {
      takeOver();
      setMode(m);
    });
  for (const v of VIEWS)
    ui.btn[v].addEventListener('click', () => {
      takeOver();
      view = v;
      viewAt0 = T;
      Object.assign(off, {az: 0, el: 0, k: 1, px: 0, pz: 0});
    });
  for (const k of DISPLAY)
    ui.btn[k].addEventListener('click', () => {
      takeOver();
      disp[k] = disp[k] ? 0 : 1;
      if (k === 'orbit') disp.orbitT = T;
    });
  ui.btn.play.addEventListener('click', () => {
    takeOver();
    if (tau >= DUR - 1e-3) tau = 0;
    paused = !paused;
  });
  const slider = (geo, apply) => {
    const d = document.createElement('div');
    d.className = 'hit';
    const place = () => Object.assign(d.style, {left: `${geo.x - 8}px`, top: `${geo.y - 11 + H - 900}px`, width: `${geo.w + 16}px`, height: '22px'});
    place();
    onResize.push(place);
    const move = (e) => {
      const [x] = toStage(e.clientX, e.clientY);
      apply(clamp((x - geo.x) / geo.w, 0, 1));
      lastInput = T;
    };
    d.addEventListener('pointerdown', (e) => {
      takeOver();
      e.stopPropagation();
      d.setPointerCapture(e.pointerId);
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      move(e);
    });
    ui.root.appendChild(d);
    return d;
  };
  const tlHit = slider(ui.TL, (k) => {
    seekTo = null;
    tau = k * DUR;
    paused = true;
  });
  const spHit = slider(ui.SP, (k) => (speed = SPEED[0] + k * (SPEED[1] - SPEED[0])));

  // rearrange controls
  ui.btn.floorGround.addEventListener('click', () => ((arFloor = 'ground'), Object.assign(off, {az: 0, el: 0, k: 1, px: 0, pz: 0})));
  ui.btn.floorUpper.addEventListener('click', () => ((arFloor = 'upper'), Object.assign(off, {az: 0, el: 0, k: 1, px: 0, pz: 0})));
  ui.btn.viewPlan.addEventListener('click', () => ((arView = 'plan'), Object.assign(off, {az: 0, el: 0, k: 1, px: 0, pz: 0})));
  ui.btn.view3d.addEventListener('click', () => ((arView = '3d'), Object.assign(off, {az: 0, el: 0, k: 1, px: 0, pz: 0})));
  const startCompare = () => {
    if (activeId === 'original' || comparing) return;
    comparing = true;
    applyLayout('original');
  };
  const endCompare = () => {
    if (!comparing) return;
    comparing = false;
    applyLayout(activeId);
  };
  ui.btn.compare.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    startCompare();
  });
  addEventListener('pointerup', endCompare);

  // editing the active layout by hand
  const editable = () => {
    if (activeId === 'original') {
      const v = {id: `l${Date.now().toString(36)}`, title: 'Manual edits', summary: 'Pieces moved by hand.', request: '', baseId: 'original', place: {}, removed: [], added: [], createdAt: Date.now(), manual: true};
      layouts.push(v);
      activeId = v.id;
      arrange.renderLayouts();
    }
    return layoutById(activeId);
  };
  const placementOf = (v, g) => {
    if (g.isNew) return v.added.find((a) => a.id === g.id);
    return v.place[g.id] || {x: g.center.x, z: g.center.z, facing: g.facing, floor: g.floor};
  };
  const setPlacement = (v, g, P) => {
    if (g.isNew) Object.assign(v.added.find((a) => a.id === g.id), P);
    else v.place[g.id] = {x: P.x, z: P.z, facing: P.facing, floor: P.floor};
  };
  const rotateSel = () => {
    if (!movable(selected) || mode !== 'rearrange') return;
    const v = editable();
    const P = {...placementOf(v, selected)};
    P.facing = normDeg((P.facing ?? 0) + 90);
    setPlacement(v, selected, P);
    applyLayout(activeId);
    arrange.save();
  };
  const storeSel = () => {
    if (!removable(selected) || mode !== 'rearrange') return;
    const v = editable();
    if (selected.isNew) v.added = v.added.filter((a) => a.id !== selected.id);
    else if (!v.removed.includes(selected.id)) {
      v.removed.push(selected.id);
      delete v.place[selected.id];
    }
    ui.toast(`${selected.label} removed (it waits on its tray; delete the layout or reset to bring it back)`);
    selected = null;
    applyLayout(activeId);
    arrange.save();
  };
  const resetSel = () => {
    if (!movable(selected) || mode !== 'rearrange' || selected.isNew) return;
    const v = editable();
    delete v.place[selected.id];
    applyLayout(activeId);
    arrange.save();
  };
  // ------------------------------------------------------------ the catalogue: add, swap
  const nextAddId = (v) => `n${1 + Math.max(0, ...v.added.map((a) => Number(a.id.slice(1)) || 0))}`;
  const pieceFrom = (item, color, at) => ({
    id: at.id, catalog_id: item.id, type: item.build, label: item.generic ? item.name : `${item.brand} ${item.name}`, x: at.x, z: at.z, facing: at.facing, floor: at.floor,
    width: item.w, depth: item.d, height: item.h, color: color || item.colors[0]?.hex, accent: item.accent, material: item.material,
  });
  const addFromCatalog = (item, color) => {
    if (mode !== 'rearrange') setMode('rearrange');
    const v = editable();
    const near = [cam.tx, cam.tz];
    const sc = sceneFor(v);
    const others = placedFor(v);
    const q = {floor: arFloor, width: item.w, depth: item.d, height: item.h, kind: item.kind, near, count: 1};
    // a free spot in the room on screen; if the room is full the piece lands where you are looking, marked in red
    const spot = findSpace(sc, others, {...q, room: model.roomOf(arFloor, near[0], near[1])}).candidates?.[0];
    const id = nextAddId(v);
    v.added.push(pieceFrom(item, color, {id, x: spot?.x ?? near[0], z: spot?.z ?? near[1], facing: spot?.facing ?? 0, floor: arFloor}));
    applyLayout(activeId);
    selected = extras.get(id) || null;
    arrange.save();
    ui.toast(spot ? `${item.name} added: drag it to adjust` : `${item.name} added: this room has no free ${Math.round(item.w * 100)} × ${Math.round(item.d * 100)} cm spot, so move or remove something (it shows in red)`);
    autoMake(item);
  };
  const swapSelected = (item, color) => {
    const g = selected;
    if (!removable(g) || mode !== 'rearrange') return;
    const v = editable();
    const P = placementOf(v, g);
    const at = {x: P.x, z: P.z, facing: P.facing ?? g.facing ?? 0, floor: P.floor ?? g.floor};
    if (g.isNew) v.added = v.added.filter((a) => a.id !== g.id);
    else if (!v.removed.includes(g.id)) {
      v.removed.push(g.id);
      delete v.place[g.id];
    }
    // same spot and facing; if the new piece does not fit there, the nearest spot within 1.5 m that does
    const sc = sceneFor(v);
    const others = placedFor(v);
    if (!fitsAt(sc, others, {id: '__new__', kind: item.kind, floor: at.floor, cx: at.x, cz: at.z, w: item.w, d: item.d, h: item.h, facing: at.facing})) {
      const c = findSpace(sc, others, {floor: at.floor, width: item.w, depth: item.d, height: item.h, kind: item.kind, near: [at.x, at.z], facing: at.facing, count: 1}).candidates?.[0];
      if (c && Math.hypot(c.x - at.x, c.z - at.z) < 1.5) Object.assign(at, {x: c.x, z: c.z});
    }
    const id = nextAddId(v);
    v.added.push(pieceFrom(item, color, {id, ...at}));
    catalogPanel.stopSwap();
    applyLayout(activeId);
    selected = extras.get(id) || null;
    arrange.save();
    ui.toast(`${g.label} swapped for ${item.name}`);
    autoMake(item);
  };
  // MAKE 3D: Claude builds a model from the product photo and listed size; every placed copy then shows it
  const makeModel = async (item) => {
    if (!config.claude.ready) return ui.toast('Making 3D models needs the ANTHROPIC_API_KEY on the server');
    ui.toast(`Making a 3D model of ${item.name} (about 40 s)…`);
    try {
      const r = await fetch('/api/model3d', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: item.id})});
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      item.gen = true;
      item.genAt = Date.now();
      for (const [id, g] of extras) if (g.spec?.catalog_id === item.id) (st.scene.remove(g.holder), extras.delete(id));
      if (mode === 'rearrange') applyLayout(activeId, false);
      ui.toast(`${item.name}: 3D model ready${j.usd ? ` ($${j.usd.toFixed(2)})` : ''}`);
    } catch (e) {
      ui.toast(`Could not make a 3D model of ${item.name}: ${e.message}`);
    }
  };
  const catalogPanel = createCatalogPanel({ui, items: catalogItems, thumbnail, onAdd: addFromCatalog, onSwap: swapSelected, onMake: makeModel});
  // a piece with no model of its own gets one as soon as it is placed
  const autoMake = (item) => item && !item.generic && threeD(item) === 'none' && config.claude.ready && catalogPanel.make(item);
  ui.btn.swap.addEventListener('click', () => {
    if (!removable(selected) || mode !== 'rearrange') return;
    const k = selected.kind;
    catalogPanel.startSwap(selected.label, catalogItems.filter((c) => c.kind === k).length >= 3 ? k : '');
  });
  ui.btn.rotate.addEventListener('click', rotateSel);
  ui.btn.store.addEventListener('click', storeSel);
  ui.btn.resetEdits.addEventListener('click', resetSel);

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    takeOver();
    const key = e.key.toLowerCase();
    const v = {1: 'hero', 2: 'ground', 3: 'upper', 4: 'plan', 5: 'trays'}[key];
    if (v && mode !== 'rearrange') ui.btn[v].click();
    else if (key === ' ' && mode !== 'rearrange') ui.btn.play.click();
    else if (key === 'r' && mode === 'rearrange') rotateSel();
    else if ((key === 'delete' || key === 'backspace') && mode === 'rearrange') storeSel();
    else if (key === 'c' && mode === 'rearrange') startCompare();
    else if (key === 'escape') selected = null;
    else return;
    e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'c') endCompare();
  });

  // ------------------------------------------------------------ picking, orbit, drag
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const setRay = (e) => {
    const [x, y] = toStage(e.clientX, e.clientY);
    ndc.set((x / W) * 2 - 1, -(y / H) * 2 + 1);
    ray.setFromCamera(ndc, st.camera);
  };
  const pick = (e) => {
    setRay(e);
    const targets = [model.root, ...activeExtras.map((g) => g.holder)];
    const hits = ray.intersectObjects(targets, true);
    for (const h of hits) {
      if (!h.object.visible) continue;
      let o = h.object;
      let vis = true;
      for (let p = o; p; p = p.parent) if (!p.visible) vis = false;
      if (!vis) continue;
      const id = o.userData.group;
      const g = byId.get(id) || extras.get(id);
      if (g) return {g, point: h.point};
    }
    return null;
  };
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    takeOver();
    canvas.setPointerCapture(e.pointerId);
    drag = {x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false, obj: null};
    if (mode === 'rearrange' && u < 0.001 && e.button === 0) {
      const hit = pick(e);
      if (hit && movable(hit.g) && !comparing) {
        const g = hit.g;
        const v = layoutById(activeId);
        const P = placementOf(v, g);
        const fy = (P.floor ?? g.floor) === 'upper' ? UPPER_Y : 0;
        drag.obj = {g, plane: new THREE.Plane(UPY, -fy), dx: P.x - hit.point.x, dz: P.z - hit.point.z, P: {...P, floor: P.floor ?? g.floor}};
        selected = g;
        canvas.classList.add('move');
        return;
      }
    }
    canvas.classList.add('drag');
  });
  const hitPoint = new THREE.Vector3();
  let lastCheck = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4) drag.moved = true;
    if (drag.obj) {
      if (!drag.moved) return;
      setRay(e);
      if (!ray.ray.intersectPlane(drag.obj.plane, hitPoint)) return;
      const v = drag.obj.v || (drag.obj.v = editable());
      const P = {...drag.obj.P, x: Math.round((hitPoint.x + drag.obj.dx) * 100) / 100, z: Math.round((hitPoint.z + drag.obj.dz) * 100) / 100};
      setPlacement(v, drag.obj.g, P);
      choreo.setLayout(posesFor(v), activeExtras);
      trans = null;
      if (T - lastCheck > 0.08) {
        refreshIssues(v);
        lastCheck = T;
      }
      return;
    }
    const dx = (e.clientX - drag.x) / scale;
    const dy = (e.clientY - drag.y) / scale;
    const planLike = (mode === 'rearrange' && arView === 'plan') || (mode !== 'rearrange' && view === 'plan');
    if (planLike) {
      const d = (mode === 'rearrange' ? AR_CAM.plan(arFloor).d : VIEW_FN.plan().d) * off.k;
      const k = d * 0.0012;
      off.pz -= dx * k;
      off.px += dy * k;
    } else {
      off.az -= dx * 0.3;
      off.el = clamp(off.el + dy * 0.2, -30, 50);
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    lastInput = T;
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove('drag', 'move');
    if (d.obj) {
      if (d.moved) {
        applyLayout(activeId, false);
        arrange.save();
      }
      return;
    }
    if (!d.moved && e) {
      const hit = pick(e);
      selected = hit ? hit.g : null;
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => endDrag(null));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      takeOver();
      off.k = clamp(off.k * Math.exp(e.deltaY * 0.0012), 0.25, 2.6);
    },
    {passive: false},
  );

  // ------------------------------------------------------------ Claude
  const arrange = createArrange({
    ui, config, scene0, sidToGid, byId, ORIGINAL, threeD, make3d: (it) => catalogPanel.make(it),
    getLayouts: () => layouts,
    setLayouts: (l) => (layouts = l),
    getActive: () => activeId,
    setActive: (id) => {
      activeId = id;
      selected = null;
      if (mode === 'rearrange') applyLayout(id);
    },
    getEffort: () => effort,
    checkVariant: (v) => checkLayout(sceneFor(v), placedFor(v)),
    catalogById,
    rooms: ROOMS,
    preview: (v, keep = false) => {
      if (v) {
        if (activeId !== 'preview') previewPrev = activeId;
        previewL = v;
        activeId = 'preview';
        if (mode === 'rearrange') applyLayout('preview');
      } else {
        previewL = null;
        if (activeId === 'preview') activeId = previewPrev || 'original';
        if (!keep && mode === 'rearrange') applyLayout(activeId);
      }
    },
  });
  for (const k of Object.keys(ui.effortBtn)) ui.effortBtn[k].addEventListener('click', () => (effort = k));
  await arrange.load();
  if (q.get('layout') && layouts.some((l) => l.id === q.get('layout'))) activeId = q.get('layout');
  applyLayout(activeId, false);

  // ------------------------------------------------------------ labels
  const roomCentres = Object.entries(ROOMS).map(([id, r]) => {
    if (r.floor === 'upper') {
      const f = model.upperFloors.find((x) => x.id === id);
      if (!f) return null;
      const cx = f.polygon.reduce((s, p) => s + p[0], 0) / f.polygon.length;
      const cz = f.polygon.reduce((s, p) => s + p[1], 0) / f.polygon.length;
      return {id, label: r.label, floor: 'upper', p: [cx, UPPER_Y + 0.05, cz]};
    }
    const rects = scene0.zones.ground.filter((z) => z.room === id).map((z) => z.rect);
    if (!rects.length) return null;
    const [x0, z0, x1, z1] = rects[0];
    return {id, label: r.label, floor: 'ground', p: [(x0 + x1) / 2, 0.05, (z0 + z1) / 2]};
  }).filter(Boolean);

  const P = new THREE.Vector3();
  const Q = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();

  // ------------------------------------------------------------ the frame
  const perf = {n: 0, sum: 0, slow: 0, age: 0};
  let last = performance.now();
  let first = true;
  const frame = (now) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    T += dt;
    if (tier < TIERS.length - 1) {
      perf.age += dt;
      if (perf.age > 1.5) {
        perf.sum += dt;
        perf.n++;
        if (perf.sum >= 0.6 && perf.n >= 8) {
          perf.slow = perf.sum / perf.n > 0.034 ? perf.slow + 1 : 0;
          perf.sum = 0;
          perf.n = 0;
          if (perf.slow >= 2) {
            tier++;
            applyTier();
            Object.assign(perf, {age: 0, slow: 0});
            console.info('[loft] quality tier', tier);
          }
        }
      }
    }

    let cursor = {x: -99, y: -99, press: false, ring: 0, ringX: 0, ringY: 0};
    if (AP.on) cursor = runTour();
    else if (mode !== 'rearrange' && T - lastInput > IDLE) startTour();

    // u: fast-forwards, playback, scrub
    if (seekTo) {
      const dir = Math.sign(seekTo.u - u);
      u = clamp(u + dir * seekTo.rate * dt, Math.min(u, seekTo.u), Math.max(u, seekTo.u));
      if (Math.abs(u - seekTo.u) < 1e-6) {
        const then = seekTo.then;
        seekTo = null;
        then();
      }
    } else if (mode !== 'rearrange') {
      if (!paused) {
        tau = Math.min(DUR, tau + dt * speed);
        if (tau >= DUR) paused = true;
      }
      u = mode === 'reassemble' ? 1 - tau / DUR : tau / DUR;
    }

    // poses
    const T0 = trans?.t0 ?? 0;
    let transLive = false;
    let flying = 0;
    let out = 0;
    let home = 0;
    let total = 0;
    let maxErr = 0;
    const fly = [];
    for (const r of roomStats) (r.n = 0), (r.home = 0);
    const live = all();
    for (const g of live) {
      let s = choreo.poseAt(g, u, P, Q);
      const tr = trans?.items.get(g);
      if (tr && u < 0.001) {
        const k = smoother((T - T0 - tr.delay) / 1.3);
        if (k < 1) {
          transLive = true;
          tmpV.lerpVectors(tr.p, P, k);
          tmpV.y += tr.arc * Math.sin(Math.PI * k);
          P.copy(tmpV);
          Q.slerpQuaternions(tr.q, Q, k);
          if (k > 0 && k < 1) s = 0.5;
        }
      }
      g.holder.position.copy(P);
      g.holder.quaternion.copy(Q);
      g.s = s;
      if (g.type === 'item' && !g.removed) {
        total++;
        if (s === 0) home++;
        else if (s === 1) out++;
        const r = roomStats.find((x) => x.id === (g.restRoom || g.room));
        if (r) {
          r.n++;
          if (s === 0) r.home++;
        }
      }
      if (s > 0 && s < 1) {
        flying++;
        fly.push(g);
      }
    }
    if (trans && !transLive) trans = null;
    model.root.updateMatrixWorld();
    for (const g of activeExtras) g.holder.updateMatrixWorld();
    // residual between where each part is drawn and where the scan put it (original layout, parts at home)
    if (activeId === 'original' || mode !== 'rearrange') {
      for (const g of groups) {
        if (g.s !== 0 || g.type !== 'item' || g.removed || layoutById(activeId).place[g.id]) continue;
        tmpV.copy(g.center).sub(g.pivot).applyMatrix4(g.holder.matrixWorld);
        maxErr = Math.max(maxErr, tmpV.distanceTo(g.center));
      }
    }
    fly.sort((a, b) => b.size.x * b.size.y * b.size.z - a.size.x * a.size.y * a.size.z);
    st.setFlying(fly.slice(0, 96).map((g) => ({box: g.localBox, matrix: g.holder.matrixWorld})));

    // camera
    let tgt;
    let floorFilter = null;
    let cut = null;
    if (mode === 'rearrange') {
      tgt = {...AR_CAM[arView](arFloor)};
      // centred in the clear view between the left panel (wider while the catalogue is open) and the Claude panel
      tgt.sx = (ui.leftEdge() + W - 442) / 2 - W / 2;
      floorFilter = arFloor === 'ground' ? 'ground' : null;
      if (u < 0.001) cut = arFloor === 'upper' ? UPPER_Y + (arView === 'plan' ? 1.4 : 1.9) : arView === '3d' ? 2.0 : 1.4;
    } else {
      const since = T - viewAt0;
      tgt = VIEW_FN[view](since);
      // the hero view pulls back as the parts leave, so the whole site stays in frame
      if (view === 'hero') {
        const kb = ss(0.08, 0.5, u);
        if (kb > 0) tgt = blendCam(tgt, VIEW_FN.trays(since), kb);
      }
      if (view === 'ground') floorFilter = 'ground';
      if (u < 0.001 && view === 'upper') cut = UPPER_Y + 1.9;
      if (u < 0.001 && view === 'ground') cut = 2.6;
      if (disp.orbit) tgt.az += 10 * (T - disp.orbitT);
    }
    if (camOverride) tgt = {sx: 0, sy: 0, ...camOverride};
    else tgt.d /= wideZoom(tgt);
    tgt.az += off.az;
    tgt.el = clamp(tgt.el + off.el, 8, 89.4);
    tgt.d *= off.k;
    tgt.tx += off.px;
    tgt.tz += off.pz;
    const k = first ? 1 : 1 - Math.exp(-dt / (AP.on ? 0.5 : 0.28));
    cam.az += wrap(tgt.az - cam.az) * k;
    for (const key of ['tx', 'ty', 'tz', 'el', 'd', 'sx', 'sy']) cam[key] += (tgt[key] - cam[key]) * k;
    model.section[0].constant = cut ?? 1e4;
    const camRad = {...cam, az: cam.az * D2R, el: cam.el * D2R};
    st.place(camRad);

    // visibility: roof off by default, outer walls facing the camera cut away, one floor at a time where asked
    const camPos = st.camera.position;
    for (const g of live) {
      let vis = true;
      if (g.s === 0) {
        if (g.type === 'ceiling' && !disp.ceilings) vis = false;
        if (g.type === 'wall' && g.exterior && disp.cutaway && cam.el < 80) {
          const dx = camPos.x - g.center.x;
          const dz = camPos.z - g.center.z;
          if (g.normal.x * dx + g.normal.z * dz > 0.5) vis = false;
        }
        if (floorFilter === 'ground' && (g.restFloor === 'upper' || (g.type !== 'item' && g.floor === 'upper'))) vis = false;
        // with a section cut, fixtures entirely above it (ceiling fans, light tracks) would float: leave them out
        if (cut !== null && g.type === 'item' && g.rest.p.y + g.localBox.min.y > cut) vis = false;
      }
      if (floorFilter === 'ground' && trans?.items.has(g) && g.restFloor === 'upper') vis = false;
      if (g.removed && u < 0.38 && !(trans?.items.has(g))) vis = false;
      g.holder.visible = vis;
    }
    st.setTrayOpacity(ss(0.36, 0.5, u));
    // selection and footprints
    if (selected && selected.holder.visible) st.setSelection(selected.localBox, selected.holder.matrixWorld);
    else st.setSelection(null);
    if (mode === 'rearrange' && u < 0.001) {
      const v = shownLayout();
      const fps = placedFor(v).filter((f) => f.floor === arFloor).map((f) => ({...f, y: f.floor === 'upper' ? UPPER_Y : 0, state: issueIds.has(f.id) && !comparing ? 'issue' : f.changed ? 'changed' : 'base'}));
      st.setFootprints(fps);
    } else st.setFootprints([]);
    st.frame(camRad);

    // labels
    const callouts = [];
    const trayLabels = [];
    if (disp.labels) {
      if (mode !== 'rearrange') {
        const pts = [];
        for (const g of fly) {
          if (g.type !== 'item' || g.s < 0.06 || g.s > 0.94) continue;
          const at = st.project(g.holder.position.x, g.holder.position.y + g.h * 0.6, g.holder.position.z);
          if (!at || at[0] < 330 || at[0] > W - 330 || at[1] < 120 || at[1] > H - 140) continue;
          pts.push({g, at, o: Math.min(1, (g.s - 0.06) * 8, (0.94 - g.s) * 8)});
          if (pts.length >= 4) break;
        }
        const L = pts.filter((x) => x.at[0] < W / 2).sort((a, b) => a.at[1] - b.at[1]);
        const R = pts.filter((x) => x.at[0] >= W / 2).sort((a, b) => a.at[1] - b.at[1]);
        const stack = (col, x) => {
          let y = 140;
          for (const c of col) {
            y = Math.max(y, Math.min(H - 180, c.at[1] - 12));
            const g = c.g;
            callouts.push({name: g.label.toUpperCase().replace(/ · .*/, '').slice(0, 30), sub: `${(ROOMS[g.restRoom || g.room]?.label || '').toUpperCase()} · ${g.size.x.toFixed(2)}×${g.size.z.toFixed(2)}×${g.size.y.toFixed(2)} M`, at: c.at, label: [x, y], w: 190, o: c.o});
            y += 36;
          }
        };
        stack(L, 340);
        stack(R, W - 540);
        const kT = ss(0.42, 0.55, u);
        if (kT > 0.01) {
          for (const t of choreo.trays) {
            const at = st.project(t.x + 0.1, 0, t.z + 0.05);
            if (at && at[0] > 320 && at[0] < W - 320 && at[1] > 120 && at[1] < H - 130) trayLabels.push({at, label: t.label, n: t.n, o: kT});
          }
          choreo.piles.forEach((p) => {
            const at = st.project(p.x - p.w / 2, p.h + 0.1, p.z - p.d / 2);
            if (at && at[0] > 320 && at[0] < W - 320 && at[1] > 120 && at[1] < H - 130) trayLabels.push({at, label: p.label, n: '', o: kT});
          });
          const pad = choreo.padOf();
          if (pad) {
            const at = st.project(pad.x - pad.w / 2, 0.2, pad.z - pad.d / 2);
            if (at && at[0] > 320 && at[0] < W - 320) trayLabels.push({at, label: 'UPPER FLOOR SLAB', n: '', o: ss(0.9, 0.97, u)});
          }
        }
        const kR = 1 - ss(0.0, 0.06, u);
        if (kR > 0.01 && !(trans)) {
          for (const r of roomCentres) {
            if (r.floor === 'upper' ? view !== 'upper' : view === 'upper') continue;
            const at = st.project(...r.p);
            if (at && at[0] > 330 && at[0] < W - 330 && at[1] > 130 && at[1] < H - 140) trayLabels.push({at: [at[0] - 30, at[1]], label: r.label, n: '', o: kR * 0.9});
          }
        }
      } else if (u < 0.001) {
        const v = shownLayout();
        for (const f of placedFor(v)) {
          if (!f.changed || f.floor !== arFloor) continue;
          const at = st.project(f.cx, (f.floor === 'upper' ? UPPER_Y : 0) + f.h + 0.05, f.cz);
          if (at && at[0] > ui.leftEdge() - 10 && at[0] < W - 430 && at[1] > 120 && at[1] < H - 130) trayLabels.push({at: [at[0] - 20, at[1]], label: f.label, n: '', o: 0.95});
          if (trayLabels.length > 16) break;
        }
      }
    }

    // labels never sit on each other: each one steps down until it is clear, or is dropped
    {
      const placed = [];
      const kept = [];
      for (const t of trayLabels.sort((a, b) => a.at[1] - b.at[1])) {
        const w = 14 + 6.6 * (t.label.length + String(t.n).length + 1);
        let [x, y] = t.at;
        let ok = false;
        for (let k = 0; k < 6 && !ok; k++, y += 15) ok = !placed.some((r) => x < r.x + r.w && x + w > r.x && y - 15 < r.y && y > r.y - 15) && !callouts.some((c) => x < c.label[0] + c.w && x + w > c.label[0] && y - 15 < c.label[1] + 20 && y > c.label[1] - 4);
        if (!ok || x + w > W - (mode === 'rearrange' ? 432 : 320) || x < (mode === 'rearrange' ? ui.leftEdge() - 12 : 318)) continue;
        placed.push({x, y, w});
        kept.push({...t, at: [x, y]});
      }
      trayLabels.length = 0;
      trayLabels.push(...kept);
    }

    // the console
    const stage = stageAt(u);
    const phase = seekTo ? (seekTo.u > u ? 'TAKING IT APART FIRST' : 'PUTTING IT BACK TOGETHER') : mode === 'reassemble' ? stage.rsub : stage.sub;
    const sel = selected;
    let selHtml = '';
    if (sel) {
      const e = sel.extras || {};
      const cls = {fixed: 'BUILT-IN', movable: 'MOVABLE', textile: 'TEXTILE', decor: 'DECOR', 'fixed-decor': 'DECOR', wall: 'WALL-MOUNTED', stored: 'STORED', shell: 'STRUCTURE'}[sel.cls] || '';
      selHtml = `<div style="font:700 13px Inter,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sel.label)}</div>
        <div class="sm" style="margin-top:3px">${esc((ROOMS[sel.restRoom || sel.room]?.label || sel.type).toUpperCase())} · ${sel.isNew ? 'NEW PIECE' : cls}</div>
        <div class="mo" style="font-size:10px;margin-top:6px">${sel.size.x.toFixed(2)} × ${sel.size.z.toFixed(2)} × ${sel.size.y.toFixed(2)} m · ${sel.parts} part${sel.parts === 1 ? '' : 's'}</div>
        <div style="font-size:10px;color:${C.mute};margin-top:4px;line-height:1.35">${esc((e.measurement_confidence || e.confidence || (sel.isNew ? 'Suggested by Claude; procedural model.' : '')).slice(0, 110))}</div>`;
    }
    const v = layoutById(activeId);
    const arSel = sel ? `${sel.label.toUpperCase()}${movable(sel) ? '' : removable(sel) ? ' · BUILT-IN: SWAP OR REMOVE' : ''}` : '';
    ui.update({
      mode, u, stage, phase, tour: AP.on, view, display: disp, paused: seekTo ? false : paused, tau, dur: DUR, speed, speedK: (speed - SPEED[0]) / (SPEED[1] - SPEED[0]),
      home, total, flying, out, maxErr, rooms: roomStats, selHtml, cursor, callouts, trayLabels,
      floor: arFloor, arView, comparing, canCompare: activeId !== 'original', selMovable: movable(sel), selRemovable: removable(sel), swapping: !!catalogPanel.swapping, effort,
      arSel,
      arHint: comparing ? 'SHOWING THE ORIGINAL LAYOUT — RELEASE TO RETURN' : `${v.title.toUpperCase()} · CLICK A PIECE · DRAG TO MOVE · R ROTATE · DEL STORE · HOLD C TO COMPARE${issueIds.size ? ` · ${issueIds.size} CONFLICT${issueIds.size > 1 ? 'S' : ''} IN RED` : ''}`,
    });
    tlHit.style.display = mode === 'rearrange' ? 'none' : 'block';
    spHit.style.display = mode === 'rearrange' ? 'none' : 'block';
    if (first) {
      first = false;
      ui.hideLoader();
      window.SIM_SHOWN = true;
    }
    requestAnimationFrame(frame);
  };

  // every program compiles before the first frame (kit/warm.js)
  ui.setLoader(0.97, 'Compiling materials');
  st.place({...cam, az: cam.az * D2R, el: cam.el * D2R});
  await warmUp(st.renderer, st.camera, [{scene: st.scene}]).catch((e) => console.warn('warm-up', e));
  // links: ?mode=rearrange opens the Claude and layouts mode; ?tab=catalog also opens the furniture catalogue
  const startMode = q.get('tab') === 'catalog' ? 'rearrange' : q.get('mode');
  if (startMode === 'rearrange') setMode('rearrange');
  if (q.get('tab') === 'catalog') ui.setTab(1);
  else if (q.has('notour')) lastInput = 1e9;
  else startTour();
  if (q.get('u')) {
    AP.on = false;
    lastInput = 1e9;
    u = Number(q.get('u'));
    tau = u * DUR;
    if (q.get('view')) view = q.get('view');
  }
  requestAnimationFrame(frame);
  window.LIVE = {
    st, model, choreo, arrange,
    get u() {
      return u;
    },
    // review hooks: the saved layouts and the layout checker's verdict on one of them
    get layouts() {
      return layouts;
    },
    check: (v) => checkLayout(sceneFor(v), placedFor(v)),
    set(o) {
      AP.on = false;
      lastInput = 1e9;
      if (o.mode) setMode(o.mode);
      if (o.u !== undefined) (seekTo = null), (u = o.u), (tau = mode === 'reassemble' ? (1 - o.u) * DUR : o.u * DUR), (paused = true);
      if (o.view) (view = o.view), (viewAt0 = T);
      if (o.arView) arView = o.arView;
      if (o.floor) arFloor = o.floor;
      if (o.layout) (activeId = o.layout), applyLayout(o.layout, false);
      if (o.labels !== undefined) disp.labels = o.labels;
      if (o.select) selected = [...byId.values()].find((g) => g.label === o.select) || null;
      if (o.camera !== undefined) camOverride = o.camera;
      if (o.cutaway !== undefined) disp.cutaway = o.cutaway;
    },
  };
}
