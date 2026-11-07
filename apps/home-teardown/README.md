# Loft Teardown

Your reconstructed loft as a page you can take apart, put back together and rearrange with Claude, with a catalogue of thousands of real furniture products. It started from the [teardown skill](https://github.com/elvarofficial/teardown)'s kit; the two kit files it needs are vendored (`vendor/teardown-kit/`, MIT), so it builds and runs anywhere with Node 20+.

```sh
cd apps/home-teardown
npm install && npm run build && npm run models   # once: dependencies, the page, the open 3D models (~100 MB)
npm start                                         # then open http://127.0.0.1:5199/
```

Or double-click `apps/home-teardown/start.command`. It loads the latest approved model revision, `data/scans/loft-refinements-2026-11-01` (the November 1 bathroom and racing-rig refinements). Use `--room <scan-folder>` to load another revision from `data/scans/`, for example `--room loft-office-detail-2026-10-29` to roll back to October 29 with its own corrections and layouts. Use `--port <n>` to change the port.

## Modes

- **Teardown** plays the home apart in order: the ceilings lift away, the walls are laid flat on piles, the upper floor rises, every object flies to a tray for its room, and finally the slab and stairs come out. The timeline scrubs it, and the speed slider sets the pace.
- **Reassemble** runs the same motion backwards. The structure goes back first, then the furniture (large pieces before small), then the walls, then the roof. Every part lands on its recorded pose; the **max error** readout is the measured distance between where each part is drawn and where the scan placed it.
- **Rearrange** sends your request to Claude Opus 5.5 with every wall, door, built-in and movable piece (measured sizes, facings, an ASCII plan of each floor). Claude can move pieces, store them, swap them, or add furniture from the [catalogue](#catalogue): real IKEA, West Elm, Crate & Barrel and other products at their listed sizes and prices, plus openly licensed 3D models. The server checks each proposal for walls, door clearances, the stairs, built-ins and overlaps, and sends any conflicts back to Claude to fix. Each answer becomes a saved layout built on the one you were viewing. **REFURNISH** (room or whole home, a style, a budget) asks Claude to keep what suits the style, store the rest and furnish from the catalogue; the result lists each new piece with its price and link, and the total. **All 68 ideas** opens a prompt library in nine categories (hosting, work, rest, space, style, new furniture, rooms, refurnish, seasons). You can search it, put a prompt in the box to edit (USE), or send it straight to Claude (SEND).

The page fills any window shape. On a wide or ultrawide screen the side panels sit at the edges, the bars between them stretch, and the camera comes closer so the house fills the space in between (up to 2.5×). On a narrower screen (down to 5:4) the panels grow taller instead. At 16:9 it looks exactly as designed, at 1600 × 900.

When you leave it alone, the page tours itself (teardown, trays, reassembly). Any click, drag, wheel or key hands control to you, and after 25 s of quiet the tour resumes.

## Model revisions and corrections

The server reads a revision's `modeled_room.glb`, `room.json` and `viewer.json` and never writes to its folder. The page's own fixes live in `private/<room>/teardown-corrections.json`, applied when the page loads, and edits show on the next reload.

The November 1 revision already squares every wall, rebuilds the upstairs closets, dressing corridor and ensuite, adds the landing guard over the entry, and has one continuous upper slab. So the October corrections that turned and added walls and closet floors are gone; on this model they would turn squared walls off the grid. What remains:

- **The L-shaped sectional** is one object. The layout checker and Claude see its two footprints, so the open corner is free floor. Only a true L keeps separate footprints: a tree whose leaves and branches are separately named stays one.
- **The hall closet** holds a 2025 GE front-load washer and dryer (dark grey, 27-inch), side by side with the dryer nearer the entrance. They are fixed built-ins; the closet is unchanged in this revision.
- **Upstairs rooms:** this room.json gives only the slab outline and stair opening, so the bedroom and landing, the dressing corridor with its two closets, and the ensuite are outlined from the new wall lines.

The loader also handles the new revision's part names (the rectangular ground slab, the continuous upper slab, the solid stair treads). It skips room.json walls that only repeat another wall's line without geometry, which leaves 29 walls. A few fixtures (the entry door and light controls, the pop-art print, the ensuite door, the standing bedroom mirror) now come attached to their walls and move with them.

**Saved layouts** refer to objects by the model's stable object IDs (`spatialObjectID`, kept across exports), so they carry over when your other agent ships a new revision. Layouts from before this change used order-based ids. They were migrated once, into `private/loft-refinements-2026-11-01/` and, for rollback, `private/loft-office-detail-2026-10-29/`; the original file beside the October model is untouched. All 24 pieces they refer to matched. Two bedroom layouts now show one 3 cm conflict between a nightstand and the olive tree, which the revision moved about 30 cm. Drag either to clear it.

## Controls

| | |
|---|---|
| Drag / wheel | Orbit / zoom (pan in plan views) |
| Click a part | Show what it is, where it belongs and how it was measured |
| `Space`, `1`–`5` | Play or pause, views (hero, ground, upper, plan, trays) |
| Rearrange: drag a piece | Move it by hand (creates or updates "Manual edits") |
| `R` / `Delete` | Rotate the selected piece 90° / remove it (built-ins such as a wardrobe or the washer can be removed too, to try a layout without them) |
| SWAP | Opens the catalogue filtered to the selected piece's kind; the replacement takes its spot and facing |
| CATALOG tab | Opens wide. Search and filter by category, brand, style, 3D status, price or size, pick a colour, ADD to the room on screen; MAKE 3D on a piece without a model. Link straight to it with `/?tab=catalog` |
| Hold `C` (or *Hold: original*) | Compare the layout with the original |
| Quick / Thorough | Claude effort `medium` / `high` |

## Claude

The server reads `ANTHROPIC_API_KEY` from its environment, falling back to the repository's `.env`. The key stays on the server: the page never sees it, and the server only accepts requests from its own origin (see [Hosting](#hosting) for a public address).

Claude Opus 5.5 works as a step-by-step agent on a draft layout that the server keeps:

- **Tools:** `apply_changes` applies one area at a time and reports that step's conflicts. `find_space` searches a 10 cm grid for spots where a footprint fits, so Claude doesn't have to work out clearances itself. `search_catalog` finds products by words, category, style, brand, size and price, and Claude adds them by `catalog_id`, so the real size, type and material come from the catalogue rather than from Claude. `inspect` reads positions back. `finish_layout` runs the final check and either accepts the layout or returns the conflicts to fix. The house previews the draft live as each step lands.
- **Conversations:** follow-up requests continue the same conversation, so Claude remembers what it did and why. The history is append-only, which keeps Opus 5.5's thinking blocks valid. NEW CHAT starts fresh.
- **Compaction:** on demand (beta `compact-2026-09-04`). When the next request would exceed 90k input tokens (`COMPACT_AT`), Claude summarises the conversation, keeping requests, preferences, plan, done and remaining steps, and decisions. The summary replaces the earlier messages, and the server then re-sends the exact draft.
- **Pacing:** a task budget (beta `task-budgets-2026-03-13`; 110k tokens Quick, 180k Thorough, 320k for a whole-home refurnish) shows Claude a countdown for the whole job. If a reply still hits the 64k per-reply limit, it is not kept. Claude is asked for one small step at one effort level lower. Completed steps are never lost, and if Claude stops early the partial layout is saved as "Unfinished".
- **Transcripts:** every conversation, with each turn's stop reason, token usage (including thinking tokens) and compactions, is saved to `private/<room>/teardown-agent/<thread>.json`.

Requests also use adaptive thinking (summarised while Claude works), strict tool schemas validated before use, prompt caching of the home's description, and server-side refusal fallbacks (`fallbacks: "default"`).

## Catalogue

`catalog/catalog.json` has 7,192 pieces from 45 retailers in 30 furniture types, and the page adds a generic piece for each of 36 procedural types so any kind can always be added.

- **7,088 harvested products** (`catalog/sources/products-harvested.json`), from Room & Board, Target, Living Spaces, Ethan Allen, Arhaus, Anthropologie, Ashley, Article, Urban Outfitters, Wayfair, RH, Blu Dot, Serena & Lily, Williams Sonoma, Joybird, CB2, Pottery Barn, Crate & Barrel, West Elm, Design Within Reach, Muuto, IKEA, Herman Miller, Knoll and others. Each has its name, its listed size in cm for one standard configuration (seat, arm, back and leg heights when listed), materials, colours (hex values approximate the swatches), style tags, a link, a price for 72% of them, shape notes for the 3D converter, and for 5,600 of them a product-photo URL. See [Harvesting](#harvesting).
- **74 curated products** from the first round (`catalog/sources/products.json`), and **39 open models**: 21 from [Amazon Berkeley Objects](https://amazon-berkeley-objects.s3.amazonaws.com/index.html) (3D models © Amazon.com, CC BY 4.0), 14 from [Poly Haven](https://polyhaven.com/models) (CC0) and 4 Wayfair models from the [Khronos glTF sample assets](https://github.com/KhronosGroup/glTF-Sample-Assets) (CC BY 4.0 / CC0), with licences in `catalog-assets/LICENSES.md`.

**3D status.** Every card says which of three a piece has: **3D MODEL** (an open model of that product), **AI 3D** (made by Claude, below) or **NO 3D MODEL**. A piece without one is drawn as a generic shape of its type at its real size; where an open model of the same type is close in proportion, that model stands in, recoloured. The 3D filter shows any one group.

**MAKE 3D.** For a piece with no model, Claude Opus 5.5 looks at the product photo (when there is one) and reads the listed facts. It answers with a part list under a strict JSON schema: rounded boxes, cylinders, tapered legs, capsules and so on, each with a material, a colour taken from the photo and a role (`shared/model3d.js`). The parts are then fitted exactly to the listed width, depth and height and set on the floor, and checked: a part that touches neither the floor nor another part gets Claude one repair round. The page builds the mesh with the same materials, contact shading and outlines as the rest of the furniture, and a colour swatch repaints only the primary parts (the upholstery, a cabinet's body). Models are saved in `catalog/generated/<id>.json`.
- On the page: MAKE 3D on a card; adding or swapping in a piece without a model starts one automatically; and when Claude's layout brings in pieces without models, its answer offers to make them all.
- Cost and speed, measured on 35 models: 3 to 9 US cents each (7 on average), 20 to 60 seconds, all drawn at the listed size on the first round. 35 come with the catalogue, one of each type and a few more.
- In bulk: `node tools/generate-3d.mjs --missing --brand "West Elm"` (or `--category sofa`, `--ids a,b`, `--sample 30`; `--dry` lists the pieces and the estimate first; `--batch` sends first rounds through the Message Batches API at half price). Doing all of the roughly 7,150 remaining would cost about $500, or about $260 with `--batch`.
- These are clean, recognisable furniture models made from primitives, not photo-real scans. Photo-real textured meshes would need an image-to-3D service (Meshy, Tripo, Rodin or TRELLIS, for example); the same fitting to the listed size would apply.

**Data notes.** Sizes, prices and colours were read from the retailers' pages at harvest time (2026-11-03) and can be wrong or change: check the product page before buying. The catalogue stores facts, links and photo URLs only. The page never shows retailer photos (thumbnails are rendered from the 3D models), and ↗ is a plain link. Several of these retailers' terms restrict automated collection; this data was gathered through Parallel's search and extraction service for a personal home planner, so keep that in mind before republishing it.

To add products by hand, edit `catalog/sources/products.json` or `catalog/sources/models.json`, then rebuild. The server picks up a rebuilt catalogue (and every new AI model) on the next page load:

```sh
npm run models     # the open models (~100 MB, git-ignored), skips files already present
npm run catalog    # catalog/catalog.json from the curated, harvested and open-model sources
```

`tools/inspect-models.py` reports a GLB or glTF's real size, to check `models.json` dimensions.

## Harvesting

`tools/harvest-catalog.mjs` builds `products-harvested.json` with [Parallel](https://docs.parallel.ai) (a web search API made for agents) and Claude:

1. **Search:** one Parallel Search per retailer and category (`tools/harvest/retailers.mjs`: 50 retailers, 30 categories, 1,361 searches), restricted to the retailer's own domain, with excerpts focused on dimensions, price and materials.
2. **Structure:** pages whose excerpt states measurements go to Claude Opus 5.5 in groups of eight, with a strict JSON schema. It decides whether each page sells one piece, maps it to a furniture type, converts one standard size to cm, and writes shape notes. 13,080 candidate pages gave 8,899 plausible records, which deduplicate to 7,088.
3. **Prices:** for records without a price, Parallel Extract reads the page and Claude picks the selling price, ignoring financing and promotion amounts.
4. **Photos:** Parallel Image Search finds the product photo, preferring the product's own page.

Everything is cached in `private/harvest/` (git-ignored), so a run resumes and a re-run only does new work. `--retailers "West Elm,IKEA" --categories sofa,bed` narrows it, `--batch` sends the structuring through the Batch API at half price, and `HARVEST_MODEL=claude-haiku-5-5` would cut the Claude part to about a fortieth. This harvest cost about $33 in Parallel (searches $19.57, photos $8.86, page reads $4.50) and about $65 in Claude ($51.52 for structuring as one batch, $13.50 for prices).

## Files

| | |
|---|---|
| `loft-teardown/` | The page. `corrections.js` applies the corrections file, and `prompts.js` holds the prompt library. `model.js` groups the GLB's roots (844 in the November 1 revision) into objects. `choreo.js` is the teardown as a pure function of one input. `stage.js` holds the studio and overlays, `console.js` the UI, `live.js` the controller, `arrange.js` the Claude panel and refurnish controls, `catalog.js` the procedural furniture and catalogue models, `catalog-panel.js` the CATALOG tab. |
| `shared/` | The layout checker (`layout-check.js`), the procedural types (`furniture.js`) and catalogue search (`catalog-index.js`), used by both the page and the server. |
| `catalog/`, `catalog-assets/` | The catalogue and its sources; the open models (git-ignored) and their licences. |
| `private/<room>/` | Per revision, git-ignored: corrections, saved layouts and Claude transcripts. |
| `server.mjs`, `server/` | The server and its parts: the Claude rearrange loop (`arrange.mjs`, `scene-text.mjs`), AI 3D models (`model3d.mjs`), keys (`env.mjs`), the Replit App Storage mirror (`persist.mjs`). |
| `shared/model3d.js` | The part-list schema Claude fills for a 3D model, and the fitting to the listed size (server and page). |
| `tools/build.mjs` | Builds the page into `teardown-out/dist/loft-teardown.html` with esbuild (standalone; the kit is in `vendor/teardown-kit/`). |
| `tools/harvest-catalog.mjs`, `tools/harvest/` | The furniture harvest: retailers and categories, the Parallel client, Claude structuring. |
| `tools/generate-3d.mjs` | Makes AI 3D models from the command line (a sample, a brand, a category, or everything missing; `--batch` for half price). |
| `tools/build-catalog.mjs`, `fetch-models.mjs`, `inspect-models.py` | Build the catalogue, download the open models, measure a model. |
| `tools/review.mjs` | Renders review stills of any state (the skill's review loop; needs the skill's Playwright). |
| `docs/replit/` | The build guide and hand-off prompt for publishing on Replit. |

After editing the page, run `npm run build` and reload. To move to a new model revision, change the default room in `server.mjs` (or pass `--room`), restart the server, and copy `private/<old room>/` to `private/<new room>/`. Then check the corrections against the new room.json: the layouts carry over by stable id. Objects are grouped when the page loads, so nothing else needs regenerating.

## Hosting

Locally the server listens on 127.0.0.1 only. To serve it elsewhere, set these environment variables (they are also listed at the top of `server.mjs`):

| | |
|---|---|
| `HOST`, `PORT` | Interface and port, e.g. `0.0.0.0` and `5199`. |
| `APP_PASSCODE` | Required on any non-loopback address: the server refuses to start without it. Every page and API asks for it once, then keeps a signed 30-day cookie; failed tries are slowed. `/healthz` stays open for health checks. |
| `PUBLIC_URL`, `ALLOWED_HOSTS` | The hosts the server answers for (`.replit.app` style entries match subdomains). Anything else gets 421, and writes from other origins get 403. |
| `DATA_DIR`, `APP_DATA_DIR` | Where the model revisions and this app's own files live. |
| `STORAGE=replit` | Mirrors the model revision, layouts, transcripts and AI models to Replit App Storage (`server/persist.mjs`): restored at start, uploaded after each write. |

`docs/replit/REPLIT-BUILD.md` is the full guide for publishing on Replit, written for the Replit AI Agent, and `docs/replit/REPLIT-AGENT-PROMPT.md` is the prompt to give it.

## Privacy

The model and room geometry stay in the ignored `data/scans/` folder, and the app's corrections, layouts and transcripts in the ignored `private/` folder. The model is streamed from there at runtime and never copied into the build. Locally the server only answers its own origin on 127.0.0.1; hosted, everything but `/healthz` is behind the passcode. Review renders in `teardown-out/` and the harvest's raw cache (`private/harvest/`) are ignored too. Requests to Claude include the furniture names, sizes and positions, and your request text, but no photos of your home; making a 3D model sends Claude the product's own photo URL and listed facts.
