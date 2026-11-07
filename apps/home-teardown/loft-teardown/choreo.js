// The teardown as a pure function of one input, u in [0, 1]. u = 0 is the home as it stands (in the active layout),
// u = 1 is the home fully taken apart: every ceiling panel and wall laid flat on piles to the west, the upper slab on
// its own pad, and every object on a labelled tray to the east, grouped by room. Reassembly is the same function run
// from 1 back to 0, which plays in build order: structure, then furniture (large before small), then walls, then roof.
import * as THREE from 'three';
import {ROOMS, UPPER_Y} from './model.js';

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoother = (x) => {
  const u = clamp01(x);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const UP = new THREE.Vector3(0, 1, 0);
export const UPPER_LIFT = 3.2;
export const WINDOWS = {ceiling: [0.0, 0.14, 0.06], upperWall: [0.06, 0.24, 0.07], groundWall: [0.16, 0.36, 0.08], lift: [0.3, 0.4], items: [0.4, 0.86, 0.08], slab: [0.86, 0.95], stairs: [0.88, 0.97]};
export const STAGES = [
  {at: 0, name: 'INTACT', sub: 'AS RECONSTRUCTED', rname: 'REASSEMBLED', rsub: 'EVERY PART ON ITS RECORDED POSE'},
  {at: 0.0005, name: 'ROOF OFF', sub: 'CEILINGS AND FIXTURES LIFT AWAY', rname: 'ROOF ON', rsub: 'CEILINGS AND FIXTURES RETURN'},
  {at: 0.14, name: 'WALLS DOWN', sub: 'WALLS LAID FLAT ON THE PILES', rname: 'WALLS UP', rsub: 'WALLS RISE FROM THE PILES'},
  {at: 0.36, name: 'FLOORS APART', sub: 'THE UPPER FLOOR RISES', rname: 'FLOORS JOIN', rsub: 'THE UPPER FLOOR SETTLES BACK'},
  {at: 0.4, name: 'UNPACKING', sub: 'EVERY OBJECT TO ITS ROOM TRAY', rname: 'FURNISHING', rsub: 'EVERY OBJECT BACK TO ITS RECORDED PLACE'},
  {at: 0.86, name: 'FLAT-PACK', sub: 'SLAB AND STAIRS COME OUT', rname: 'STRUCTURE', rsub: 'SLAB AND STAIRS GO BACK IN'},
  {at: 0.9995, name: 'TORN DOWN', sub: 'EVERY PART LAID OUT', rname: 'TORN DOWN', rsub: 'EVERY PART LAID OUT'},
];
export const stageAt = (u) => STAGES.filter((s) => s.at <= u).pop();

export function createChoreo(model) {
  const {groups} = model;
  for (const g of groups) {
    g.rest = {p: g.pivot.clone(), q: new THREE.Quaternion()};
    g.slot = {p: g.pivot.clone(), q: new THREE.Quaternion()};
    g.win = [2, 3];
  }
  let trays = [];
  let piles = [];
  let site = {x0: -3, x1: 3, z0: -8, z1: 8};

  // ------------------------------------------------------------------ where everything goes when it is torn down
  const layoutSlots = (extra = []) => {
    const all = groups.concat(extra);
    // shell: walls and big ceiling panels lie flat on piles; the upper slab gets a pad of its own
    const panels = [];
    for (const g of all) {
      if (g.type === 'wall' || (g.type === 'ceiling' && g.size.y < 0.35 && g.size.x * g.size.z > 0.8)) panels.push(g);
    }
    const upperSlab = model.byId.get('slab-upper');
    const PILE_X = -6.3;
    // flat orientation: the wall's normal turns to face up, then its long side turns along z
    for (const g of panels) {
      const q = new THREE.Quaternion();
      if (g.type === 'wall') q.setFromUnitVectors(g.normal || new THREE.Vector3(1, 0, 0), UP);
      const tmp = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), g.size).applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
      let s = tmp.getSize(new THREE.Vector3());
      if (s.x > s.z) {
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2));
        s = new THREE.Vector3(s.z, s.y, s.x);
      }
      g.flat = {q, s};
    }
    panels.sort((a, b) => b.flat.s.x * b.flat.s.z - a.flat.s.x * a.flat.s.z);
    const MAXH = 2.4;
    piles = [];
    let pile = null;
    for (const g of panels) {
      if (!pile || pile.h + g.flat.s.y > MAXH) {
        // two rows along z, then further west
        const i = piles.length;
        pile = {x: PILE_X - 6.1 * Math.floor(i / 2), z: i % 2 ? 5.2 : -5.2, h: 0, n: 0, w: 0, d: 0, label: ''};
        piles.push(pile);
      }
      g.slot.p.set(pile.x, pile.h + g.flat.s.y / 2 + 0.004, pile.z);
      g.slot.q.copy(g.flat.q);
      pile.h += g.flat.s.y + 0.012;
      pile.w = Math.max(pile.w, g.flat.s.x);
      pile.d = Math.max(pile.d, g.flat.s.z);
      pile.n++;
    }
    // the upper slab comes out last, so it lands on top of the first pile
    if (upperSlab && piles[0]) {
      const p = piles[0];
      upperSlab.slot.p.set(p.x, p.h + upperSlab.size.y / 2 + 0.01, p.z);
      upperSlab.slot.q.identity();
      p.h += upperSlab.size.y + 0.01;
      p.w = Math.max(p.w, upperSlab.size.x);
      p.d = Math.max(p.d, upperSlab.size.z);
      p.slab = true;
    }
    piles.forEach((p, i) => (p.label = `PILE ${String.fromCharCode(65 + i)} · ${p.n} PANELS${p.slab ? ' + UPPER SLAB' : ''}`));

    // objects: trays by room, shelf-packed, largest first
    const objs = all.filter((g) => (g.type === 'item' || g.type === 'stairs' || (g.type === 'ceiling' && !panels.includes(g))) && !g.static);
    const trayKey = (g) => (g.isNew ? 'new' : g.type === 'ceiling' ? 'ceiling' : g.type === 'stairs' ? 'stairs' : g.room);
    const order = [...Object.keys(ROOMS), 'ceiling', 'new'];
    const byTray = new Map(order.map((k) => [k, []]));
    for (const g of objs) {
      const k = trayKey(g);
      if (!byTray.has(k)) byTray.set(k, []);
      byTray.get(k).push(g);
    }
    trays = [];
    const TW = 6.0, GAP = 0.16, PAD = 0.28, HEAD = 0.42, Z0 = -10.6, Z1 = 10.8;
    let colX = 3.6;
    let z = Z0;
    for (const [k, list] of byTray) {
      if (!list.length) continue;
      list.sort((a, b) => b.size.x * b.size.z - a.size.x * a.size.z);
      // pack rows
      let x = 0, rowD = 0, depth = 0;
      const pos = [];
      for (const g of list) {
        const w = g.size.x, d = g.size.z;
        if (x > 0 && x + w > TW - 2 * PAD) {
          depth += rowD + GAP;
          x = 0;
          rowD = 0;
        }
        pos.push([g, x, depth]);
        x += w + GAP;
        rowD = Math.max(rowD, d);
      }
      depth += rowD;
      const trayD = depth + 2 * PAD + HEAD;
      if (z + trayD > Z1 && z > Z0) {
        colX += TW + 0.8;
        z = Z0;
      }
      for (const [g, px, pz] of pos) {
        const lift = g.box.min.y - g.pivot.y;
        g.slot.p.set(colX + PAD + px + g.size.x / 2 + (g.pivot.x - g.center.x), -lift + 0.012, z + HEAD + PAD + pz + g.size.z / 2 + (g.pivot.z - g.center.z));
        g.slot.q.identity();
      }
      const label = k === 'ceiling' ? 'Ceiling fixtures' : k === 'new' ? 'New pieces' : k === 'stairs' ? 'Stairs' : ROOMS[k]?.label || k;
      trays.push({key: k, label, n: list.length, x: colX, z, w: TW, d: trayD});
      z += trayD + 0.55;
    }
    // the whole laid-out site, for framing the camera
    const xs = [-2.7, 2.7, ...trays.flatMap((t) => [t.x, t.x + t.w]), ...piles.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2])];
    const zs = [-7.5, 7.5, ...trays.flatMap((t) => [t.z, t.z + t.d]), ...piles.flatMap((p) => [p.z - p.d / 2, p.z + p.d / 2])];
    site = {x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs)};
  };

  // ------------------------------------------------------------------ when each part moves
  const assignWindows = () => {
    const stagger = (list, [a, b, dur], key) => {
      list.sort(key);
      const n = Math.max(1, list.length - 1);
      list.forEach((g, i) => {
        const t0 = a + (b - a - dur) * (list.length > 1 ? i / n : 0);
        g.win = [t0, t0 + dur];
      });
    };
    const live = groups.filter((g) => !g.static && !g.removed);
    stagger(live.filter((g) => g.type === 'ceiling'), WINDOWS.ceiling, (a, b) => b.center.y - a.center.y || a.center.z - b.center.z);
    stagger(live.filter((g) => g.type === 'wall' && g.floor === 'upper'), WINDOWS.upperWall, (a, b) => a.center.z - b.center.z);
    stagger(live.filter((g) => g.type === 'wall' && g.floor !== 'upper'), WINDOWS.groundWall, (a, b) => (b.exterior ? 1 : 0) - (a.exterior ? 1 : 0) || a.center.z - b.center.z);
    // objects: the lifted upper floor empties first, then the ground floor room by room; small things before big
    const items = live.filter((g) => g.type === 'item');
    const room = (g) => (g.restFloor === 'upper' ? 0 : 10) + (ROOMS[g.restRoom || g.room]?.order ?? 20);
    stagger(items, WINDOWS.items, (a, b) => room(a) - room(b) || a.size.x * a.size.y * a.size.z - b.size.x * b.size.y * b.size.z);
    const slab = model.byId.get('slab-upper');
    if (slab) slab.win = [WINDOWS.slab[0], WINDOWS.slab[1]];
    const stairs = model.byId.get('stairs');
    if (stairs) stairs.win = [WINDOWS.stairs[0], WINDOWS.stairs[1]];
    for (const g of groups) {
      const dist = g.rest.p.distanceTo(g.slot.p);
      g.arc = g.type === 'wall' || g.type === 'ceiling' ? Math.min(3.2, Math.max(1.4, dist * 0.18)) : Math.min(5, Math.max(1.2, dist * 0.26));
    }
  };

  const ground = model.byId.get('slab-ground');
  if (ground) ground.static = true;

  /** Rest poses for the active layout. poses: Map id -> {p, q, floor, room}; ids not in it rest where they were built. */
  const setLayout = (poses, extra = []) => {
    for (const g of groups.concat(extra)) {
      const r = poses.get(g.id);
      if (r) {
        g.rest.p.copy(r.p);
        g.rest.q.copy(r.q);
      } else {
        g.rest.p.copy(g.pivot);
        g.rest.q.identity();
      }
      g.restFloor = r?.floor ?? g.floor;
      g.restRoom = r?.room ?? g.room;
      g.removed = !!r?.removed;
      g.upperLift = (g.type === 'item' || g.id === 'slab-upper') && g.restFloor === 'upper';
    }
    layoutSlots(extra);
    assignWindows();
    for (const g of extra) {
      g.win = g.win[0] > 1 ? [WINDOWS.items[1] - WINDOWS.items[2], WINDOWS.items[1]] : g.win;
      g.arc = Math.min(6, Math.max(1.2, g.rest.p.distanceTo(g.slot.p) * 0.28));
    }
    // removed pieces wait on their tray even while the home stands
    for (const g of groups.concat(extra)) if (g.removed) g.rest.p.copy(g.slot.p), g.rest.q.copy(g.slot.q);
  };

  const liftAt = (u) => UPPER_LIFT * smoother((u - WINDOWS.lift[0]) / (WINDOWS.lift[1] - WINDOWS.lift[0]));
  const A = new THREE.Vector3();
  /** Pose of one part at teardown progress u. Returns s: 0 at rest, 1 on its tray or pile, in between in flight. */
  const poseAt = (g, u, outP, outQ) => {
    const lift = g.upperLift ? liftAt(u) : 0;
    if (g.static || g.removed || u <= g.win[0]) {
      outP.copy(g.rest.p);
      outP.y += lift;
      outQ.copy(g.rest.q);
      return 0;
    }
    if (u >= g.win[1]) {
      outP.copy(g.slot.p);
      outQ.copy(g.slot.q);
      return 1;
    }
    const s = (u - g.win[0]) / (g.win[1] - g.win[0]);
    const k = smoother(s);
    A.copy(g.rest.p);
    A.y += g.upperLift ? liftAt(g.win[0]) : 0;
    outP.lerpVectors(A, g.slot.p, k);
    outP.y += g.arc * Math.sin(Math.PI * k);
    outQ.slerpQuaternions(g.rest.q, g.slot.q, smoother((k - 0.12) / 0.76));
    return s;
  };

  return {
    setLayout,
    poseAt,
    liftAt,
    get trays() {
      return trays;
    },
    get piles() {
      return piles;
    },
    get site() {
      return site;
    },
    padOf: () => null,
    UPPER_Y,
  };
}
