// The console: the badge and title, the mode switch, the state and room panels driven by the same poses that move the
// parts, the views and display toggles, the teardown timeline, labels with leaders, the tour pointer, and in the
// rearrange mode the layouts list and the Claude panel. It is designed on a 1600 x 900 frame that live.js stretches
// to the window's shape and scales: --dw and --dh on #app are the extra width and height, so the right-hand column
// rides the right edge, the bottom bars ride the bottom edge, and the bars between the side columns stretch.
import {STAGES} from './choreo.js';

export const C = {ink: '#2a2521', mute: '#958a7c', faint: '#dccfbd', line: '#e8dfd1', panel: 'rgba(252,250,246,.95)', or: '#e3562a', green: '#2fa36b', blue: '#3c79a8', red: '#c8322b'};
export const VIEWS = ['hero', 'ground', 'upper', 'plan', 'trays'];
export const VIEW_LABEL = {hero: 'HERO', ground: 'GROUND', upper: 'UPPER', plan: 'PLAN', trays: 'TRAYS'};
export const DISPLAY = ['labels', 'ceilings', 'cutaway', 'orbit'];
export const DISPLAY_LABEL = {labels: 'LABELS', ceilings: 'CEILINGS', cutaway: 'CUTAWAY', orbit: 'ORBIT'};
export const MODES = ['teardown', 'reassemble', 'rearrange'];

const CSS = `
#app{--dw:0px;--dh:0px;font-family:Inter,system-ui,sans-serif;color:${C.ink};-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.ui{position:absolute;inset:0;pointer-events:none}
.mo{font-family:'JetBrains Mono',ui-monospace,monospace}
.cp{position:absolute;background:${C.panel};border:1px solid ${C.line};border-radius:6px;box-shadow:0 2px 10px rgba(120,90,50,.07)}
.ph{position:absolute;display:flex;align-items:center;gap:9px;font:700 10.5px 'JetBrains Mono',monospace;letter-spacing:1.8px}
.ph i{display:block;width:3px;height:13px;background:${C.or}}
.pn{position:absolute;font:500 9.5px 'JetBrains Mono',monospace;color:${C.mute};letter-spacing:1px}
.sm{font:500 9px 'JetBrains Mono',monospace;letter-spacing:1.5px;color:${C.mute};text-transform:uppercase;white-space:nowrap}
.bt{position:absolute;height:23px;padding:0 10px;display:flex;align-items:center;justify-content:center;border:1px solid ${C.faint};border-radius:4px;background:#fffdf9;font:700 9.4px 'JetBrains Mono',monospace;letter-spacing:1.3px;color:${C.ink};white-space:nowrap;pointer-events:auto;cursor:pointer;user-select:none}
.bt:hover{filter:brightness(.96)}
.bt.on{background:${C.or};border-color:${C.or};color:#fff}
.bt.dis{opacity:.4;pointer-events:none}
.seg{position:absolute;display:flex;padding:3px;gap:3px;border-radius:7px;background:#ece3d5;pointer-events:auto}
.seg div{width:132px;height:30px;display:flex;align-items:center;justify-content:center;gap:8px;border-radius:5px;font:700 10.5px 'JetBrains Mono',monospace;letter-spacing:1.6px;color:#8d8274;cursor:pointer;user-select:none}
.seg div.on{background:${C.or};color:#fff;box-shadow:0 1px 4px rgba(227,86,42,.35)}
.seg div b{font-weight:500;opacity:.7;font-size:9px}
.bar{position:absolute;height:4px;background:#efe6d8;border-radius:2px;overflow:hidden}
.bar i{position:absolute;left:0;top:0;bottom:0;background:${C.or};border-radius:2px}
.call{position:absolute;white-space:nowrap}
.call b{display:flex;align-items:center;gap:6px;max-width:210px;overflow:hidden;font:700 9.4px 'JetBrains Mono',monospace;letter-spacing:1.2px;color:${C.ink};background:rgba(252,250,246,.86);padding:1px 4px;border-radius:2px}
.call b i{display:block;width:6px;height:6px;background:${C.or}}
.call span{display:block;font:500 7.8px 'JetBrains Mono',monospace;letter-spacing:1.1px;color:${C.mute};margin:2px 0 0 4px}
.tray{position:absolute;white-space:nowrap;font:700 9px 'JetBrains Mono',monospace;letter-spacing:1.4px;color:${C.ink};transform:translate(-2px,-100%);background:rgba(252,250,246,.82);padding:2px 5px;border-radius:2px}
.tray span{color:${C.or};margin-left:6px;font-weight:500}
.cur{position:absolute;left:0;top:0;z-index:50;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))}
.ring{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:1.5px solid ${C.or};opacity:0;z-index:49}
.tourchip{position:absolute;left:calc(800px + var(--dw) / 2);top:104px;transform:translateX(-50%);display:flex;align-items:center;gap:7px;height:22px;padding:0 11px;border:1px solid ${C.line};border-radius:4px;background:rgba(252,250,246,.95);font:700 9px 'JetBrains Mono',monospace;letter-spacing:1.3px;white-space:nowrap;cursor:pointer;pointer-events:auto}
.tourchip i{display:block;width:6px;height:6px;border-radius:50%;background:${C.or}}
.tourchip.on i{animation:blink 1.2s steps(2) infinite}
@keyframes blink{50%{opacity:.15}}
.hit{position:absolute;pointer-events:auto;cursor:ew-resize}
.room{position:absolute;left:42px;width:254px;height:26px}
.room .n{position:absolute;left:0;top:0;font:600 11px Inter,sans-serif}
.room .v{position:absolute;right:0;top:0;font:600 10px 'JetBrains Mono',monospace}
.room .bar{left:0;right:0;top:17px}
.card{position:absolute;font-size:12px;line-height:1.45}
.stl{position:absolute;left:calc(1304px + var(--dw));width:254px;height:24px;display:flex;align-items:center;gap:10px;font:600 10px 'JetBrains Mono',monospace;letter-spacing:1.2px;color:${C.mute}}
.stl i{display:block;width:9px;height:9px;border-radius:50%;border:1.5px solid ${C.faint};box-sizing:border-box}
.stl.done{color:${C.ink}} .stl.done i{background:${C.ink};border-color:${C.ink}}
.stl.now{color:${C.or}} .stl.now i{background:${C.or};border-color:${C.or}}
/* rearrange */
.chat{position:absolute;left:calc(1178px + var(--dw));top:112px;width:394px;height:calc(760px + var(--dh));display:flex;flex-direction:column;pointer-events:auto}
.chat .log{flex:1;overflow-y:auto;padding:12px 14px 6px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin}
.msg{font-size:12.5px;line-height:1.5;border-radius:8px;padding:9px 11px;white-space:pre-wrap;word-wrap:break-word}
.msg.user{align-self:flex-end;max-width:88%;background:${C.ink};color:#fbf8f2}
.msg.ai{background:#fff;border:1px solid ${C.line}}
.msg.ai h4{margin:0 0 4px;font:700 13px Inter,sans-serif;display:flex;align-items:center;gap:7px}
.msg.ai h4 i{display:block;width:7px;height:7px;background:${C.or}}
.msg .meta{font:500 9px 'JetBrains Mono',monospace;letter-spacing:1.2px;color:${C.mute};text-transform:uppercase;margin-top:6px}
.msg .chg{margin:6px 0 0;padding:0;list-style:none;font-size:11.5px;color:#5d544a}
.msg .chg li{padding:2px 0 2px 14px;position:relative}
.msg .chg li:before{content:'';position:absolute;left:2px;top:9px;width:6px;height:2px;background:${C.or}}
.msg .chg li.add:before{background:${C.green}}
.msg .chg li.rem:before{background:${C.red}}
.msg .chg li.warn{color:${C.red}}
.msg.status{background:transparent;padding:2px 4px;color:${C.mute};font:500 10px 'JetBrains Mono',monospace;letter-spacing:.6px;white-space:normal}
.msg.status b{color:${C.or};font-weight:700}
.msg.think{background:#f6f1e9;color:#6f665b;font-size:11.5px;font-style:italic;max-height:150px;overflow-y:auto}
.msg.err{background:#fbecea;color:${C.red}}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:6px 14px}
.chips div{font:500 11px Inter,sans-serif;padding:5px 9px;border-radius:12px;border:1px solid ${C.faint};background:#fffdf9;cursor:pointer;color:#5d544a}
.chips div:hover{border-color:${C.or};color:${C.or}}
.chips div.more{border-color:${C.or};color:${C.or};font-weight:600}
.lib{position:absolute;left:0;right:0;top:44px;bottom:92px;background:#fffdf9;display:none;flex-direction:column;z-index:5;border-bottom:1px solid ${C.line}}
.lib.on{display:flex}
.lib .lh{display:flex;align-items:center;gap:8px;padding:10px 14px 6px}
.lib .lh .t{font:700 10px 'JetBrains Mono',monospace;letter-spacing:1.6px;white-space:nowrap}
.lib .lh input{flex:1;min-width:0;height:26px;border:1px solid ${C.faint};border-radius:5px;padding:0 8px;font:12px Inter,sans-serif;color:${C.ink};background:#fff;outline:none}
.lib .lh input:focus{border-color:${C.or}}
.lib .lh .x{cursor:pointer;font:600 15px Inter,sans-serif;color:${C.mute};padding:0 4px}
.lib .tabs{display:flex;flex-wrap:wrap;gap:4px;padding:2px 14px 8px}
.lib .tabs div{font:700 8.6px 'JetBrains Mono',monospace;letter-spacing:1.1px;padding:4px 7px;border-radius:4px;border:1px solid ${C.faint};cursor:pointer;color:#8d8274;text-transform:uppercase}
.lib .tabs div.on{background:${C.or};border-color:${C.or};color:#fff}
.lib .list{flex:1;overflow-y:auto;overflow-x:hidden;padding:0 10px 12px;scrollbar-width:thin}
.lib .cat{font:700 9px 'JetBrains Mono',monospace;letter-spacing:1.4px;color:${C.mute};margin:10px 4px 3px;text-transform:uppercase}
.lib .row{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:5px;font:12px/1.35 Inter,sans-serif;color:${C.ink}}
.lib .row:hover{background:#f6f1e9}
.lib .row span{flex:1;min-width:0;white-space:normal;cursor:pointer}
.lib .row b{flex:none}
.lib .row b{font:700 8.4px 'JetBrains Mono',monospace;letter-spacing:1.1px;color:${C.or};cursor:pointer;padding:3px 6px;border:1px solid ${C.or};border-radius:4px;opacity:.35}
.lib .row:hover b{opacity:1}
.lib .none{padding:20px 6px;color:${C.mute};font:12px Inter,sans-serif}
.ask{display:flex;gap:8px;padding:10px 14px 14px;border-top:1px solid ${C.line}}
.ask textarea{flex:1;height:56px;resize:none;border:1px solid ${C.faint};border-radius:6px;padding:8px 10px;font:13px/1.4 Inter,sans-serif;color:${C.ink};background:#fffdf9;outline:none}
.ask textarea:focus{border-color:${C.or}}
.ask button{width:64px;border:none;border-radius:6px;background:${C.or};color:#fff;font:700 10px 'JetBrains Mono',monospace;letter-spacing:1.4px;cursor:pointer}
.ask button:disabled{opacity:.45;cursor:default}
.lay{position:absolute;left:42px;width:254px;min-height:44px;padding:7px 9px;border:1px solid ${C.line};border-radius:5px;background:#fffdf9;pointer-events:auto;cursor:pointer;box-sizing:border-box}
.lay.on{border-color:${C.or};box-shadow:inset 3px 0 0 ${C.or}}
.lay .t{font:600 12px Inter,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:18px}
.lay .s{font:500 8.6px 'JetBrains Mono',monospace;letter-spacing:1.1px;color:${C.mute};margin-top:3px;text-transform:uppercase}
.lay .x{position:absolute;right:6px;top:5px;font:600 12px Inter;color:${C.mute};padding:0 3px}
.lay .x:hover{color:${C.red}}
.tabs2{position:absolute;left:42px;top:124px;display:flex;gap:4px;pointer-events:auto}
.tabs2 div{font:700 10px 'JetBrains Mono',monospace;letter-spacing:1.6px;padding:6px 12px;border-radius:5px;cursor:pointer;color:#8d8274;border:1px solid ${C.faint};background:#fffdf9}
.tabs2 div.on{background:${C.ink};border-color:${C.ink};color:#fbf8f2}
.leftcp{width:282px}
/* the catalogue opens wide: two card columns at 16:9, more on a wider screen */
.wide .leftcp,.wide .cat{width:calc(540px + min(calc(var(--dw) * 0.3), 320px))}
/* the wide catalogue stops above the ARRANGE bar, which starts at x 330 */
.wide .leftcp{height:calc(650px + var(--dh)) !important}
.wide .cat{height:calc(602px + var(--dh))}
.cat{position:absolute;left:28px;top:160px;width:282px;height:calc(712px + var(--dh));display:none;flex-direction:column;pointer-events:auto}
.cat.on{display:flex}
.cat .q{margin:6px 14px 6px;height:28px;border:1px solid ${C.faint};border-radius:5px;padding:0 9px;font:12px Inter,sans-serif;color:${C.ink};background:#fff;outline:none}
.cat .q:focus{border-color:${C.or}}
.cat .f{display:flex;gap:6px;margin:0 14px 6px}
.cat select{flex:1;min-width:0;height:24px;border:1px solid ${C.faint};border-radius:4px;background:#fffdf9;font:600 9.5px 'JetBrains Mono',monospace;letter-spacing:.6px;color:${C.ink};padding:0 4px}
.cat .swap{margin:0 14px 6px;padding:7px 9px;border-radius:5px;background:${C.or};color:#fff;font:600 11px Inter,sans-serif;display:none;align-items:center;gap:8px}
.cat .swap.on{display:flex}
.cat .swap span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cat .swap b{cursor:pointer;font:700 9px 'JetBrains Mono',monospace;letter-spacing:1px;border:1px solid #fff;border-radius:3px;padding:2px 6px}
.cat .n{margin:0 16px 4px;font:500 9px 'JetBrains Mono',monospace;letter-spacing:1.2px;color:${C.mute};text-transform:uppercase}
.cat .list{flex:1;overflow-y:auto;overflow-x:hidden;padding:0 10px 10px 14px;scrollbar-width:thin;display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));gap:6px;align-content:start}
.it{display:flex;gap:9px;padding:7px;border:1px solid ${C.line};border-radius:6px;background:#fffdf9;min-width:0}
.it .row3{display:flex;align-items:center;gap:5px;margin-top:4px}
.b3{font:700 7.8px 'JetBrains Mono',monospace;letter-spacing:.9px;padding:2px 5px;border-radius:3px;white-space:nowrap}
.b3.own{background:#e3f1e8;color:#2c7349}
.b3.gen{background:#e5ecf6;color:#36597f}
.b3.none{background:#fbe9e6;color:#b8352b}
.b3.busy{background:#fff1dd;color:#a76200}
.it .mk{font:700 7.8px 'JetBrains Mono',monospace;letter-spacing:.9px;padding:1px 5px;border-radius:3px;border:1px solid ${C.or};color:${C.or};cursor:pointer;white-space:nowrap}
.it .mk:hover{background:${C.or};color:#fff}
.it:hover{border-color:${C.faint}}
.it img,.it .ph0{width:66px;height:66px;flex:none;border-radius:4px;background:#f3ede4;object-fit:contain}
.it .b{flex:1;min-width:0}
.it .t{font:600 11.5px/1.25 Inter,sans-serif;color:${C.ink};overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.it .s{font:500 8.6px 'JetBrains Mono',monospace;letter-spacing:.8px;color:${C.mute};margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.it .row{display:flex;align-items:center;gap:4px;margin-top:5px}
.it .dot{width:12px;height:12px;border-radius:50%;border:1px solid rgba(0,0,0,.18);cursor:pointer;flex:none}
.it .dot.on{outline:2px solid ${C.or};outline-offset:1px}
.it .go{margin-left:auto;font:700 8.6px 'JetBrains Mono',monospace;letter-spacing:1px;padding:3px 7px;border-radius:4px;background:${C.or};color:#fff;cursor:pointer}
.it .ln{font:700 9px 'JetBrains Mono',monospace;color:${C.mute};text-decoration:none;padding:0 2px}
.it .ln:hover{color:${C.or}}
.refurb{display:flex;gap:5px;align-items:center;padding:6px 14px 0}
.refurb select{flex:1;min-width:0;height:24px;border:1px solid ${C.faint};border-radius:4px;background:#fffdf9;font:600 9.2px 'JetBrains Mono',monospace;color:${C.ink};padding:0 3px}
.refurb .bt{position:static;height:24px;padding:0 8px;font-size:8.6px}
.toast{position:absolute;left:calc(800px + var(--dw) / 2);top:146px;transform:translateX(-50%);padding:7px 14px;border-radius:5px;background:${C.ink};color:#fbf8f2;font:600 11px Inter,sans-serif;opacity:0;transition:opacity .25s;white-space:nowrap}
.loader{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#efe9df;z-index:100;pointer-events:auto}
.loader .t{font:700 30px Inter,sans-serif;letter-spacing:-.5px}
.loader .p{width:420px;height:5px;border-radius:3px;background:#e2d8c9;overflow:hidden}
.loader .p i{display:block;height:100%;width:0;background:${C.or};transition:width .15s}
.loader .s{font:500 10px 'JetBrains Mono',monospace;letter-spacing:1.6px;color:${C.mute};text-transform:uppercase}
`;
const el = (h) => {
  const d = document.createElement('div');
  d.innerHTML = h.trim();
  return d.firstElementChild;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
export {esc};

export function createConsole(app) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const ui = el(`<div class="ui"></div>`);
  app.appendChild(ui);
  const add = (h, parent = ui) => {
    const n = el(h);
    parent.appendChild(n);
    return n;
  };
  // anchors on the design frame: r rides the right edge, c stays centred, b rides the bottom edge, W and H stretch
  const X = (x, a = '') => (a.includes('r') ? `calc(${x}px + var(--dw))` : a.includes('c') ? `calc(${x}px + var(--dw) / 2)` : `${x}px`);
  const Y = (y, a = '') => (a.includes('b') ? `calc(${y}px + var(--dh))` : `${y}px`);
  const SW = (w) => `calc(${w}px + var(--dw))`;
  const SH = (h) => `calc(${h}px + var(--dh))`;
  const panel = (x, y, w, h, title, n, parent = ui, a = '') => {
    const box = add(`<div class="cp" style="left:${X(x, a)};top:${Y(y, a)};width:${a.includes('W') ? SW(w) : `${w}px`};height:${a.includes('H') ? SH(h) : `${h}px`}"></div>`, parent);
    const t = add(`<div class="ph" style="left:13px;top:12px"><i></i>${title}</div>`, box);
    add(`<div class="pn" style="right:13px;top:14px">${n}</div>`, box);
    return {box, t};
  };
  const memo = new Map();
  const set = (node, key, v) => {
    const k = memo.get(node) || {};
    if (k[key] === v) return;
    k[key] = v;
    memo.set(node, k);
    if (key === 'text') node.textContent = v;
    else if (key === 'html') node.innerHTML = v;
    else if (key === 'class') node.className = v;
    else node.style[key] = v;
  };

  // ------------------------------------------------------------ header
  add(`<div style="position:absolute;left:0;top:0;width:150px;height:89px;background:${C.or}"></div>`);
  add(`<svg style="position:absolute;left:44px;top:21px" width="62" height="48" viewBox="0 0 62 48"><g fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"><path d="M6 24 L31 5 L56 24"/><path d="M12 20 V44 H50 V20"/></g><g fill="#fff"><rect x="18" y="29" width="9" height="9"/><rect x="35" y="29" width="9" height="15"/></g></svg>`);
  add(`<div class="sm" style="position:absolute;left:172px;top:21px;letter-spacing:2.4px">RECONSTRUCTED HOME · LOCAL MODEL</div>`);
  add(`<div style="position:absolute;left:171px;top:36px;font-size:33px;font-weight:700;letter-spacing:-.6px;line-height:1">Loft Teardown <span style="color:${C.or};font-weight:400">/</span></div>`);
  const subtitle = add(`<div class="mo" style="position:absolute;left:172px;top:76px;font-size:11px;letter-spacing:2.1px;color:#6d6357"></div>`);
  const seg = add(`<div class="seg" style="left:${X(784, 'c')};top:26px"></div>`);
  const modeBtn = {};
  MODES.forEach((m, i) => {
    modeBtn[m] = add(`<div><b>0${i + 1}</b>${m.toUpperCase()}</div>`, seg);
  });
  const claudeChip = add(`<div class="mo" style="position:absolute;right:28px;top:30px;font-size:9.5px;letter-spacing:1.6px;text-align:right;line-height:16px;color:${C.mute}"></div>`);

  // ------------------------------------------------------------ teardown / reassemble layer
  const td = add(`<div style="position:absolute;inset:0"></div>`);
  panel(28, 112, 282, 236, 'STATE', '01', td);
  const chip = add(`<div style="position:absolute;left:42px;top:152px;width:13px;height:26px;border-radius:2px;background:${C.green}"></div>`, td);
  const stName = add(`<div style="position:absolute;left:66px;top:149px;font-size:17px;font-weight:700"></div>`, td);
  const stSub = add(`<div class="sm" style="position:absolute;left:67px;top:171px"></div>`, td);
  add(`<div style="position:absolute;left:42px;top:192px;width:254px;height:1px;background:${C.line}"></div>`, td);
  const rows = ['PARTS HOME', 'IN FLIGHT', 'LAID OUT', 'MAX ERROR'].map((n, i) => {
    const y = 206 + i * 33;
    add(`<div class="sm" style="position:absolute;left:42px;top:${y}px">${n}</div>`, td);
    const v = add(`<div class="mo" style="position:absolute;left:42px;width:254px;text-align:right;top:${y - 2}px;font-size:12px;font-weight:700"></div>`, td);
    const b = add(`<div class="bar" style="left:42px;width:254px;top:${y + 15}px"><i></i></div>`, td);
    return {v, f: b.firstElementChild};
  });
  const roomsPanel = panel(28, 362, 282, 400, 'ROOMS · OBJECTS HOME', '02', td);
  const roomRows = add(`<div style="position:absolute;inset:0"></div>`, td);

  // views, display, the sequence
  panel(1290, 112, 282, 112, 'VIEWS', '03', td, 'r');
  const btn = {};
  const btnRow = (keys, labels, x0, y, parent, a = '', wmax = 254) => {
    let x = x0;
    let yy = y;
    for (const k of keys) {
      const w = Math.round(labels[k].length * 7.2 + 22);
      if (x + w > x0 + wmax) {
        x = x0;
        yy += 30;
      }
      btn[k] = add(`<div class="bt" style="left:${X(x, a)};top:${yy}px;width:${w}px">${labels[k]}</div>`, parent);
      x += w + 6;
    }
  };
  btnRow(VIEWS, VIEW_LABEL, 1304, 150, td, 'r');
  panel(1290, 238, 282, 112, 'DISPLAY', '04', td, 'r');
  btnRow(DISPLAY, DISPLAY_LABEL, 1304, 276, td, 'r');
  panel(1290, 364, 282, 270, 'SEQUENCE', '05', td, 'r');
  const stl = STAGES.map((s, i) => add(`<div class="stl" style="top:${400 + i * 31}px"><i></i><b style="font-weight:600"></b><span style="margin-left:auto;font-weight:500;font-size:9px"></span></div>`, td));
  panel(1290, 648, 282, 114, 'SELECTED', '06', td, 'r');
  const selCard = add(`<div class="card" style="left:${X(1304, 'r')};top:676px;width:254px;height:80px;overflow:hidden"></div>`, td);

  // the operation timeline: rides the bottom edge and stretches between the side columns
  const tlTitle = panel(330, 776, 940, 96, 'TEARDOWN', '07', td, 'bW').t;
  btn.play = add(`<div class="bt" style="left:346px;top:${Y(808, 'b')};width:46px;height:46px;border-radius:50%;border:none;background:${C.or};color:#fff;font-size:15px"></div>`, td);
  const opFrom = add(`<div class="sm" style="position:absolute;left:410px;top:${Y(806, 'b')}"></div>`, td);
  const opPhase = add(`<div class="mo" style="position:absolute;left:410px;width:${SW(690)};top:${Y(805, 'b')};text-align:center;font-size:9.6px;font-weight:700;letter-spacing:1.6px;color:${C.or}"></div>`, td);
  const opTo = add(`<div class="sm" style="position:absolute;right:500px;top:${Y(806, 'b')}"></div>`, td);
  // slider geometry in frame pixels, updated by resize(); live.js reads it for the drag areas
  const TL = {x: 412, w: 688, y: 834};
  add(`<div style="position:absolute;left:${TL.x}px;top:${Y(833, 'b')};width:${SW(TL.w)};height:3px;background:#efe6d8;border-radius:2px"></div>`, td);
  for (const s of STAGES.slice(1, -1)) add(`<div style="position:absolute;left:calc(${TL.x}px + ${s.at} * ${SW(TL.w)});top:${Y(829, 'b')};width:1px;height:11px;background:${C.faint}"></div>`, td);
  const tlFill = add(`<div style="position:absolute;left:${TL.x}px;top:${Y(833, 'b')};height:3px;background:${C.or};border-radius:2px"></div>`, td);
  const tlKnob = add(`<div style="position:absolute;top:${Y(827, 'b')};width:15px;height:15px;margin-left:-7.5px;border-radius:50%;background:#fff;border:2px solid ${C.or};box-sizing:border-box"></div>`, td);
  const tlTime = add(`<div class="mo" style="position:absolute;left:410px;top:${Y(848, 'b')};font-size:9.6px;color:${C.mute};letter-spacing:1px"></div>`, td);
  add(`<div class="sm" style="position:absolute;left:${X(1124, 'r')};top:${Y(808, 'b')}">SPEED</div>`, td);
  const SP = {x: 1126, w: 92, y: 834};
  add(`<div style="position:absolute;left:${X(SP.x, 'r')};top:${Y(833, 'b')};width:${SP.w}px;height:3px;background:#efe6d8;border-radius:2px"></div>`, td);
  const spFill = add(`<div style="position:absolute;left:${X(SP.x, 'r')};top:${Y(833, 'b')};height:3px;background:${C.or};border-radius:2px"></div>`, td);
  const spKnob = add(`<div style="position:absolute;top:${Y(827, 'b')};width:15px;height:15px;margin-left:-7.5px;border-radius:50%;background:#fff;border:2px solid ${C.or};box-sizing:border-box"></div>`, td);
  const spVal = add(`<div class="mo" style="position:absolute;left:${X(1226, 'r')};top:${Y(828, 'b')};font-size:10px;font-weight:700"></div>`, td);
  add(`<div class="sm" style="position:absolute;left:27px;top:${Y(882, 'b')};letter-spacing:2.1px">DRAG TO ORBIT · WHEEL TO ZOOM · CLICK A PART · SPACE PLAY · 1-5 VIEWS</div>`);
  const foot = add(`<div class="sm" style="position:absolute;right:28px;top:${Y(882, 'b')};letter-spacing:2.1px"></div>`);
  const frame = {w: 1600, h: 900};

  // ------------------------------------------------------------ rearrange layer
  const ar = add(`<div style="position:absolute;inset:0;display:none"></div>`);
  add(`<div class="cp leftcp" style="left:28px;top:112px;height:${SH(760)}"></div>`, ar);
  const tabs2 = add(`<div class="tabs2"><div class="on">LAYOUTS</div><div>CATALOG</div></div>`, ar);
  const layList = add(`<div style="position:absolute;inset:0"></div>`, ar);
  const cat = add(`<div class="cat"><input class="q" placeholder="Search: sofa, walnut, IKEA, boucle…"><div class="f"><select data-k="category"></select><select data-k="brand"></select><select data-k="style"></select></div><div class="f"><select data-k="three"></select><select data-k="sort"><option value="">Best match</option><option value="price">Price ↑</option><option value="size">Smallest</option></select></div><div class="swap"><span></span><b>CANCEL</b></div><div class="n"></div><div class="list"></div></div>`, ar);
  let tab = 0;
  const setTab = (i) => {
    tab = i;
    ar.classList.toggle('wide', i === 1);
    [...tabs2.children].forEach((t, k) => t.classList.toggle('on', k === i));
    layList.style.display = i === 0 ? 'block' : 'none';
    cat.classList.toggle('on', i === 1);
  };
  [...tabs2.children].forEach((t, i) => t.addEventListener('click', () => setTab(i)));
  add(`<div class="cp" style="left:${X(1178, 'r')};top:112px;width:394px;height:${SH(760)}"></div>`, ar);
  const chat = add(`<div class="chat"></div>`, ar);
  const chatHead = add(`<div style="position:relative;height:44px;border-bottom:1px solid ${C.line}"></div>`, chat);
  add(`<div class="ph" style="left:14px;top:14px"><i></i>CLAUDE OPUS 5.5</div>`, chatHead);
  const newChat = add(`<div class="bt" style="right:150px;top:11px;height:20px;font-size:8.4px;padding:0 7px" title="Start a fresh conversation with Claude">NEW CHAT</div>`, chatHead);
  const effort = add(`<div class="seg" style="right:12px;top:8px;padding:2px;gap:2px"></div>`, chatHead);
  const effortBtn = {};
  for (const [k, l] of [['medium', 'QUICK'], ['high', 'THOROUGH']]) {
    effortBtn[k] = add(`<div style="width:64px;height:24px;font-size:8.6px">${l}</div>`, effort);
  }
  const log = add(`<div class="log"></div>`, chat);
  const refurb = add(`<div class="refurb"><select data-k="room"></select><select data-k="style"></select><select data-k="budget"><option value="">Any budget</option><option value="2000">≈ $2k</option><option value="5000">≈ $5k</option><option value="10000">≈ $10k</option><option value="25000">≈ $25k</option></select><div class="bt" data-k="go">REFURNISH</div></div>`, chat);
  const chips = add(`<div class="chips"></div>`, chat);
  const lib = add(`<div class="lib"><div class="lh"><div class="t">PROMPT LIBRARY</div><input placeholder="Search prompts…"><div class="x" title="Close">×</div></div><div class="tabs"></div><div class="list"></div></div>`, chat);
  const ask = add(`<div class="ask"><textarea placeholder="Ask for a layout: “make the living room work for 8 guests”, “swap the sectional for a sage velvet sofa”…"></textarea><button>SEND</button></div>`, chat);
  const input = ask.querySelector('textarea');
  const send = ask.querySelector('button');
  panel(330, 776, 836, 96, 'ARRANGE', '02', ar, 'bW');
  btn.floorGround = add(`<div class="bt" style="left:346px;top:${Y(812, 'b')};width:80px">GROUND</div>`, ar);
  btn.floorUpper = add(`<div class="bt" style="left:432px;top:${Y(812, 'b')};width:80px">UPPER</div>`, ar);
  btn.viewPlan = add(`<div class="bt" style="left:530px;top:${Y(812, 'b')};width:64px">PLAN</div>`, ar);
  btn.view3d = add(`<div class="bt" style="left:600px;top:${Y(812, 'b')};width:52px">3D</div>`, ar);
  btn.compare = add(`<div class="bt" style="left:664px;top:${Y(812, 'b')};width:112px">HOLD: ORIGINAL</div>`, ar);
  btn.swap = add(`<div class="bt" style="left:792px;top:${Y(812, 'b')};width:62px">SWAP</div>`, ar);
  btn.store = add(`<div class="bt" style="left:860px;top:${Y(812, 'b')};width:72px">REMOVE</div>`, ar);
  btn.rotate = add(`<div class="bt" style="left:938px;top:${Y(812, 'b')};width:96px">ROTATE 90°</div>`, ar);
  btn.resetEdits = add(`<div class="bt" style="left:1040px;top:${Y(812, 'b')};width:110px">RESET PIECE</div>`, ar);
  const arHint = add(`<div class="sm" style="position:absolute;left:346px;top:${Y(846, 'b')};width:${SW(800)};overflow:hidden;text-overflow:ellipsis"></div>`, ar);
  const arSel = add(`<div class="mo" style="position:absolute;left:452px;top:${Y(792, 'b')};width:${SW(640)};overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:9.5px;letter-spacing:1px;color:${C.ink}"></div>`, ar);

  // ------------------------------------------------------------ labels, trays, the pointer, toast, loader
  const callSvg = add(`<svg style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"></svg>`);
  const callG = add(`<div style="position:absolute;inset:0"></div>`);
  const trayG = add(`<div style="position:absolute;inset:0"></div>`);
  const tourChip = add(`<div class="tourchip"></div>`);
  const ring = add(`<div class="ring"></div>`);
  const cur = add(`<div class="cur"><svg width="22" height="22" viewBox="0 0 34 34"><path d="M4 3 L30 13.5 L17.5 17.5 L13.5 30 Z" fill="#111" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg></div>`);
  const toastEl = add(`<div class="toast"></div>`);
  const loader = add(`<div class="loader"><div class="sm" style="letter-spacing:2.4px">RECONSTRUCTED HOME</div><div class="t">Loft Teardown</div><div class="p"><i></i></div><div class="s">Starting…</div></div>`);

  const centre = (n) => {
    const r = n.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  let toastT = 0;
  const api = {
    root: ui, btn, modeBtn, effortBtn, input, send, log, chips, layList, roomsPanel, TL, SP, tourChip, loader, newChat, cat, setTab, refurb, frame,
    /** Where the clear view starts on the left, in frame pixels: past the layouts panel, or the wider catalogue. */
    leftEdge: () => (tab === 1 && ar.style.display !== 'none' ? cat.offsetLeft + cat.offsetWidth + 20 : 330),
    /** The frame live.js laid out (1600 x 900 or wider / taller): moves the slider geometry with it. */
    resize(w, h) {
      frame.w = w;
      frame.h = h;
      TL.w = 688 + (w - 1600);
      SP.x = 1126 + (w - 1600);
    },
    spots: () => Object.fromEntries([...Object.entries(btn), ...Object.entries(modeBtn).map(([k, v]) => [`mode:${k}`, v])].map(([k, n]) => [k, centre(n)])),
    setLoader(k, text) {
      loader.querySelector('i').style.width = `${(Math.max(0, Math.min(1, k)) * 100).toFixed(1)}%`;
      loader.querySelector('.s').textContent = text;
    },
    hideLoader() {
      loader.style.transition = 'opacity .5s';
      loader.style.opacity = '0';
      setTimeout(() => loader.remove(), 520);
    },
    toast(text) {
      toastEl.textContent = text;
      toastEl.style.opacity = '1';
      clearTimeout(toastT);
      toastT = setTimeout(() => (toastEl.style.opacity = '0'), 2600);
    },
    setStatic({subtitleText, claude, footText}) {
      subtitle.textContent = subtitleText;
      claudeChip.innerHTML = claude;
      foot.innerHTML = footText;
    },
    setRooms(list) {
      roomRows.innerHTML = '';
      list.forEach((r, i) => {
        const n = add(`<div class="room" style="top:${398 + i * 35}px"><div class="n">${esc(r.label)}</div><div class="v mo"></div><div class="bar"><i></i></div></div>`, roomRows);
        r.v = n.querySelector('.v');
        r.f = n.querySelector('i');
      });
      return list;
    },
    pointer(c) {
      cur.style.display = c.x < 0 ? 'none' : 'block';
      cur.style.transform = `translate(${(c.x - 3).toFixed(1)}px, ${(c.y - 2).toFixed(1)}px) scale(${c.press ? 0.88 : 1})`;
      ring.style.left = `${c.ringX}px`;
      ring.style.top = `${c.ringY}px`;
      ring.style.opacity = String(c.ring * 0.85);
      ring.style.transform = `scale(${(0.35 + 0.9 * (1 - c.ring)).toFixed(3)})`;
    },
    update(s) {
      for (const m of MODES) set(modeBtn[m], 'class', s.mode === m ? 'on' : '');
      const arr = s.mode === 'rearrange';
      set(td, 'display', arr ? 'none' : 'block');
      set(ar, 'display', arr ? 'block' : 'none');
      set(tourChip, 'display', arr ? 'none' : 'flex');
      set(tourChip, 'class', s.tour ? 'tourchip on' : 'tourchip');
      set(tourChip, 'html', s.tour ? '<i></i>AUTO TOUR · CLICK TO TAKE OVER' : '▶ RESUME TOUR');
      if (!arr) {
        const st = s.stage;
        set(chip, 'background', s.u <= 0.0005 ? C.green : s.u >= 0.9995 ? C.blue : C.or);
        const re = s.mode === 'reassemble';
        set(stName, 'text', re ? st.rname : st.name);
        set(stSub, 'text', re ? st.rsub : st.sub);
        const vals = [
          [s.home / s.total, `${s.home} / ${s.total}`],
          [s.flying / Math.max(1, s.total) * 6, String(s.flying)],
          [s.out / s.total, String(s.out)],
          [s.home === s.total ? 1 : 0, s.home ? `${s.maxErr.toFixed(4)} m` : '—'],
        ];
        rows.forEach((r, i) => {
          set(r.v, 'text', vals[i][1]);
          set(r.f, 'width', `${(Math.min(1, vals[i][0]) * 100).toFixed(1)}%`);
          if (i === 3) set(r.f, 'background', C.green);
        });
        for (const r of s.rooms) {
          set(r.v, 'text', `${r.home}/${r.n}`);
          set(r.f, 'width', `${((r.home / Math.max(1, r.n)) * 100).toFixed(1)}%`);
        }
        // the sequence reads top to bottom in the order it plays: reversed, with reassembly names, when going back
        const order = re ? [...STAGES].reverse() : STAGES;
        order.forEach((x, i) => {
          const next = STAGES[STAGES.indexOf(x) + 1];
          const startK = re ? (next ? 1 - next.at : 0) : x.at;
          set(stl[i].querySelector('b'), 'text', re ? x.rname : x.name);
          set(stl[i].querySelector('span'), 'text', `${Math.max(0, Math.round(startK * 100))}%`);
          set(stl[i], 'class', `stl ${x === st ? 'now' : (re ? x.at > s.u : x.at < s.u) ? 'done' : ''}`);
        });
        for (const k of VIEWS) set(btn[k], 'class', `bt${s.view === k ? ' on' : ''}`);
        for (const k of DISPLAY) set(btn[k], 'class', `bt${s.display[k] ? ' on' : ''}`);
        set(btn.play, 'text', s.paused ? '▶' : '❚❚');
        set(tlTitle, 'html', `<i></i>${s.mode === 'reassemble' ? 'REASSEMBLY' : 'TEARDOWN'}`);
        set(opFrom, 'text', s.mode === 'reassemble' ? 'TORN DOWN' : 'INTACT');
        set(opTo, 'text', s.mode === 'reassemble' ? 'REASSEMBLED' : 'TORN DOWN');
        set(opPhase, 'text', s.phase);
        const k = s.mode === 'reassemble' ? 1 - s.u : s.u;
        set(tlFill, 'width', `${(k * TL.w).toFixed(1)}px`);
        set(tlKnob, 'left', `${(TL.x + k * TL.w).toFixed(1)}px`);
        set(tlTime, 'text', `${s.tau.toFixed(1)} s / ${s.dur.toFixed(1)} s`);
        set(spFill, 'width', `${(s.speedK * SP.w).toFixed(1)}px`);
        set(spKnob, 'left', `${(SP.x + s.speedK * SP.w).toFixed(1)}px`);
        set(spVal, 'text', `${s.speed.toFixed(1)}×`);
        set(selCard, 'html', s.selHtml || `<div class="sm" style="white-space:normal;line-height:15px">Click any part to read what it is, where it belongs and how it was measured.</div>`);
      } else {
        set(btn.floorGround, 'class', `bt${s.floor === 'ground' ? ' on' : ''}`);
        set(btn.floorUpper, 'class', `bt${s.floor === 'upper' ? ' on' : ''}`);
        set(btn.viewPlan, 'class', `bt${s.arView === 'plan' ? ' on' : ''}`);
        set(btn.view3d, 'class', `bt${s.arView === '3d' ? ' on' : ''}`);
        set(btn.compare, 'class', `bt${s.comparing ? ' on' : ''}${s.canCompare ? '' : ' dis'}`);
        for (const k of ['resetEdits', 'rotate']) set(btn[k], 'class', `bt${s.selMovable ? '' : ' dis'}`);
        for (const k of ['swap', 'store']) set(btn[k], 'class', `bt${s.selRemovable ? '' : ' dis'}${k === 'swap' && s.swapping ? ' on' : ''}`);
        set(arHint, 'text', s.arHint);
        set(arSel, 'text', s.arSel || '');
        for (const k of Object.keys(effortBtn)) set(effortBtn[k], 'class', s.effort === k ? 'on' : '');
      }
      // labels with leaders
      let lh = '';
      let ch = '';
      for (const c of s.callouts) {
        if (c.o < 0.02 || !c.at) continue;
        const [ax, ay] = c.at;
        const [lx, ly] = c.label;
        const right = lx > ax;
        const ex = right ? lx - 4 : lx + c.w + 4;
        lh += `<polyline points="${ax.toFixed(1)},${ay.toFixed(1)} ${ex.toFixed(1)},${(ly + 7).toFixed(1)}" fill="none" stroke="${C.or}" stroke-width=".9" opacity="${c.o.toFixed(2)}"/><circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="2.4" fill="${C.or}" opacity="${c.o.toFixed(2)}"/>`;
        ch += `<div class="call" style="left:${lx.toFixed(1)}px;top:${(ly - 1).toFixed(1)}px;opacity:${c.o.toFixed(2)}"><b><i></i>${esc(c.name)}</b><span>${esc(c.sub)}</span></div>`;
      }
      set(callSvg, 'html', lh);
      set(callG, 'html', ch);
      let th = '';
      for (const t of s.trayLabels) th += `<div class="tray" style="left:${t.at[0].toFixed(1)}px;top:${t.at[1].toFixed(1)}px;opacity:${t.o.toFixed(2)}">${esc(t.label.toUpperCase())}<span>${t.n}</span></div>`;
      set(trayG, 'html', th);
      api.pointer(s.cursor);
    },
    setLayouts(list, activeId, onPick, onDelete) {
      layList.innerHTML = '';
      let y = 162;
      for (const l of list) {
        const n = add(`<div class="lay${l.id === activeId ? ' on' : ''}" style="top:${y}px"><div class="t">${esc(l.title)}</div><div class="s">${esc(l.sub)}</div>${l.id !== 'original' ? '<div class="x" title="Delete layout">×</div>' : ''}</div>`, layList);
        n.addEventListener('click', (e) => {
          if (e.target.classList.contains('x')) onDelete(l.id);
          else onPick(l.id);
        });
        y += 52;
        if (y > 810 + (frame.h - 900)) break;
      }
    },
    setChips(list, onPick, more) {
      chips.innerHTML = '';
      for (const t of list) add(`<div>${esc(t)}</div>`, chips).addEventListener('click', () => onPick(t));
      if (more) add(`<div class="more">${esc(more.label)}</div>`, chips).addEventListener('click', more.onClick);
    },
    /** The prompt library: tabs by category, a search, and per prompt "use" (into the box) or "send" (straight to Claude). */
    library({groups, onUse, onSend}) {
      const search = lib.querySelector('input');
      const tabs = lib.querySelector('.tabs');
      const list = lib.querySelector('.list');
      let cat = 'All';
      const render = () => {
        tabs.innerHTML = '';
        for (const k of ['All', ...Object.keys(groups)]) {
          const n = k === 'All' ? Object.values(groups).flat().length : groups[k].length;
          const t = add(`<div class="${k === cat ? 'on' : ''}">${esc(k)} ${n}</div>`, tabs);
          t.addEventListener('click', () => ((cat = k), render()));
        }
        const q = search.value.trim().toLowerCase();
        list.innerHTML = '';
        let shown = 0;
        for (const [k, items] of Object.entries(groups)) {
          if (cat !== 'All' && k !== cat) continue;
          const hits = items.filter((t) => !q || t.toLowerCase().includes(q));
          if (!hits.length) continue;
          add(`<div class="cat">${esc(k)}</div>`, list);
          for (const t of hits) {
            const row = add(`<div class="row"><span>${esc(t)}</span><b title="Put it in the box to edit">USE</b><b title="Send to Claude now">SEND</b></div>`, list);
            row.querySelector('span').addEventListener('click', () => onUse(t));
            const [use, send] = row.querySelectorAll('b');
            use.addEventListener('click', () => onUse(t));
            send.addEventListener('click', () => onSend(t));
            shown++;
          }
        }
        if (!shown) add(`<div class="none">No prompt matches “${esc(search.value)}”. Type your own request below.</div>`, list);
      };
      search.addEventListener('input', render);
      lib.querySelector('.x').addEventListener('click', () => lib.classList.remove('on'));
      render();
      return {
        open() {
          lib.classList.add('on');
          search.value = '';
          render();
          search.focus();
        },
        close: () => lib.classList.remove('on'),
      };
    },
    addMsg(cls, html) {
      const n = add(`<div class="msg ${cls}">${html}</div>`, log);
      log.scrollTop = log.scrollHeight;
      return n;
    },
    scrollLog() {
      log.scrollTop = log.scrollHeight;
    },
  };
  return api;
}
