#!/usr/bin/env node
// Builds loft-teardown/ into one offline HTML page: three.js, the fonts and the CSS inlined. Standalone: it needs only
// this app's own devDependencies (npm install), so it runs the same here, on Replit or in CI. The teardown skill's
// two kit files it uses are vendored in vendor/teardown-kit (MIT).
//
//   node apps/home-teardown/tools/build.mjs        -> teardown-out/dist/loft-teardown.html
//
// The model is not bundled: the server streams it from the room folder at runtime.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DEPS = path.join(APP, 'node_modules');
const KIT = path.join(APP, 'vendor/teardown-kit');
const DIST = path.join(process.env.TEARDOWN_OUT || path.join(APP, 'teardown-out'), 'dist');
fs.mkdirSync(DIST, {recursive: true});

const woff = (rel) => fs.readFileSync(path.join(DEPS, rel)).toString('base64');
const FONTS =
  [400, 600, 700].map((w) => `@font-face{font-family:'JetBrains Mono';font-weight:${w};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${woff(`@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2`)}) format('woff2');}`).join('\n') +
  `\n@font-face{font-family:'Inter';font-weight:100 900;font-style:normal;font-display:block;src:url(data:font/woff2;base64,${woff('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format('woff2');}`;

// `teardown-kit/x.js` -> vendor/teardown-kit/x.js; `three` always resolves to this app's copy, so there is one three.js
const kitPlugin = {
  name: 'teardown-kit',
  setup(b) {
    b.onResolve({filter: /^teardown-kit\//}, (args) => ({path: path.join(KIT, args.path.slice('teardown-kit/'.length))}));
    b.onResolve({filter: /^three(\/.*)?$/}, (args) => ({path: fileURLToPath(import.meta.resolve(args.path, `file://${DEPS}/`))}));
  },
};

const t0 = Date.now();
const res = await esbuild.build({
  plugins: [kitPlugin],
  entryPoints: [path.join(APP, 'loft-teardown/main.js')],
  bundle: true,
  nodePaths: [DEPS],
  format: 'esm',
  minify: !process.env.DEBUG_BUILD,
  write: false,
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
});
const js = res.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Loft Teardown</title>
<style>
${FONTS}
${fs.readFileSync(path.join(KIT, 'style.css'), 'utf8')}
</style>
</head>
<body>
<div id="app"></div>
<script type="module">
${js}
</script>
</body>
</html>
`;
const out = path.join(DIST, 'loft-teardown.html');
fs.writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms`);
