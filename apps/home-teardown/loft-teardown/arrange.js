// The rearrange mode's conversation. A request goes to the local server with the home's static description and the
// layout on screen; the server runs Claude Opus 5.5, checks every proposal against the walls, doors, stairs,
// built-ins and the other pieces, sends the conflicts back for a fix, and streams its progress here. The accepted
// proposal becomes a new layout on top of the one it was asked about, saved next to the private model.
import {normDeg} from '../shared/layout-check.js';
import {CATALOG} from './catalog.js';
import {esc} from './console.js';
import {ALL_PROMPTS, PROMPTS} from './prompts.js';

export function createArrange({ui, config, sidToGid, byId, ORIGINAL, getLayouts, setLayouts, getActive, setActive, getEffort, scene0, preview = () => {}, catalogById = new Map(), rooms = {}, make3d = null, threeD = () => 'own'}) {
  const gidToSid = new Map([...sidToGid].map(([s, g]) => [g, s]));
  let busy = false;
  const layoutById = (id) => getLayouts().find((l) => l.id === id) || ORIGINAL;
  const subOf = (l) => {
    if (l.id === 'original') return 'AS RECONSTRUCTED';
    const m = Object.keys(l.place).length;
    const parts = [`${m} MOVED`];
    if (l.added.length) parts.push(`${l.added.length} NEW`);
    if (l.removed.length) parts.push(`${l.removed.length} STORED`);
    return parts.join(' · ');
  };
  const renderLayouts = () =>
    ui.setLayouts(getLayouts().map((l) => ({id: l.id, title: l.title, sub: subOf(l)})), getActive(), (id) => {
      setActive(id);
      renderLayouts();
    }, (id) => {
      setLayouts(getLayouts().filter((l) => l.id !== id));
      if (getActive() === id) setActive('original');
      renderLayouts();
      save();
    });
  const save = async () => {
    renderLayouts();
    try {
      await fetch('/api/layouts', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({layouts: getLayouts().filter((l) => l.id !== 'original')})});
    } catch (e) {
      console.warn('could not save layouts', e);
    }
  };
  const load = async () => {
    try {
      const r = await fetch('/api/layouts');
      if (r.ok) {
        const {layouts = []} = await r.json();
        setLayouts([ORIGINAL, ...layouts.filter((l) => l && l.id && l.place)]);
      }
    } catch (e) {
      console.warn('could not load layouts', e);
    }
    renderLayouts();
  };

  /** The layout on screen, in the ids Claude knows (m* for original pieces, n* for pieces it added). */
  const baseForClaude = (v) => ({
    moved: Object.entries(v.place).map(([gid, P]) => ({id: gidToSid.get(gid), x: P.x, z: P.z, facing: P.facing, floor: P.floor})).filter((m) => m.id),
    removed: v.removed.map((gid) => gidToSid.get(gid)).filter(Boolean),
    // built-ins the homeowner removed: no longer obstacles for Claude's checker
    removedFixed: v.removed.filter((gid) => !gidToSid.has(gid)),
    removedFixedLabels: v.removed.filter((gid) => !gidToSid.has(gid)).map((gid) => byId.get(gid)?.label).filter(Boolean),
    added: v.added.map((a) => ({id: a.id, catalog_id: a.catalog_id || '', type: a.type, label: a.label, x: a.x, z: a.z, facing: a.facing, floor: a.floor, width: a.width, depth: a.depth, height: a.height, color: a.color, accent: a.accent, material: a.material})),
  });
  const lineage = (v) => {
    const out = [];
    for (let l = v; l && l.id !== 'original'; l = layoutById(l.baseId)) {
      if (l.request) out.unshift({request: l.request, title: l.title, summary: l.summary});
      if (out.length > 6 || !l.baseId) break;
    }
    return out;
  };
  const describeChange = (base, v, r) => {
    const lines = [];
    const label = (sid) => (sid?.startsWith('n') ? (v.added.find((a) => a.id === sid) || base.added.find((a) => a.id === sid))?.label : byId.get(sidToGid.get(sid))?.label) || sid;
    for (const m of r.moves) {
      const g = byId.get(sidToGid.get(m.id));
      const prev = g ? base.place[g.id] || {x: g.center.x, z: g.center.z, facing: g.facing, floor: g.floor} : null;
      let what = '';
      if (prev) {
        const dist = Math.hypot(m.x - prev.x, m.z - prev.z);
        const turn = Math.abs(((normDeg(m.facing) - normDeg(prev.facing) + 540) % 360) - 180);
        what = [dist > 0.05 ? `${dist.toFixed(1)} m` : '', turn > 1 ? `turned ${Math.round(turn)}°` : '', m.floor !== prev.floor ? `to the ${m.floor} floor` : ''].filter(Boolean).join(', ');
      }
      lines.push(`<li>${esc(label(m.id))}${what ? ` <span style="color:#958a7c">· ${esc(what)}</span>` : ''}</li>`);
    }
    for (const a of r.add) {
      const c = a.catalog_id ? catalogById.get(a.catalog_id) : null;
      const shop = c?.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" style="color:#e3562a">↗</a>` : '';
      lines.push(`<li class="add">New: ${esc(a.label)} <span style="color:#958a7c">· ${c && !c.generic ? `${esc(c.brand)}${c.price ? ` $${c.price.toLocaleString('en-US')}` : ''}, ` : `${esc(a.type.replace(/_/g, ' '))}, `}${a.width.toFixed(2)}×${a.depth.toFixed(2)} m</span>${shop}</li>`);
    }
    for (const id of r.remove) lines.push(`<li class="rem">Stored: ${esc(label(id))}</li>`);
    return lines.join('');
  };

  const fail = (text) => {
    ui.addMsg('err', esc(text));
    busy = false;
    ui.send.disabled = false;
  };
  /** A layout from Claude's changes (relative to the layout it started from); used for the live draft and the result. */
  const variantFrom = (base, ops, extra) => {
    const v = {
      id: `l${Date.now().toString(36)}`, baseId: base.id, place: JSON.parse(JSON.stringify(base.place)), removed: [...base.removed], added: base.added.map((a) => ({...a})), createdAt: Date.now(), ...extra,
    };
    for (const m of ops.moves) {
      if (m.id.startsWith('n')) {
        const a = v.added.find((x) => x.id === m.id);
        if (a) Object.assign(a, {x: m.x, z: m.z, facing: normDeg(m.facing), floor: m.floor});
        continue;
      }
      const gid = sidToGid.get(m.id);
      if (!gid) continue;
      v.place[gid] = {x: m.x, z: m.z, facing: normDeg(m.facing), floor: m.floor};
      v.removed = v.removed.filter((r) => r !== gid);
    }
    for (const id of ops.remove) {
      if (id.startsWith('n')) v.added = v.added.filter((a) => a.id !== id);
      else {
        const gid = sidToGid.get(id);
        if (gid && !v.removed.includes(gid)) v.removed.push(gid);
        if (gid) delete v.place[gid];
      }
    }
    let next = 1 + Math.max(0, ...v.added.map((a) => Number(a.id.slice(1)) || 0));
    for (const a of ops.add) {
      if (!CATALOG[a.type]) continue;
      v.added.push({id: `n${next++}`, type: a.type, label: a.label, x: a.x, z: a.z, facing: normDeg(a.facing), floor: a.floor, width: a.width, depth: a.depth, height: a.height, color: a.color, accent: a.accent, material: a.material});
    }
    return v;
  };
  // one conversation with Claude per tab: follow-ups continue it (the server compacts it when it grows)
  let threadId = sessionStorage.getItem('loft-thread') || null;
  const k = (n) => `${(n / 1000).toFixed(1)}k`;

  const send = async (text, {scope = ''} = {}) => {
    text = text.trim();
    if (!text || busy) return;
    if (!config.claude.ready) {
      ui.addMsg('user', esc(text));
      fail('The server has no ANTHROPIC_API_KEY. Export it in the terminal that runs the server (or put it in the repository .env) and restart it.');
      return;
    }
    busy = true;
    ui.send.disabled = true;
    ui.input.value = '';
    const base = layoutById(getActive());
    ui.addMsg('user', esc(text));
    const status = ui.addMsg('status', '<b>●</b> Sending the home to Claude…');
    let think = null;
    let thinkText = '';
    const t0 = performance.now();
    let statusText = 'Claude is thinking';
    let spend = '';
    const tick = setInterval(() => {
      status.innerHTML = `<b>●</b> ${esc(statusText)} · ${((performance.now() - t0) / 1000).toFixed(0)} s${spend}`;
      ui.log.appendChild(status);
    }, 500);
    const freshThinking = () => ((think = null), (thinkText = ''));
    let result = null;
    let partial = false;
    let finalIssues = [];
    let meta = null;
    let previewing = false;
    try {
      const res = await fetch('/api/arrange', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({request: text, effort: getEffort(), scope, scene: scene0, base: baseForClaude(base), baseTitle: base.title, history: lineage(base), threadId}),
      });
      if (!res.ok || !res.body) throw new Error(`server: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'status') statusText = ev.text;
          else if (ev.type === 'thread') {
            threadId = ev.id;
            sessionStorage.setItem('loft-thread', ev.id);
            if (!ev.fresh) ui.addMsg('status', `<b>↺</b> Continuing the conversation: ${ev.earlier} earlier request${ev.earlier === 1 ? '' : 's'}${ev.compactions ? `, summarised ${ev.compactions}×` : ''}`);
          } else if (ev.type === 'thinking') {
            if (!think) think = ui.addMsg('think', '');
            thinkText += ev.delta;
            think.textContent = thinkText.slice(-1600);
            think.scrollTop = think.scrollHeight;
            ui.scrollLog();
          } else if (ev.type === 'step') {
            ui.addMsg('status', `<b>${ev.conflicts.length ? '!' : '✓'}</b> Step ${ev.n}: ${esc(ev.note || 'changes')} · ${ev.changes} change${ev.changes === 1 ? '' : 's'}${ev.conflicts.length ? `, ${ev.conflicts.length} conflict${ev.conflicts.length > 1 ? 's' : ''} to fix` : ''}`);
            freshThinking();
          } else if (ev.type === 'draft') {
            // the house follows the draft as Claude builds it
            preview(variantFrom(base, ev.ops, {id: 'preview', title: 'Claude’s draft', summary: '', request: text}));
            previewing = true;
          } else if (ev.type === 'search') statusText = `Searching: ${ev.text}`;
          else if (ev.type === 'budget') spend = ` · ${k(ev.output)} of ${k(ev.budget)} tokens`;
          else if (ev.type === 'compaction') {
            ui.addMsg('status', `<b>⇣</b> Conversation summarised (it was about ${k(ev.before)} tokens); the draft is kept exactly`);
            freshThinking();
          } else if (ev.type === 'retry') {
            ui.addMsg('status', `<b>!</b> ${esc(ev.text)}`);
            freshThinking();
          } else if (ev.type === 'round') {
            ui.addMsg('status', ev.accepted ? `<b>✓</b> Finished: layout checked${ev.issues.length ? `, ${ev.issues.length} minor issue${ev.issues.length > 1 ? 's' : ''} left` : ', no conflicts'}` : `<b>↻</b> Final check: ${ev.issues.length} conflict${ev.issues.length > 1 ? 's' : ''} (${esc(ev.issues.slice(0, 2).join(' ').slice(0, 160))}…), sent back to Claude`);
            freshThinking();
          } else if (ev.type === 'result') {
            result = ev.layout;
            partial = !!ev.partial;
            finalIssues = ev.issues || [];
            meta = ev.meta;
          } else if (ev.type === 'error') throw new Error(ev.message);
        }
      }
    } catch (e) {
      clearInterval(tick);
      status.remove();
      if (previewing) preview(null);
      fail(e.message || String(e));
      return;
    }
    clearInterval(tick);
    status.remove();
    if (!result) {
      if (previewing) preview(null);
      return fail('Claude finished without changing the layout. Try rephrasing the request.');
    }
    const v = variantFrom(base, result, {title: (partial ? 'Unfinished · ' : '') + (result.title.slice(0, 44) || 'New layout'), summary: result.summary, request: text, issues: finalIssues, meta, partial});
    preview(null, true);
    setLayouts([...getLayouts(), v]);
    setActive(v.id);
    save();
    const newCost = result.add.reduce((sum, a) => sum + (catalogById.get(a.catalog_id)?.price || 0), 0);
    const cost = newCost ? `<div class="meta" style="color:#2a2521">New pieces from the catalogue: $${newCost.toLocaleString('en-US')} at list prices</div>` : '';
    const warn = finalIssues.length ? `<ul class="chg">${finalIssues.slice(0, 4).map((x) => `<li class="warn">${esc(x)}</li>`).join('')}</ul>` : '';
    const note = partial ? `<div class="meta" style="color:#c8322b">Claude stopped before calling finish; the steps it completed are saved as this layout. Ask it to continue.</div>` : '';
    const m = meta ? [`${meta.steps} step${meta.steps === 1 ? '' : 's'}`, `${meta.turns} turns`, meta.compactions ? `${meta.compactions} compaction${meta.compactions > 1 ? 's' : ''}` : '', `${meta.seconds.toFixed(0)} s`, `${k(meta.input)} in (${k(meta.cached)} cached)`, `${k(meta.output)} out of ${k(meta.budget)}`].filter(Boolean).join(' · ') : '';
    // catalogue pieces Claude added that have no 3D model yet: one button makes them all
    const bare = [...new Set(result.add.map((a) => a.catalog_id).filter(Boolean))].map((id) => catalogById.get(id)).filter((it) => it && !it.generic && threeD(it) === 'none');
    const make = bare.length && make3d ? `<div class="meta"><span class="mk3" style="cursor:pointer;color:#e3562a;font-weight:700">MAKE 3D FOR ${bare.length} NEW PIECE${bare.length > 1 ? 'S' : ''}</span> · about $${(bare.length * 0.08).toFixed(2)}, ${bare.length > 3 ? 'a few minutes' : 'about a minute'}</div>` : '';
    const msgEl = ui.addMsg('ai', `<h4><i></i>${esc(v.title)}</h4>${esc(result.summary)}<ul class="chg">${describeChange(base, v, result)}</ul>${cost}${warn}${note}${make}<div class="meta">${esc(m)} · on top of “${esc(base.title)}”</div>`);
    msgEl.querySelector('.mk3')?.addEventListener('click', (e) => {
      e.target.textContent = `MAKING ${bare.length} 3D MODEL${bare.length > 1 ? 'S' : ''}…`;
      e.target.style.pointerEvents = 'none';
      Promise.all(bare.map((it) => make3d(it))).then(() => (e.target.textContent = 'DONE: THE NEW PIECES SHOW THEIR 3D MODELS'));
    });
    busy = false;
    ui.send.disabled = false;
    dealChips();
  };
  // refurnish: a room or the whole home, in a style, optionally within a budget, with pieces from the catalogue
  {
    const f = Object.fromEntries([...ui.refurb.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
    const STYLES = ['Modern', 'Scandinavian', 'Japandi', 'Mid-century modern', 'Organic modern', 'Minimalist', 'Industrial', 'Coastal', 'Boho', 'Traditional', 'Art deco', 'Warm contemporary'];
    f.room.innerHTML = `<option value="home">Whole home</option>${Object.entries(rooms).filter(([id]) => !['stairs', 'hall', 'guest-bath', 'main-bath'].includes(id)).map(([id, r]) => `<option value="${id}">${esc(r.label)}</option>`).join('')}`;
    f.room.value = 'living';
    f.style.innerHTML = STYLES.map((x) => `<option>${x}</option>`).join('');
    f.go.addEventListener('click', () => {
      if (busy) return;
      const home = f.room.value === 'home';
      const where = home ? 'the whole home, room by room' : `the ${rooms[f.room.value]?.label.toLowerCase() || f.room.value}`;
      const money = f.budget.value ? ` Keep the new pieces to about $${Number(f.budget.value).toLocaleString('en-US')} in total at list prices.` : '';
      send(`Refurnish ${where} in a ${f.style.value.toLowerCase()} style with pieces from the catalogue. Keep what already fits the style, replace or remove the rest, and keep it comfortable for everyday living.${money}`, {scope: home ? 'home' : 'room'});
    });
  }
  ui.newChat?.addEventListener('click', () => {
    if (busy) return;
    threadId = null;
    sessionStorage.removeItem('loft-thread');
    ui.addMsg('status', '<b>+</b> New conversation: Claude starts fresh from the layout on screen');
  });

  ui.send.addEventListener('click', () => send(ui.input.value));
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(ui.input.value);
    }
  });
  // three suggestions that change after every request, and the whole library one click away
  const use = (t) => {
    library.close();
    ui.input.value = t;
    ui.input.focus();
  };
  const library = ui.library({groups: PROMPTS, onUse: use, onSend: (t) => (library.close(), send(t))});
  let deal = 0;
  const dealChips = () => {
    const picks = [];
    for (let i = 0; i < 3; i++) picks.push(ALL_PROMPTS[(deal * 17 + i * 23) % ALL_PROMPTS.length].text);
    deal++;
    ui.setChips(picks, use, {label: `All ${ALL_PROMPTS.length} ideas →`, onClick: () => library.open()});
  };
  dealChips();
  ui.addMsg('ai', `<h4><i></i>Rearrange with Claude</h4>Describe how you want to live in the loft. Claude Opus 5.5 sees every wall, door, built-in and ${scene0.items.length} movable pieces with their measured sizes, proposes a layout, and the page checks it for collisions before you see it. It can also bring in new furniture. Each answer becomes a layout on the left; hold <b>C</b> to compare with the original. Drag any piece to adjust it by hand.`);
  return {send, save, load, renderLayouts};
}
