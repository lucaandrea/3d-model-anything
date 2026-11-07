#!/usr/bin/env node
// Downloads the catalogue's open 3D models (CC0 / CC BY 4.0, see catalog-assets/LICENSES.md) into
// catalog-assets/models/<source>/ (git-ignored, about 100 MB). Files already present are skipped, so it is safe to
// run on every deploy.   node tools/fetch-models.mjs
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const M = path.join(path.dirname(fileURLToPath(import.meta.url)), '../catalog-assets/models');
const UA = 'LoftTeardown-home-planner/1.0';
const ABO = ['B07HYY8ZGY', 'B07BWM2CR9', 'B07DBHCKJ5', 'B07BTRTC76', 'B07B7BJK89', 'B072ZLCB3M', 'B075QFCHM9', 'B075Z8GZ9X', 'B075YZ16V7', 'B075ZF4S39', 'B07B7J5BC2', 'B07B7DL3GX', 'B075Z8769G', 'B07HK85S41', 'B0725Z9MX3', 'B07B4WKMB1', 'B075YMN1VY', 'B073G7BVBP', 'B07HSJY7CY', 'B075X4YDJT', 'B07B4SCB6T'];
const KHRONOS = ['GlamVelvetSofa', 'SheenChair', 'SpecularSilkPouf', 'ChairDamaskPurplegold'];
const POLYHAVEN = ['modern_arm_chair_01', 'dining_chair_02', 'coffee_table_round_01', 'modern_coffee_table_01', 'side_table_01', 'drawer_cabinet', 'wooden_display_shelves_01', 'steel_frame_shelves_01', 'modern_wooden_cabinet', 'potted_plant_01', 'potted_plant_02', 'sofa_02', 'Ottoman_01', 'metal_office_desk'];
let ok = 0;
let fail = 0;
const get = async (url, dest) => {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return ok++;
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  try {
    const r = await fetch(url, {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(180000)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(`${dest}.part`, Buffer.from(await r.arrayBuffer()));
    fs.renameSync(`${dest}.part`, dest);
    ok++;
  } catch (e) {
    console.log(`FAIL ${url}: ${e.message}`);
    fail++;
  }
};
const jobs = [
  ...ABO.map((id) => () => get(`https://amazon-berkeley-objects.s3.amazonaws.com/3dmodels/original/${id.at(-1)}/${id}.glb`, path.join(M, 'abo', `${id}.glb`))),
  ...KHRONOS.map((n) => () => get(`https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${n}/glTF-Binary/${n}.glb`, path.join(M, 'khronos', `${n}.glb`))),
  // Poly Haven: the 1k glTF, its bin and every texture at the relative paths the glTF expects
  ...POLYHAVEN.map((id) => async () => {
    try {
      const files = await (await fetch(`https://api.polyhaven.com/files/${id}`, {headers: {'User-Agent': UA}})).json();
      const g = files.gltf['1k'].gltf;
      await get(g.url, path.join(M, 'polyhaven', id, g.url.split('/').pop()));
      for (const [rel, f] of Object.entries(g.include)) {
        if (rel.includes('..')) continue;
        await get(f.url, path.join(M, 'polyhaven', id, rel));
      }
    } catch (e) {
      console.log(`FAIL polyhaven ${id}: ${e.message}`);
      fail++;
    }
  }),
];
for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map((j) => j()));
console.log(`open models downloaded or present: ${ok}, failed: ${fail}`);
process.exit(fail ? 1 : 0);
