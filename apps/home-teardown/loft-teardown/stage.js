// The studio: a pale warm ground, one sun with soft shadows over the whole site (home, piles and trays), a room-like
// environment for the reconstructed materials, and the overlays that carry the one accent colour: boxes around parts
// in flight, the selection, and footprints in the rearrange mode.
import * as THREE from 'three';
import {obbCorners, rectsOf} from '../shared/layout-check.js';

const D2R = Math.PI / 180;

export const COL = {bg: '#efe9df', ground: '#e7dfd2', tray: '#f7f3ec', pad: '#ece4d7', accent: '#e3562a', warn: '#c8322b', ink: '#2a2521', blue: '#3c79a8', green: '#2fa36b'};

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.bg);
  scene.fog = new THREE.Fog(COL.bg, 70, 140);
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 400);

  // environment: a soft studio box so glossy and metal parts have something to reflect
  {
    const env = new THREE.Scene();
    env.background = new THREE.Color('#e6ddcf');
    const panel = (w, h, pos, k) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({color: new THREE.Color(1, 0.98, 0.95).multiplyScalar(k), side: THREE.DoubleSide}));
      m.position.copy(pos);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    panel(14, 14, new THREE.Vector3(0, 14, 2), 2.2);
    panel(4, 14, new THREE.Vector3(-12, 4, 6), 2.6);
    panel(4, 14, new THREE.Vector3(12, 4, -4), 1.8);
    panel(20, 3, new THREE.Vector3(0, 2, 14), 1.3);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 32), new THREE.MeshBasicMaterial({color: '#cdbfa8', side: THREE.DoubleSide}));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2;
    env.add(floor);
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(env, 0.03).texture;
    scene.environmentIntensity = 0.75;
    pm.dispose();
  }
  const SUN_DIR = new THREE.Vector3(-0.42, 0.84, 0.34).normalize();
  const sun = new THREE.DirectionalLight('#fff4e6', 2.1);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, {left: -26, right: 26, top: 14, bottom: -14, near: 1, far: 90});
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.position.copy(SUN_DIR).multiplyScalar(40).add(new THREE.Vector3(-4, 0, 0));
  sun.target.position.set(-4, 0, 0);
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#fffaf2', '#d6c6ab', 0.85);
  scene.add(hemi);

  const groundMat = new THREE.MeshStandardMaterial({color: COL.ground, roughness: 1, metalness: 0});
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.085;
  ground.receiveShadow = true;
  scene.add(ground);

  // trays and pads for the torn-down layout, faded in with the teardown
  const trayGroup = new THREE.Group();
  scene.add(trayGroup);
  const trayMat = new THREE.MeshStandardMaterial({color: COL.tray, roughness: 1, transparent: true, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4});
  const padMat = new THREE.MeshStandardMaterial({color: COL.pad, roughness: 1, transparent: true, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4});
  const edgeMat = new THREE.LineBasicMaterial({color: COL.accent, transparent: true, opacity: 0});
  const setTrays = (trays, piles, pad) => {
    trayGroup.clear();
    const rect = (x, z, w, d, mat) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x + w / 2, -0.078, z + d / 2);
      m.receiveShadow = true;
      trayGroup.add(m);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d)), edgeMat);
      e.rotation.x = -Math.PI / 2;
      e.position.copy(m.position).setY(-0.07);
      trayGroup.add(e);
    };
    for (const t of trays) rect(t.x, t.z, t.w, t.d, trayMat);
    for (const p of piles) rect(p.x - p.w / 2 - 0.3, p.z - p.d / 2 - 0.3, p.w + 0.6, p.d + 0.6, padMat);
    if (pad) rect(pad.x - pad.w / 2 - 0.3, pad.z - pad.d / 2 - 0.3, pad.w + 0.6, pad.d + 0.6, padMat);
  };
  const setTrayOpacity = (k) => {
    trayMat.opacity = 0.95 * k;
    padMat.opacity = 0.95 * k;
    edgeMat.opacity = 0.55 * k;
    trayGroup.visible = k > 0.001;
  };

  // accent boxes around parts in flight: one buffer, rewritten each frame
  const MAXB = 96;
  const flyGeo = new THREE.BufferGeometry();
  flyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXB * 24 * 3), 3));
  flyGeo.setDrawRange(0, 0);
  const fly = new THREE.LineSegments(flyGeo, new THREE.LineBasicMaterial({color: COL.accent, transparent: true, opacity: 0.85, depthTest: false}));
  fly.renderOrder = 10;
  fly.frustumCulled = false;
  scene.add(fly);
  const EDGES = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const corner = new THREE.Vector3();
  const writeBox = (arr, n, box, matrix) => {
    const c = [];
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(matrix);
      c.push(corner.x, corner.y, corner.z);
    }
    for (let e = 0; e < 24; e++) {
      const k = EDGES[e] * 3;
      arr[(n * 24 + e) * 3] = c[k];
      arr[(n * 24 + e) * 3 + 1] = c[k + 1];
      arr[(n * 24 + e) * 3 + 2] = c[k + 2];
    }
  };
  const setFlying = (list) => {
    const arr = flyGeo.attributes.position.array;
    let n = 0;
    for (const {box, matrix} of list) {
      if (n >= MAXB) break;
      writeBox(arr, n++, box, matrix);
    }
    flyGeo.attributes.position.needsUpdate = true;
    flyGeo.setDrawRange(0, n * 24);
  };

  // selection box
  const selGeo = new THREE.BufferGeometry();
  selGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
  const sel = new THREE.LineSegments(selGeo, new THREE.LineBasicMaterial({color: COL.accent, depthTest: false, transparent: true}));
  sel.renderOrder = 11;
  sel.frustumCulled = false;
  sel.visible = false;
  scene.add(sel);
  const setSelection = (box, matrix) => {
    sel.visible = !!box;
    if (!box) return;
    writeBox(selGeo.attributes.position.array, 0, box, matrix);
    selGeo.attributes.position.needsUpdate = true;
  };

  // footprints in the rearrange mode: changed pieces in the accent, conflicts in red, the rest faint
  const fpGroup = new THREE.Group();
  fpGroup.renderOrder = 9;
  scene.add(fpGroup);
  const fpMats = {
    base: new THREE.LineBasicMaterial({color: '#9b8f80', transparent: true, opacity: 0.45, depthTest: false}),
    changed: new THREE.LineBasicMaterial({color: COL.accent, transparent: true, opacity: 0.95, depthTest: false}),
    issue: new THREE.LineBasicMaterial({color: COL.warn, transparent: true, opacity: 1, depthTest: false}),
  };
  const setFootprints = (list) => {
    fpGroup.clear();
    for (const k of ['base', 'changed', 'issue']) {
      const pts = [];
      for (const f of list) {
        if (f.state !== k) continue;
        for (const q of rectsOf(f)) {
          const c = obbCorners(q);
          for (let i = 0; i < 4; i++) {
            const [ax, az] = c[i];
            const [bx, bz] = c[(i + 1) % 4];
            pts.push(ax, f.y + 0.03, az, bx, f.y + 0.03, bz);
          }
        }
      }
      if (!pts.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, fpMats[k]);
      l.renderOrder = 9;
      l.frustumCulled = false;
      fpGroup.add(l);
    }
  };

  const size = {w: 1600, h: 900};
  // a wider frame shows more to the sides at the same size; a narrower one keeps the 16:9 width in view
  const lens = (c, w, h) => {
    c.aspect = w / h;
    c.fov = c.aspect >= 16 / 9 ? 30 : (2 * Math.atan((Math.tan(15 * D2R) * (16 / 9)) / c.aspect)) / D2R;
    c.updateProjectionMatrix();
  };
  const resize = (w, h, pr) => {
    size.w = w;
    size.h = h;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    lens(camera, w, h);
  };
  // cam: {tx, ty, tz, az, el, d} in radians and metres; sx, sy shift the image so the subject clears the panels
  const aim = (c, cam, w, h) => {
    c.position.set(cam.tx + cam.d * Math.cos(cam.el) * Math.sin(cam.az), cam.ty + cam.d * Math.sin(cam.el), cam.tz + cam.d * Math.cos(cam.el) * Math.cos(cam.az));
    c.up.set(0, 1, 0);
    if (cam.el > 1.5) c.up.set(-Math.sin(cam.az), 0, -Math.cos(cam.az));
    c.lookAt(cam.tx, cam.ty, cam.tz);
    c.setViewOffset(w, h, -(cam.sx || 0), -(cam.sy || 0), w, h);
    c.updateMatrixWorld();
  };
  const place = (cam) => aim(camera, cam, size.w, size.h);
  // how many times over a box fits inside a clear area {l, r, t, b} of a w x h frame, seen from cam
  const probe = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 400);
  const pc = new THREE.Vector3();
  const fitIn = (cam, box, w, h, area) => {
    lens(probe, w, h);
    aim(probe, cam, w, h);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      pc.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(probe);
      if (pc.z > 1) return 0;
      const x = (pc.x * 0.5 + 0.5) * w;
      const y = (-pc.y * 0.5 + 0.5) * h;
      x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
    }
    return Math.min((area.r - area.l) / Math.max(1, x1 - x0), (area.b - area.t) / Math.max(1, y1 - y0));
  };
  const frame = (cam) => {
    place(cam);
    renderer.render(scene, camera);
  };
  const pv = new THREE.Vector3();
  const project = (x, y, z) => {
    pv.set(x, y, z).project(camera);
    if (pv.z > 1) return null;
    return [(pv.x * 0.5 + 0.5) * size.w, (-pv.y * 0.5 + 0.5) * size.h];
  };
  const setQuality = ({shadow}) => {
    if (shadow === 0) {
      sun.castShadow = false;
      return;
    }
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadow, shadow);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  };
  return {renderer, scene, camera, sun, resize, frame, place, fitIn, project, size, setQuality, setTrays, setTrayOpacity, setFlying, setSelection, setFootprints};
}
