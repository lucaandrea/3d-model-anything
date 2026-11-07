import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { LocalCapture } from '../../demos/local-captures';
import type { CaptureMeasurements } from './captured-room';
import type { BuiltRoom, V3 } from './types';
import type { WallDef } from './walls';
import { batchStatic } from './batch';

/** A private authored model retains the capture's coordinates and reference photographs. */
export async function buildAuthoredCapture(capture: LocalCapture, data: CaptureMeasurements): Promise<BuiltRoom> {
  const { scene: group } = await new GLTFLoader().loadAsync(capture.model!);
  const walls: BuiltRoom['walls'] = [];
  const ceiling: THREE.Object3D[] = [];
  group.traverse(object => {
    const index = object.userData.capture_wall_index;
    // Low guards and parapets define a visible floor edge even when the
    // full-height exterior walls are cut away for the dollhouse view.
    if (typeof index === 'number' && object.userData.capture_keep_visible !== true) {
      const source = data.walls.find(wall => wall.index === index);
      if (source) {
        const def: WallDef = { name: String(index), origin: new THREE.Vector3(...source.origin),
          u: new THREE.Vector3(...source.u), n: new THREE.Vector3(...source.n), length: source.length,
          height: source.height, thickness: .15, crown: false, panels: [], openings: [] };
        walls.push({ def, group: object });
      }
    }
    if (object.userData.capture_ceiling) ceiling.push(object);
    if (object.userData.capture_item) object.userData.physics = { type: 'static' };
    if (object instanceof THREE.Mesh) {
      object.castShadow = object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => {
        if (material instanceof THREE.MeshStandardMaterial) {
          // Keep dark authored materials readable without losing their surface response.
          material.envMapIntensity = .55;
        }
      });
    }
  });
  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight('#fffdf8', '#8a8f91', 2.1));
  const key = new THREE.DirectionalLight('#fff4df', 2.5);key.position.set(4,7,3);lights.add(key);
  const fill = new THREE.DirectionalLight('#dbe7ff', 1.2);fill.position.set(-3,4,-2);lights.add(fill);
  const inside = (x: number, z: number) => {
    let hit = false;
    for (let i=0,j=data.polygon.length-1;i<data.polygon.length;j=i++) {
      const [xi,zi]=data.polygon[i],[xj,zj]=data.polygon[j];
      if ((zi>z)!==(zj>z) && x<(xj-xi)*(z-zi)/(zj-zi)+xi) hit=!hit;
    }
    return hit;
  };
  const photo=data.photos[0];
  const walk: V3=photo ? [photo.position[0],1.6,photo.position[2]] : [0,1.6,0];
  const footprint = new THREE.Box2();
  data.polygon.forEach(([x,z]) => footprint.expandByPoint(new THREE.Vector2(x,z)));
  const center = footprint.getCenter(new THREE.Vector2());
  const size = footprint.getSize(new THREE.Vector2());
  const span = Math.max(size.x,size.y,3);
  return {
    group,lights,walls,ceiling,wallTop:2.45,modelLabel:'Rebuilt',
    layout:{...data,note:data.reconstruction?.physicalAlignmentVerified === false
      ? 'Authored geometry corrected from review notes and existing scans. Wall positions and fine details include estimates; this model is not physically calibrated.'
      : 'Measured scan outline with a photo-guided Blender reconstruction. Hidden surfaces and fine details are approximated; compare against Scan and the original photos.'},
    camera:{orbit:[center.x+span*1.3,span*1.1,center.y-span*.25],target:[center.x,1,center.y],walk,walkLook:[walk[0],1.3,walk[2]-1]},
    environment:{center:[.8,1.3,.3],intensity:.4},
    render:{envSize:64,envBounces:0,ao:{intensity:.7,halfRes:true}},
    bloom:{strength:.12,radius:.3,threshold:3},
    exposure:1.05,walkable:inside,referenceAvailable:true,referenceKind:'scan',
    photos:data.photos.map((p,index)=>({...p,url:`${capture.photos}${String(index).padStart(4,'0')}.jpg`})),
    optimize(options) { return batchStatic(group,[...walls.map(w=>w.group),...ceiling],{mergeDynamic:options?.static}); },
    async loadReference(onProgress) {
      const gltf=await new GLTFLoader().loadAsync(capture.reference,event=>{if(event.total)onProgress?.(event.loaded/event.total);});
      gltf.scene.traverse(object=>{
        if (!(object instanceof THREE.Mesh)) return;
        const old=Array.isArray(object.material)?object.material:[object.material];old.forEach(material=>material.dispose());
        object.material=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.FrontSide,toneMapped:false});
      });
      return gltf.scene;
    },
  };
}
