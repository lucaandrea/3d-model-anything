// The CATALOG tab: search and filter the furniture catalogue, pick a colour, then ADD a piece to the room on screen or,
// while swapping, SWAP it in for the selected piece. Every card says whether the piece has a 3D model of its own, an
// AI-made one, or none yet (it is then drawn as a generic shape of its type); MAKE 3D has Claude build one from the
// product photo and listed size. Cards render in pages as the list scrolls; thumbnails render as cards come into view.
import {CATEGORIES, dimsText, priceText, searchCatalog, threeD} from '../shared/catalog-index.js';
import {esc} from './console.js';

const PAGE = 90;

export function createCatalogPanel({ui, items, thumbnail, onAdd, onSwap, onMake}) {
  const root = ui.cat;
  const q = root.querySelector('.q');
  const sel = Object.fromEntries([...root.querySelectorAll('select')].map((s) => [s.dataset.k, s]));
  const list = root.querySelector('.list');
  const count = root.querySelector('.n');
  const banner = root.querySelector('.swap');
  let swap = null; // {label, kind}
  const chosen = new Map(); // item id -> colour hex
  const making = new Set(); // item ids being modelled
  let res = [];
  let shown = 0;

  const fill = (s, first, values) => (s.innerHTML = `<option value="">${first}</option>${values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`);
  const present = (f) => [...new Set(items.map(f).flat().filter(Boolean))];
  fill(sel.category, 'All categories', CATEGORIES.filter((c) => items.some((i) => i.category === c)));
  const brandCount = new Map();
  for (const i of items) brandCount.set(i.brand, (brandCount.get(i.brand) || 0) + 1);
  sel.brand.innerHTML = `<option value="">All brands (${brandCount.size})</option>${present((i) => i.brand).sort((a, b) => (a === 'Generic') - (b === 'Generic') || a.localeCompare(b)).map((b) => `<option value="${esc(b)}">${esc(b)} · ${brandCount.get(b)}</option>`).join('')}`;
  const styleCount = new Map();
  for (const i of items) for (const st of i.style || []) styleCount.set(st, (styleCount.get(st) || 0) + 1);
  fill(sel.style, 'All styles', [...styleCount].filter(([s]) => s !== 'basic').sort((a, b) => b[1] - a[1]).slice(0, 18).map(([s]) => s));
  sel.three.innerHTML = `<option value="">Any 3D status</option><option value="any">Has a 3D model</option><option value="own">Own 3D model</option><option value="gen">AI-made 3D</option><option value="none">No 3D model</option>`;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      io.unobserve(img);
      const it = items.find((x) => x.id === img.dataset.id);
      if (it) thumbnail(it, chosen.get(it.id), (url) => (img.src = url));
    }
  }, {root: list});

  const badge = (it) => {
    const t = threeD(it);
    if (making.has(it.id)) return `<span class="b3 busy">MAKING 3D…</span>`;
    if (t === 'own') return `<span class="b3 own" title="${esc(it.model.attribution || '')}">3D MODEL</span>`;
    if (t === 'gen') return `<span class="b3 gen" title="Made by Claude from the product photo and listed size">AI 3D</span>`;
    return `<span class="b3 none" title="No 3D model yet: shown as a generic ${esc(it.build.replace(/_/g, ' '))}${it.model?.standIn ? ` (a similar open model stands in)` : ''}">NO 3D MODEL</span>${it.generic ? '' : `<span class="mk" title="Claude builds a 3D model from the product photo, sized exactly to the listed dimensions (about 40 s)">MAKE 3D</span>`}`;
  };
  const card = (it) => {
    const color = chosen.get(it.id) || it.colors[0]?.hex;
    const c = document.createElement('div');
    c.className = 'it';
    c.dataset.id = it.id;
    const t3 = threeD(it);
    const src = t3 === 'own' ? `3D: ${it.model.source} · ${it.model.license}` : t3 === 'none' && it.model?.standIn ? `A similar open model stands in until made` : '';
    c.innerHTML = `<img data-id="${esc(it.id)}" alt=""><div class="b"><div class="t" title="${esc(it.name)}">${esc(it.name)}</div><div class="s">${esc(it.brand.toUpperCase())}${it.price ? ` · ${priceText(it)}` : ''}</div><div class="s">${esc(dimsText(it))}${it.size_note ? ` · ${esc(it.size_note)}` : ''}</div><div class="row3">${badge(it)}</div>${src ? `<div class="s" title="${esc(it.model?.attribution || '')}">${esc(src)}</div>` : ''}<div class="row">${it.colors.slice(0, 6).map((cl) => `<i class="dot${cl.hex === color ? ' on' : ''}" data-hex="${cl.hex}" title="${esc(cl.name)}" style="background:${cl.hex}"></i>`).join('')}${it.url ? `<a class="ln" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" title="Open at ${esc(it.brand)}">↗</a>` : ''}<span class="go">${swap ? 'SWAP' : 'ADD'}</span></div></div>`;
    const img = c.querySelector('img');
    io.observe(img);
    for (const d of c.querySelectorAll('.dot'))
      d.addEventListener('click', () => {
        chosen.set(it.id, d.dataset.hex);
        c.querySelectorAll('.dot').forEach((x) => x.classList.toggle('on', x === d));
        thumbnail(it, d.dataset.hex, (url) => (img.src = url));
      });
    c.querySelector('.go').addEventListener('click', () => (swap ? onSwap(it, chosen.get(it.id) || it.colors[0]?.hex) : onAdd(it, chosen.get(it.id) || it.colors[0]?.hex)));
    c.querySelector('.mk')?.addEventListener('click', () => api.make(it));
    return c;
  };
  const more = () => {
    const frag = document.createDocumentFragment();
    for (const it of res.slice(shown, shown + PAGE)) frag.appendChild(card(it));
    shown = Math.min(res.length, shown + PAGE);
    list.appendChild(frag);
  };
  const render = () => {
    res = searchCatalog(items, {query: q.value, category: sel.category.value, brand: sel.brand.value, style: sel.style.value, three: sel.three.value, kind: swap?.kind || '', limit: Infinity});
    if (sel.sort.value === 'price') res = res.slice().sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
    if (sel.sort.value === 'size') res = res.slice().sort((a, b) => a.w * a.d - b.w * b.d);
    const with3d = res.filter((r) => threeD(r) !== 'none').length;
    count.textContent = `${res.length.toLocaleString('en-US')} piece${res.length === 1 ? '' : 's'}${res.length ? ` · ${with3d.toLocaleString('en-US')} with 3D · ${(res.length - with3d).toLocaleString('en-US')} without` : ''}`;
    list.innerHTML = '';
    list.scrollTop = 0;
    shown = 0;
    more();
  };
  list.addEventListener('scroll', () => {
    if (shown < res.length && list.scrollTop + list.clientHeight > list.scrollHeight - 400) more();
  });
  q.addEventListener('input', render);
  for (const s of Object.values(sel)) s.addEventListener('change', render);
  banner.querySelector('b').addEventListener('click', () => api.stopSwap());
  const refreshCard = (id) => {
    const old = list.querySelector(`.it[data-id="${CSS.escape(id)}"]`);
    const it = items.find((x) => x.id === id);
    if (old && it) old.replaceWith(card(it));
  };
  const api = {
    render,
    refreshCard,
    get swapping() {
      return swap;
    },
    /** Asks the server for an AI 3D model of a piece; the card shows progress and then the new model. */
    async make(it) {
      if (making.has(it.id) || threeD(it) !== 'none') return;
      making.add(it.id);
      refreshCard(it.id);
      try {
        await onMake(it);
      } finally {
        making.delete(it.id);
        refreshCard(it.id);
      }
    },
    startSwap(label, kind) {
      swap = {label, kind};
      q.value = '';
      banner.querySelector('span').textContent = `Swapping “${label}”: pick a replacement`;
      banner.classList.add('on');
      ui.setTab(1);
      render();
    },
    stopSwap() {
      swap = null;
      banner.classList.remove('on');
      render();
    },
  };
  render();
  return api;
}
