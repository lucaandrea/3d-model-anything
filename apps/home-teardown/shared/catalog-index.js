// The furniture catalogue: real products (retailer name, real dimensions, colours, price, link) and openly licensed
// models, plus a generic entry for every procedural type. Shared by the page (the CATALOG panel, swapping, rendering)
// and the server (Claude's search_catalog tool). Pure data and search, no three.js.
import {CATALOG} from './furniture.js';

export const CATEGORY_OF = {
  sofa: 'Sofas', sectional_l: 'Sofas', loveseat: 'Sofas', armchair: 'Chairs', lounge_chair: 'Chairs', chaise: 'Chairs', ottoman: 'Ottomans & poufs', pouf: 'Ottomans & poufs', bench: 'Benches',
  dining_chair: 'Dining chairs', bar_stool: 'Bar stools', office_chair: 'Desk chairs', coffee_table: 'Coffee tables', round_coffee_table: 'Coffee tables', side_table: 'Side tables',
  dining_table: 'Dining tables', round_dining_table: 'Dining tables', desk: 'Desks', console_table: 'Console tables', bed: 'Beds', daybed: 'Beds', nightstand: 'Nightstands',
  dresser: 'Dressers', sideboard: 'Sideboards', tv_console: 'Media consoles', bookshelf: 'Bookcases & shelving', wardrobe: 'Wardrobes', bar_cart: 'Bar carts', floor_lamp: 'Lighting',
  rug: 'Rugs', round_rug: 'Rugs', plant: 'Plants', tall_plant: 'Plants', tv: 'Media', piano: 'Media', room_divider: 'Decor', mirror: 'Mirrors', washer: 'Appliances', dryer: 'Appliances',
};
export const CATEGORIES = [...new Set(Object.values(CATEGORY_OF))];

/** Generic pieces: one per procedural type at its default size, so every kind can always be added. */
export function genericItems() {
  return Object.entries(CATALOG)
    .filter(([type]) => !['washer', 'dryer', 'piano'].includes(type))
    .map(([type, T]) => ({
      id: `generic-${type}`, name: type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), brand: 'Generic', category: CATEGORY_OF[type] || 'Decor', kind: T.kind, build: type,
      w: T.w, d: T.d, h: T.h, material: /table|desk|console|shelf|dresser|sideboard|nightstand|wardrobe|bench|cart/.test(type) ? 'wood' : /lamp/.test(type) ? 'metal' : 'fabric',
      colors: [{name: 'Natural', hex: /table|desk|console|shelf|dresser|sideboard|nightstand|wardrobe|bench|cart/.test(type) ? '#a57a52' : '#c8bfb2'}, {name: 'Charcoal', hex: '#3d3b39'}, {name: 'Sage', hex: '#8fa58b'}],
      accent: '#2b2622', price: null, url: null, style: ['basic'], generic: true,
    }));
}

/** Fills defaults and derived fields; drops entries without usable dimensions. */
export function normaliseItems(raw) {
  const out = [];
  for (const it of raw) {
    if (!it?.id || !it.name || !(it.w > 0.05) || !(it.d > 0.005) || !(it.h > 0.005)) continue;
    const T = CATALOG[it.build] || CATALOG.armchair;
    out.push({
      brand: 'Generic', kind: T.kind, material: 'fabric', accent: '#2b2622', style: [], price: null, url: null,
      ...it,
      // the shared bucket ("Sofas", "Chairs"…) for filtering; a retailer's own label is kept as retail_category
      category: CATEGORY_OF[it.build] || it.category || 'Decor',
      ...(it.category && it.category !== (CATEGORY_OF[it.build] || it.category) && !it.retail_category ? {retail_category: it.category} : {}),
      colors: it.colors?.length ? it.colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c.hex)) : [{name: 'Default', hex: '#c8bfb2'}],
    });
  }
  return out;
}

// accent-insensitive, so "poang" finds POÄNG and "boucle" finds bouclé
/**
 * A piece's 3D status: 'own' (an openly licensed model of this product), 'gen' (made by Claude from its photo and
 * listed size, catalog/generated/<id>.json) or 'none' (drawn as a generic shape of its type, or a borrowed stand-in).
 */
export const threeD = (it) => (it.model && !it.model.standIn ? 'own' : it.gen ? 'gen' : 'none');
export const THREE_D_LABEL = {own: '3D model', gen: 'AI-made 3D', none: 'no 3D model'};

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
/**
 * Search: every query word must match the name, brand, category, style, materials or colour names (prefix match).
 * Filters: kind, category, brand, style, max_w / max_d / max_h (metres), max_price. Real products rank before generic ones.
 */
export function searchCatalog(items, {query = '', kind = '', category = '', brand = '', style = '', three = '', max_w = 0, max_d = 0, max_h = 0, max_price = 0, limit = 12} = {}) {
  const q = words(query);
  const res = [];
  for (const it of items) {
    if (kind && it.kind !== kind) continue;
    if (category && it.category.toLowerCase() !== category.toLowerCase()) continue;
    if (brand && it.brand.toLowerCase() !== brand.toLowerCase()) continue;
    if (style && !it.style.some((s) => s.toLowerCase().includes(style.toLowerCase()))) continue;
    if (three && (three === 'any' ? threeD(it) === 'none' : threeD(it) !== three)) continue;
    if (max_w && it.w > max_w + 1e-6) continue;
    if (max_d && it.d > max_d + 1e-6) continue;
    if (max_h && it.h > max_h + 1e-6) continue;
    if (max_price && it.price && it.price > max_price) continue;
    const hay = words([it.name, it.brand, it.category, it.retail_category, it.build, ...(it.style || []), ...(it.materials || []), it.material, ...it.colors.map((c) => c.name)].join(' '));
    let score = 0;
    let ok = true;
    for (const w of q) {
      const hit = hay.some((h) => h.startsWith(w) || (w.length > 4 && h.startsWith(w.slice(0, -1))));
      if (!hit) {
        ok = false;
        break;
      }
      score += words(it.name).some((h) => h.startsWith(w)) ? 3 : 1;
    }
    if (!ok) continue;
    res.push({it, score: score + (it.generic ? 0 : 2) + (threeD(it) !== 'none' ? 1 : 0)});
  }
  res.sort((a, b) => b.score - a.score || (a.it.price ?? 1e9) - (b.it.price ?? 1e9));
  return res.slice(0, limit).map((r) => r.it);
}

export const fmtCm = (m) => `${Math.round(m * 100)}`;
export const dimsText = (it) => `${fmtCm(it.w)} × ${fmtCm(it.d)} × ${fmtCm(it.h)} cm`;
export const priceText = (it) => (it.price ? `$${Number(it.price).toLocaleString('en-US')}` : '');
