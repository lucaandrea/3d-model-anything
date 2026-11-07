// Architecture corrections from the room's teardown-corrections.json (see server.mjs for where it lives), applied to the scene roots before they
// are grouped, so every later step (grouping, merging, the teardown, the checker, Claude's description) sees the
// corrected home. The GLB and the Blender source stay as they are.
//
//   move   rigidly moves walls, floors and ceilings (selected by wall index, region or name); the furniture in a
//          region follows the same map but keeps its own orientation (it is already square to the building).
//   wall   adds a wall panel in the material of an existing part ("like"), or only a line the checker respects.
//   floor  adds a floor panel (a closet the scan never saw), joining the upper slab.
//   merge  makes named parts one object (an L-shaped sectional).
//   item   adds a fixed appliance built from the catalogue (the hall closet's washer and dryer).
import * as THREE from 'three';
import {pointInPolygon, pointToSegment} from '../shared/layout-check.js';
import {buildFurniture} from './catalog.js';

const D2R = Math.PI / 180;
const baseName = (n) => n.replace(/(\.\d{3})+$/, '');
// plan rotation by deg (turning +x toward +z) about pivot, then a translation; three's rotation.y runs the other way
const planMatrix = (deg = 0, [px, pz] = [0, 0], [tx, tz] = [0, 0]) =>
  new THREE.Matrix4()
    .makeTranslation(px + tx, 0, pz + tz)
    .multiply(new THREE.Matrix4().makeRotationY(-deg * D2R))
    .multiply(new THREE.Matrix4().makeTranslation(-px, 0, -pz));
const mapPoint = (m, [x, z]) => {
  const v = new THREE.Vector3(x, 0, z).applyMatrix4(m);
  return [v.x, v.z];
};
const nearPolygon = (p, poly, pad) => pointInPolygon(p, poly) || poly.some((a, i) => pointToSegment(p, a, poly[(i + 1) % poly.length]) <= pad);
const isShell = (r) => r.u.capture_wall_index != null || r.u.capture_ceiling || /measured floor|tile|footprint/i.test(r.name);

export function applyCorrections({R, scene, roomJson, corr, floorOf}) {
  const rj = JSON.parse(JSON.stringify(roomJson));
  const log = [];
  const merges = [];
  if (!corr?.ops?.length && !corr?.upperFloors) return {roomJson: rj, merges, log};
  const refresh = (r) => {
    r.o.updateMatrixWorld(true);
    r.box = new THREE.Box3().setFromObject(r.o);
    r.size = r.box.getSize(new THREE.Vector3());
  };
  const materialLike = (name) => {
    const r = R.find((x) => baseName(x.name) === name);
    let mat = null;
    r?.o.traverse((m) => {
      if (!mat && m.isMesh) mat = Array.isArray(m.material) ? m.material[0] : m.material;
    });
    return mat || new THREE.MeshStandardMaterial({color: '#d9d4cc', roughness: 0.9});
  };
  const addRoot = (o, name, u) => {
    o.name = name;
    // a stable id like the model's own, so layouts can refer to an added piece across reloads
    o.userData = {spatialObjectID: `teardown-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, ...u, correction: true};
    scene.add(o);
    const r = {o, name, u: o.userData};
    refresh(r);
    R.push(r);
    return r;
  };

  for (const op of corr.ops || []) {
    if (op.op === 'move') {
      const sel = R.filter((r) => {
        if (op.walls && r.u.capture_wall_index != null) return op.walls.includes(r.u.capture_wall_index);
        if (op.names?.includes(baseName(r.name))) return true;
        if (!op.region || r.u.capture_wall_index != null) return false;
        if (floorOf(r.box) !== op.region.floor) return false;
        const c = [(r.box.min.x + r.box.max.x) / 2, (r.box.min.z + r.box.max.z) / 2];
        return nearPolygon(c, op.region.polygon, op.region.pad ?? 0);
      });
      for (const r of sel) {
        const c = r.box.getCenter(new THREE.Vector3());
        const pivot = op.pivot === 'self' ? [c.x, c.z] : op.pivot;
        const m = planMatrix(op.rotate, pivot, op.translate);
        if (isShell(r) || op.pivot === 'self') r.o.applyMatrix4(m);
        else {
          // furniture: square already, so only its position follows the map
          const turn = op.rectify?.[baseName(r.name)];
          if (turn) r.o.applyMatrix4(planMatrix(turn, [c.x, c.z]));
          const to = mapPoint(m, [c.x, c.z]);
          r.o.position.x += to[0] - c.x;
          r.o.position.z += to[1] - c.z;
        }
        refresh(r);
      }
      // the measured walls in room.json follow the same map
      const m = op.pivot === 'self' ? null : planMatrix(op.rotate, op.pivot, op.translate);
      if (m)
        for (const w of rj.walls || [])
          if (op.walls?.includes(w.index)) {
            w.a = mapPoint(m, w.a);
            w.b = mapPoint(m, w.b);
            if (w.origin) [w.origin[0], w.origin[2]] = mapPoint(m, [w.origin[0], w.origin[2]]);
          }
      log.push(`${op.label}: ${sel.length} parts`);
    } else if (op.op === 'wall') {
      const floorY = op.floor === 'upper' ? 2.77554 : 0;
      rj.walls.push({index: op.index, a: op.a, b: op.b, height: (op.y?.[1] ?? floorY + 2.4) - floorY, origin: [op.a[0], floorY, op.a[1]], openings: [], correction: true});
      if (op.geometry === false) continue;
      const [ax, az] = op.a;
      const [bx, bz] = op.b;
      const L = Math.hypot(bx - ax, bz - az);
      const h = op.y[1] - op.y[0];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(L, h, op.t ?? 0.09), materialLike(op.like));
      mesh.position.set((ax + bx) / 2, (op.y[0] + op.y[1]) / 2, (az + bz) / 2);
      mesh.rotation.y = -Math.atan2(bz - az, bx - ax);
      addRoot(mesh, op.label, {capture_wall_index: op.index, floorID: op.floor});
      log.push(`added ${op.label}`);
    } else if (op.op === 'floor') {
      const [x0, z0, x1, z1] = op.rect;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, op.y[1] - op.y[0], z1 - z0), materialLike(op.like));
      mesh.position.set((x0 + x1) / 2, (op.y[0] + op.y[1]) / 2, (z0 + z1) / 2);
      addRoot(mesh, op.label, {correction_slab: 'slab-upper', floorID: 'upper'});
      log.push(`added ${op.label}`);
    } else if (op.op === 'merge') merges.push(op);
    else if (op.op === 'item') {
      const built = buildFurniture(op);
      const holder = new THREE.Group();
      holder.add(built.group);
      holder.position.set(op.x, op.floor === 'upper' ? 2.77554 : 0, op.z);
      holder.rotation.y = (op.facing || 0) * D2R;
      addRoot(holder, op.label, {capture_item: true, floorID: op.floor, measurement_confidence: 'Added by hand in teardown-corrections.json; procedural model at the listed size.'});
      log.push(`added ${op.label}`);
    }
  }
  if (corr.upperFloors && rj.reconstruction?.upstairs) rj.reconstruction.upstairs.floors = corr.upperFloors.map((f) => ({...f, elevation: 2.77554}));
  if (corr.upperFloors) rj.upstairs = {...(rj.upstairs || {}), floors: corr.upperFloors.map((f) => ({...f, elevation: 2.77554}))};
  return {roomJson: rj, merges, log};
}
