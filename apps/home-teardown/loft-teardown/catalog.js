// New furniture Claude can bring in, built from code. Each type has real default dimensions; Claude may resize it,
// colour it and pick a material. The front faces +z, the footprint is centred on the origin, the floor is y = 0.
import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

import {CATALOG, MATERIALS, TYPES} from '../shared/furniture.js';
export {CATALOG, MATERIALS, TYPES};

// Surface character, drawn once per material kind: a weave, bouclé loops, grain, mottling, veins. Used as a colour
// modulation and a bump, so a pale piece still shows its form under the studio light instead of reading as a blank box.
const texCache = new Map();
function surface(kind) {
  if (texCache.has(kind)) return texCache.get(kind);
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const x = cv.getContext('2d');
  let seed = [...kind].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  x.fillStyle = '#f2f2f2';
  x.fillRect(0, 0, N, N);
  const g = (v, a = 1) => `rgba(${v},${v},${v},${a})`;
  if (kind === 'fabric' || kind === 'velvet') {
    for (let i = 0; i < N; i += 6) {
      x.fillStyle = g(175 + rnd() * 40, kind === 'velvet' ? 0.3 : 0.6);
      x.fillRect(0, i, N, 2);
      x.fillRect(i, 0, 2, N);
    }
  } else if (kind === 'boucle') {
    for (let i = 0; i < 1400; i++) {
      x.strokeStyle = g(140 + rnd() * 80, 0.8);
      x.lineWidth = 1.8;
      x.beginPath();
      x.arc(rnd() * N, rnd() * N, 3 + rnd() * 4, 0, Math.PI * 2);
      x.stroke();
    }
  } else if (kind === 'wood' || kind === 'rattan') {
    for (let i = 0; i < N; i++) {
      const v = 200 + 30 * Math.sin(i * 0.35 + Math.sin(i * 0.05) * 4) + rnd() * 18;
      x.fillStyle = g(Math.round(v), 0.8);
      x.fillRect(0, i, N, 1);
    }
    if (kind === 'rattan')
      for (let i = 0; i < N; i += 8) {
        x.fillStyle = g(150, 0.5);
        x.fillRect(i, 0, 2, N);
      }
  } else if (kind === 'leather') {
    for (let i = 0; i < 900; i++) {
      x.fillStyle = g(185 + rnd() * 60, 0.35);
      x.beginPath();
      x.arc(rnd() * N, rnd() * N, 2 + rnd() * 7, 0, Math.PI * 2);
      x.fill();
    }
  } else if (kind === 'marble') {
    x.strokeStyle = g(150, 0.45);
    for (let i = 0; i < 9; i++) {
      x.lineWidth = 0.6 + rnd() * 1.6;
      x.beginPath();
      let px = rnd() * N, py = 0;
      x.moveTo(px, py);
      while (py < N) x.lineTo((px += (rnd() - 0.5) * 30), (py += 12 + rnd() * 20));
      x.stroke();
    }
  } else if (kind === 'metal' || kind === 'appliance') {
    for (let i = 0; i < N; i++) {
      x.fillStyle = g(215 + rnd() * 25, 0.6);
      x.fillRect(0, i, N, 1);
    }
  } else return null;
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.5, 1.5);
  t.anisotropy = 4;
  texCache.set(kind, t);
  return t;
}

const matCache = new Map();
function mat(color, kind = 'fabric') {
  const key = `${color}|${kind}`;
  if (matCache.has(key)) return matCache.get(key);
  const c = new THREE.Color(color);
  // a near-white piece blows out on the pale studio floor: cap its lightness, keep its hue
  const hsl = {};
  c.getHSL(hsl);
  if (hsl.l > 0.76 && kind !== 'emissive') c.setHSL(hsl.h, hsl.s, 0.76);
  const p = {color: c, roughness: 0.8, metalness: 0};
  const m = {
    fabric: {roughness: 0.92, sheen: 0.35, sheenRoughness: 0.8, sheenColor: c.clone().multiplyScalar(0.9)},
    velvet: {roughness: 0.75, sheen: 0.9, sheenRoughness: 0.35, sheenColor: c.clone().lerp(new THREE.Color('#fff'), 0.3)},
    boucle: {roughness: 1, sheen: 0.4, sheenRoughness: 0.9, sheenColor: c.clone()},
    leather: {roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.5},
    wood: {roughness: 0.62},
    metal: {roughness: 0.38, metalness: 0.85},
    appliance: {roughness: 0.32, metalness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.25},
    glass: {roughness: 0.06, transparent: true, opacity: 0.35, depthWrite: false},
    marble: {roughness: 0.22, clearcoat: 0.5, clearcoatRoughness: 0.2},
    rattan: {roughness: 0.88},
    lacquer: {roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.1},
    emissive: {roughness: 0.6, emissive: c, emissiveIntensity: 0.9},
  }[kind] || {};
  const tex = surface(kind);
  const out = new THREE.MeshPhysicalMaterial({...p, ...m, vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, ...(tex ? {map: tex, bumpMap: tex, bumpScale: kind === 'boucle' ? 2.2 : 0.8} : {})});
  matCache.set(key, out);
  return out;
}
const INK = new THREE.LineBasicMaterial({color: '#2a2521', transparent: true, opacity: 0.55});

/** Contact shade toward the floor and an ink outline on hard edges: what makes a plain mesh read as furniture. */
function finishPiece(g, h) {
  // form at any distance: every vertex darkens toward the floor (a soft contact shade), flat pieces stay even
  g.updateMatrixWorld(true);
  const vw = new THREE.Vector3();
  g.traverse((m) => {
    if (!m.isMesh) return;
    m.castShadow = !m.material.transparent;
    m.receiveShadow = true;
    const pos = m.geometry.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      vw.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const t = Math.min(1, Math.max(0, vw.y / Math.max(h, 0.05)));
      const k = h < 0.06 ? 0.96 : 0.68 + 0.32 * Math.sqrt(t);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
    }
    m.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  });
  // an ink outline on every hard edge, in one draw
  {
    g.updateMatrixWorld(true);
    const pts = [];
    const v = new THREE.Vector3();
    g.traverse((m) => {
      if (!m.isMesh || m.material.transparent) return;
      const e = new THREE.EdgesGeometry(m.geometry, 40);
      const pos = e.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        pts.push(v.x, v.y, v.z);
      }
      e.dispose();
    });
    if (pts.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      g.add(new THREE.LineSegments(geo, INK));
    }
  }
}

export function buildFurniture(spec) {
  const T = CATALOG[spec.type] || CATALOG.armchair;
  const w = Math.max(0.1, spec.width || T.w);
  const d = Math.max(0.02, spec.depth || T.d);
  const h = Math.max(0.01, spec.height || T.h);
  const main = mat(spec.color || '#c8c0b4', spec.material || 'fabric');
  const acc = mat(spec.accent || '#2b2622', /metal/.test(spec.material) ? 'metal' : /glass/.test(spec.material) ? 'metal' : 'wood');
  const g = new THREE.Group();
  const box = (bw, bh, bd, x, y, z, m = main, r = 0.02) => {
    const rr = Math.min(r, bw / 2.01, bh / 2.01, bd / 2.01);
    const mesh = new THREE.Mesh(rr > 0.002 ? new RoundedBoxGeometry(bw, bh, bd, 2, rr) : new THREE.BoxGeometry(bw, bh, bd), m);
    mesh.position.set(x, y + bh / 2, z);
    g.add(mesh);
    return mesh;
  };
  const cyl = (rt, rb, ch, x, y, z, m = acc, seg = 20) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, ch, seg), m);
    mesh.position.set(x, y + ch / 2, z);
    g.add(mesh);
    return mesh;
  };
  const legs = (lw, ld, lh, r = 0.018, inset = 0.06) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(r, r * 0.8, lh, sx * (lw / 2 - inset), 0, sz * (ld / 2 - inset));
  };
  const sofa = (sw, sd, sh, cushions) => {
    const lh = 0.1, seatH = 0.42, arm = Math.min(0.17, sw * 0.12), backD = 0.2;
    legs(sw, sd, lh, 0.02, 0.08);
    box(sw, seatH - lh - 0.12, sd, 0, lh, 0, main, 0.04);
    box(sw, sh - lh, backD, 0, lh, -sd / 2 + backD / 2, main, 0.06);
    for (const sx of [-1, 1]) box(arm, 0.62 - lh, sd, sx * (sw / 2 - arm / 2), lh, 0, main, 0.06);
    const iw = (sw - 2 * arm) / cushions;
    for (let i = 0; i < cushions; i++) box(iw - 0.015, 0.14, sd - backD - 0.04, -sw / 2 + arm + iw * (i + 0.5), seatH - 0.13, backD / 2 + 0.01, main, 0.06);
    for (let i = 0; i < cushions; i++) {
      const c = box(iw - 0.03, sh - seatH - 0.06, 0.16, -sw / 2 + arm + iw * (i + 0.5), seatH, -sd / 2 + backD + 0.07, main, 0.07);
      c.rotation.x = -0.12;
    }
  };
  const caseGoods = (cw, cd, ch, drawers, cols = 1, lh = 0.08) => {
    if (lh > 0) legs(cw, cd, lh, 0.015, 0.05);
    box(cw, ch - lh, cd, 0, lh, 0, main, 0.012);
    const fh = (ch - lh - 0.04) / drawers, fw = (cw - 0.04) / cols;
    for (let c = 0; c < cols; c++)
      for (let i = 0; i < drawers; i++) {
        box(fw - 0.012, fh - 0.012, 0.012, -cw / 2 + 0.02 + fw * (c + 0.5), lh + 0.02 + fh * i + 0.006, cd / 2, main, 0.004);
        box(Math.min(0.16, fw * 0.3), 0.012, 0.018, -cw / 2 + 0.02 + fw * (c + 0.5), lh + 0.02 + fh * (i + 0.5), cd / 2 + 0.012, acc, 0.004);
      }
  };
  const foliage = (cx, cy, cz, r, n, seed) => {
    const leaf = mat(spec.color && spec.type.includes('plant') ? spec.color : '#4f7a46', 'fabric');
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r * (0.45 + 0.35 * rnd()), 1), leaf);
      m.position.set(cx + (rnd() - 0.5) * r * 1.3, cy + (rnd() - 0.3) * r * 1.2, cz + (rnd() - 0.5) * r * 1.3);
      m.scale.y = 0.8;
      g.add(m);
    }
  };

  switch (spec.type) {
    case 'sofa':
    case 'loveseat':
      sofa(w, d, h, w > 1.8 ? 3 : 2);
      break;
    case 'sectional_l': {
      // the sofa runs along the back (depth sd); the chaise runs forward on the +x end, centred at z = sd / 2
      const sd = Math.min(0.95, d * 0.55);
      const cw = Math.min(0.95, w * 0.36);
      const cl = d - sd;
      g.add(groupOf(() => sofa(w, sd, h, 3)).translateZ(-(d - sd) / 2));
      box(cw, 0.29, cl, w / 2 - cw / 2, 0.01, sd / 2, main, 0.04);
      box(cw - 0.2, 0.14, cl - 0.02, w / 2 - cw / 2 - 0.08, 0.29, sd / 2, main, 0.06);
      box(0.17, 0.61, cl, w / 2 - 0.085, 0.01, sd / 2, main, 0.06);
      break;
    }
    case 'armchair':
    case 'lounge_chair':
      sofa(w, d, h, 1);
      break;
    case 'chaise':
      legs(w, d, 0.1, 0.02, 0.08);
      box(w, 0.3, d, 0, 0.1, 0, main, 0.05);
      box(w, h - 0.1, 0.22, 0, 0.1, -d / 2 + 0.11, main, 0.08).rotation.x = -0.25;
      box(w - 0.03, 0.12, d * 0.8, 0, 0.4, 0.06, main, 0.06);
      break;
    case 'ottoman':
      legs(w, d, 0.08, 0.016, 0.06);
      box(w, h - 0.08, d, 0, 0.08, 0, main, 0.06);
      break;
    case 'pouf': {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2 * 0.92, h, 28), main);
      m.position.y = h / 2;
      g.add(m);
      break;
    }
    case 'bench':
      box(w, 0.05, d, 0, h - 0.05, 0, acc.color ? main : main, 0.01);
      for (const sx of [-1, 1]) box(0.05, h - 0.05, d - 0.04, sx * (w / 2 - 0.08), 0, 0, acc, 0.005);
      break;
    case 'dining_chair':
      legs(w, d, 0.44, 0.014, 0.04);
      box(w, 0.05, d, 0, 0.44, 0, main, 0.015);
      box(w, h - 0.49, 0.035, 0, 0.49, -d / 2 + 0.02, main, 0.012).rotation.x = -0.08;
      break;
    case 'bar_stool':
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const l = cyl(0.012, 0.012, h - 0.04, Math.cos(a) * w * 0.33, 0, Math.sin(a) * w * 0.33);
        l.rotation.z = Math.cos(a) * 0.06;
        l.rotation.x = -Math.sin(a) * 0.06;
      }
      cyl(w / 2, w / 2, 0.05, 0, h - 0.05, 0, main, 28);
      {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(w * 0.33, 0.008, 6, 28), acc);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.28;
        g.add(ring);
      }
      break;
    case 'office_chair':
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const arm = box(w * 0.42, 0.03, 0.04, Math.cos(a) * w * 0.21, 0.04, Math.sin(a) * w * 0.21, acc, 0.01);
        arm.rotation.y = -a;
        cyl(0.025, 0.025, 0.04, Math.cos(a) * w * 0.42, 0, Math.sin(a) * w * 0.42, acc, 10);
      }
      cyl(0.025, 0.025, 0.4, 0, 0.07, 0);
      box(w * 0.78, 0.08, d * 0.75, 0, 0.46, 0.02, main, 0.04);
      box(w * 0.72, h - 0.62, 0.06, 0, 0.6, -d * 0.33, main, 0.03).rotation.x = -0.1;
      break;
    case 'coffee_table':
    case 'desk':
    case 'console_table':
    case 'dining_table': {
      const top = spec.type === 'coffee_table' ? 0.04 : 0.035;
      box(w, top, d, 0, h - top, 0, main, 0.008);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.045, h - top, 0.045, sx * (w / 2 - 0.07), 0, sz * (d / 2 - 0.07), acc, 0.004);
      if (spec.type === 'desk') caseGoodsAt(g, () => caseGoods(0.4, d - 0.08, h - top - 0.02, 3, 1, 0), w / 2 - 0.28, 0);
      break;
    }
    case 'round_coffee_table':
    case 'round_dining_table':
    case 'side_table':
      cyl(w / 2, w / 2, 0.035, 0, h - 0.035, 0, main, 40);
      cyl(0.04, 0.05, h - 0.035, 0, 0, 0);
      cyl(Math.min(0.3, w * 0.32), Math.min(0.3, w * 0.32), 0.025, 0, 0, 0, acc, 32);
      break;
    case 'bed':
    case 'daybed': {
      const frameH = 0.32;
      box(w, frameH, d, 0, 0.05, 0, acc, 0.02);
      legs(w, d, 0.05, 0.02, 0.1);
      box(w - 0.06, 0.22, d - 0.08, 0, 0.05 + frameH, 0.02, mat('#f4f1ea', 'fabric'), 0.06);
      box(w - 0.02, 0.06, d * 0.62, 0, 0.05 + frameH + 0.2, d * 0.18, main, 0.05);
      if (spec.type === 'bed') {
        box(w + 0.04, h, 0.08, 0, 0, -d / 2 - 0.02, acc, 0.03);
        for (const sx of [-1, 1]) box(w / 2 - 0.12, 0.14, 0.34, sx * (w / 4), 0.05 + frameH + 0.22, -d / 2 + 0.25, mat('#ffffff', 'fabric'), 0.06);
      } else {
        box(w, 0.42, 0.12, 0, 0.37, -d / 2 + 0.06, acc, 0.03);
        for (const sx of [-1, 1]) box(0.12, 0.3, d, sx * (w / 2 - 0.06), 0.37, 0, acc, 0.03);
      }
      break;
    }
    case 'nightstand':
      caseGoods(w, d, h, 2, 1, 0.1);
      break;
    case 'dresser':
      caseGoods(w, d, h, 3, 2, 0.08);
      break;
    case 'sideboard':
    case 'tv_console':
      caseGoods(w, d, h, 1, Math.max(2, Math.round(w / 0.45)), 0.1);
      break;
    case 'bookshelf': {
      const t = 0.025, n = Math.max(3, Math.round(h / 0.38));
      for (const sx of [-1, 1]) box(t, h, d, sx * (w / 2 - t / 2), 0, 0, main, 0.004);
      box(w, h, 0.012, 0, 0, -d / 2 + 0.006, main, 0.002);
      const bookCols = ['#b5523b', '#2f4b5e', '#d9c7a0', '#5d6b4a', '#8a6f9e', '#c48a3a'];
      for (let i = 0; i <= n; i++) {
        const y = (i * (h - t)) / n;
        box(w - 2 * t, t, d, 0, y, 0, main, 0.003);
        if (i < n) {
          let x = -w / 2 + t + 0.02;
          let k = i * 3;
          while (x < w / 2 - t - 0.12 && (k - i * 3) < 9) {
            const bw = 0.03 + ((k * 37) % 5) * 0.008, bh = (h / n) * (0.55 + ((k * 13) % 4) * 0.08);
            box(bw, bh, d * 0.7, x + bw / 2, y + t, 0.0, mat(bookCols[k % bookCols.length], 'fabric'), 0.003);
            x += bw + 0.004 + (k % 4 === 3 ? 0.08 : 0);
            k++;
          }
        }
      }
      break;
    }
    case 'wardrobe':
      caseGoods(w, d, h, 1, 2, 0.05);
      break;
    case 'bar_cart':
      for (const y of [0.18, h - 0.04]) box(w, 0.02, d, 0, y, 0, main, 0.004);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(0.01, 0.01, h, sx * (w / 2 - 0.02), 0, sz * (d / 2 - 0.02));
      for (const sx of [-1, 1]) {
        const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 8, 20), acc);
        wheel.position.set(sx * (w / 2 - 0.02), 0.06, d / 2 - 0.02);
        wheel.rotation.y = Math.PI / 2;
        g.add(wheel);
      }
      break;
    case 'floor_lamp': {
      cyl(w * 0.4, w * 0.42, 0.025, 0, 0, 0, acc, 28);
      cyl(0.011, 0.011, h - 0.3, 0, 0.025, 0, acc, 10);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.36, w * 0.5, 0.3, 28, 1, true), mat(spec.color || '#efe6d4', 'fabric'));
      shade.material.side = THREE.DoubleSide;
      shade.position.y = h - 0.15;
      g.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), mat('#fff3d6', 'emissive'));
      bulb.position.y = h - 0.2;
      g.add(bulb);
      break;
    }
    case 'rug':
      box(w, h, d, 0, 0, 0, mat(spec.accent || '#8b7d6b', 'fabric'), 0.003);
      box(w - 0.12, h + 0.002, d - 0.12, 0, 0, 0, main, 0.002);
      break;
    case 'round_rug': {
      const a = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 48), mat(spec.accent || '#8b7d6b', 'fabric'));
      a.position.y = h / 2;
      const b = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 - 0.08, w / 2 - 0.08, h + 0.002, 48), main);
      b.position.y = h / 2 + 0.001;
      g.add(a, b);
      break;
    }
    case 'plant':
    case 'tall_plant': {
      const potH = Math.min(0.42, h * 0.32), potR = Math.min(w * 0.38, 0.24);
      cyl(potR, potR * 0.8, potH, 0, 0, 0, mat(spec.accent || '#d8cfc2', 'marble'), 24);
      if (spec.type === 'tall_plant') {
        cyl(0.018, 0.024, h * 0.55, 0, potH, 0, mat('#6b5236', 'wood'), 8);
        foliage(0, h * 0.68, 0, w * 0.45, 9, 7);
      } else foliage(0, potH + (h - potH) * 0.45, 0, w * 0.48, 7, 3);
      break;
    }
    case 'tv': {
      const sh = 0.82, sy = h - sh;
      box(w, sh, 0.05, 0, sy, 0, mat('#0d0f12', 'lacquer'), 0.006);
      for (const sx of [-1, 1]) cyl(0.014, 0.014, sy, sx * w * 0.32, 0, 0, acc, 10);
      box(w * 0.75, 0.02, d, 0, 0, 0, acc, 0.004);
      break;
    }
    case 'piano':
      box(w, h * 0.66, d, 0, h * 0.34, 0, main, 0.01);
      box(w, 0.04, d + 0.2, 0, h * 0.66, 0.1, main, 0.008);
      box(w - 0.08, 0.02, 0.16, 0, h * 0.7, d / 2 + 0.08, mat('#f7f4ee', 'lacquer'), 0.004);
      for (const sx of [-1, 1]) box(0.05, h * 0.34, d + 0.2, sx * (w / 2 - 0.025), 0, 0.1, main, 0.004);
      break;
    case 'room_divider':
      for (let i = 0; i < 3; i++) {
        const p = box(w / 3 - 0.02, h - 0.04, 0.03, -w / 3 + (i * w) / 3, 0.04, 0, main, 0.006);
        p.rotation.y = (i - 1) * 0.35;
      }
      break;
    case 'mirror':
      box(w, h, 0.04, 0, 0, 0, acc, 0.01);
      box(w - 0.06, h - 0.06, 0.01, 0, 0.03, 0.022, new THREE.MeshStandardMaterial({color: '#cfd8dc', metalness: 1, roughness: 0.04}), 0.002);
      break;
    case 'washer':
    case 'dryer': {
      // a front-loader: cabinet, the control strip across the top with a dial and display, the round door, kick plate
      const paint = mat(spec.color || '#4a4d51', 'appliance');
      const dark = mat(spec.accent || '#1e2022', 'lacquer');
      const chrome = mat('#c4c8cc', 'metal');
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(0.022, 0.022, 0.03, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.08), dark, 12);
      box(w, h - 0.03, d - 0.05, 0, 0.03, -0.025, paint, 0.025);
      box(w - 0.02, 0.16, 0.02, 0, h - 0.18, d / 2 - 0.045, dark, 0.006);
      box(0.13, 0.04, 0.006, 0.04, h - 0.125, d / 2 - 0.032, mat('#8fd0ff', 'emissive'), 0.002);
      const knob = cyl(0.036, 0.036, 0.028, w / 2 - 0.13, 0, 0, chrome, 28);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(w / 2 - 0.13, h - 0.1, d / 2 - 0.022);
      if (spec.type === 'washer') box(0.2, 0.08, 0.012, -w / 2 + 0.15, h - 0.14, d / 2 - 0.03, paint, 0.006);
      const cy = (h - 0.2) * 0.52 + 0.06;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.034, 14, 48), spec.type === 'washer' ? chrome : dark);
      ring.position.set(0, cy, d / 2 - 0.035);
      g.add(ring);
      const glassM = spec.type === 'washer' ? new THREE.MeshPhysicalMaterial({color: '#2b3440', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.55}) : mat('#24272b', 'lacquer');
      const glass = new THREE.Mesh(new THREE.CircleGeometry(0.19, 48), glassM);
      glass.position.set(0, cy, d / 2 - 0.03);
      g.add(glass);
      if (spec.type === 'washer') {
        const drum = new THREE.Mesh(new THREE.CircleGeometry(0.17, 48), mat('#6d7277', 'metal'));
        drum.position.set(0, cy, d / 2 - 0.09);
        g.add(drum);
      }
      box(w - 0.06, 0.07, 0.012, 0, 0.04, d / 2 - 0.04, dark, 0.004);
      break;
    }
    default:
      box(w, h, d, 0, 0, 0, main, 0.03);
  }
  finishPiece(g, h);
  return {group: g, w, d, h, kind: T.kind};

  function groupOf(fn) {
    const before = g.children.length;
    fn();
    const sub = new THREE.Group();
    for (const c of g.children.splice(before)) sub.add(c);
    return sub;
  }
  function caseGoodsAt(parent, fn, x, z) {
    const sub = groupOf(fn);
    sub.position.set(x, 0, z);
    parent.add(sub);
  }
}

// ------------------------------------------------------------------ catalogue pieces: open models fitted to real sizes
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

const gltfCache = new Map();
const loadGltf = (url) => {
  if (!gltfCache.has(url)) gltfCache.set(url, new GLTFLoader().loadAsync(url));
  return gltfCache.get(url);
};
const FRONT_TURN = {'+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2};

// ------------------------------------------------------------------ AI-made models (shared/model3d.js part lists)
const genCache = new Map();
const loadGenerated = (id, v = '') => {
  const key = `${id}|${v}`;
  if (!genCache.has(key)) genCache.set(key, fetch(`/catalog-generated/${encodeURIComponent(id)}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))));
  return genCache.get(key);
};
const GEN_KIND = {stone: 'marble', ceramic: 'lacquer', plastic: 'lacquer', paper: 'fabric', light: 'emissive'};
/**
 * A part list as a mesh. Parts keep the colours Claude read from the photo; choosing another colour swatch repaints
 * the primary parts (the upholstery, or a cabinet's body) and leaves legs, frames and hardware as they were.
 */
export function buildGenerated(rec, recolorHex) {
  const g = new THREE.Group();
  for (const p of rec.parts) {
    const {x: sx, y: sy, z: sz} = p.size;
    let geo;
    if (p.shape === 'rounded_box') {
      const r = Math.min(p.corner_radius || 0, sx / 2.01, sy / 2.01, sz / 2.01);
      geo = r > 0.002 ? new RoundedBoxGeometry(sx, sy, sz, 3, r) : new THREE.BoxGeometry(sx, sy, sz);
    } else if (p.shape === 'cylinder' || p.shape === 'cone') {
      geo = new THREE.CylinderGeometry(p.shape === 'cone' ? 0.5 * (p.taper ?? 0) : 0.5, 0.5, 1, 28);
      geo.scale(sx, sy, sz);
    } else if (p.shape === 'sphere') {
      geo = new THREE.SphereGeometry(0.5, 28, 18);
      geo.scale(sx, sy, sz);
    } else if (p.shape === 'capsule') {
      const r = Math.min(sx, sz) / 2;
      geo = new THREE.CapsuleGeometry(r, Math.max(0.001, sy - 2 * r), 8, 20);
      geo.scale(sx / (2 * r), 1, sz / (2 * r));
    } else geo = new THREE.BoxGeometry(sx, sy, sz);
    const color = recolorHex && p.role === 'primary' ? recolorHex : p.color;
    const mesh = new THREE.Mesh(geo, mat(color, GEN_KIND[p.material] || p.material));
    mesh.position.set(p.center.x, p.center.y, p.center.z);
    // extrinsic X, then Y, then Z: the order shared/model3d.js fits the bounding box with
    mesh.rotation.set(p.rotation.x * (Math.PI / 180), p.rotation.y * (Math.PI / 180), p.rotation.z * (Math.PI / 180), 'ZYX');
    g.add(mesh);
  }
  finishPiece(g, rec.h);
  return g;
}

/**
 * A catalogue item as a 3D piece: the procedural stand-in at the item's real size at once, swapped for its open model
 * (when it has one) as soon as that loads. The model is turned so its front faces +z, then fitted to width, depth and
 * height; per-axis stretch is limited to 25% around a uniform scale so a stand-in never looks squashed.
 */
export function buildCatalogPiece(item, colorHex, onSwap) {
  const color = colorHex || item.colors?.[0]?.hex;
  const fallback = buildFurniture({type: item.build, width: item.w, depth: item.d, height: item.h, color, accent: item.accent, material: item.material});
  const group = new THREE.Group();
  group.add(fallback.group);
  // an AI-made model replaces the borrowed stand-in; a piece's own open model still comes first
  if (item.gen && !(item.model?.url && !item.model.standIn)) {
    loadGenerated(item.id, item.genAt)
      .then((rec) => {
        const g = buildGenerated(rec, colorHex && colorHex !== item.colors?.[0]?.hex ? colorHex : null);
        group.remove(fallback.group);
        group.add(g);
        onSwap?.(group);
      })
      .catch((e) => console.warn('[catalog] AI model failed, keeping the stand-in', item.id, e.message));
    return {group, w: item.w, d: item.d, h: item.h, kind: item.kind};
  }
  if (item.model?.url)
    loadGltf(item.model.url)
      .then((gltf) => {
        const wrap = new THREE.Group();
        const inner = gltf.scene.clone(true);
        // sample models can carry their own lights; the studio lights the home
        const lights = [];
        inner.traverse((o) => o.isLight && lights.push(o));
        for (const l of lights) l.parent.remove(l);
        inner.rotation.y = FRONT_TURN[item.model.front || '+z'] ?? 0;
        wrap.add(inner);
        wrap.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(wrap);
        const size = box.getSize(new THREE.Vector3());
        let s = [item.w / size.x, item.h / size.y, item.d / size.z];
        const u = Math.cbrt(s[0] * s[1] * s[2]);
        if (item.model.fit === 'uniform') s = [u, u, u];
        else s = s.map((v) => Math.min(u * 1.25, Math.max(u / 1.25, v)));
        wrap.scale.set(...s);
        const c = box.getCenter(new THREE.Vector3());
        wrap.position.set(-c.x * s[0], -box.min.y * s[1], -c.z * s[2]);
        wrap.traverse((m) => {
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = true;
          // a stand-in takes the chosen colour: its texture's average colour is measured and divided out
          if (item.model.recolor && color) {
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            m.material = mats.map((mt) => recolor(mt, color));
            if (m.material.length === 1) m.material = m.material[0];
          }
          // a colour variant tints the model's main material when the entry names it
          const tint = item.model.tint;
          if (tint && color) {
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            m.material = mats.map((mt) => {
              if (!mt?.name || !mt.name.toLowerCase().includes(tint.toLowerCase())) return mt;
              const cl = mt.clone();
              cl.color = new THREE.Color(color);
              return cl;
            });
            if (m.material.length === 1) m.material = m.material[0];
          }
        });
        group.remove(fallback.group);
        group.add(wrap);
        onSwap?.(group);
      })
      .catch((e) => console.warn('[catalog] model failed, keeping the stand-in', item.id, e.message));
  return {group, w: item.w, d: item.d, h: item.h, kind: item.kind};
}

const recolorCache = new Map();
/**
 * A clone of the material painted in the target colour while keeping the model's own detail: the texture's luminance
 * (grain, weave, baked shadow) is normalised around its mean and multiplied by the target, so a dark espresso dresser
 * can become "white stain" without its hue blowing out. Cached per texture and colour.
 */
function recolor(mt, hex) {
  if (!mt?.isMaterial) return mt;
  const cl = mt.clone();
  const tex = mt.map;
  if (!tex?.image) {
    cl.color = new THREE.Color(hex);
    return cl;
  }
  const key = `${tex.uuid}|${hex}`;
  if (!recolorCache.has(key)) {
    let out = null;
    try {
      const img = tex.image;
      const N = Math.min(1024, img.width || 1024);
      const cv = document.createElement('canvas');
      cv.width = cv.height = N;
      const x = cv.getContext('2d', {willReadFrequently: true});
      x.drawImage(img, 0, 0, N, N);
      const data = x.getImageData(0, 0, N, N);
      const d = data.data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const mean = Math.max(1, sum / (d.length / 4));
      const t = new THREE.Color(hex);
      const [tr, tg, tb] = [t.r, t.g, t.b].map((v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)));
      for (let i = 0; i < d.length; i += 4) {
        // keep detail, soften extremes so a near-black texture does not turn into flat noise
        const k = Math.min(1.6, Math.max(0.45, 0.35 + 0.65 * ((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / mean)));
        d[i] = Math.min(255, tr * k);
        d[i + 1] = Math.min(255, tg * k);
        d[i + 2] = Math.min(255, tb * k);
      }
      x.putImageData(data, 0, 0);
      out = new THREE.CanvasTexture(cv);
      out.colorSpace = THREE.SRGBColorSpace;
      out.flipY = tex.flipY;
      out.wrapS = tex.wrapS;
      out.wrapT = tex.wrapT;
      out.anisotropy = 4;
      out.channel = tex.channel;
    } catch (e) {
      out = null;
    }
    recolorCache.set(key, out);
  }
  const map = recolorCache.get(key);
  if (map) {
    cl.map = map;
    cl.color = new THREE.Color('#ffffff');
  } else cl.color = new THREE.Color(hex);
  return cl;
}

// ------------------------------------------------------------------ thumbnails for the catalogue panel
let thumbR = null;
const thumbCache = new Map();
const thumbQueue = [];
let thumbBusy = false;
/** A small rendered picture of an item (procedural stand-in or its model), made once and cached. */
export function thumbnail(item, colorHex, cb) {
  const key = `${item.id}|${colorHex || ''}|${item.gen ? item.genAt || 'g' : ''}`;
  if (thumbCache.has(key)) return cb(thumbCache.get(key));
  thumbQueue.push({item, colorHex, key, cb});
  pumpThumbs();
}
function pumpThumbs() {
  if (thumbBusy || !thumbQueue.length) return;
  thumbBusy = true;
  const {item, colorHex, key, cb} = thumbQueue.shift();
  if (!thumbR) {
    thumbR = new THREE.WebGLRenderer({antialias: true, alpha: true, preserveDrawingBuffer: true});
    thumbR.setSize(160, 160);
    thumbR.outputColorSpace = THREE.SRGBColorSpace;
    thumbR.toneMapping = THREE.NeutralToneMapping;
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#fffaf2', '#cdbfa8', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 1.8);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const render = (obj) => {
    scene.add(obj);
    const r = Math.max(item.w, item.h, item.d);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    cam.position.set(r * 1.5, item.h * 0.5 + r * 1.05, r * 1.9);
    cam.lookAt(0, item.h * 0.42, 0);
    thumbR.render(scene, cam);
    const url = thumbR.domElement.toDataURL('image/png');
    thumbCache.set(key, url);
    cb(url);
  };
  const piece = buildCatalogPiece(item, colorHex, (g) => {
    // the model arrived: picture it instead of the stand-in
    scene.remove(piece.group);
    render(g);
  });
  render(piece.group);
  thumbBusy = false;
  requestAnimationFrame(pumpThumbs);
}
