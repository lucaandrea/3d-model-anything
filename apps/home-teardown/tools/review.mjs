#!/usr/bin/env node
// Review stills for the teardown skill's review loop: opens the live page in the skill's Chromium (real GPU flags),
// drives window.LIVE into each state and writes one PNG per state.
//
//   node apps/home-teardown/tools/review.mjs out-dir '[{"name":"hero","set":{"u":0,"view":"hero"}}]'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SKILL = process.env.TEARDOWN_SKILL || path.join(os.homedir(), '.claude/skills/teardown');
const {CHROMIUM_ARGS, playwright} = await import(path.join(SKILL, 'paths.mjs'));
const [outDir = 'teardown-out/review', shotsArg = '[]'] = process.argv.slice(2);
const shots = JSON.parse(fs.existsSync(shotsArg) ? fs.readFileSync(shotsArg, 'utf8') : shotsArg);
const url = process.env.URL || 'http://127.0.0.1:5199/?notour';
fs.mkdirSync(outDir, {recursive: true});
// the full Chromium (new headless) gets the Metal GPU on macOS; the default headless shell gets no WebGL here
const browser = await playwright().chromium.launch({channel: 'chromium', args: CHROMIUM_ARGS});
const page = await browser.newPage({viewport: {width: 1600, height: 900}, deviceScaleFactor: Number(process.env.DPR || 1)});
const log = [];
page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(url);
await page.waitForFunction(() => window.SIM_SHOWN || document.querySelector('.loader .s')?.textContent.startsWith('Could not'), null, {timeout: 300000});
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const gpu = await page.evaluate(() => {
  const gl = document.querySelector('#gl').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log('GPU', gpu);
for (const s of shots) {
  if (s.set) await page.evaluate((o) => window.LIVE.set(o), s.set);
  if (s.eval) await page.evaluate(s.eval);
  await page.waitForTimeout(s.wait ?? 1800);
  const file = path.join(outDir, `${s.name}.png`);
  await page.screenshot({path: file});
  console.log('wrote', file);
}
const fps = await page.evaluate(() => new Promise((r) => {
  let n = 0;
  const t = performance.now();
  const f = () => (++n < 60 ? requestAnimationFrame(f) : r((n / (performance.now() - t)) * 1000));
  requestAnimationFrame(f);
}));
console.log(`fps ~${fps.toFixed(1)} (headless)`);
console.log(log.filter((l) => !/Download the React DevTools/.test(l)).slice(0, 60).join('\n'));
await browser.close();
