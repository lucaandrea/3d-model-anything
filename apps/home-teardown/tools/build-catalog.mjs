#!/usr/bin/env node
// Builds catalog/catalog.json from researched product facts and openly licensed models.
//
//   node apps/home-teardown/tools/build-catalog.mjs catalog/sources/products.json catalog/sources/models.json
//
// catalog/sources/products-harvested.json (tools/harvest-catalog.mjs) is merged in when present: its records already
// carry a furniture type, a product-photo URL and shape notes for the 3D converter. A curated product of the same
// retailer and name wins, and only borrows the harvested photo and notes.
//
// products.json: [{retailer, name, category, url, w_cm, d_cm, h_cm, seat_h_cm, materials, colors:[{name,hex}],
//                  price_usd, price_seen, style:[]}]   (facts only: no retailer images or models)
// models.json:   [{id, name, category, file, source, license, attribution, url, front, fit, tint, dims_m}]
//                 file is relative to catalog-assets/models/
// Each product gets the procedural builder for its category at its real size; models become their own entries.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const [productsFile, modelsFile] = process.argv.slice(2).map((f) => path.resolve(APP, f));
const harvestedFile = path.join(APP, 'catalog/sources/products-harvested.json');
const read = (f) => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []);

// retailer category (and name) -> procedural type
function buildOf(category, name, w, d) {
  const c = `${category} ${name}`.toLowerCase();
  const round = /\bround\b|\bdrum\b|\bcircle\b|\boval\b|\bpedestal\b/.test(c);
  if (/sectional/.test(c) || (/sofa/.test(c) && d > 1.3)) return 'sectional_l';
  if (/loveseat|love seat|settee/.test(c)) return 'loveseat';
  if (/sofa|couch/.test(c)) return 'sofa';
  if (/chaise/.test(c)) return 'chaise';
  if (/desk chair|office chair|task chair/.test(c)) return 'office_chair';
  if (/bar stool|counter stool|stool/.test(c)) return 'bar_stool';
  if (/dining chair|side chair|dining/.test(c) && /chair/.test(c)) return 'dining_chair';
  if (/chair|lounger/.test(c) && !/table|desk/.test(c)) return w < 0.7 ? 'lounge_chair' : 'armchair';
  if (/coffee table/.test(c)) return round ? 'round_coffee_table' : 'coffee_table';
  if (/side table|end table|accent table|nightstand/.test(c) && !/nightstand|bedside/.test(c)) return 'side_table';
  if (/nightstand|bedside/.test(c)) return 'nightstand';
  if (/dining table|kitchen table|table/.test(c) && /dining|kitchen/.test(c)) return round ? 'round_dining_table' : 'dining_table';
  if (/desk/.test(c)) return 'desk';
  if (/console table/.test(c)) return 'console_table';
  if (/daybed/.test(c)) return 'daybed';
  if (/\bbed\b|bed frame/.test(c)) return 'bed';
  if (/dresser|chest of drawers/.test(c)) return 'dresser';
  if (/media|tv |tv-|television|entertainment/.test(c)) return 'tv_console';
  if (/sideboard|buffet|credenza/.test(c)) return 'sideboard';
  if (/bookcase|bookshelf|shelving|shelf unit|kallax|billy/.test(c)) return 'bookshelf';
  if (/wardrobe|armoire/.test(c)) return 'wardrobe';
  if (/bar cart|utility cart|\bcart\b/.test(c)) return 'bar_cart';
  if (/floor lamp/.test(c)) return 'floor_lamp';
  if (/rug/.test(c)) return round ? 'round_rug' : 'rug';
  if (/planter|plant|pot/.test(c)) return 'plant';
  if (/bench/.test(c)) return 'bench';
  if (/pouf/.test(c)) return 'pouf';
  if (/ottoman/.test(c)) return 'ottoman';
  if (/mirror/.test(c)) return 'mirror';
  return null;
}
function materialOf(materials) {
  const m = (Array.isArray(materials) ? materials.join(' ') : String(materials || '')).toLowerCase();
  if (/velvet/.test(m)) return 'velvet';
  if (/boucl/.test(m)) return 'boucle';
  if (/leather/.test(m)) return 'leather';
  if (/rattan|cane|wicker|seagrass|jute/.test(m)) return 'rattan';
  if (/marble|travertine|stone|concrete/.test(m)) return 'marble';
  if (/linen|cotton|polyester|wool|fabric|performance|weave|upholster|chenille|tweed/.test(m)) return 'fabric';
  if (/lacquer/.test(m)) return 'lacquer';
  if (/walnut|oak|ash|pine|acacia|mango|wood|veneer|birch|beech|teak|bamboo|particleboard|fiberboard|mdf/.test(m)) return 'wood';
  if (/steel|iron|metal|brass|aluminum|aluminium|chrome/.test(m)) return 'metal';
  if (/glass/.test(m)) return 'glass';
  return 'fabric';
}
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
const HEX = /^#[0-9a-f]{6}$/i;

const out = [];
const seen = new Set();
const skipped = [];
import {CATALOG as TYPES} from '../shared/furniture.js';
import {CATEGORY_OF} from '../shared/catalog-index.js';
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const curated = read(productsFile);
const curatedKeys = new Map(curated.map((p) => [`${norm(p.retailer)}|${norm(p.name)}`, p]));
const harvested = read(harvestedFile).filter((h) => {
  const twin = curatedKeys.get(`${norm(h.retailer)}|${norm(h.name)}`);
  if (twin) {
    twin.image_url ??= h.image_url;
    twin.shape_notes ??= h.shape_notes;
    return false;
  }
  return true;
});
for (const p of [...curated, ...harvested]) {
  let w = p.w_cm / 100, d = p.d_cm / 100, h = p.h_cm / 100;
  // harvested records name their type already; curated ones are mapped from the retailer's category and name
  const build = TYPES[p.category] && p.source === 'parallel' ? (/\bround\b|\bdrum\b|\bcircular\b|\bpedestal\b/i.test(p.name) && TYPES[`round_${p.category}`] ? `round_${p.category}` : p.category) : buildOf(p.category || '', p.name || '', w || 1, d || 1);
  // gaps filled from the type's defaults and marked: rugs list no height, a leaning mirror needs its lean on the floor
  const approx = [];
  const T = TYPES[build];
  if (T) {
    if (!(w > 0.05)) (w = T.w), approx.push('width');
    if (!(d > 0.005)) (d = T.d), approx.push('depth');
    if (!(h > 0.005)) (h = T.h), approx.push('height');
    if (build === 'mirror' && d < 0.3 && h > 1.2) (d = 0.35), approx.push('leaning depth');
  }
  if (!build || !(w > 0.05 && d > 0.005 && h > 0.005)) {
    skipped.push(`${p.retailer} ${p.name}: ${!build ? `no 3D type for "${p.category}"` : 'missing dimensions'}`);
    continue;
  }
  let id = `${slug(p.retailer)}-${slug(p.name)}`;
  while (seen.has(id)) id += '-2';
  seen.add(id);
  const colors = (p.colors || []).filter((c) => c && HEX.test(c.hex)).map((c) => ({name: String(c.name).slice(0, 40), hex: c.hex.toLowerCase()}));
  out.push({
    id, name: p.name, brand: p.retailer, category: CATEGORY_OF[build] || 'Decor', retail_category: p.category, build, w: +w.toFixed(3), d: +d.toFixed(3), h: +h.toFixed(3), ...(p.seat_h_cm ? {seat_h: +(p.seat_h_cm / 100).toFixed(3)} : {}),
    materials: Array.isArray(p.materials) ? p.materials : p.materials ? [p.materials] : [], material: materialOf(p.materials), colors: colors.length ? colors : [{name: 'As listed', hex: '#b9ae9c'}],
    accent: /metal|black/.test(String(p.materials).toLowerCase()) ? '#1f1f1f' : '#3a2f27', price: p.price_usd ?? null, price_seen: p.price_seen ?? null, url: p.url || null, style: (p.style || []).map((s) => String(s).toLowerCase()),
    ...(approx.length ? {approx} : {}), ...(p.note ? {note: String(p.note).slice(0, 240)} : {}), source: p.source === 'parallel' ? `Parallel web search, ${p.price_seen || ''}`.trim() : 'search-result snippets, 2026-10-31',
    ...(p.image_url ? {image: p.image_url} : {}), ...(p.shape_notes ? {shape_notes: String(p.shape_notes).slice(0, 400)} : {}), ...(p.size_note ? {size_note: String(p.size_note).slice(0, 80)} : {}),
    ...(p.dims_cm && Object.keys(p.dims_cm).length ? {dims: p.dims_cm} : {}),
  });
}
for (const m of read(modelsFile)) {
  const file = path.join(APP, 'catalog-assets/models', m.file);
  if (!fs.existsSync(file)) {
    skipped.push(`model ${m.id}: file ${m.file} missing`);
    continue;
  }
  const {w, d, h} = m;
  out.push({
    id: slug(m.id), name: m.name, brand: m.brand || m.source, category: m.category, build: m.build || buildOf(m.category, m.name, w, d) || 'armchair', w, d, h, material: m.material || 'wood', colors: m.colors || [{name: 'As modelled', hex: '#b9ae9c'}],
    accent: '#2b2622', price: m.price ?? null, url: m.url || null, style: m.style || ['open source'],
    model: {url: `/catalog-assets/models/${m.file}`, source: m.source, license: m.license, attribution: m.attribution, front: m.front || '+z', fit: m.fit || 'stretch', ...(m.tint ? {tint: m.tint} : {})},
  });
}
// a retailer piece borrows the closest ABO model of the same type as its 3D stand-in: fitted to the real size and
// recoloured to the colour chosen (ABO models use one baked material, so legs and frames are never painted separately)
const opens = out.filter((x) => x.model && x.brand !== 'Poly Haven' && /Amazon Berkeley/.test(x.model.source));
for (const it of out) {
  if (it.model) continue;
  let best = null;
  for (const o of opens) {
    if (o.build !== it.build) continue;
    const score = Math.abs(Math.log(it.w / it.d / (o.w / o.d))) + Math.abs(Math.log(it.h / it.w / (o.h / o.w)));
    if (score < 0.45 && (!best || score < best.score)) best = {o, score};
  }
  if (best) it.model = {...best.o.model, recolor: true, standIn: best.o.name};
}
fs.mkdirSync(path.join(APP, 'catalog'), {recursive: true});
fs.writeFileSync(path.join(APP, 'catalog/catalog.json'), JSON.stringify(out, null, 1));
const by = (k) => Object.entries(out.reduce((a, x) => ((a[x[k]] = (a[x[k]] || 0) + 1), a), {})).map(([a, b]) => `${a} ${b}`).join(', ');
console.log(`catalog.json: ${out.length} entries`);
console.log(`  brands: ${by('brand')}`);
console.log(`  types: ${by('build')}`);
if (skipped.length) console.log(`skipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
