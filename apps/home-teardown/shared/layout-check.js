// Footprint geometry for the rearrange mode. Pure JS with no dependencies: the page uses it for live warnings
// while you drag, the server uses it to check every layout Claude proposes and to tell it exactly what is wrong.
//
// Frame: the model's room-local metres (room.json). +x / -x across the loft, +z toward the patio end, -z toward
// the entrance, y up. "facing" is in degrees and names the direction an object's front points:
// 0 = +z, 90 = +x, 180 = -z, 270 = -x (three.js rotation.y = facing in radians).

export const D2R = Math.PI / 180;
export const facingVec = (deg) => [Math.sin(deg * D2R), Math.cos(deg * D2R)];
export const normDeg = (d) => ((Math.round(d * 10) / 10) % 360 + 360) % 360;

/** Rectangle footprint: centre, width across the front, depth along the facing direction. */
export function obbCorners({cx, cz, w, d, facing}, shrink = 0) {
  const [fx, fz] = facingVec(facing);
  const rx = fz, rz = -fx; // the object's side axis
  const hw = Math.max(0.001, w / 2 - shrink), hd = Math.max(0.001, d / 2 - shrink);
  return [
    [cx + rx * hw + fx * hd, cz + rz * hw + fz * hd],
    [cx - rx * hw + fx * hd, cz - rz * hw + fz * hd],
    [cx - rx * hw - fx * hd, cz - rz * hw - fz * hd],
    [cx + rx * hw - fx * hd, cz + rz * hw - fz * hd],
  ];
}

/** The rectangles an object occupies: itself, or its pieces (dx across, dz along its facing) for an L-shaped piece. */
export function rectsOf(o) {
  if (!o.pieces?.length) return [o];
  const [fx, fz] = facingVec(o.facing);
  const rx = fz, rz = -fx;
  return o.pieces.map((q) => ({cx: o.cx + rx * q.dx + fx * q.dz, cz: o.cz + rz * q.dx + fz * q.dz, w: q.w, d: q.d, facing: o.facing}));
}

const axesOf = (poly) => {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ez = bz - az;
    const l = Math.hypot(ex, ez);
    if (l > 1e-9) out.push([-ez / l, ex / l]);
  }
  return out;
};
const project = (poly, [nx, nz]) => {
  let lo = Infinity, hi = -Infinity;
  for (const [x, z] of poly) {
    const p = x * nx + z * nz;
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  return [lo, hi];
};
/** Separating-axis test for two convex polygons (or a polygon and a segment). Returns penetration depth, 0 if apart. */
export function penetration(a, b) {
  let depth = Infinity;
  for (const ax of [...axesOf(a), ...axesOf(b)]) {
    const [a0, a1] = project(a, ax);
    const [b0, b1] = project(b, ax);
    const o = Math.min(a1, b1) - Math.max(a0, b0);
    if (o <= 0) return 0;
    depth = Math.min(depth, o);
  }
  return depth === Infinity ? 0 : depth;
}

export function pointInPolygon([x, z], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const segCross = ([ax, az], [bx, bz], [cx, cz], [dx, dz]) => {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
};
/** True when the rectangle lies inside one of the floor's polygons (corners inside, no edge crossing the outline). */
export function insideFloor(corners, polygons) {
  return polygons.some((poly) => {
    if (!corners.every((c) => pointInPolygon(c, poly))) return false;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < poly.length; j++)
        if (segCross(corners[i], corners[(i + 1) % 4], poly[j], poly[(j + 1) % poly.length])) return false;
    return true;
  });
}
export const pointToSegment = ([px, pz], [ax, az], [bx, bz]) => {
  const ex = bx - ax, ez = bz - az;
  const l2 = ex * ex + ez * ez || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / l2));
  return Math.hypot(px - (ax + ex * t), pz - (az + ez * t));
};

/** Keep-clear rectangles in front of and behind every door opening, 0.6 m deep (the door swing and the way through). */
export function doorZones(walls, depth = 0.6) {
  const out = [];
  for (const w of walls) {
    const [ax, az] = w.a;
    const [bx, bz] = w.b;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    for (const [u0, u1] of w.doors || []) {
      const mid = (u0 + u1) / 2;
      const cx = ax + ux * mid, cz = az + uz * mid;
      // facing along the wall normal; width = the opening
      const facing = Math.atan2(-uz, ux) / D2R; // normal (−uz, ux) as a facing angle
      out.push({floor: w.floor, label: w.doorLabel || 'a doorway', cx, cz, w: u1 - u0, d: 2 * depth, facing: normDeg(facing)});
    }
  }
  return out;
}

const SEATS = new Set(['seat']);
const UNDER = new Set(['table', 'desk', 'bed']);
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Checks a layout. scene: {floors:[{id, elevation, polygons}], walls:[{floor,a,b,doors}], keepouts:[...obb], fixed:[...],
 * items:[...]} with obb fields {cx, cz, w, d, facing} and heights {y0, y1} relative to the floor where relevant.
 * placed: [{id, label, kind, floor, cx, cz, w, d, h, facing, changed}]. Only issues that involve a changed object are
 * reported, so the original home's own tight spots (chairs tucked under a table) never count against a proposal.
 */
export function checkLayout(scene, placed, {tol = 0.03} = {}) {
  const issues = [];
  const floors = Object.fromEntries(scene.floors.map((f) => [f.id, f]));
  const doors = doorZones(scene.walls);
  const flat = (o) => o.kind === 'textile';
  for (const o of placed) {
    if (!o.changed) continue;
    const fl = floors[o.floor];
    if (!fl) {
      issues.push({id: o.id, kind: 'floor', text: `${o.label}: unknown floor "${o.floor}"`});
      continue;
    }
    const rects = rectsOf(o).map((q) => obbCorners(q, tol));
    if (!rects.every((outer) => insideFloor(outer, fl.polygons))) {
      issues.push({id: o.id, kind: 'bounds', text: `${o.label} at (${r2(o.cx)}, ${r2(o.cz)}) facing ${normDeg(o.facing)}° extends outside the ${fl.label || fl.id} floor area (through an outer wall, into the stairwell or past the loft edge).`});
      continue;
    }
    const pen = (poly) => Math.max(0, ...rects.map((outer) => penetration(outer, poly)));
    for (const w of scene.walls) {
      if (w.floor !== o.floor) continue;
      if (pen([w.a, w.b]) > 0) {
        issues.push({id: o.id, kind: 'wall', text: `${o.label} at (${r2(o.cx)}, ${r2(o.cz)}) cuts through the wall from (${r2(w.a[0])}, ${r2(w.a[1])}) to (${r2(w.b[0])}, ${r2(w.b[1])}).`});
        break;
      }
    }
    if (!flat(o))
      for (const dz of doors) {
        if (dz.floor !== o.floor) continue;
        const p = pen(obbCorners(dz));
        if (p > 0.05) {
          issues.push({id: o.id, kind: 'door', text: `${o.label} blocks ${dz.label} (the 0.6 m keep-clear zone either side of the opening centred at (${r2(dz.cx)}, ${r2(dz.cz)})) by ${r2(p)} m.`});
          break;
        }
      }
    for (const k of scene.keepouts || []) {
      if (k.floor !== o.floor) continue;
      const p = pen(obbCorners(k));
      if (p > 0) issues.push({id: o.id, kind: 'keepout', text: `${o.label} intrudes ${r2(p)} m into ${k.label}.`});
    }
    if (flat(o)) continue;
    for (const f of scene.fixed) {
      if (f.floor !== o.floor) continue;
      // vertical overlap: the object occupies 0..h above its floor; a fixed part occupies y0..y1 (wall cabinets start high)
      if (f.y0 >= o.h - 0.02 || f.y1 <= 0.02) continue;
      const p = pen(obbCorners(f, 0));
      if (p > tol) issues.push({id: o.id, kind: 'fixed', other: f.id, text: `${o.label} overlaps the built-in "${f.label}" by ${r2(p)} m.`});
    }
  }
  // movable against movable (each pair once, at least one of them changed)
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i];
    if (flat(a)) continue;
    for (let j = i + 1; j < placed.length; j++) {
      const b = placed[j];
      if (flat(b) || a.floor !== b.floor || !(a.changed || b.changed)) continue;
      let p = 0;
      for (const ra of rectsOf(a)) for (const rb of rectsOf(b)) p = Math.max(p, penetration(obbCorners(ra, tol), obbCorners(rb, tol)));
      if (p <= 0) continue;
      // a chair may tuck under a table or desk; allow up to 0.3 m of tuck
      const tuck = (SEATS.has(a.kind) && UNDER.has(b.kind)) || (SEATS.has(b.kind) && UNDER.has(a.kind));
      if (tuck && p < 0.3) continue;
      const mover = a.changed ? a : b;
      const other = mover === a ? b : a;
      issues.push({id: mover.id, kind: 'overlap', other: other.id, text: `${mover.label} overlaps ${other.label} by ${r2(p)} m.`});
    }
  }
  return issues;
}

// ------------------------------------------------------------------ searching for room
const centroid = (poly) => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
const rectPoly = ([x0, z0, x1, z1]) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** True when a footprint fits: on its floor, clear of walls, doors, keep-outs, built-ins and the other pieces. */
export function fitsAt(scene, others, o, {tol = 0.03, doors = doorZones(scene.walls)} = {}) {
  const fl = scene.floors.find((f) => f.id === o.floor);
  if (!fl) return false;
  const rects = rectsOf(o).map((q) => obbCorners(q, tol));
  if (!rects.every((r) => insideFloor(r, fl.polygons))) return false;
  const hit = (poly) => rects.some((r) => penetration(r, poly) > 0);
  for (const w of scene.walls) if (w.floor === o.floor && hit([w.a, w.b])) return false;
  const flat = o.kind === 'textile';
  for (const k of scene.keepouts || []) if (k.floor === o.floor && hit(obbCorners(k))) return false;
  if (flat) return true;
  for (const d of doors) if (d.floor === o.floor && rects.some((r) => penetration(r, obbCorners(d)) > 0.05)) return false;
  for (const f of scene.fixed) {
    if (f.floor !== o.floor || f.y0 >= o.h - 0.02 || f.y1 <= 0.02) continue;
    if (rects.some((r) => penetration(r, obbCorners(f, 0)) > tol)) return false;
  }
  for (const p of others) {
    if (p.floor !== o.floor || p.kind === 'textile' || p.id === o.id) continue;
    for (const q of rectsOf(p)) if (rects.some((r) => penetration(r, obbCorners(q, tol)) > 0)) return false;
  }
  return true;
}

/**
 * Where a footprint fits. query: {floor, width, depth, height, kind, room?, near?: [x, z], facing?, against_wall?, count?}.
 * Scans a 10 cm grid over the room (or the floor) at the given facing or all four, keeps the spots that fit, and returns
 * the best few, spread apart: nearest to `near` (or the room's middle), backed onto a wall when asked, roomiest first on ties.
 */
export function findSpace(scene, others, q) {
  const floor = scene.floors.find((f) => f.id === q.floor);
  if (!floor) return {error: `unknown floor ${q.floor}`};
  let areas = floor.polygons;
  if (q.room) {
    const zg = scene.zones.ground.filter((z) => z.room === q.room).map((z) => rectPoly(z.rect));
    const zu = scene.zones.upper.filter((z) => z.room === q.room).map((z) => z.polygon);
    if (zg.length || zu.length) areas = [...zg, ...zu];
  }
  const xs = areas.flat().map((p) => p[0]);
  const zs = areas.flat().map((p) => p[1]);
  const target = q.near || centroid(areas[0]);
  const facings = Number.isFinite(q.facing) ? [normDeg(q.facing)] : [0, 90, 180, 270];
  const doors = doorZones(scene.walls);
  const walls = scene.walls.filter((w) => w.floor === q.floor);
  const base = {id: q.id || '__probe__', label: 'probe', kind: q.kind || 'other', floor: q.floor, w: q.width, d: q.depth, h: q.height || 0.9, pieces: q.pieces};
  const hits = [];
  const STEP = 0.1;
  for (let x = Math.min(...xs) + STEP / 2; x < Math.max(...xs); x += STEP)
    for (let z = Math.min(...zs) + STEP / 2; z < Math.max(...zs); z += STEP) {
      if (!areas.some((a) => pointInPolygon([x, z], a))) continue;
      for (const facing of facings) {
        const o = {...base, cx: x, cz: z, facing};
        if (!fitsAt(scene, others, o, {doors})) continue;
        // how far the back of the piece is from the nearest wall line
        const [fx, fz] = facingVec(facing);
        const back = [x - fx * (q.depth / 2), z - fz * (q.depth / 2)];
        const backGap = Math.min(...walls.map((w) => pointToSegment(back, w.a, w.b)));
        if (q.against_wall && backGap > 0.15) continue;
        // room to spare at the sides and in front (the back may sit against a wall): grow until it stops fitting
        let room = 0;
        for (const g of [0.15, 0.3, 0.6]) {
          if (fitsAt(scene, others, {...o, cx: x + (fx * g) / 2, cz: z + (fz * g) / 2, w: q.width + 2 * g, d: q.depth + g}, {doors})) room = g;
          else break;
        }
        hits.push({x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, facing, dist: Math.hypot(x - target[0], z - target[1]), backGap, room});
      }
    }
  hits.sort((a, b) => a.dist - b.dist - (b.room - a.room) * 0.4);
  const picks = [];
  for (const h of hits) {
    if (picks.some((p) => Math.hypot(p.x - h.x, p.z - h.z) < 0.35)) continue;
    picks.push(h);
    if (picks.length >= (q.count || 6)) break;
  }
  return {
    candidates: picks.map((h) => ({x: h.x, z: h.z, facing: h.facing, distance_from_target: Math.round(h.dist * 100) / 100, back_to_wall: Math.round(h.backGap * 100) / 100, clear_margin: h.room ? `${h.room} m or more at the sides and in front` : 'tight: under 0.15 m at a side or in front'})),
    searched: `${hits.length} fitting positions in ${q.room || q.floor}`,
  };
}
