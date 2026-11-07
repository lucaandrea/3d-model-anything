#!/usr/bin/env node
// Harvests furniture from retailers' sites into catalog/sources/products-harvested.json, using Parallel's web APIs to
// find and read product pages and Claude to turn each page into a catalogue record. Facts only: name, size, price,
// materials, colours, style, link, plus one product-photo URL the 3D converter can look at. No page text or image is
// stored in the repository; the raw search results are cached in private/harvest/ (git-ignored) so a run resumes.
//
//   node tools/harvest-catalog.mjs                      every retailer x every category
//   node tools/harvest-catalog.mjs --retailers "West Elm,IKEA" --categories sofa,bed --batch
//
// Stages (by default): search -> structure -> prices -> images -> write. 'extract' (re-reading pages whose excerpt
// lacked a size, then structuring again) is opt-in: in the pilot it recovered few sizes for its cost.
//   --stages search,structure     run only some
//   --batch                       structure through the Message Batches API (half price, slower)
//   --max-results 20              search results per retailer and category
//   --concurrency 8
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parallel, pool, spend} from './harvest/parallel.mjs';
import {CATEGORIES, RETAILERS, SIZE_RANGE} from './harvest/retailers.mjs';
import {pricesNow, structureBatch, structureNow, usage} from './harvest/structure.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(APP, 'private/harvest');
const OUT = path.join(APP, 'catalog/sources/products-harvested.json');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const flag = (k) => process.argv.includes(`--${k}`);
const pick = (list, s) => (s ? s.split(',').map((x) => x.trim().toLowerCase()) : null);
const wantR = pick(RETAILERS, arg('retailers'));
const wantC = pick(null, arg('categories'));
const STAGES = new Set((arg('stages') || 'search,structure,prices,images,write').split(','));
const MAXR = Number(arg('max-results', 25));
const CONC = Number(arg('concurrency', 8));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
fs.mkdirSync(path.join(CACHE, 'search'), {recursive: true});
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const writeJson = (f, v) => {
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(v));
  fs.renameSync(`${f}.tmp`, f);
};
const STRUCT = path.join(CACHE, 'structured.json'); // url -> record | {skip}
const IMAGES = path.join(CACHE, 'images.json'); // url -> {image_url, page} | {none}
const structured = readJson(STRUCT, {});
const images = readJson(IMAGES, {});
const P = parallel();
const retailers = RETAILERS.filter((r) => !wantR || wantR.includes(r.name.toLowerCase()));
const types = Object.keys(CATEGORIES).filter((t) => !wantC || wantC.includes(t));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const costLine = () => `Parallel $${spend.usd.toFixed(2)} (${spend.calls.search} searches, ${spend.calls.extract} extracts, ${spend.calls.images} image searches) · Claude $${usage.usd.toFixed(2)} (${usage.requests} requests, ${(usage.input / 1e6).toFixed(2)}M in, ${(usage.output / 1e6).toFixed(2)}M out)`;

// one product, one URL: drop queries, fragments, print views and trailing slashes
const canon = (u) => {
  try {
    const x = new URL(u);
    return `${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/pip-print\.html$/, '').replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u;
  }
};
// a page worth structuring states at least two measurements (or a W x D x H triple) in its excerpt
const measured = (t) => (t.match(/\d+(\.\d+)?(\s+\d\/\d)?\s*("|”|''|in\b|in\.|inch|cm\b)/gi) || []).length >= 2 || /\d+(\.\d+)?\s*[x×]\s*\d+(\.\d+)?\s*[x×]\s*\d+/i.test(t);
const NOT_PRODUCT = /\/(c|cat|category|categories|collections?|shop|search|ideas|inspiration|blog|stories|rooms?|lookbook|gift|sale|catalog)\/?$|\/(search|ideas|inspiration|blog|stories|lookbook)\//i;

// ------------------------------------------------------------------ 1. search
if (STAGES.has('search')) {
  const jobs = retailers.flatMap((r) => types.filter((t) => !r.only || r.only.includes(t)).map((t) => ({r, t, file: path.join(CACHE, 'search', `${slug(r.name)}--${t}.json`)}))).filter((j) => !fs.existsSync(j.file));
  log(`search: ${jobs.length} retailer x category searches to run`);
  let done = 0;
  await pool(jobs, CONC, async ({r, t, file}) => {
    const [term, alt] = CATEGORIES[t];
    try {
      const results = await P.search({
        objective: `Individual product pages for ${term}s sold by ${r.name} (${r.domain}): each page sells one ${term} and lists its overall dimensions (width, depth, height), price, materials and colours.`,
        chars: 1500,
        queries: [`${r.name} ${term}`, `${alt || term} dimensions width depth height`],
        domains: [r.domain],
        maxResults: MAXR,
      });
      writeJson(file, {retailer: r.name, domain: r.domain, type: t, at: new Date().toISOString(), results: results.map((x) => ({url: x.url, title: x.title, excerpts: x.excerpts}))});
    } catch (e) {
      log(`  ${r.name} / ${t}: ${e.message}`);
    }
    if (++done % 25 === 0) log(`  ${done}/${jobs.length} · ${costLine()}`);
  });
}

// ------------------------------------------------------------------ candidates from every cached search
const candidates = new Map(); // canon -> page
for (const f of fs.readdirSync(path.join(CACHE, 'search'))) {
  const s = readJson(path.join(CACHE, 'search', f), null);
  if (!s || (wantR && !wantR.includes(s.retailer.toLowerCase())) || (wantC && !wantC.includes(s.type))) continue;
  for (const x of s.results) {
    const key = canon(x.url);
    const text = `${x.title || ''} ${(x.excerpts || []).join(' ')}`;
    if (!measured(text) || NOT_PRODUCT.test(new URL(x.url).pathname)) continue;
    const prev = candidates.get(key);
    // keep the richest excerpt for a page found by several searches
    if (!prev || text.length > (prev.title || '').length + prev.excerpts.join(' ').length) candidates.set(key, {url: x.url, key, title: x.title, excerpts: x.excerpts, retailer: s.retailer, hint: s.type});
  }
}
log(`candidates: ${candidates.size} product-like pages`);

// ------------------------------------------------------------------ 2. structure (and 3. extract for pages without sizes)
const plausible = (rec) => {
  const R = SIZE_RANGE[rec.category];
  if (!R) return false;
  const [w, d, h] = [rec.w_cm, rec.d_cm, rec.h_cm];
  return [w, d, h].every((v, i) => v != null && v >= R[i][0] && v <= R[i][1]);
};
const structure = async (pages, label) => {
  if (!pages.length) return;
  const chunks = [];
  for (let i = 0; i < pages.length; i += 8) chunks.push(pages.slice(i, i + 8));
  log(`${label}: ${pages.length} pages in ${chunks.length} requests${flag('batch') ? ' (batch)' : ''}`);
  const save = (chunk, items) => {
    chunk.forEach((pg, i) => {
      const it = items?.[i];
      structured[pg.key] = it ? {...it, url: pg.url, retailer: pg.retailer, hint: pg.hint, at: new Date().toISOString()} : {skip: 'no answer', url: pg.url};
    });
  };
  if (flag('batch')) {
    const res = await structureBatch(chunks, {onStatus: (b) => log(`  batch ${b.id}: ${b.processing_status} · ${JSON.stringify(b.request_counts)}`)});
    chunks.forEach((c, i) => save(c, res[i]));
    writeJson(STRUCT, structured);
  } else {
    let n = 0;
    await pool(chunks, CONC, async (chunk) => {
      try {
        save(chunk, await structureNow(chunk));
      } catch (e) {
        log(`  request failed: ${e.message}`);
      }
      if (++n % 20 === 0) {
        writeJson(STRUCT, structured);
        log(`  ${n}/${chunks.length} · ${costLine()}`);
      }
    });
    writeJson(STRUCT, structured);
  }
};
if (STAGES.has('structure')) await structure([...candidates.values()].filter((p) => !structured[p.key]), 'structure');
if (STAGES.has('extract')) {
  // a product page whose search excerpt missed the size: read the page itself for its dimensions, then structure again
  const lacking = [...candidates.values()].filter((p) => {
    const s = structured[p.key];
    return s && !s.skip && s.is_product && s.category !== 'other' && (s.w_cm == null || s.d_cm == null || s.h_cm == null) && !s.extracted;
  });
  log(`extract: ${lacking.length} product pages without full dimensions`);
  const pages = [];
  const groups = [];
  for (let i = 0; i < lacking.length; i += 20) groups.push(lacking.slice(i, i + 20));
  await pool(groups, 4, async (g) => {
    try {
      const {results} = await P.extract({urls: g.map((p) => p.url), objective: 'The product name, price, overall dimensions (width, depth, height), seat, arm and leg heights, materials and available colours'});
      for (const r of results) {
        const p = g.find((x) => x.url === r.url || canon(x.url) === canon(r.url));
        if (p) pages.push({...p, title: r.title || p.title, excerpts: r.excerpts});
      }
    } catch (e) {
      log(`  extract failed: ${e.message}`);
    }
  });
  for (const p of lacking) structured[p.key] = {...structured[p.key], extracted: true};
  await structure(pages, 'restructure');
  for (const p of pages) if (structured[p.key]) structured[p.key].extracted = true;
  writeJson(STRUCT, structured);
}

// ------------------------------------------------------------------ accepted records
const accepted = [...candidates.values()].map((p) => structured[p.key]).filter((s) => s && !s.skip && s.is_product && s.category !== 'other' && s.name && plausible(s));
log(`accepted: ${accepted.length} products with plausible sizes`);

// ------------------------------------------------------------------ 3b. prices the excerpts missed: read the page, take its lowest listed price
const PRICES = path.join(CACHE, 'prices.json');
const prices = readJson(PRICES, {});
if (STAGES.has('prices')) {
  const todo = accepted.filter((s) => s.price_usd == null && prices[canon(s.url)] === undefined);
  log(`prices: ${todo.length} products without a price`);
  const groups = [];
  for (let i = 0; i < todo.length; i += 20) groups.push(todo.slice(i, i + 20));
  let done = 0;
  await pool(groups, 8, async (g) => {
    try {
      // the page itself (not its print view), read by Parallel, priced by Claude: financing and promo amounts ignored
      const {results} = await P.extract({urls: g.map((s) => s.url.replace(/\/pip-print\.html$/, '/')), objective: 'The current price of this product in US dollars, including any sale price', chars: 1500});
      const pages = g.map((s) => ({s, r: results.find((x) => canon(x.url) === canon(s.url))})).filter((x) => x.r);
      for (let i = 0; i < pages.length; i += 10) {
        const part = pages.slice(i, i + 10);
        const got = await pricesNow(part.map(({r}) => r));
        part.forEach(({s}, k) => (prices[canon(s.url)] = got[k]));
      }
      for (const s of g) if (prices[canon(s.url)] === undefined) prices[canon(s.url)] = null;
    } catch (e) {
      log(`  price lookup failed: ${e.message}`);
    }
    // saved as it goes, so an interrupted run picks up where it stopped
    writeJson(PRICES, prices);
    if (++done % 10 === 0) log(`  ${done}/${groups.length} groups · ${costLine()}`);
  });
  writeJson(PRICES, prices);
}

// ------------------------------------------------------------------ 4. a product photo for each (the 3D converter looks at it)
if (STAGES.has('images')) {
  const todo = accepted.filter((s) => !images[canon(s.url)]);
  log(`images: ${todo.length} to find`);
  let n = 0;
  await pool(todo, 10, async (s) => {
    const host = new URL(s.url).host.replace(/^www\./, '');
    const want = canon(s.url);
    try {
      const res = await P.images({queries: [`${s.retailer} ${s.name}`], objective: `The retailer's main product photo of the ${s.retailer} ${s.name}: the whole piece, front or three-quarter view.`});
      // prefer the product's own page, then the retailer's domain
      const best = res.find((r) => canon(r.source_page_url) === want) || res.find((r) => canon(r.source_page_url).startsWith(want.split('/').slice(0, 3).join('/'))) || res.find((r) => r.source_page_url.includes(host));
      images[want] = best ? {image_url: best.image_url, page: best.source_page_url} : {none: true};
    } catch (e) {
      images[want] = {none: true, error: e.message.slice(0, 120)};
    }
    if (++n % 100 === 0) {
      writeJson(IMAGES, images);
      log(`  ${n}/${todo.length} · ${costLine()}`);
    }
  });
  writeJson(IMAGES, images);
}

// ------------------------------------------------------------------ 5. write the source file build-catalog.mjs reads
if (STAGES.has('write')) {
  const old = readJson(OUT, []);
  const byKey = new Map(old.map((r) => [canon(r.url), r]));
  const today = new Date().toISOString().slice(0, 10);
  const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
  for (const s of accepted) {
    const img = images[canon(s.url)];
    byKey.set(canon(s.url), {
      // sofa or loveseat by the chosen size, not the page's wording: under 165 cm wide seats two
      retailer: s.retailer, name: s.name, category: /^(sofa|loveseat)$/.test(s.category) ? (s.w_cm < 165 ? 'loveseat' : 'sofa') : s.category, url: s.url.replace(/\/pip-print\.html$/, '/'),
      w_cm: round(s.w_cm), d_cm: round(s.d_cm), h_cm: round(s.h_cm), seat_h_cm: round(s.seat_h_cm),
      dims_cm: Object.fromEntries([['seat_depth', s.seat_d_cm], ['arm_height', s.arm_h_cm], ['back_height', s.back_h_cm], ['leg_height', s.leg_h_cm]].filter(([, v]) => v != null).map(([k, v]) => [k, round(v)])),
      size_note: s.size_note, materials: s.materials, colors: s.colors, price_usd: s.price_usd ?? prices[canon(s.url)] ?? null, price_seen: s.at?.slice(0, 10) || today,
      style: s.style, shape_notes: s.shape_notes, image_url: img?.image_url || null, source: 'parallel', id_hint: hash(canon(s.url)),
    });
  }
  // the same product listed twice under different URLs keeps one entry
  const seen = new Set();
  const out = [...byKey.values()].filter((r) => {
    const k = `${r.retailer}|${r.name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join(' ')}|${Math.round(r.w_cm)}x${Math.round(r.d_cm)}x${Math.round(r.h_cm)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out.sort((a, b) => a.retailer.localeCompare(b.retailer) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const by = (k) => Object.entries(out.reduce((a, x) => ((a[x[k]] = (a[x[k]] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join(', ');
  log(`wrote ${path.relative(APP, OUT)}: ${out.length} products (${out.filter((r) => r.image_url).length} with a photo)`);
  log(`  retailers: ${by('retailer')}`);
  log(`  types: ${by('category')}`);
}
log(`spent: ${costLine()}`);
