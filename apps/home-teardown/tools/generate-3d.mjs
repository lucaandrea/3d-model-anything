#!/usr/bin/env node
// Makes AI 3D models for catalogue pieces that have none (server/model3d.mjs), from the command line.
//
//   node tools/generate-3d.mjs --ids west-elm-haven-sofa,ikea-kivik-sofa
//   node tools/generate-3d.mjs --sample 8                    one piece of each of 8 types
//   node tools/generate-3d.mjs --missing --brand "West Elm" --category sofa --limit 40
//   node tools/generate-3d.mjs --missing --batch             first attempts through the Batch API (half price)
//   --dry                                                   list what would be made and the estimated cost
//
// Each model is one Claude Opus 5.5 call (two when it needs a repair round); the page picks it up on its next
// catalogue load. Models already made are skipped unless --force.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {fitModel} from '../shared/model3d.js';
import {genericItems, normaliseItems, threeD} from '../shared/catalog-index.js';
import {firstTurn, GEN_DIR, generateModel, genFile, generatedIds, requestParams} from '../server/model3d.mjs';
import {readKey} from '../server/env.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const flag = (k) => process.argv.includes(`--${k}`);
const gen = generatedIds();
const items = normaliseItems(JSON.parse(fs.readFileSync(path.join(APP, 'catalog/catalog.json'), 'utf8'))).map((it) => (gen.has(it.id) ? {...it, gen: true} : it));
const needs = (it) => !it.generic && (flag('force') || threeD(it) === 'none');

let todo;
if (arg('ids')) todo = arg('ids').split(',').map((id) => items.find((x) => x.id === id.trim())).filter(Boolean);
else {
  todo = items.filter(needs);
  if (arg('brand')) todo = todo.filter((x) => x.brand.toLowerCase() === arg('brand').toLowerCase());
  if (arg('category')) todo = todo.filter((x) => x.build === arg('category') || x.category.toLowerCase() === arg('category').toLowerCase());
  if (flag('photo')) todo = todo.filter((x) => x.image);
  if (arg('sample')) {
    // one per type, photo first, so a sample shows the range
    const seen = new Set();
    todo = todo.filter((x) => x.image).filter((x) => !seen.has(x.build) && seen.add(x.build)).slice(0, Number(arg('sample')));
  } else if (!flag('missing') && !arg('brand') && !arg('category')) {
    console.log('Pass --ids, --sample N, or --missing (with --brand / --category / --limit). Nothing to do.');
    process.exit(0);
  }
}
todo = todo.filter((x) => flag('force') || !gen.has(x.id)).slice(0, Number(arg('limit', 1e9)));
const EST = 0.12; // USD per model at effort high, measured on the first runs; batches halve the first round
console.log(`${todo.length} pieces to model${flag('batch') ? ' (batch)' : ''}; about $${(todo.length * EST * (flag('batch') ? 0.6 : 1)).toFixed(2)}`);
if (flag('dry')) {
  for (const it of todo.slice(0, 40)) console.log(`  ${it.id}  ${it.brand} ${it.name} · ${it.build} · ${it.image ? 'photo' : 'no photo'}`);
  process.exit(0);
}

let usd = 0;
let ok = 0;
const report = (it, rec, ms) => {
  usd += rec.usage.usd;
  ok++;
  console.log(`  ${it.id}: ${rec.parts.length} parts, ${rec.rounds} round${rec.rounds > 1 ? 's' : ''}, photo ${rec.photo}, scale ${rec.scale.join('/')}, $${rec.usage.usd.toFixed(3)}, ${(ms / 1000).toFixed(0)} s${rec.issues.length ? `, still: ${rec.issues.join('; ').slice(0, 160)}` : ''}`);
};

if (flag('batch')) {
  // first attempts as one batch; anything that needs a repair round, failed, or could not see its photo runs directly
  const client = new Anthropic({apiKey: readKey('ANTHROPIC_API_KEY').key});
  const turns = await Promise.all(todo.map((it) => firstTurn(it, it.image ? 'url' : 'none')));
  let batch = await client.messages.batches.create({requests: todo.map((it, i) => ({custom_id: `m${i}`, params: requestParams([turns[i]])}))});
  console.log(`batch ${batch.id} submitted`);
  for (;;) {
    batch = await client.messages.batches.retrieve(batch.id);
    if (batch.processing_status === 'ended') break;
    console.log(`  ${batch.processing_status} ${JSON.stringify(batch.request_counts)}`);
    await new Promise((r) => setTimeout(r, 30000));
  }
  const retry = [];
  for await (const r of await client.messages.batches.results(batch.id)) {
    const i = Number(r.custom_id.slice(1));
    const it = todo[i];
    if (r.result.type !== 'succeeded' || r.result.message.stop_reason !== 'end_turn') {
      retry.push(it);
      continue;
    }
    const msg = r.result.message;
    const raw = JSON.parse(msg.content.find((b) => b.type === 'text').text);
    const fit = fitModel(raw, it);
    if (fit.issues.length) {
      retry.push(it);
      continue;
    }
    const u = msg.usage;
    const rec = {id: it.id, name: it.name, brand: it.brand, w: it.w, d: it.d, h: it.h, model: 'claude-opus-5-5', photo: it.image ? 'url' : 'none', created: new Date().toISOString(), rounds: 1, front: raw.front, scale: fit.scale.map((s) => Math.round(s * 1000) / 1000), issues: [], parts: fit.parts, usage: {input: u.input_tokens, output: u.output_tokens, usd: Math.round(((u.input_tokens * 4 + u.output_tokens * 20) / 1e6 / 2) * 10000) / 10000}, batch: batch.id};
    fs.mkdirSync(GEN_DIR, {recursive: true});
    fs.writeFileSync(genFile(it.id), JSON.stringify(rec));
    report(it, rec, 0);
  }
  todo = retry;
  console.log(`${retry.length} to run directly`);
}

const CONC = Number(arg('concurrency', 3));
let next = 0;
await Promise.all(
  Array.from({length: Math.min(CONC, todo.length)}, async () => {
    for (;;) {
      const it = todo[next++];
      if (!it) return;
      const t0 = Date.now();
      try {
        report(it, await generateModel(it), Date.now() - t0);
      } catch (e) {
        console.log(`  ${it.id}: failed (${e.message})`);
      }
    }
  }),
);
console.log(`made ${ok} models · $${usd.toFixed(2)}`);
