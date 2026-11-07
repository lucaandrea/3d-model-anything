// Claude Opus 5.5 as the layout designer, built as a long-running agent rather than one big answer.
//
// Why: a single propose_layout call made Claude solve a whole multi-room request in one reply, checking every
// clearance in its head; at Thorough effort it spent its 64k-token reply limit thinking and never submitted anything.
// Now the server keeps a working draft and Claude works in small steps:
//   apply_changes   moves / stores / adds pieces in the draft, answers with the conflicts of that step
//   find_space      the server searches a 10 cm grid for spots where a footprint fits, instead of mental geometry
//   inspect         reads current positions back (cheap, and the source of truth after a compaction)
//   finish_layout   final check of the whole draft; accepted, or the conflicts to fix
// Around the loop:
//   threads         follow-up requests continue the same append-only conversation (thinking blocks stay valid)
//   compaction      on demand (beta compact-2026-09-04): when the next request would pass COMPACT_AT input tokens the
//                   conversation is summarised by Claude with instructions that keep the plan and progress, and the
//                   server re-sends the authoritative draft, so nothing depends on the summary being perfect
//   task budget     (beta task-budgets-2026-03-13) Claude sees a countdown for the whole task and paces itself
//   recovery        a reply cut off at max_tokens is not appended; a system message asks for the next small step and
//                   effort drops a level; work already applied is never lost, and a stop returns the partial layout
//   transcripts     every run is written next to the private model for review
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {checkLayout, findSpace, normDeg} from '../shared/layout-check.js';
import {CATALOG, MATERIALS, TYPES} from '../shared/furniture.js';
import {CATEGORIES, dimsText, priceText, searchCatalog, threeD, THREE_D_LABEL} from '../shared/catalog-index.js';
import {COMPACT_INSTRUCTIONS, continuationText, RULES, sceneText, userText} from './scene-text.mjs';

export const MODEL = 'claude-opus-5-5';
const BETAS = ['server-side-fallback-2026-07-01', 'task-budgets-2026-03-13', 'compact-2026-09-04'];
const BUDGET = {low: 60000, medium: 110000, high: 180000}; // output + tool results Claude reads, per request
const HOME_BUDGET = 320000; // refurnishing the whole home, room by room
const LOWER = {high: 'medium', medium: 'low', low: 'low'};
const MAX_TOKENS = 64000; // per reply (hard, unseen by Claude); the task budget is the soft, visible one
const COMPACT_AT = Number(process.env.COMPACT_AT || 90000); // input tokens of the next request
const MAX_TURNS = 18;
const MAX_TURNS_HOME = 70;
const MAX_FINISH_REJECTS = 3;
const KINDS = ['seat', 'table', 'bed', 'storage', 'plant', 'lamp', 'equipment', 'textile', 'mirror', 'small', 'other'];

// ------------------------------------------------------------------ tools (strict schemas, inputs re-validated here)
const num = {type: 'number'};
const floorE = {type: 'string', enum: ['ground', 'upper']};
const MOVE = {type: 'object', additionalProperties: false, required: ['id', 'x', 'z', 'facing', 'floor'], properties: {id: {type: 'string'}, x: num, z: num, facing: {type: 'number', description: 'Degrees: 0 = front faces +z, 90 = +x, 180 = -z, 270 = -x.'}, floor: floorE}};
const ADD = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'label', 'x', 'z', 'facing', 'floor', 'width', 'depth', 'height', 'color', 'accent', 'material'],
  properties: {catalog_id: {type: 'string', description: 'id from search_catalog, or "" for a generic piece described by the other fields. With a catalog id the real size, type and material come from the catalogue; pick color from its colours.'}, type: {type: 'string', enum: TYPES}, label: {type: 'string'}, x: num, z: num, facing: num, floor: floorE, width: num, depth: num, height: num, color: {type: 'string', description: '#rrggbb'}, accent: {type: 'string', description: '#rrggbb'}, material: {type: 'string', enum: MATERIALS}},
};
ADD.required.unshift('catalog_id');
const tool = (name, description, properties, required) => ({name, description, strict: true, eager_input_streaming: true, input_schema: {type: 'object', additionalProperties: false, required, properties}});
export const TOOLS = [
  tool('apply_changes', 'Apply one step of the request to the working draft: final centres and facings for moved pieces (m* original pieces, n* pieces added in earlier layouts, a* pieces you added in this request), ids to store out of the home, and new catalogue pieces. Changes take effect immediately; the result lists any conflicts for the pieces this step touched and the new ids of added pieces.', {note: {type: 'string', description: 'What this step does, in a few words (shown to the homeowner).'}, moves: {type: 'array', items: MOVE}, remove: {type: 'array', items: {type: 'string'}}, add: {type: 'array', items: ADD}}, ['note', 'moves', 'remove', 'add']),
  tool('find_space', 'Find positions where a footprint fits on a floor or in one room, clear of walls, doors, stairs, built-ins and the current draft. Use it instead of working out clearances by hand. Returns up to 6 spots, nearest to `near` first.', {floor: floorE, room: {type: 'string', description: 'A room id from the scene, or "" for the whole floor.'}, width: num, depth: num, height: num, kind: {type: 'string', enum: KINDS}, near: {type: 'array', items: num, description: '[x, z] to search around, or [] for the middle of the room.'}, facing: {type: 'number', description: 'Fixed facing in degrees, or -1 to try all four.'}, against_wall: {type: 'boolean', description: 'Only spots whose back is within 15 cm of a wall (sideboards, consoles, beds, shelves).'}, ignore_id: {type: 'string', description: 'The piece being placed, so its current spot does not block itself, or "" for a new piece.'}}, ['floor', 'room', 'width', 'depth', 'height', 'kind', 'near', 'facing', 'against_wall', 'ignore_id']),
  tool('search_catalog', 'Search the furniture catalogue: real products from IKEA, West Elm, Crate & Barrel and others with their real dimensions, colours, prices and links, plus openly licensed models and generic pieces. Use it before adding furniture and add the result by catalog_id.', {query: {type: 'string', description: 'Words to match, e.g. "walnut media console" or "boucle lounge chair"; "" for any.'}, category: {type: 'string', description: `One of: ${CATEGORIES.join(', ')}; or "" for any.`}, style: {type: 'string', description: 'e.g. "mid-century", "scandinavian", "modern", or "" for any.'}, brand: {type: 'string', description: 'e.g. "IKEA", "West Elm", "Crate & Barrel", or "" for any.'}, max_width: {type: 'number', description: 'Metres, or 0 for no limit.'}, max_depth: {type: 'number', description: 'Metres, or 0 for no limit.'}, max_price: {type: 'number', description: 'US dollars, or 0 for no limit.'}}, ['query', 'category', 'style', 'brand', 'max_width', 'max_depth', 'max_price']),
  tool('inspect', 'Read the current draft: positions, facings and footprints of the listed pieces and/or every piece in a room.', {ids: {type: 'array', items: {type: 'string'}}, room: {type: 'string', description: 'A room id, or "" for none.'}}, ['ids', 'room']),
  tool('finish_layout', 'Finish the request: the server checks the whole draft. If conflicts remain it lists them and you fix them with apply_changes before calling this again; otherwise the layout is shown to the homeowner.', {title: {type: 'string', description: 'A short name for the layout, at most 40 characters.'}, summary: {type: 'string', description: 'Two to four sentences for the homeowner on what changed and why.'}}, ['title', 'summary']),
];

// ------------------------------------------------------------------ the working draft
const HEX = /^#[0-9a-f]{6}$/i;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
export class Draft {
  constructor(scene, base, catalog = []) {
    this.scene = scene;
    this.catalog = new Map(catalog.map((c) => [c.id, c]));
    this.items = new Map(scene.items.map((i) => [i.id, {...i, removed: false}]));
    for (const m of base.moved || []) {
      const it = this.items.get(m.id);
      if (it) Object.assign(it, {cx: m.x, cz: m.z, facing: normDeg(m.facing), floor: m.floor});
    }
    for (const id of base.removed || []) if (this.items.has(id)) this.items.get(id).removed = true;
    for (const a of base.added || []) this.items.set(a.id, this.fromSpec(a.id, a));
    this.start = new Map([...this.items].map(([k, v]) => [k, {...v}]));
    this.added = 0;
    this.steps = 0;
  }
  fromSpec(id, a) {
    // a catalogue piece takes its real size, type and material from the catalogue, whatever the call said
    const c = a.catalog_id ? this.catalog.get(a.catalog_id) : null;
    if (c) {
      const color = c.colors.some((x) => x.hex.toLowerCase() === String(a.color).toLowerCase()) ? a.color : c.colors[0].hex;
      a = {...a, type: c.build, label: a.label && !/^\s*$/.test(a.label) ? a.label : `${c.brand} ${c.name}`, width: c.w, depth: c.d, height: c.h, color, accent: c.accent, material: c.material};
    }
    const T = CATALOG[a.type] || {};
    return {id, label: a.label, kind: c?.kind || T.kind || 'other', floor: a.floor, room: a.room || '', cx: a.x, cz: a.z, w: a.width, d: a.depth, h: a.height, facing: normDeg(a.facing), carries: [], removed: false, spec: {catalog_id: c ? c.id : '', type: a.type, label: a.label, width: a.width, depth: a.depth, height: a.height, color: a.color, accent: a.accent, material: a.material}};
  }
  validate(input) {
    const errs = [];
    for (const m of input.moves) {
      const it = this.items.get(m?.id);
      if (!it) errs.push(`unknown id "${m?.id}"`);
      else if (![m.x, m.z, m.facing].every(finite) || !['ground', 'upper'].includes(m.floor)) errs.push(`${m.id} needs numeric x, z, facing and a floor`);
    }
    for (const id of input.remove) if (!this.items.has(id)) errs.push(`remove: unknown id "${id}"`);
    for (const a of input.add) {
      if (a?.catalog_id) {
        if (!this.catalog.has(a.catalog_id)) errs.push(`add: unknown catalog_id "${a.catalog_id}" (use search_catalog)`);
        else if (![a.x, a.z, a.facing].every(finite) || !['ground', 'upper'].includes(a.floor)) errs.push(`add: ${a.catalog_id} needs numeric x, z, facing and a floor`);
        continue;
      }
      if (!a || !CATALOG[a.type]) errs.push(`add: unknown type "${a?.type}"`);
      else if (![a.x, a.z, a.facing, a.width, a.depth, a.height].every(finite) || !['ground', 'upper'].includes(a.floor)) errs.push(`add: ${a.label || a.type} needs numbers and a floor`);
      else if (a.width <= 0.05 || a.depth <= 0.005 || a.height <= 0.005 || a.width > 4 || a.depth > 4 || a.height > 2.6) errs.push(`add: ${a.label || a.type} has implausible dimensions`);
      else if (!HEX.test(a.color) || !HEX.test(a.accent) || !MATERIALS.includes(a.material)) errs.push(`add: ${a.label || a.type} needs #rrggbb colours and a catalogue material`);
    }
    return errs;
  }
  apply(input) {
    const touched = new Set();
    const lines = [];
    for (const m of input.moves) {
      const it = this.items.get(m.id);
      Object.assign(it, {cx: m.x, cz: m.z, facing: normDeg(m.facing), floor: m.floor, removed: false});
      touched.add(m.id);
      lines.push(`moved ${m.id} ${it.label} to (${r2(m.x)}, ${r2(m.z)}) facing ${normDeg(m.facing)} on the ${m.floor} floor`);
    }
    for (const id of input.remove) {
      const it = this.items.get(id);
      if (!it) continue;
      if (id.startsWith('a')) this.items.delete(id);
      else it.removed = true;
      lines.push(`stored ${id} ${it.label}`);
    }
    for (const a of input.add) {
      const id = `a${++this.added}`;
      const it = this.fromSpec(id, a);
      this.items.set(id, it);
      touched.add(id);
      lines.push(`added ${id} ${it.label}${it.spec.catalog_id ? ` [${it.spec.catalog_id}, ${r2(it.w)} x ${r2(it.d)} x ${r2(it.h)} m]` : ` (${a.type})`} at (${r2(a.x)}, ${r2(a.z)}) facing ${normDeg(a.facing)}`);
    }
    this.steps++;
    return {touched, lines};
  }
  placed(changedIds) {
    return [...this.items.values()].filter((i) => !i.removed).map((i) => ({id: i.id, label: `${i.label} (${i.id})`, kind: i.kind, floor: i.floor, cx: i.cx, cz: i.cz, w: i.w, d: i.d, h: i.h, facing: i.facing, pieces: i.pieces, changed: changedIds.has(i.id)}));
  }
  changedSinceStart() {
    const out = new Set();
    for (const [id, it] of this.items) {
      const s = this.start.get(id);
      if (!s || s.removed !== it.removed || s.cx !== it.cx || s.cz !== it.cz || s.facing !== it.facing || s.floor !== it.floor) out.add(id);
    }
    return out;
  }
  conflicts(ids) {
    return [...new Set(checkLayout(this.scene, this.placed(ids)).map((x) => x.text))];
  }
  /** The draft as changes relative to the layout the request started from, in the page's format. */
  ops() {
    const moves = [];
    const remove = [];
    const add = [];
    for (const [id, it] of this.items) {
      if (id.startsWith('a')) {
        if (!it.removed) add.push({...it.spec, x: it.cx, z: it.cz, facing: it.facing, floor: it.floor});
        continue;
      }
      const s = this.start.get(id);
      if (it.removed && !s.removed) remove.push(id);
      else if (!it.removed && (s.removed || s.cx !== it.cx || s.cz !== it.cz || s.facing !== it.facing || s.floor !== it.floor)) moves.push({id, x: it.cx, z: it.cz, facing: it.facing, floor: it.floor});
    }
    return {moves, remove, add};
  }
  describe(ids = [], room = '') {
    const list = [...this.items.values()].filter((i) => ids.includes(i.id) || (room && i.room === room));
    if (!list.length) return room ? `No pieces in room "${room}" (pieces you added in this request carry no room; ask for them by id).` : 'No such pieces.';
    return list.map((i) => `${i.id} | ${i.label} | ${i.removed ? 'stored' : `${i.floor} | centre (${r2(i.cx)}, ${r2(i.cz)}) | ${r2(i.w)} x ${r2(i.d)} x ${r2(i.h)} | facing ${i.facing}`}`).join('\n');
  }
  summary() {
    const changed = this.changedSinceStart();
    if (!changed.size) return 'No changes yet in this request.';
    return [...changed]
      .map((id) => {
        const it = this.items.get(id);
        if (it.removed) return `${id} ${it.label}: stored`;
        return `${id} ${it.label}: (${r2(it.cx)}, ${r2(it.cz)}) facing ${it.facing}, ${it.floor} floor${id.startsWith('a') ? ' (new)' : ''}`;
      })
      .join('\n');
  }
}

// ------------------------------------------------------------------ threads, kept next to the private model
export function createThreadStore(dir, {onSave} = {}) {
  fs.mkdirSync(dir, {recursive: true});
  const mem = new Map();
  const file = (id) => path.join(dir, `${id}.json`);
  return {
    dir,
    get(id) {
      if (!id || !/^t[a-z0-9]+$/.test(id)) return null;
      if (mem.has(id)) return mem.get(id);
      if (!fs.existsSync(file(id))) return null;
      const t = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      mem.set(id, t);
      return t;
    },
    create(sceneHash) {
      const t = {id: `t${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, sceneHash, created: new Date().toISOString(), messages: [], estimate: 0, compactions: 0, runs: []};
      mem.set(t.id, t);
      return t;
    },
    save(t) {
      t.updated = new Date().toISOString();
      fs.writeFileSync(`${file(t.id)}.tmp`, JSON.stringify(t));
      fs.renameSync(`${file(t.id)}.tmp`, file(t.id));
      onSave?.(file(t.id));
    },
  };
}

// usage across iterations: compaction and fallback steps report there, and the top-level fields leave them out
function usageOf(msg) {
  const u = msg.usage || {};
  const its = u.iterations?.length ? u.iterations : [u];
  const sum = (k) => its.reduce((s, x) => s + (x[k] || 0), 0);
  return {
    input: sum('input_tokens') + sum('cache_read_input_tokens') + sum('cache_creation_input_tokens'),
    cached: sum('cache_read_input_tokens'),
    output: sum('output_tokens'),
    thinking: u.output_tokens_details?.thinking_tokens ?? null,
    // what the next request will carry: this request's input plus its reply
    next: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
  };
}

export async function runArrange({body, send, apiKey, signal, store, catalog = []}) {
  const client = new Anthropic({...(apiKey ? {apiKey} : {}), maxRetries: 2});
  const scene = body.scene;
  const system = [
    {type: 'text', text: RULES},
    {type: 'text', text: sceneText(scene), cache_control: {type: 'ephemeral'}},
  ];
  // a thread continues only while the system prompt and tools are byte-identical: preserved thinking binds to them
  const sceneHash = crypto.createHash('sha256').update(JSON.stringify(system) + JSON.stringify(TOOLS)).digest('hex').slice(0, 16);
  let thread = body.newThread ? null : store.get(body.threadId);
  const fresh = !thread || thread.sceneHash !== sceneHash;
  if (fresh) thread = store.create(sceneHash);
  const M = thread.messages;
  send({type: 'thread', id: thread.id, fresh, compactions: thread.compactions, earlier: thread.runs.length});
  const draft = new Draft(scene, {moved: body.base?.moved || [], removed: body.base?.removed || [], added: body.base?.added || []}, catalog);
  // built-ins the homeowner removed are no longer obstacles (the system prompt stays as it is, for the cache)
  const gone = new Set(body.base?.removedFixed || []);
  if (gone.size) draft.scene = {...scene, fixed: scene.fixed.filter((f) => !gone.has(f.id))};
  let effort = ['low', 'medium', 'high'].includes(body.effort) ? body.effort : 'medium';
  const home = body.scope === 'home';
  const budget = home ? HOME_BUDGET : BUDGET[effort];
  const maxTurns = home ? MAX_TURNS_HOME : MAX_TURNS;
  const run = {request: body.request, effort, started: new Date().toISOString(), turns: [], compactions: [], outcome: null};
  thread.runs.push(run);
  const t0 = Date.now();
  const total = {input: 0, cached: 0, output: 0};
  const add = (u) => ((total.input += u.input), (total.cached += u.cached), (total.output += u.output));

  // a run stopped mid-tool-round left a tool_use without its result: answer it, append-only, before going on
  const last = M[M.length - 1];
  if (last?.role === 'assistant') {
    const pending = (last.content || []).filter((b) => b.type === 'tool_use');
    if (pending.length) M.push({role: 'user', content: pending.map((b) => ({type: 'tool_result', tool_use_id: b.id, content: 'Not run: the homeowner stopped this request.'}))});
  }

  // on-demand compaction: Claude summarises the conversation, the summary replaces every message before it
  const compact = async (why) => {
    send({type: 'status', text: 'Summarising the conversation so far (compaction)'});
    const before = thread.estimate;
    const res = await client.beta.messages.create(
      {model: MODEL, max_tokens: 16000, betas: ['compact-2026-09-04'], thinking: {type: 'adaptive'}, output_config: {effort: 'low'}, system, tools: TOOLS, messages: M, compaction: {type: 'summarize', instructions: COMPACT_INSTRUCTIONS}},
      {signal},
    );
    const u = usageOf(res);
    add(u);
    const block = res.content.find((b) => b.type === 'compaction');
    run.compactions.push({why, before, stop: res.stop_reason, usage: u, at: new Date().toISOString()});
    if (res.stop_reason !== 'compaction' || !block?.content) {
      send({type: 'status', text: `Compaction returned no summary (${res.stop_reason}); continuing without it`});
      return false;
    }
    M.splice(0, M.length, {role: 'assistant', content: [block]});
    thread.compactions++;
    thread.estimate = 0;
    send({type: 'compaction', before, summaryChars: block.content.length});
    return true;
  };

  if (!fresh && thread.estimate > COMPACT_AT) await compact('long conversation, before a new request');
  M.push({role: 'user', content: userText(body, scene, {fresh})});

  let finished = null;
  let finishRejects = 0;
  let nudgedAt = -1;
  let endTurnNudged = false;
  let jsonRetries = 0;
  try {
    for (let turn = 0; turn < maxTurns && !finished; turn++) {
      // compaction only between rounds: the history then ends with a user turn (never on a pending tool_use)
      if (thread.estimate > COMPACT_AT && M[M.length - 1]?.role === 'user' && turn > 0) {
        if (await compact('the conversation grew past the limit during this request')) M.push({role: 'user', content: continuationText(body.request, draft)});
      }
      // after a compaction the API can no longer count earlier spend, so the visible budget shrinks by what was used
      const taskBudget = Math.max(20000, budget - total.output);
      send({type: 'status', text: turn ? `Claude is working (step ${draft.steps + 1})` : 'Claude is reading the home and planning'});
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          betas: BETAS,
          fallbacks: 'default',
          thinking: {type: 'adaptive', display: 'summarized'},
          output_config: {effort, task_budget: {type: 'tokens', total: taskBudget}},
          cache_control: {type: 'ephemeral'},
          system,
          tools: TOOLS,
          messages: M,
        },
        {signal},
      );
      stream.on('thinking', (delta) => send({type: 'thinking', delta}));
      stream.on('text', (delta) => send({type: 'thinking', delta}));
      let msg;
      try {
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // only an unparseable tool input is retried; API errors go to the page
        if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= 2) throw err;
        send({type: 'status', text: 'A tool call arrived malformed, asking again'});
        continue;
      }
      const u = usageOf(msg);
      add(u);
      thread.estimate = u.next;
      const uses = msg.content.filter((b) => b.type === 'tool_use');
      run.turns.push({stop: msg.stop_reason, effort, model: msg.model, usage: u, tools: uses.map((b) => b.name), seconds: (Date.now() - t0) / 1000});
      send({type: 'budget', output: total.output, budget, input: u.input, cached: u.cached, thinking: u.thinking});
      if (msg.stop_reason === 'refusal') throw new Error(`Claude declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}. Try describing it differently.`);
      if (msg.stop_reason === 'max_tokens') {
        // the cut-off reply is not appended (append-only: it never becomes history). Ask for one small step, one
        // effort level lower; a system message may follow a user turn only once, so a second cut-off ends the run.
        if (nudgedAt === M.length) break;
        effort = LOWER[effort];
        M.push({role: 'system', content: `Your last reply ran out of output space before you acted, so nothing from it was kept. Keep the plan short and do the next step now: one apply_changes call for one area, using find_space for positions instead of checking clearances by hand.${draft.steps ? ' The steps you already applied are kept in the draft.' : ''}`});
        nudgedAt = M.length;
        send({type: 'retry', text: `Claude's reply hit the ${MAX_TOKENS / 1000}k output limit; asking for smaller steps at ${effort} effort`});
        continue;
      }
      M.push({role: 'assistant', content: msg.content});
      if (!uses.length) {
        if (endTurnNudged) break;
        endTurnNudged = true;
        M.push({role: 'user', content: draft.steps ? 'Please call finish_layout to finish (after apply_changes if anything is left).' : 'Please work through the request with apply_changes, then call finish_layout.'});
        continue;
      }
      const results = [];
      for (const use of uses) {
        const reply = (content, isError = false) => results.push({type: 'tool_result', tool_use_id: use.id, content, ...(isError ? {is_error: true} : {})});
        const inp = use.input || {};
        if (use.name === 'apply_changes') {
          if (!Array.isArray(inp.moves) || !Array.isArray(inp.remove) || !Array.isArray(inp.add)) {
            reply(JSON.stringify({INVALID_INPUT: 'moves, remove and add must be arrays', received: inp}).slice(0, 4000), true);
            continue;
          }
          const errs = draft.validate(inp);
          if (errs.length) {
            reply(`Nothing applied, invalid fields: ${errs.join('; ')}.`, true);
            continue;
          }
          const {touched, lines} = draft.apply(inp);
          const conflicts = draft.conflicts(touched);
          send({type: 'step', n: draft.steps, note: String(inp.note || '').slice(0, 120), changes: lines.length, conflicts});
          send({type: 'draft', ops: draft.ops()});
          reply(`Applied step ${draft.steps}:\n${lines.join('\n') || '(no changes)'}\nConflicts for the pieces in this step: ${conflicts.length ? `\n${conflicts.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : 'none.'}`);
        } else if (use.name === 'find_space') {
          const others = draft.placed(new Set()).filter((p) => p.id !== inp.ignore_id);
          const self = draft.items.get(inp.ignore_id);
          const res = findSpace(draft.scene, others, {floor: inp.floor, room: inp.room || undefined, width: inp.width, depth: inp.depth, height: inp.height, kind: inp.kind, near: Array.isArray(inp.near) && inp.near.length === 2 ? inp.near : undefined, facing: inp.facing >= 0 ? inp.facing : undefined, against_wall: !!inp.against_wall, pieces: self?.pieces});
          send({type: 'search', text: `${inp.width}×${inp.depth} m ${inp.kind} in ${inp.room || `the ${inp.floor} floor`}: ${res.candidates?.length || 0} spots`});
          reply(res.error ? `Error: ${res.error}` : res.candidates.length ? `${res.searched}. Best spots:\n${res.candidates.map((c) => `(${c.x}, ${c.z}) facing ${c.facing}: ${c.clear_margin}, back ${c.back_to_wall} m from a wall, ${c.distance_from_target} m from the target`).join('\n')}` : `No position fits (${res.searched}). Try a smaller footprint, another facing, the whole floor, or move something first.`);
        } else if (use.name === 'search_catalog') {
          const hits = searchCatalog(catalog, {query: inp.query, category: inp.category, style: inp.style, brand: inp.brand, max_w: inp.max_width, max_d: inp.max_depth, max_price: inp.max_price, limit: 10});
          send({type: 'search', text: `catalogue: “${[inp.query, inp.category, inp.style, inp.brand].filter(Boolean).join(' · ') || 'anything'}”, ${hits.length} found`});
          reply(hits.length ? hits.map((c) => `${c.id} | ${c.brand} ${c.name} | ${c.category} | ${dimsText(c)} (w x d x h) | ${c.material} | colours: ${c.colors.map((x) => `${x.name} ${x.hex}`).join(', ')}${c.price ? ` | ${priceText(c)}` : ''}${c.style?.length ? ` | ${c.style.join(', ')}` : ''} | ${THREE_D_LABEL[threeD(c)]}`).join('\n') : 'Nothing matched. Try fewer words, another category, or no brand.');
        } else if (use.name === 'inspect') {
          reply(draft.describe(Array.isArray(inp.ids) ? inp.ids : [], inp.room || ''));
        } else if (use.name === 'finish_layout') {
          const conflicts = draft.conflicts(draft.changedSinceStart());
          if (conflicts.length && finishRejects < MAX_FINISH_REJECTS) {
            finishRejects++;
            send({type: 'round', n: finishRejects, accepted: false, issues: conflicts});
            reply(`Not finished, ${conflicts.length} conflict(s) remain:\n${conflicts.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nFix them with apply_changes, then call finish_layout again.`);
          } else {
            finished = {title: String(inp.title || 'New layout').slice(0, 60), summary: String(inp.summary || '').slice(0, 1200), issues: conflicts};
            send({type: 'round', n: finishRejects + 1, accepted: true, issues: conflicts});
            reply(conflicts.length ? `Finished with ${conflicts.length} remaining issue(s); the layout is shown to the homeowner.` : 'Finished: no conflicts. The layout is shown to the homeowner.');
          }
        } else reply(`Unknown tool ${use.name}.`, true);
      }
      M.push({role: 'user', content: results});
    }
  } finally {
    run.ended = new Date().toISOString();
    run.meta = {steps: draft.steps, turns: run.turns.length, compactions: run.compactions.length, seconds: (Date.now() - t0) / 1000, ...total, budget};
    if (signal?.aborted) run.outcome = 'cancelled';
    store.save(thread);
  }

  const ops = draft.ops();
  const changed = ops.moves.length + ops.remove.length + ops.add.length;
  run.outcome = finished ? 'finished' : changed ? 'partial' : 'nothing';
  store.save(thread);
  if (!finished && !changed) throw new Error('Claude stopped before changing anything. Try a narrower request, or Quick effort.');
  send({
    type: 'result',
    partial: !finished,
    layout: {title: finished?.title || 'Unfinished layout', summary: finished?.summary || 'Claude stopped before finishing; these are the steps it had completed.', ...ops},
    issues: finished?.issues ?? draft.conflicts(draft.changedSinceStart()),
    meta: {rounds: finishRejects + 1, ...run.meta, model: MODEL, thread: thread.id},
  });
}
