// Makes a 3D model for a catalogue piece that has none. Claude Opus 5.5 looks at the product photo (when the harvest
// found one) and the listed facts (size, seat and arm heights, materials, shape notes) and returns a part list under
// a strict JSON schema. The list is fitted to the exact listed size (shared/model3d.js); if parts float or the drawn
// size is far off, Claude gets one repair round in the same conversation. The result is saved to
// catalog/generated/<id>.json, which the page builds into a mesh and the catalogue then marks "AI 3D".
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {fitModel, MODEL_SCHEMA, PART_MATERIALS} from '../shared/model3d.js';
import {readKey} from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GEN_DIR = path.join(HERE, '../catalog/generated');
export const MODEL = 'claude-opus-5-5';
export const EFFORT = process.env.MODEL3D_EFFORT || 'high';
const USD = {in: 4 / 1e6, out: 20 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 5 / 1e6};
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,120}$/;
export const genFile = (id) => (SAFE_ID.test(id) ? path.join(GEN_DIR, `${id}.json`) : null);

export const SYSTEM = `You build 3D models of real furniture products for a home-planning app. A model is a list of solid primitive parts that, together, read as this exact product at room scale: right silhouette, proportions, construction and colours. You get the retailer's facts (listed dimensions, materials, shape notes) and usually a product photo.

Frame: metres. y is up and the floor is y = 0. The footprint is centred on x = 0, z = 0. The front of the piece faces +z (the side you sit on, face or open drawers from); x runs across its width. The whole model must fill exactly the listed width (x), depth (z) and height (y): put the outermost parts at those limits. Respect every listed sub-dimension (seat height, seat depth, arm height, back height, leg height).

Shapes (size is always the full extent along the part's own x, y, z before rotation):
- box: a hard-edged block (case goods, tabletops, shelves, plinths, drawer fronts, frames).
- rounded_box: a block with rounded edges; corner_radius in metres (up to half its smallest side). Use for upholstery, cushions, padded arms and backs, soft-edged tops.
- cylinder: size.x and size.z are the diameters, size.y the length along its own y. Rotate 90 degrees about x or z to lay it along z or x (rails, stretchers, bolsters).
- cone: a cylinder whose top diameter is taper times its bottom diameter (taper 0 is a point, 0.6 a tapered leg). Lamp shades, tapered legs, planters.
- sphere: an ellipsoid with the given diameters (knobs, globe shades, rounded poufs).
- capsule: a cylinder with hemispherical ends; size.y is the full length. Tubular frames, rolled arms, bolsters.
rotation is in degrees, Euler XYZ. Keep 0 unless the product has splayed or angled legs, a reclined back, or an arc.

Construction: parts must touch (legs meet the underside of the frame or top, cushions sit on the deck, shades meet their stems); small overlaps are good, gaps are not. Use 8 to 60 parts: enough to show legs or base, frame, seat and back cushions as separate pieces, arms, tops, shelves, doors and drawer fronts with pulls, stretchers. Leave out stitching, screws and tiny trim.

Materials and colour: material is one of ${PART_MATERIALS.join(', ')} (light is an emissive bulb or lit shade). color is #rrggbb as the photo shows this variant. role: primary for the piece's main colour surface (upholstery, or the body of a cabinet or table), which the user can recolour; secondary for other large surfaces (legs, frame, a contrasting top); accent for hardware and small details.

If the photo shows another configuration than the listed size (a longer sofa, an added chaise), follow the listed size and description. Without a photo, build the typical design the facts describe. front: one sentence naming what faces +z and how the piece is built.`;

const client = () => {
  const {key} = readKey('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return new Anthropic({apiKey: key});
};
const cm = (m) => `${Math.round(m * 1000) / 10} cm`;
export function factsText(item) {
  const extra = Object.entries(item.dims || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v} cm`);
  return [
    `Product: ${item.brand} ${item.name}`,
    `Type: ${item.build.replace(/_/g, ' ')}${item.retail_category && item.retail_category !== item.build ? ` (listed as ${item.retail_category})` : ''}`,
    `Listed size: width ${cm(item.w)}, depth ${cm(item.d)}, height ${cm(item.h)}${item.size_note ? ` (${item.size_note})` : ''}`,
    item.seat_h ? `Seat height: ${cm(item.seat_h)}` : '',
    extra.length ? `Other listed dimensions: ${extra.join(', ')}` : '',
    item.materials?.length ? `Materials: ${item.materials.join(', ')}` : '',
    item.colors?.length ? `Colours offered: ${item.colors.map((c) => `${c.name} (${c.hex})`).join(', ')}; the default is ${item.colors[0].name}` : '',
    item.shape_notes ? `Shape notes from the product page: ${item.shape_notes}` : '',
    item.style?.length ? `Style: ${item.style.join(', ')}` : '',
    `Model it at width ${item.w.toFixed(3)} m (x), depth ${item.d.toFixed(3)} m (z), height ${item.h.toFixed(3)} m (y).`,
  ].filter(Boolean).join('\n');
}

// the photo as Claude fetches it; some retailer CDNs refuse that, so the server can fetch it once and send the bytes
async function photoBlock(url, mode) {
  if (!url) return null;
  if (mode === 'url') return {type: 'image', source: {type: 'url', url}};
  const r = await fetch(url, {headers: {Accept: 'image/jpeg,image/png,image/webp;q=0.9', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'}, signal: AbortSignal.timeout(20000)});
  const type = (r.headers.get('content-type') || '').split(';')[0];
  if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new Error(`photo ${r.status} ${type}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 4.5e6) throw new Error('photo too large');
  return {type: 'image', source: {type: 'base64', media_type: type, data: buf.toString('base64')}};
}
export const requestParams = (messages) => ({
  model: MODEL,
  max_tokens: 32000,
  system: SYSTEM,
  output_config: {effort: EFFORT, format: {type: 'json_schema', schema: MODEL_SCHEMA}},
  messages,
});
const costOf = (u) => u.input_tokens * USD.in + u.output_tokens * USD.out + (u.cache_read_input_tokens || 0) * USD.cacheRead + (u.cache_creation_input_tokens || 0) * USD.cacheWrite;
const answer = (msg) => {
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to model this piece');
  if (msg.stop_reason === 'max_tokens') throw new Error('the model description ran out of room');
  return JSON.parse(msg.content.find((b) => b.type === 'text').text);
};

/** A user turn for an item: its photo (by URL, by bytes, or none) and its facts. */
export async function firstTurn(item, photo = 'url') {
  let img = null;
  try {
    img = await photoBlock(item.image, photo);
  } catch {}
  return {role: 'user', content: [...(img ? [img] : []), {type: 'text', text: `${img ? 'The photo shows this product.\n' : 'No photo is available.\n'}${factsText(item)}`}]};
}

/** Generates, fits, repairs once if needed, saves. Returns the saved record. */
export async function generateModel(item, {onStatus} = {}) {
  const c = client();
  const usage = {input: 0, output: 0, usd: 0};
  const call = async (messages) => {
    for (let attempt = 0; ; attempt++) {
      try {
        // server-side fallbacks: a declined request is re-run on a fallback model in the same call
        const stream = c.beta.messages.stream({...requestParams(messages), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'});
        const msg = await stream.finalMessage();
        usage.input += msg.usage.input_tokens;
        usage.output += msg.usage.output_tokens;
        usage.usd += costOf(msg.usage);
        return msg;
      } catch (e) {
        const retry = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError || (e instanceof Anthropic.APIError && e.status === 529);
        if (!retry || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
      }
    }
  };
  onStatus?.('reading the photo and the listed size');
  let photo = item.image ? 'url' : 'none';
  let messages = [await firstTurn(item, photo)];
  let msg;
  try {
    msg = await call(messages);
  } catch (e) {
    // the CDN refused Claude's fetch: send the photo's bytes instead, then without a photo at all
    if (!(e instanceof Anthropic.BadRequestError) || photo !== 'url') throw e;
    photo = 'base64';
    messages = [await firstTurn(item, photo)];
    if (!messages[0].content.some((b) => b.type === 'image')) photo = 'none';
    msg = await call(messages);
  }
  let raw = answer(msg);
  let fit = fitModel(raw, item);
  let rounds = 1;
  if (fit.issues.length) {
    onStatus?.('fixing the model');
    // append-only: the whole assistant turn (thinking included) stays as it was
    messages = [...messages, {role: 'assistant', content: msg.content}, {role: 'user', content: `Checked against the listed size and construction, the part list has problems:\n- ${fit.issues.join('\n- ')}\nReturn the complete corrected part list.`}];
    try {
      const m2 = await call(messages);
      const raw2 = answer(m2);
      const fit2 = fitModel(raw2, item);
      if (fit2.issues.length <= fit.issues.length) (raw = raw2), (fit = fit2);
      rounds = 2;
    } catch {}
  }
  const record = {
    id: item.id, name: item.name, brand: item.brand, w: item.w, d: item.d, h: item.h,
    model: MODEL, effort: EFFORT, photo, created: new Date().toISOString(), rounds,
    front: raw.front, scale: fit.scale.map((s) => Math.round(s * 1000) / 1000), issues: fit.issues, parts: fit.parts,
    usage: {...usage, usd: Math.round(usage.usd * 10000) / 10000},
  };
  fs.mkdirSync(GEN_DIR, {recursive: true});
  const file = genFile(item.id);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
  fs.renameSync(`${file}.tmp`, file);
  return record;
}

/** Which catalogue ids already have a generated model. */
export function generatedIds() {
  try {
    return new Set(fs.readdirSync(GEN_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
  } catch {
    return new Set();
  }
}
