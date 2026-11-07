import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { wallMatrix, wallShape, type WallDef } from './walls';
import type { BuiltRoom, V3 } from './types';
import type { LocalCapture } from '../../demos/local-captures';

export interface CaptureMeasurements {
  polygon: number[][];
  reconstruction?: { physicalAlignmentVerified?: boolean };
  walls: { index: number; a: number[]; b: number[]; origin: V3; u: V3; n: V3; length: number; height: number;
    openings: { kind: string; u0: number; u1: number; v0: number; v1: number }[] }[];
  objects: { category: string; center: V3; size: V3; rotY: number }[];
  photos: { position: V3; forward: V3; up: V3; fovY: number; aspect: number }[];
}

/** RoomPlan dimensions are editable schematic geometry, not detailed furniture models. */
export async function buildCapturedRoom(capture: LocalCapture): Promise<BuiltRoom> {
  const response = await fetch(capture.measurements);
  if (!response.ok) throw new Error(`Room measurements: HTTP ${response.status}`);
  const data: CaptureMeasurements = await response.json();
  if (!data.walls?.length || !data.polygon?.length) throw new Error('Capture has no measured room outline');
  if (capture.model) {
    const { buildAuthoredCapture } = await import('./authored-capture');
    return buildAuthoredCapture(capture, data);
  }
  const group = new THREE.Group();
  group.name = 'captured-room';
  const wallMaterial = new THREE.MeshStandardMaterial({ color: '#c2c6bf', roughness: .95 });
  const floorMaterial = new THREE.MeshStandardMaterial({ color: '#a58b6c', roughness: .95, side: THREE.DoubleSide });
  const wallTop = Math.max(...data.walls.map(w => w.height));
  const walls = data.walls.map(w => {
    const def: WallDef = {
      name: String(w.index), origin: new THREE.Vector3(...w.origin), u: new THREE.Vector3(...w.u), n: new THREE.Vector3(...w.n),
      length: w.length, height: w.height, thickness: .08, crown: false, ext: [0, 0], panels: [],
      openings: w.openings.map(o => ({ kind: 'rect', u0: Math.max(0, o.u0), u1: Math.min(w.length, o.u1),
        v0: Math.max(0, o.v0), v1: Math.min(w.height, o.v1) })),
    };
    const geometry = new THREE.ExtrudeGeometry(wallShape(def, 0), { depth: def.thickness, bevelEnabled: false });
    geometry.translate(0, 0, -def.thickness);
    const mesh = new THREE.Mesh(geometry, wallMaterial);
    mesh.applyMatrix4(wallMatrix(def));
    mesh.name = `wall-${w.index}`;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    return { def, group: mesh };
  });
  const outline = new THREE.Shape(data.polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(outline), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'floor'; floor.receiveShadow = true;
  group.add(floor);

  const colors: Record<string, string> = { sofa: '#6f8384', chair: '#8b9b91', storage: '#a58f73' };
  for (const [index, object] of data.objects.entries()) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...object.size),
      new THREE.MeshStandardMaterial({ color: colors[object.category] ?? '#8f9caa', roughness: .85 }));
    mesh.position.set(...object.center); mesh.rotation.y = object.rotY;
    mesh.name = `${object.category}-bounds-${index + 1}`;
    mesh.userData.physics = { type: 'static' };
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  const bounds = new THREE.Box3().setFromObject(group);
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z);
  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight('#fff8ee', '#798982', 2.7));
  const sun = new THREE.DirectionalLight('#ffffff', 2.2);
  sun.position.set(span, wallTop + 4, span / 2);
  lights.add(sun);
  const inside = (x: number, z: number) => {
    let hit = false;
    for (let i = 0, j = data.polygon.length - 1; i < data.polygon.length; j = i++) {
      const [xi, zi] = data.polygon[i], [xj, zj] = data.polygon[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  const firstPhoto = data.photos[0];
  const walk: V3 = firstPhoto ? [firstPhoto.position[0], 1.6, firstPhoto.position[2]] : [0, 1.6, 0];
  return {
    group, lights, walls, ceiling: [], wallTop, modelLabel: 'Measured',
    layout: { ...data, note: 'Measured RoomPlan outline and object bounds. Furniture boxes are approximate; compare with Scan for captured detail. Wall thickness and colors are schematic.' },
    camera: { orbit: [span * 1.1, Math.max(span * 1.2, wallTop + 1), span * 1.4], target: [0, wallTop * .28, 0],
      walk, walkLook: firstPhoto ? [walk[0] + firstPhoto.forward[0], 1.6, walk[2] + firstPhoto.forward[2]] : [0, 1.6, -1] },
    environment: { center: [walk[0], 1.4, walk[2]], intensity: .4 },
    render: { envSize: 64, envBounces: 0, ao: { intensity: .5, halfRes: true } },
    walkable: inside, referenceAvailable: true, referenceKind: 'scan',
    photos: data.photos.map((photo, index) => ({ ...photo, url: `${capture.photos}${String(index).padStart(4, '0')}.jpg` })),
    async loadReference(onProgress) {
      const gltf = await new GLTFLoader().loadAsync(capture.reference, event => {
        if (event.total) onProgress?.(event.loaded / event.total);
      });
      gltf.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const old = Array.isArray(object.material) ? object.material : [object.material];
        old.forEach(material => material.dispose());
        // Inward-facing scan surfaces reveal the interior from outside the room.
        object.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.FrontSide, toneMapped: false });
      });
      return gltf.scene;
    },
  };
}
