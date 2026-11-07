// AI-made 3D models for catalogue pieces that have none: Claude reads the product photo and the listed facts and
// answers with a part list (boxes, rounded boxes, cylinders, cones, spheres, capsules), each with a material, colour
// and role. This module holds the schema Claude must fill and the post-processing shared by the server (validation,
// before saving) and the page (building the mesh): the parts are scaled so their bounding box is exactly the listed
// width x depth x height, set on the floor and centred, and parts that float free of the rest are reported.
//
// Frame: metres, y up, the footprint centred on the origin, the floor at y = 0, the FRONT facing +z (the side you sit
// on or open from); x runs across the width.

export const SHAPES = ['box', 'rounded_box', 'cylinder', 'cone', 'sphere', 'capsule'];
export const PART_MATERIALS = ['fabric', 'velvet', 'boucle', 'leather', 'wood', 'metal', 'glass', 'marble', 'stone', 'rattan', 'lacquer', 'ceramic', 'plastic', 'paper', 'light'];
export const ROLES = ['primary', 'secondary', 'accent'];

const XYZ = {type: 'object', additionalProperties: false, required: ['x', 'y', 'z'], properties: {x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'}}};
export const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['front', 'parts'],
  properties: {
    front: {type: 'string', description: 'one sentence: what faces +z and how the piece is built'},
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role', 'shape', 'material', 'color', 'center', 'size', 'rotation', 'corner_radius', 'taper'],
        properties: {
          name: {type: 'string'},
          role: {type: 'string', enum: ROLES},
          shape: {type: 'string', enum: SHAPES},
          material: {type: 'string', enum: PART_MATERIALS},
          color: {type: 'string', description: '#rrggbb'},
          center: XYZ,
          size: XYZ,
          rotation: XYZ,
          corner_radius: {type: 'number'},
          taper: {type: 'number'},
        },
      },
    },
  },
};

const D2R = Math.PI / 180;
// Euler XYZ (three.js order) applied to a local offset
function rotate([x, y, z], r) {
  const [a, b, c] = [r.x * D2R, r.y * D2R, r.z * D2R];
  let [x1, y1, z1] = [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  [x1, z1] = [x1 * Math.cos(b) + z1 * Math.sin(b), -x1 * Math.sin(b) + z1 * Math.cos(b)];
  [x1, y1] = [x1 * Math.cos(c) - y1 * Math.sin(c), x1 * Math.sin(c) + y1 * Math.cos(c)];
  return [x1, y1, z1];
}
/** A part's axis-aligned box in the model frame: [min, max]. */
export function partBox(p) {
  const h = [p.size.x / 2, p.size.y / 2, p.size.z / 2];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const o = rotate([i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]], p.rotation);
    const c = [p.center.x + o[0], p.center.y + o[1], p.center.z + o[2]];
    for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], c[k])), (hi[k] = Math.max(hi[k], c[k]));
  }
  return [lo, hi];
}
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Cleans a part list and fits it to the listed size. Returns {parts, scale, issues}: scale is the per-axis factor
 * that was applied (near 1 when Claude drew it to size), issues are problems worth one repair round.
 */
export function fitModel(model, {w, d, h}) {
  const issues = [];
  let parts = (model.parts || [])
    .filter((p) => SHAPES.includes(p.shape) && p.size && p.center)
    .map((p) => ({
      ...p,
      material: PART_MATERIALS.includes(p.material) ? p.material : 'fabric',
      role: ROLES.includes(p.role) ? p.role : 'secondary',
      color: HEX.test(p.color) ? p.color.toLowerCase() : '#b9ae9c',
      size: {x: Math.abs(p.size.x) || 0.01, y: Math.abs(p.size.y) || 0.01, z: Math.abs(p.size.z) || 0.01},
      rotation: {x: p.rotation?.x || 0, y: p.rotation?.y || 0, z: p.rotation?.z || 0},
      corner_radius: Math.max(0, p.corner_radius || 0),
      taper: p.shape === 'cone' ? Math.min(1, Math.max(0, p.taper ?? 0)) : 1,
    }));
  if (parts.length < 3) issues.push(`only ${parts.length} parts: model the piece's real construction (base or legs, body, top, cushions, arms...)`);
  if (parts.length > 90) issues.push(`${parts.length} parts: keep it under 90 by merging small details`);
  parts = parts.slice(0, 120);
  if (!parts.length) return {parts, scale: [1, 1, 1], issues};

  // the drawn size against the listed size
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const [a, b] = partBox(p);
    for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], a[k])), (hi[k] = Math.max(hi[k], b[k]));
  }
  const drawn = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const scale = [w / drawn[0], h / drawn[1], d / drawn[2]];
  const off = scale.map((s, k) => (s > 1.35 || s < 0.74 ? `${'xyz'[k]} ${(drawn[k] * 100).toFixed(0)} cm drawn for ${([w, h, d][k] * 100).toFixed(0)} cm listed` : '')).filter(Boolean);
  if (off.length) issues.push(`overall size is off (${off.join('; ')}): draw the parts at the listed size`);
  const mid = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  // scale each part's own axes by the world axis it most lies along, so a leg turned on its side scales correctly
  const axisScale = (r) => {
    const out = [];
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const t = rotate(v, r).map(Math.abs);
      out.push(scale[t.indexOf(Math.max(...t))]);
    }
    return out;
  };
  parts = parts.map((p) => {
    const s = axisScale(p.rotation);
    const minScale = Math.min(...s);
    return {
      ...p,
      center: {x: (p.center.x - mid[0]) * scale[0], y: (p.center.y - mid[1]) * scale[1], z: (p.center.z - mid[2]) * scale[2]},
      size: {x: p.size.x * s[0], y: p.size.y * s[1], z: p.size.z * s[2]},
      corner_radius: p.corner_radius * minScale,
    };
  });

  // every part should rest on the floor or touch another part (1.5 cm tolerance); report the ones that float
  const boxes = parts.map(partBox);
  const touch = (a, b) => [0, 1, 2].every((k) => a[0][k] <= b[1][k] + 0.015 && b[0][k] <= a[1][k] + 0.015);
  const reached = new Set(boxes.map((b, i) => (b[0][1] <= 0.015 ? i : -1)).filter((i) => i >= 0));
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < boxes.length; i++)
      if (!reached.has(i) && [...reached].some((j) => touch(boxes[i], boxes[j]))) {
        reached.add(i);
        grew = true;
      }
  }
  const floating = parts.filter((_, i) => !reached.has(i)).map((p) => p.name);
  if (floating.length && parts.length > 2) issues.push(`these parts float, touching neither the floor nor another part: ${floating.slice(0, 12).join(', ')}`);
  return {parts, scale, issues};
}
