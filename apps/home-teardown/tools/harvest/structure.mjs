// Product pages -> catalogue records, by Claude with a strict JSON schema (structured outputs). Each request carries
// a handful of pages; Claude decides whether each is one purchasable piece, maps it to a furniture type, converts the
// listed dimensions to centimetres for one representative size, and notes the shape for the 3D step.
import Anthropic from '@anthropic-ai/sdk';
import {readKey} from '../../server/env.mjs';
import {CATEGORIES} from './retailers.mjs';

// HARVEST_MODEL picks another model for bulk structuring (claude-haiku-5-5 costs about 1/40 as much); default Opus 5.5
export const MODEL = process.env.HARVEST_MODEL || 'claude-opus-5-5';
const PRICES = {'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5]};
const [pin, pout] = PRICES[MODEL] || PRICES['claude-opus-5-5'];
const PRICE = {in: pin / 1e6, out: pout / 1e6}; // USD per token, standard; batches are half
export const usage = {usd: 0, input: 0, output: 0, requests: 0};

const TYPES = Object.keys(CATEGORIES);
const N = {anyOf: [{type: 'number'}, {type: 'null'}]};
const ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['index', 'is_product', 'category', 'name', 'price_usd', 'w_cm', 'd_cm', 'h_cm', 'seat_h_cm', 'seat_d_cm', 'arm_h_cm', 'back_h_cm', 'leg_h_cm', 'size_note', 'materials', 'colors', 'style', 'shape_notes'],
  properties: {
    index: {type: 'integer'},
    is_product: {type: 'boolean', description: 'true only for a page selling one specific furniture piece (not a category, collection, inspiration or review page)'},
    category: {type: 'string', enum: [...TYPES, 'other']},
    name: {type: 'string', description: 'product name as listed, without the retailer name'},
    price_usd: N,
    w_cm: N,
    d_cm: N,
    h_cm: N,
    seat_h_cm: N,
    seat_d_cm: N,
    arm_h_cm: N,
    back_h_cm: N,
    leg_h_cm: N,
    size_note: {type: 'string'},
    materials: {type: 'array', items: {type: 'string'}},
    colors: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['name', 'hex'], properties: {name: {type: 'string'}, hex: {type: 'string'}}}},
    style: {type: 'array', items: {type: 'string'}},
    shape_notes: {type: 'string'},
  },
};
export const SCHEMA = {type: 'object', additionalProperties: false, required: ['items'], properties: {items: {type: 'array', items: ITEM}}};

export const SYSTEM = `You turn furniture retailers' product pages into catalogue records for a 3D home-planning app. Each page arrives as <page index="..." url="..." retailer="...">, with its title and text excerpts. Return one item per page, in the same order, with the page's index.

- is_product: true only when the page sells one specific piece of furniture (or one rug, lamp, planter or mirror). Category pages, collections, sets of several pieces, room ideas, reviews, swatches, covers and replacement parts are false; fill the other fields as best you can and they will be ignored.
- category: the type the piece is. sofa (2-4 seat, straight), sectional_l (L- or U-shaped sectional, or a sofa with a chaise), loveseat (2-seat, under about 175 cm), armchair (upholstered accent or club chair), lounge_chair (low reclined or sling chair, often wood or metal frame), chaise (chaise lounge), ottoman, pouf, bench, dining_chair, bar_stool (counter or bar height), office_chair (desk or task chair), coffee_table, side_table (end, accent, C-table), dining_table (any shape), desk, console_table, bed (frame or platform bed), daybed, nightstand, dresser, sideboard (sideboard, buffet, credenza), tv_console (media console, TV stand), bookshelf (bookcase, shelving, etagere), wardrobe (wardrobe, armoire), bar_cart, floor_lamp, rug, plant (planter or pot, with or without a plant), mirror (floor or leaning mirror). Anything else: other.
- Dimensions: the overall outside width (side to side, facing the front), depth (front to back) and height of ONE representative configuration, in centimetres (1 inch = 2.54 cm). When the page lists several sizes, pick the standard full size, not the smallest: for a sofa the 3-seat width nearest 84 in., for a bed Queen, for a rug 8 x 10 ft, otherwise the default or middle option. Use a size only if the page gives its dimensions; if it lists dimensions for one size only, use that one. Describe the chosen size in size_note ("84 in. 3-seat sofa", "Queen", "8 x 10 ft"); the category follows the chosen size. For rugs, width x depth is the rug's size and height its pile thickness. For a round piece, width and depth are both its diameter. For beds, use the frame's outside size. Fill seat height, seat depth, arm height, back height and leg height when listed; otherwise null. Never guess a dimension the page does not state: use null.
- price_usd: the lowest listed price for the chosen configuration, as a number (a sale price if shown), or null.
- materials: the main materials, short ("oak veneer", "performance linen", "powder-coated steel").
- colors: up to 6 colours or finishes the piece comes in, with the name the page uses and an approximate #rrggbb for how that finish looks.
- style: one to three of: modern, mid-century, scandinavian, minimalist, japandi, industrial, traditional, transitional, farmhouse, coastal, bohemian, glam, contemporary, rustic, art deco, organic.
- shape_notes: one or two sentences on the silhouette for building a 3D model: arms (track, rolled, slope, none), back (tight, loose cushions, channel), seat cushions (count), base (legs: how many, shape, material and colour; plinth; sled), and anything distinctive (curved, tufted, open shelves, drawer count, pedestal). Only what the page states or clearly implies.`;

const client = () => {
  const {key} = readKey('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (environment or .env)');
  return new Anthropic({apiKey: key});
};

const pageBlock = (p, i) => `<page index="${i}" url="${p.url}" retailer="${p.retailer}">\n${p.title || ''}\n${(p.excerpts || []).join('\n').slice(0, 6000)}\n</page>`;
const params = (pages) => ({
  model: MODEL,
  max_tokens: 16000,
  system: SYSTEM,
  output_config: {effort: 'low', format: {type: 'json_schema', schema: SCHEMA}},
  messages: [{role: 'user', content: pages.map(pageBlock).join('\n\n')}],
});
const parse = (msg, n) => {
  if (msg.stop_reason === 'refusal') throw new Error('refused');
  if (msg.stop_reason === 'max_tokens') throw new Error('ran out of output');
  const text = msg.content.find((b) => b.type === 'text')?.text;
  const items = JSON.parse(text).items;
  return Array.from({length: n}, (_, i) => items.find((x) => x.index === i) || null);
};
const tally = (u, half = false) => {
  usage.requests++;
  usage.input += u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  usage.output += u.output_tokens;
  usage.usd += (u.input_tokens * PRICE.in + (u.cache_read_input_tokens || 0) * PRICE.in * 0.05 + (u.cache_creation_input_tokens || 0) * PRICE.in * 1.25 + u.output_tokens * PRICE.out) * (half ? 0.5 : 1);
};

/** One request, now: pages -> items (null where Claude returned nothing for a page). */
export async function structureNow(pages) {
  const c = client();
  for (let attempt = 0; ; attempt++) {
    try {
      // server-side fallbacks: a declined request is re-run on a fallback model inside the same call
      const msg = await c.beta.messages.create({...params(pages), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'});
      tally(msg.usage);
      return parse(msg, pages.length);
    } catch (e) {
      const retry = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError || (e instanceof Anthropic.APIError && e.status === 529);
      if (!retry || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 4000 * 2 ** attempt));
    }
  }
}

/** Many requests through the Message Batches API (half price, usually done within the hour). chunks: pages[][] */
export async function structureBatch(chunks, {onStatus} = {}) {
  const c = client();
  const requests = chunks.map((pages, i) => ({custom_id: `c${i}`, params: params(pages)}));
  const out = new Array(chunks.length).fill(null);
  // a batch holds up to 100,000 requests / 256 MB; keep each one modest
  for (let s = 0; s < requests.length; s += 2000) {
    const part = requests.slice(s, s + 2000);
    let batch = await c.messages.batches.create({requests: part});
    for (;;) {
      batch = await c.messages.batches.retrieve(batch.id);
      onStatus?.(batch);
      if (batch.processing_status === 'ended') break;
      await new Promise((r) => setTimeout(r, 30_000));
    }
    for await (const r of await c.messages.batches.results(batch.id)) {
      const i = Number(r.custom_id.slice(1));
      if (r.result.type !== 'succeeded') continue;
      tally(r.result.message.usage, true);
      try {
        out[i] = parse(r.result.message, chunks[i].length);
      } catch {}
    }
  }
  return out;
}

// ------------------------------------------------------------------ prices only (pages whose excerpt had the size but not the price)
const PRICE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {items: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['index', 'price_usd'], properties: {index: {type: 'integer'}, price_usd: {anyOf: [{type: 'number'}, {type: 'null'}]}}}}},
};
const PRICE_SYSTEM = `Each <page> is a retailer's product page. Return its current selling price in US dollars: the price shown with the product (a sale price if one is shown; for a range, the lowest). Ignore monthly or financing amounts, shipping, gift-card and promotion amounts, "save $X", and prices of other products listed on the page. null if the page shows no price for this product.`;
export async function pricesNow(pages) {
  const c = client();
  const msg = await c.beta.messages.create({
    model: MODEL, max_tokens: 4000, system: PRICE_SYSTEM, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: {effort: 'low', format: {type: 'json_schema', schema: PRICE_SCHEMA}},
    messages: [{role: 'user', content: pages.map((p, i) => `<page index="${i}" url="${p.url}">\n${p.title || ''}\n${(p.excerpts || []).join('\n').slice(0, 2000)}\n</page>`).join('\n\n')}],
  });
  tally(msg.usage);
  return parse(msg, pages.length).map((x) => x?.price_usd ?? null);
}
