// The loft as parts. Loads the reconstructed GLB, recovers each node's original name (GLTFLoader sanitises them),
// and turns the 803 scene roots into the objects a person would point at: walls by their measured wall index,
// ceilings, the two floor slabs, the staircase, and furniture assembled from its fragments (an olive tree's 27
// branches, trunk, soil and pot become one tree). Each object gets one holder at a floor-level pivot, so a pose is
// a position and a turn about the vertical; its meshes are merged per material underneath it.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {normDeg, pointInPolygon, pointToSegment} from '../shared/layout-check.js';
import {applyCorrections} from './corrections.js';

export const UPPER_Y = 2.77554;
export const ROOMS = {
  office: {label: 'Entrance & office', floor: 'ground', order: 0},
  'guest-bath': {label: 'Guest bath', floor: 'ground', order: 1},
  hall: {label: 'Hall & closet', floor: 'ground', order: 2},
  stairs: {label: 'Stairs', floor: 'ground', order: 3},
  kitchen: {label: 'Kitchen', floor: 'ground', order: 4},
  dining: {label: 'Dining', floor: 'ground', order: 5},
  living: {label: 'Living room', floor: 'ground', order: 6},
  bedroom: {label: 'Bedroom & landing', floor: 'upper', order: 7},
  'dressing-corridor': {label: 'Dressing corridor', floor: 'upper', order: 8},
  'main-bath': {label: 'Ensuite', floor: 'upper', order: 9},
};
// Ground-floor zones as rectangles [x0, z0, x1, z1]; the upper floor uses room.json's measured polygons.
const GROUND_ZONES = [
  ['office', [-2.6, -7.4, 2.6, -4.9]],
  ['guest-bath', [-2.6, -4.9, 0.17, -2.82]],
  ['hall', [0.17, -4.9, 2.6, -2.82]],
  ['kitchen', [-2.6, -2.82, 0.17, 0.45]],
  ['hall', [0.17, -2.82, 1.45, 0.45]],
  ['stairs', [1.45, -2.82, 2.6, 1.48]],
  ['dining', [-2.6, 0.45, 2.6, 2.95]],
  ['living', [-2.6, 2.95, 2.6, 7.4]],
];

export async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return buf.buffer;
}

// ------------------------------------------------------------------ names and classification
// Names read "<room> · <object> <part>" ("UP · Oak nightstand 0", "Bedroom olive tree branch.004"). Two parts belong
// together when their names share a leading phrase (two words, or one long word that is not a place) and they touch.
const PLACE = new Set('up living kitchen dining bedroom ensuite guest bath office entry entrance hall loft stairs fireplace ceiling'.split(' '));
const baseName = (n) => n.replace(/(\.\d{3})+$/, '');
const ROOM_PREFIX = /^(UP|Living|Guest bath|Bedroom|Ensuite|Kitchen|Dining|Office art|Office display|Office|Entry|Hall|Stairs|Fireplace|Loft parapet|Ceiling)\s*[·|]\s*/i;
const words = (n) => baseName(n).replace(ROOM_PREFIX, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const sharedLead = (a, b) => {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  if (k >= 2) return true;
  return k === 1 && a[0].length >= 5 && !PLACE.has(a[0]) && !/^\d/.test(a[0]);
};
export function cleanLabel(n) {
  let s = baseName(n)
    .replace(/^(UP|Living|Guest bath|Bedroom|Ensuite|Kitchen|Dining|Office|Entry|Hall|Stairs|Fireplace)\s*[·|]\s*/i, '')
    .replace(/\s+—\s+photo reconstructed$/i, '')
    .replace(/\s*·\s*complete assembly$/i, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\s+-?\d+\.\d+$/, '')
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const FIXED = /washer|dryer|cabinet|countertop|backsplash|\bbase\b|sink|faucet|\brange\b|microwave|refrigerator|dishwasher|bathtub|\btub\b|shower|toilet|vanity|wardrobe|closet|louver|ledge|platform|(?<!sectional )\breturn\b|fireplace|pendant|downlight|\bled\b|track|ceiling|sprinkler|handrail|railing|projection screen|breaker|electrical|wall plate|controls|doorstop|door stop|\bdoors?\b|breakfast bar|peninsula|setback|escutcheon|detector|parapet|towel|shelves|wall shelf|shade|glazing|window|utility|plug-in|emblem|camera|rope|mirrored/i;
const KINDS = [
  ['textile', /\brug\b|\bmat\b|runner|bathmat/i],
  ['bed', /\bbed\b/i],
  ['plant', /plant|tree|palm|\bfig\b|croton|monstera|succulent|bouquet|vase/i],
  ['seat', /sofa|sectional|chaise|chair|stool|bench|ottoman|cushion|pouf|sleeper/i],
  ['lamp', /lamp|\blight\b|uplight|torchiere/i],
  ['table', /\btables?\b|\bdesk/i],
  ['storage', /bookcase|shelf|sideboard|drawer|dresser|nightstand|locker|cart|rack|hamper|basket|\bbins?\b|cabinet|chest|trunk|tote|backpack|parcel|carton|suitcase|duffel/i],
  ['equipment', /washer|dryer|simulator|piano|speaker|subwoofer|\bfan\b|purifier|laptop|mixer|shredder|device|\btv\b|electronics/i],
  ['mirror', /mirror/i],
];
const kindOf = (label) => KINDS.find(([, re]) => re.test(label))?.[0] ?? 'other';

// ------------------------------------------------------------------ the loader
export async function loadModel({url, roomJson: roomJson0, corrections, onStatus}) {
  onStatus?.({phase: 'download', k: 0});
  const buf = await fetchWithProgress(url, (got, total) => onStatus?.({phase: 'download', got, total, k: total ? got / total : 0}));
  onStatus?.({phase: 'parse', k: 0});
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  const json = gltf.parser.json;
  const assoc = gltf.parser.associations;
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const roots = scene.children.slice();
  onStatus?.({phase: 'group', k: 0});

  // every root with its world box, original name and extras
  const R = roots.map((o, i) => {
    const a = assoc.get(o);
    const name = (a && a.nodes !== undefined && json.nodes[a.nodes]?.name) || o.name || `part ${i}`;
    const box = new THREE.Box3().setFromObject(o);
    return {o, name, u: o.userData || {}, box, size: box.getSize(new THREE.Vector3())};
  }).filter((r) => !r.box.isEmpty());

  let upperPolys = (roomJson0.upstairs?.floors || []).map((f) => f.polygon);
  const floorOf = (box) => {
    if (box.min.y < UPPER_Y - 0.15) return 'ground';
    const c = [(box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2];
    return upperPolys.some((p) => pointInPolygon(c, p)) || !upperPolys.length ? 'upper' : 'ground';
  };
  // corrections move, add and merge parts before anything is grouped; from here on the corrected room.json is the truth
  const fix = applyCorrections({R, scene, roomJson: roomJson0, corr: corrections, floorOf});
  const roomJson = fix.roomJson;
  upperPolys = (roomJson.upstairs?.floors || []).map((f) => f.polygon);
  if (fix.log.length) console.info('[loft] corrections', fix.log);
  const groups = [];
  const add = (g) => (groups.push(g), g);
  const byKey = new Map();
  const keyed = (key, init) => byKey.get(key) || byKey.set(key, add({...init, members: []})).get(key);

  const items = [];
  const ceilings = [];
  for (const r of R) {
    const n = r.name;
    if (r.u.capture_wall_index != null) {
      const wi = r.u.capture_wall_index;
      keyed(`wall-${wi}`, {id: `wall-${wi}`, type: 'wall', wallIndex: wi, label: `Wall ${wi}`}).members.push(r);
    } else if (/merged measured footprint|^Ground floor · .*footprint/i.test(n)) keyed('slab-ground', {id: 'slab-ground', type: 'slab', label: 'Ground floor slab', floor: 'ground'}).members.push(r);
    else if (/measured floor|regularized observed footprint|^Upper floor · continuous slab/i.test(n) || r.u.correction_slab === 'slab-upper') keyed('slab-upper', {id: 'slab-upper', type: 'slab', label: 'Upper floor slab', floor: 'upper'}).members.push(r);
    else if (/^(Carpet rounded nosing · )?(Step \d+|Upper landing riser)$|^Stair (solid tread \d+|final landing riser)$/i.test(n)) keyed('stairs', {id: 'stairs', type: 'stairs', label: 'Staircase', floor: 'ground'}).members.push(r);
    else if (/tile/i.test(n) && r.size.y < 0.05) {
      const f = floorOf(r.box);
      keyed(`slab-${f}`, {id: `slab-${f}`, type: 'slab', label: f === 'upper' ? 'Upper floor slab' : 'Ground floor slab', floor: f}).members.push(r);
    } else if (r.u.capture_ceiling) ceilings.push(r);
    else items.push(r);
  }

  // Two passes. First, families by name: the same name, or a shared leading phrase, and touching. Then families
  // join when one family lies wholly inside another, when a small family supports a bigger one from just below (a
  // plant stand's legs), or when a tiny family touches a bigger one and shares a word with it (a shredder's cable).
  // Judging whole families keeps a tree that leans over a chaise from joining it through one of its branches.
  const gap = (a, b) => Math.max(a.min.x - b.max.x, b.min.x - a.max.x, a.min.y - b.max.y, b.min.y - a.max.y, a.min.z - b.max.z, b.min.z - a.max.z, 0);
  const unionFind = (n) => {
    const parent = Array.from({length: n}, (_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const sets = () => {
      const m = new Map();
      for (let i = 0; i < n; i++) {
        const k = find(i);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(i);
      }
      return [...m.values()];
    };
    return {join: (i, j) => (parent[find(i)] = find(j)), sets};
  };
  const wordSet = (name) => new Set(words(name).filter((x) => x.length >= 5 && !PLACE.has(x)).map((x) => x.replace(/s$/, '')));
  const unite = (list, type) => {
    const w = list.map((r) => words(r.name));
    const base = list.map((r) => baseName(r.name));
    const fl = list.map((r) => floorOf(r.box));
    const uf = unionFind(list.length);
    const forced = (i, j) => fix.merges.some((m) => m.names.includes(base[i]) && m.names.includes(base[j]));
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (forced(i, j) || (fl[i] === fl[j] && gap(list[i].box, list[j].box) <= 0.02 && (base[i] === base[j] || sharedLead(w[i], w[j])))) uf.join(i, j);
    const fam = uf.sets().map((idx) => {
      const box = new THREE.Box3();
      for (const i of idx) box.union(list[i].box);
      const s = box.getSize(new THREE.Vector3());
      // a name's head noun is its last word ("Black paper shredder"); a tiny part only joins a piece it names that way
      const heads = new Set(idx.map((i) => w[i].filter((x) => /^[a-z]{4,}$/.test(x)).pop()?.replace(/s$/, '')).filter(Boolean));
      return {idx, box, s, vol: Math.max(1e-6, s.x * s.y * s.z), floor: fl[idx[0]], names: idx.map((i) => list[i].name), words: new Set(idx.flatMap((i) => [...wordSet(list[i].name)])), heads};
    });
    const uf2 = unionFind(fam.length);
    for (let i = 0; i < fam.length; i++)
      for (let j = i + 1; j < fam.length; j++) {
        const [big, small] = fam[i].vol >= fam[j].vol ? [fam[i], fam[j]] : [fam[j], fam[i]];
        if (big.floor !== small.floor || gap(big.box, small.box) > 0.02) continue;
        const linear = big.names.some((n) => /rope|track|handrail|\bled\b/i.test(n));
        // containment only absorbs small parts (under 10 litres): a device standing under a tree's canopy stays itself
        let join = !linear && small.vol < 0.01 && big.s.y > 0.005 && big.box.clone().expandByScalar(0.02).containsBox(small.box);
        if (!join && small.vol < 0.06) {
          const cx = (small.box.min.x + small.box.max.x) / 2, cz = (small.box.min.z + small.box.max.z) / 2;
          const under = small.box.max.y > big.box.min.y - 0.05 && small.box.max.y < big.box.min.y + 0.3 && small.box.min.y < big.box.min.y - 0.02;
          join = under && cx > big.box.min.x - 0.05 && cx < big.box.max.x + 0.05 && cz > big.box.min.z - 0.05 && cz < big.box.max.z + 0.05;
        }
        if (!join && small.vol < 0.03) for (const t of small.words) if (big.heads.has(t)) { join = true; break; }
        if (join) uf2.join(i, j);
      }
    for (const set of uf2.sets()) {
      const members = set.flatMap((f) => fam[f].idx.map((i) => list[i]));
      const famBoxes = set.map((f) => fam[f].box);
      const merged = fix.merges.find((m) => members.some((x) => m.names.includes(baseName(x.name))));
      members.sort((a, b) => b.size.x * b.size.y * b.size.z - a.size.x * a.size.y * a.size.z);
      let label = cleanLabel(members[0].name);
      if (members.length > 1) {
        const ws = members.map((m) => baseName(m.name).replace(ROOM_PREFIX, '').split(/\s+/));
        let k = 0;
        while (ws.every((x) => x[k] !== undefined && x[k].toLowerCase() === ws[0][k].toLowerCase())) k++;
        if (k >= 2 && ws.some((x) => x.length > k)) label = cleanLabel(ws[0].slice(0, k).join(' '));
      }
      add({id: '', type, members, label: merged?.label || label, famBoxes});
    }
  };
  unite(items, 'item');
  unite(ceilings, 'ceiling');

  // ------------------------------------------------------------------ geometry facts per group
  const upperFloors = roomJson.upstairs?.floors || [];
  const roomOf = (floor, x, z) => {
    if (floor === 'upper') {
      for (const f of upperFloors) if (pointInPolygon([x, z], f.polygon)) return f.id;
      // nearest polygon
      let best = 'bedroom', bd = Infinity;
      for (const f of upperFloors) for (const [px, pz] of f.polygon) {
        const d = Math.hypot(px - x, pz - z);
        if (d < bd) (bd = d), (best = f.id);
      }
      return ROOMS[best] ? best : 'bedroom';
    }
    for (const [id, [x0, z0, x1, z1]] of GROUND_ZONES) if (x >= x0 && x < x1 && z >= z0 && z < z1) return id;
    return 'living';
  };
  // room.json can list one wall under several indices (the November revisions keep the superseded ones); a wall with
  // no geometry in the model that lies on another wall's line is a duplicate. A geometry-free correction wall (a
  // guard line the checker respects) is kept.
  const drawn = new Set(R.map((r) => r.u.capture_wall_index).filter((i) => i != null));
  const onLine = (w, o) => pointToSegment(w.a, o.a, o.b) < 0.03 && pointToSegment(w.b, o.a, o.b) < 0.03 && Math.abs((w.origin?.[1] ?? 0) - (o.origin?.[1] ?? 0)) < 0.05;
  const duplicate = (w) => !w.correction && !drawn.has(w.index) && (roomJson.walls || []).some((o) => o !== w && drawn.has(o.index) && onLine(w, o));
  const walls2d = (roomJson.walls || []).filter((w) => !(roomJson.reconstruction?.excludedWallIndices || []).includes(w.index) && !duplicate(w)).map((w) => ({
    index: w.index, a: w.a, b: w.b, height: w.height, floor: (w.origin?.[1] ?? 0) > 1 ? 'upper' : 'ground', n: w.n, openings: w.openings || [],
  }));
  const roomplan = (roomJson.objects || []).map((o) => ({cx: o.center[0], cy: o.center[1], cz: o.center[2], front: o.front, category: o.category}));

  // ids: walls, slabs and the stairs are named; everything else takes the stable id of its largest part
  // (spatialObjectID, kept across model revisions), so saved layouts survive a new export. legacyId is the order-based
  // id of earlier versions, used once to migrate saved layouts.
  let n = 0;
  const vol = (b) => {
    const z = b.getSize(new THREE.Vector3());
    return z.x * z.y * z.z;
  };
  const used = new Set(groups.filter((g) => g.id).map((g) => g.id));
  for (const g of groups) {
    const box = new THREE.Box3();
    for (const r of g.members) box.union(r.box);
    g.box = box;
    g.size = box.getSize(new THREE.Vector3());
    g.center = box.getCenter(new THREE.Vector3());
    g.floor = g.floor || (g.type === 'stairs' ? 'ground' : floorOf(box));
    g.floorY = g.floor === 'upper' ? UPPER_Y : 0;
    g.room = roomOf(g.floor, g.center.x, g.center.z);
    g.extras = g.members[0].u;
    g.parts = g.members.length;
    if (!g.id) {
      g.legacyId = `obj-${++n}`;
      const anchor = g.members.filter((r) => r.u.spatialObjectID).sort((a, b) => vol(b.box) - vol(a.box) || String(a.u.spatialObjectID).localeCompare(String(b.u.spatialObjectID)))[0];
      let id = anchor ? `o-${String(anchor.u.spatialObjectID).replace(/-/g, '').slice(0, 12)}` : g.legacyId;
      while (used.has(id)) id += '+';
      used.add(id);
      g.id = id;
    }
    g.rawName = g.members[0].name;
  }

  // ------------------------------------------------------------------ what kind of thing each item is
  const floorPolys = {ground: [roomJson.polygon || []], upper: upperFloors.map((f) => f.polygon)};
  for (const g of groups) {
    if (g.type !== 'item') {
      g.cls = 'shell';
      continue;
    }
    const {size: s, box} = g;
    const lift = box.min.y - g.floorY;
    const label = g.label;
    if (lift > 1.6) g.cls = 'stored';
    else if (FIXED.test(label) || FIXED.test(g.rawName)) g.cls = 'fixed';
    else if (Math.min(s.x, s.z) < 0.12 && lift > 0.35) g.cls = 'wall';
    else if (s.y < 0.06 && s.x * s.z > 0.25) g.cls = 'textile';
    else if (lift > 0.2) g.cls = 'decor';
    else g.cls = 'movable';
    g.kind = g.cls === 'textile' ? 'textile' : kindOf(label);
    if (g.cls === 'movable' && Math.max(s.x, s.z) < 0.45 && s.y < 0.7) g.kind = g.kind === 'other' ? 'small' : g.kind;
  }

  // facing: a RoomPlan detection nearby knows its front; otherwise the side away from the nearest wall
  for (const g of groups) {
    if (g.type !== 'item') continue;
    const {center: c, size: s} = g;
    const mainBox = g.members[0].box;
    const mc = mainBox.getCenter(new THREE.Vector3());
    let facing = null;
    let best = 0.5;
    for (const o of roomplan) {
      if (Math.abs(o.cy - (g.box.min.y + s.y / 2)) > 1.2) continue;
      const d = Math.min(Math.hypot(o.cx - c.x, o.cz - c.z), Math.hypot(o.cx - mc.x, o.cz - mc.z));
      if (d < best) (best = d), (facing = Math.atan2(o.front[0], o.front[1]) * (180 / Math.PI));
    }
    if (facing === null) {
      let bw = null, bd = 0.45 + Math.max(s.x, s.z) / 2;
      for (const w of walls2d) {
        if (w.floor !== g.floor) continue;
        const d = pointToSegment([c.x, c.z], w.a, w.b);
        if (d < bd) (bd = d), (bw = w);
      }
      if (bw) {
        const ux = bw.b[0] - bw.a[0], uz = bw.b[1] - bw.a[1];
        let nx = -uz, nz = ux;
        if ((c.x - bw.a[0]) * nx + (c.z - bw.a[1]) * nz < 0) (nx = -nx), (nz = -nz);
        facing = Math.atan2(nx, nz) * (180 / Math.PI);
      } else facing = 0;
    }
    g.facing = normDeg(Math.round(facing / 90) * 90);
    const side = g.facing % 180 === 0;
    g.w = side ? s.x : s.z;
    g.d = side ? s.z : s.x;
    g.h = s.y + Math.max(0, g.box.min.y - g.floorY);
    // an object made of big pieces (an L-shaped sectional) keeps one footprint per piece, in its own frame
    // pieces: the boxes of the differently named parts it was made from (the sectional and its return)
    const byName = new Map();
    for (const r of g.members) {
      const k = baseName(r.name);
      if (!byName.has(k)) byName.set(k, new THREE.Box3());
      byName.get(k).union(r.box);
    }
    const big = [...byName.values()].filter((b) => {
      const z = b.getSize(new THREE.Vector3());
      return z.x * z.y * z.z > 0.25;
    });
    if (big.length >= 2) {
      const fx = Math.sin((g.facing * Math.PI) / 180), fz = Math.cos((g.facing * Math.PI) / 180);
      g.pieces = big.map((b) => {
        const bc = b.getCenter(new THREE.Vector3());
        const bs = b.getSize(new THREE.Vector3());
        const rx = bc.x - c.x, rz = bc.z - c.z;
        return {dx: rx * fz - rz * fx, dz: rx * fx + rz * fz, w: side ? bs.x : bs.z, d: side ? bs.z : bs.x};
      });
      // only a real L (or U) keeps its pieces: they must leave part of the overall footprint empty. A tree whose
      // leaves and branches are separately named parts covers its whole box and stays one footprint.
      const cells = 24;
      let hit = 0;
      for (let i = 0; i < cells; i++)
        for (let j = 0; j < cells; j++) {
          const x = g.box.min.x + ((i + 0.5) / cells) * s.x, z = g.box.min.z + ((j + 0.5) / cells) * s.z;
          if (big.some((b) => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z)) hit++;
        }
      if (hit / (cells * cells) > 0.85) delete g.pieces;
    }
  }

  // decor rides on the movable piece under it (the lamp on a nightstand, the vase on a bookcase)
  const carriers = groups.filter((g) => g.cls === 'movable' || g.cls === 'fixed');
  for (const g of groups) {
    if (g.cls !== 'decor') continue;
    let best = null;
    for (const c of carriers) {
      if (c.floor !== g.floor) continue;
      if (Math.abs(c.box.max.y - g.box.min.y) > 0.08 && !(g.box.min.y > c.box.min.y && g.box.min.y < c.box.max.y)) continue;
      if (g.center.x < c.box.min.x || g.center.x > c.box.max.x || g.center.z < c.box.min.z || g.center.z > c.box.max.z) continue;
      if (!best || c.size.x * c.size.z < best.size.x * best.size.z) best = c;
    }
    if (best) {
      g.carrier = best.id;
      (best.riders ||= []).push(g.id);
      if (best.cls === 'fixed') g.cls = 'fixed-decor';
    } else g.cls = 'fixed-decor';
  }

  // wall outward normals: which side of a wall is outside the floor plan (interior partitions have none)
  for (const g of groups) {
    if (g.type !== 'wall') continue;
    const w = walls2d.find((x) => x.index === g.wallIndex);
    const c = g.center;
    let nx, nz;
    if (w) {
      const ux = w.b[0] - w.a[0], uz = w.b[1] - w.a[1];
      const l = Math.hypot(ux, uz) || 1;
      (nx = -uz / l), (nz = ux / l);
    } else if (g.size.x < g.size.z) (nx = 1), (nz = 0);
    else (nx = 0), (nz = 1);
    // outside means outside the building's footprint: an upstairs wall beside an unmodelled closet or the
    // double-height entry is an interior wall and is never cut away
    const polys = floorPolys.ground;
    const inside = (k) => polys.some((p) => pointInPolygon([c.x + nx * k, c.z + nz * k], p));
    const plus = inside(0.4), minus = inside(-0.4);
    g.exterior = plus !== minus;
    if (g.exterior && plus) (nx = -nx), (nz = -nz);
    g.normal = new THREE.Vector3(nx, 0, nz);
    g.label = w ? `${g.exterior ? 'Outer' : 'Partition'} wall ${g.wallIndex}` : `Wall ${g.wallIndex}`;
  }

  // ------------------------------------------------------------------ meshes: one holder per object, merged per material
  const root = new THREE.Group();
  root.name = 'loft';
  const shellMats = new Map();
  const glass = new Map();
  const section = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e4)];
  const matFor = (m, shell) => {
    let mat = m;
    if (m.transmission > 0) {
      if (!glass.has(m)) {
        const gm = new THREE.MeshStandardMaterial({color: m.color, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide});
        gm.name = `${m.name || 'glass'} (glass)`;
        glass.set(m, gm);
      }
      mat = glass.get(m);
    }
    if (!shell) return mat;
    if (!shellMats.has(mat)) {
      const c = mat.clone();
      c.clippingPlanes = section;
      c.clipShadows = true;
      shellMats.set(mat, c);
    }
    return shellMats.get(mat);
  };
  const sig = (geo) => Object.keys(geo.attributes).sort().map((k) => `${k}${geo.attributes[k].itemSize}${geo.attributes[k].normalized ? 'n' : ''}${geo.attributes[k].array.constructor.name}`).join(',') + (geo.index ? '|i' : '|n');

  let done = 0;
  let drawCalls = 0;
  for (const g of groups) {
    // structure, and built-ins tall enough to block the view (the chimney), take the section cut
    const shell = g.cls === 'shell' || (g.cls === 'fixed' && g.size.y > 2.3);
    const pivot = g.type === 'item' ? new THREE.Vector3(g.center.x, g.floorY, g.center.z) : g.center.clone();
    g.pivot = pivot;
    const holder = new THREE.Group();
    holder.name = g.id;
    holder.position.copy(pivot);
    const content = new THREE.Group();
    holder.add(content);
    const buckets = new Map();
    const inv = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    for (const r of g.members)
      r.o.traverse((m) => {
        if (m.isLineSegments) {
          // the outline of a procedural piece (the closet's washer and dryer) travels with it unmerged
          const l = new THREE.LineSegments(m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)), m.material);
          content.add(l);
          return;
        }
        if (!m.isMesh || !m.geometry?.attributes?.position) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        if (mats.length > 1 && geo.groups.length && geo.index) {
          // split a multi-material mesh into one geometry per material group (GLTFLoader rarely makes these)
          for (const gr of geo.groups) {
            const part = geo.clone();
            part.setIndex(Array.from(part.index.array.slice(gr.start, gr.start + gr.count)));
            part.clearGroups();
            const mat = matFor(mats[gr.materialIndex] || mats[0], shell);
            const k = `${mat.uuid}|${sig(part)}`;
            if (!buckets.has(k)) buckets.set(k, {mat, geos: []});
            buckets.get(k).geos.push(part);
          }
          return;
        }
        geo.clearGroups();
        const mat = matFor(mats[0], shell);
        const k = `${mat.uuid}|${sig(geo)}`;
        if (!buckets.has(k)) buckets.set(k, {mat, geos: []});
        buckets.get(k).geos.push(geo);
      });
    for (const {mat, geos} of buckets.values()) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) continue;
      if (geos.length > 1) geos.forEach((x) => x.dispose());
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = !mat.transparent;
      mesh.receiveShadow = true;
      mesh.userData.group = g.id;
      content.add(mesh);
      drawCalls++;
    }
    g.holder = holder;
    g.content = content;
    root.add(holder);
    if (++done % 40 === 0) {
      onStatus?.({phase: 'build', k: done / groups.length});
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  // the source scene is no longer needed
  scene.traverse((m) => {
    if (m.isMesh) m.geometry.dispose();
  });

  const byId = new Map(groups.map((g) => [g.id, g]));
  const model = {root, groups, byId, walls2d, floorPolys, upperFloors, roomJson, section, drawCalls, roomOf};
  model.stats = {
    roots: R.length,
    objects: groups.filter((g) => g.type === 'item').length,
    movable: groups.filter((g) => g.cls === 'movable' || g.cls === 'textile').length,
    walls: groups.filter((g) => g.type === 'wall').length,
    ceilings: groups.filter((g) => g.type === 'ceiling').length,
    drawCalls,
  };
  return model;
}

// ------------------------------------------------------------------ what Claude is told about the home
/** Static description: floors, walls with doors, keep-out zones, built-ins, and every movable piece in its original place. */
export function exportScene(model) {
  const r = (v) => Math.round(v * 100) / 100;
  const {groups, walls2d, floorPolys} = model;
  const floors = [
    {id: 'ground', label: 'ground floor', elevation: 0, polygons: floorPolys.ground.map((p) => p.map(([x, z]) => [r(x), r(z)]))},
    {id: 'upper', label: 'upper floor', elevation: UPPER_Y, polygons: floorPolys.upper.map((p) => p.map(([x, z]) => [r(x), r(z)]))},
  ];
  const walls = walls2d.map((w) => ({
    floor: w.floor, index: w.index, a: w.a.map(r), b: w.b.map(r), h: r(w.height),
    doors: w.openings.filter((o) => o.kind === 'door').map((o) => [r(o.u0), r(o.u1)]),
    openings: w.openings.filter((o) => o.kind !== 'door').map((o) => ({kind: o.kind, u: [r(o.u0), r(o.u1)]})),
  }));
  const stairs = model.byId.get('stairs');
  const keepouts = [];
  if (stairs) {
    const b = stairs.box;
    keepouts.push({floor: 'ground', label: 'the staircase', cx: r((b.min.x + b.max.x) / 2), cz: r((b.min.z + b.max.z) / 2), w: r(b.max.x - b.min.x), d: r(b.max.z - b.min.z), facing: 0});
    keepouts.push({floor: 'ground', label: 'the landing space at the foot of the stairs', cx: r((b.min.x + b.max.x) / 2), cz: r(b.max.z + 0.4), w: r(b.max.x - b.min.x), d: 0.8, facing: 0});
    keepouts.push({floor: 'upper', label: 'the top of the stairs', cx: 1.85, cz: -2.05, w: 1.0, d: 0.95, facing: 0});
  }
  const fixed = [];
  const items = [];
  let m = 0;
  for (const g of groups) {
    if (g.type !== 'item') continue;
    const lift = g.box.min.y - g.floorY;
    if (g.cls === 'fixed' || g.cls === 'wall' || (g.cls === 'stored' && lift < 2.2)) {
      if (lift > 2.1 || Math.max(g.size.x, g.size.z) < 0.25 || /rope|cable|\bled\b|strip|doorstop|door stop|emblem|controls|plate|camera/i.test(g.label)) continue;
      fixed.push({id: g.id, label: g.label, floor: g.floor, room: g.room, cx: r(g.center.x), cz: r(g.center.z), w: r(g.size.x), d: r(g.size.z), facing: 0, y0: r(lift), y1: r(g.box.max.y - g.floorY)});
    } else if (g.cls === 'movable' || g.cls === 'textile') {
      g.sid = `m${++m}`;
      items.push({
        id: g.sid, gid: g.id, label: g.label, kind: g.kind, floor: g.floor, room: g.room,
        cx: r(g.center.x), cz: r(g.center.z), w: r(g.w), d: r(g.d), h: r(g.h), facing: g.facing,
        carries: (g.riders || []).map((id) => model.byId.get(id)?.label).filter(Boolean),
        ...(g.pieces ? {pieces: g.pieces.map((q) => ({dx: r(q.dx), dz: r(q.dz), w: r(q.w), d: r(q.d)}))} : {}),
      });
    }
  }
  const rooms = Object.entries(ROOMS).map(([id, v]) => ({id, label: v.label, floor: v.floor}));
  return {
    units: 'metres',
    frame: '+x and -x run across the loft (the stairs and hall are on the +x side, the kitchen on the -x side); +z runs toward the living room and the patio glazing, -z toward the entrance and office. y is up. facing: 0 = front points +z, 90 = +x, 180 = -z, 270 = -x.',
    floors, rooms, walls, keepouts, fixed, items,
    zones: {ground: GROUND_ZONES.map(([id, b]) => ({room: id, rect: b})), upper: model.upperFloors.map((f) => ({room: f.id, polygon: f.polygon.map(([x, z]) => [r(x), r(z)])}))},
  };
}
