// The home, written out for Claude. Everything here is deterministic for a given scene so the system prompt stays
// byte-identical between requests and the prompt cache holds: floors and rooms, every wall with its door openings,
// keep-out zones, the built-ins, the movable pieces in their original places, and an ASCII plan of each floor.
import {doorZones, obbCorners, pointInPolygon, pointToSegment} from '../shared/layout-check.js';
import {CATALOG, MATERIALS} from '../shared/furniture.js';

const f2 = (v) => String(Math.round(v * 100) / 100);
const pt = ([x, z]) => `(${f2(x)}, ${f2(z)})`;
const ROOM_LABEL = {office: 'Entrance & office', 'guest-bath': 'Guest bath', hall: 'Hall & closet', stairs: 'Stairs', kitchen: 'Kitchen', dining: 'Dining', living: 'Living room', bedroom: 'Bedroom & landing', 'dressing-corridor': 'Dressing corridor', 'main-bath': 'Ensuite'};

export const RULES = `You are an interior layout designer working on a measured 3D reconstruction of the user's own home, a two-floor loft. You rearrange its existing movable furniture, and you can store pieces and bring in new ones from a fixed catalogue. You work on a draft of the layout that the server keeps, through four tools, and a geometry checker tests every change against the walls, the door keep-clear zones, the stairs, the built-ins and the other pieces.

Working method:
- Plan in a few lines, then act. For a request that covers several areas (a media wall, then the seating, then the dining area), make one apply_changes call per area and read its result before the next. Small steps are better than one large one: each reply has an output limit, and you have a token budget for the whole task.
- Use find_space whenever a piece needs a position. Give its floor, room, width, depth and height, a target point and a facing if they matter, and against_wall for sideboards, consoles, beds and shelves. It answers with spots that fit, so do not work out clearances in your head. Pass ignore_id when you are moving an existing piece.
- apply_changes applies a step to the draft at once and reports the conflicts of the pieces it touched. Fix a conflict with another apply_changes that moves those pieces. Moves give final absolute centres and facings; ids of pieces you add come back as a1, a2 and so on, so you can move or store them later.
- Use inspect to read back positions when you need them, for example after the conversation has been summarised.
- New furniture comes from the catalogue: search_catalog finds real products from about fifty retailers (IKEA, West Elm, Crate & Barrel, Article, Room & Board and others) with their real dimensions, colours and prices, and generic pieces. Add a piece by its catalog_id and pick one of its listed colours. Prefer real products; use a generic piece only when nothing in the catalogue fits. Each result says whether it has a 3D model, an AI-made 3D model, or none yet (the user then sees a generic shape until a model is made); between otherwise equal choices, prefer one with a 3D model. Name the brand and product in your summary.
- Refurnishing a room: keep the pieces that suit the new direction, store the movable pieces you replace, and add catalogue pieces for the rest. Keep the room practical: enough seating, a surface within reach of each seat, light where people read or work, and a rug that the main group sits on. For the whole home, go room by room, with one or two apply_changes calls per room, then finish once every room is done. Respect any budget the homeowner states and add up the prices you choose.
- When the request is done, call finish_layout with a title and the summary. If conflicts remain it lists them; fix them and call it again.
- In a conversation with several requests, each new request starts from the layout described in its message, which is authoritative: the homeowner may have chosen another layout or moved pieces by hand since your last answer.

Design guidance:
- Think in plan. A footprint is a rectangle centred on (x, z); width runs across the piece's front and depth along the direction it faces. At facing 90 or 270 the width runs along z. Walls are zero-thickness lines in this data, but the real partitions are about 10 cm thick, so keep footprints at least 6 cm from a wall line.
- Built-ins stay where they are: kitchen cabinetry and appliances, bathroom fixtures, closets and wardrobes, the fireplace, lights, wall art, mirrors, doors. Treat them as obstacles.
- Keep real circulation: about 0.9 m for the main routes (entrance to the hall and stairs, kitchen, dining and living), 0.6 m beside a bed and behind dining chairs. Keep the door keep-clear zones, the foot and the top of the stairs, and the patio door clear.
- Respect what each piece is for: seating faces its focus (the media screen, the fireplace, the patio view or each other in a conversation group); a bed has its headboard against a wall with access from both long sides where possible; nightstands flank beds; desks want a wall or a window; dining chairs tuck at their table (a seat may overlap its table or desk by up to 0.3 m); rugs go under the seating group or the dining table.
- Change only what the request calls for and leave everything else exactly where it is. Pieces of kind "small" (bins, parcels, devices) usually stay put.
- For different furniture, store the piece being replaced (list its id in remove) and add the new piece from the catalogue with realistic dimensions, a colour and a material that suit the request. Moving a piece to the other floor is allowed but only do it when the request asks for it.
- The summary is for the homeowner: two to four plain sentences on what changed and why, naming pieces the way they would.

Catalogue for new pieces (type: default width x depth x height in metres):
${Object.entries(CATALOG).map(([k, v]) => `${k}: ${v.w} x ${v.d} x ${v.h}`).join('; ')}.
Materials: ${MATERIALS.join(', ')}. Colours are #rrggbb; accent is the colour of legs, frames or trim.`;

/** ASCII plan at 0.25 m: '#' wall, 'D' door keep-clear, 'S' stairs keep-out, 'B' built-in on the floor, '.' open floor. */
function asciiPlan(scene, floorId, [x0, z0, x1, z1]) {
  const CELL = 0.25;
  const floor = scene.floors.find((f) => f.id === floorId);
  const walls = scene.walls.filter((w) => w.floor === floorId);
  const doors = doorZones(scene.walls).filter((d) => d.floor === floorId).map((d) => obbCorners(d));
  const keep = (scene.keepouts || []).filter((k) => k.floor === floorId).map((k) => obbCorners(k));
  const built = scene.fixed.filter((f) => f.floor === floorId && f.y0 < 0.4).map((f) => obbCorners(f));
  const cols = Math.ceil((x1 - x0) / CELL);
  const rows = Math.ceil((z1 - z0) / CELL);
  const lines = [];
  const head = Array.from({length: cols}, (_, c) => {
    const x = x0 + (c + 0.5) * CELL;
    return Math.abs(x - Math.round(x)) <= CELL / 2 + 1e-9 && x - Math.round(x) < 0 ? String(Math.abs(Math.round(x)) % 10) : ' ';
  }).join('');
  lines.push(`       x: ${head}   (digit = |x| at whole metres; left edge x = ${f2(x0)}, right edge x = ${f2(x1)})`);
  for (let r = 0; r < rows; r++) {
    const z = z0 + (r + 0.5) * CELL;
    let row = '';
    for (let c = 0; c < cols; c++) {
      const x = x0 + (c + 0.5) * CELL;
      const p = [x, z];
      let ch = ' ';
      if (floor.polygons.some((poly) => pointInPolygon(p, poly))) {
        ch = '.';
        if (built.some((b) => pointInPolygon(p, b))) ch = 'B';
        if (keep.some((b) => pointInPolygon(p, b))) ch = 'S';
        if (doors.some((b) => pointInPolygon(p, b))) ch = 'D';
      }
      if (walls.some((w) => pointToSegment(p, w.a, w.b) < CELL * 0.55)) ch = '#';
      row += ch;
    }
    lines.push(`z=${(z >= 0 ? '+' : '') + z.toFixed(2).padStart(5)} ${row}`);
  }
  return lines.join('\n');
}

export function sceneText(scene) {
  const out = [];
  out.push(`# The home\nUnits: ${scene.units}. ${scene.frame}`);
  out.push(`\n## Floors`);
  for (const f of scene.floors) out.push(`- ${f.id} (elevation ${f2(f.elevation)} m): ${f.polygons.map((p) => p.map(pt).join(' ')).join(' | ')}`);
  out.push(`The upper floor is a loft over the -z part of the ground floor. The living room (z > 2.95) is double height with no floor above it, and the stairwell is a hole in the upper floor.`);
  out.push(`\n## Rooms`);
  for (const z of scene.zones.ground) out.push(`- ground · ${ROOM_LABEL[z.room] || z.room} (${z.room}): x ${f2(z.rect[0])} to ${f2(z.rect[2])}, z ${f2(z.rect[1])} to ${f2(z.rect[3])}`);
  for (const z of scene.zones.upper) out.push(`- upper · ${ROOM_LABEL[z.room] || z.room} (${z.room}): polygon ${z.polygon.map(pt).join(' ')}`);
  out.push(`\n## Walls (floor: start -> end, height; door openings in metres along the wall from its start)`);
  for (const w of scene.walls) {
    const extra = [w.doors.length ? `doors ${w.doors.map(([a, b]) => `${f2(a)}-${f2(b)}`).join(', ')}` : '', w.openings.length ? `${w.openings.map((o) => `${o.kind} ${f2(o.u[0])}-${f2(o.u[1])}`).join(', ')}` : ''].filter(Boolean).join('; ');
    out.push(`- ${w.floor}: ${pt(w.a)} -> ${pt(w.b)}, h ${f2(w.h)}${extra ? `; ${extra}` : ''}`);
  }
  out.push(`\n## Keep-out zones`);
  for (const k of scene.keepouts) out.push(`- ${k.floor}: ${k.label}, centre ${pt([k.cx, k.cz])}, ${f2(k.w)} (x) by ${f2(k.d)} (z)`);
  out.push(`Doors also keep a 0.6 m deep clear zone on both sides of every opening.`);
  out.push(`\n## Built-ins and fixed parts (they never move; height range above their floor)`);
  for (const f of scene.fixed) out.push(`- ${f.floor} · ${ROOM_LABEL[f.room] || f.room}: ${f.label}; centre ${pt([f.cx, f.cz])}, ${f2(f.w)} (x) by ${f2(f.d)} (z), from ${f2(f.y0)} to ${f2(f.y1)} m`);
  out.push(`\n## Movable pieces in their ORIGINAL positions (id | name | kind | floor | room | centre | width x depth x height | facing | carries)`);
  for (const i of scene.items) {
    const parts = i.pieces?.length ? ` | L-shaped, one piece made of ${i.pieces.map((q) => `${f2(q.w)} x ${f2(q.d)} at ${f2(q.dx)} across, ${f2(q.dz)} forward`).join(' + ')} (offsets from the centre in its own frame; the corner between them is open floor)` : '';
    out.push(`${i.id} | ${i.label} | ${i.kind} | ${i.floor} | ${i.room} | ${pt([i.cx, i.cz])} | ${f2(i.w)} x ${f2(i.d)} x ${f2(i.h)} | ${i.facing} |${i.carries.length ? ` ${i.carries.join(', ')}` : ''}${parts}`);
  }
  out.push(`\n## Plan of the ground floor, rows run from the entrance (-z, top) to the patio (+z, bottom)\n${asciiPlan(scene, 'ground', [-2.75, -7.5, 2.75, 7.5])}`);
  out.push(`\n## Plan of the upper floor\n${asciiPlan(scene, 'upper', [-3.0, -7.25, 2.75, 4.0])}`);
  return out.join('\n');
}

export function userText({request, base, baseTitle, history}, scene, {fresh = true} = {}) {
  const byId = new Map(scene.items.map((i) => [i.id, i]));
  const out = [];
  if (!fresh) out.push('A new request in our conversation. The layout below is where it starts from, whatever was decided before.\n');
  if (fresh && history?.length) {
    out.push(`Earlier requests that led to the current layout (oldest first):`);
    history.forEach((h, i) => out.push(`${i + 1}. "${h.request}" -> "${h.title}"`));
    out.push('');
  }
  out.push(`Current layout: "${baseTitle || 'Original'}".`);
  if (!base.moved.length && !base.removed.length && !base.added.length && !base.removedFixedLabels?.length) out.push(`Every movable piece is in its original position as listed in the scene.`);
  else {
    out.push(`Differences from the original positions in the scene (everything else is where the scene lists it):`);
    for (const m of base.moved) out.push(`- moved: ${m.id} ${byId.get(m.id)?.label ?? ''} -> centre ${pt([m.x, m.z])}, facing ${m.facing}, ${m.floor} floor`);
    for (const id of base.removed) out.push(`- stored (out of the home): ${id} ${byId.get(id)?.label ?? ''}`);
    for (const f of base.removedFixedLabels || []) out.push(`- built-in removed by the homeowner (no longer an obstacle): ${f}`);
    for (const a of base.added) out.push(`- added earlier: ${a.id} | ${a.label}${a.catalog_id ? ` [${a.catalog_id}]` : ''} | ${a.type} | ${a.floor} | centre ${pt([a.x, a.z])} | ${f2(a.width)} x ${f2(a.depth)} x ${f2(a.height)} | facing ${a.facing} | ${a.color} ${a.material}`);
  }
  out.push(`\nRequest from the homeowner:\n"""${request}"""\n\nWork through it step by step with the tools, then call finish_layout.`);
  return out.join('\n');
}

/** What the summariser keeps when the conversation is compacted. The server re-sends the draft itself afterwards. */
export const COMPACT_INSTRUCTIONS = `Summarise this interior-layout conversation so the work can continue from the summary alone. Keep, in this order:
1. Every request the homeowner made, in their words, and any preferences or constraints they stated (styles, colours, pieces to keep or avoid).
2. For the request in progress: your plan, which steps are done, which remain, and the reason for each decision that is not obvious.
3. Ids and final positions only for the pieces you changed in the request in progress, and any conflicts still open. The server re-sends the full current draft after this summary, so do not list unchanged pieces.
4. For earlier, finished requests: the layout titles and a one-line description of each.
Write plain prose and short lists. Do not call tools; reply with the summary text only.`;

/** The first message after a compaction in the middle of a request: the authoritative draft and what to do next. */
export function continuationText(request, draft) {
  return [
    'The conversation above was summarised to save space. The server kept the working draft; this is its exact state.',
    `Request in progress:\n"""${request}"""`,
    `Changes in the draft so far, relative to the layout this request started from:\n${draft.summary()}`,
    'Continue with the remaining steps (inspect any piece you need), then call finish_layout.',
  ].join('\n\n');
}
