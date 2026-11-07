# Loft Teardown on Replit: build and publish guide (for the Replit AI Agent)

This file tells an AI agent exactly how to build, configure, publish and verify the **Loft Teardown** web app from this
GitHub repository on Replit. Read it fully before changing anything. Follow the steps in order. Where it says MUST, do
not improvise.

---

## 1. What you are deploying

- **Only `apps/home-teardown/`.** The repository is a monorepo (`apps/house-capture` is an iOS app, `apps/room-viewer`
  is a separate Vite viewer, `packages/` and `.agents/` are unrelated). Do not build, modify or deploy anything outside
  `apps/home-teardown/`, except adding `.replit` (and `replit.nix` only if Replit requires it) at the repository root.
- The app is one Node.js process (`apps/home-teardown/server.mjs`, plain `node:http`, ES modules, no framework) that
  serves one prebuilt HTML page (`teardown-out/dist/loft-teardown.html`, built by esbuild) and a JSON API.
- What it does: shows a 3D model of the user's real home (a two-floor loft). The user can tear it down and reassemble it,
  rearrange the furniture with Claude Opus 5.5 (Anthropic API), browse a catalogue of ~7,200 real furniture products
  from 45 retailers, add, swap and remove furniture, and have Claude make a 3D model of any catalogue piece that has
  none (sized to the product's listed dimensions).
- The home model is **private** (it is the user's actual home). The app MUST be behind the passcode login (built in,
  see §5). Never make the model, the API, or the page reachable without it.

## 2. Facts about the code you can rely on

| Item | Value |
|---|---|
| Runtime | Node.js 20 or newer (uses global `fetch`, `AbortSignal.timeout`, `import.meta.resolve`, top-level `await`). Prefer `nodejs-22`; `nodejs-20` works. |
| App directory | `apps/home-teardown` (all commands below run from there) |
| Install | `npm ci` (lockfile `apps/home-teardown/package-lock.json`). Dependencies: `@anthropic-ai/sdk`; dev: `esbuild`, `three`, two `@fontsource` packages. |
| Build | `npm run build` -> `teardown-out/dist/loft-teardown.html` (~0.9 MB, fonts and three.js inlined). Takes < 1 s. |
| Open 3D models | `npm run models` downloads ~100 MB of CC0 / CC BY 4.0 models into `catalog-assets/models/` (git-ignored). Idempotent. Needs outbound HTTPS to `amazon-berkeley-objects.s3.amazonaws.com`, `raw.githubusercontent.com`, `api.polyhaven.com`, `dl.polyhaven.org`. |
| Start | `npm start` (= `node server.mjs`) |
| Health check | `GET /healthz` -> `200 {"ok":true}` (no login needed) |
| Login | `GET /` shows a passcode page until signed in; `POST /login` `{"passcode":"..."}` sets an HttpOnly cookie for 30 days |
| Default model revision | `loft-refinements-2026-11-01` (override with env `LOFT_ROOM`) |

Key files (read them if something is unclear; do not rewrite them):

| Path (under `apps/home-teardown/`) | Role |
|---|---|
| `server.mjs` | HTTP server, routes, host/origin checks, passcode login, env settings (documented at the top of the file) |
| `server/persist.mjs` | Replit App Storage mirror: `restore()` at start, `persist(file)` after writes. Active only when `STORAGE=replit`. |
| `server/arrange.mjs`, `server/scene-text.mjs` | The Claude rearrange agent (SSE endpoint `POST /api/arrange`) |
| `server/model3d.mjs`, `shared/model3d.js` | AI 3D model generation (`POST /api/model3d`) and the part-list schema |
| `server/env.mjs` | Reads `ANTHROPIC_API_KEY` / `PARALLEL_API_KEY` from the environment, else from a `.env` file |
| `loft-teardown/` | The page source (three.js). Built by `tools/build.mjs`. |
| `catalog/catalog.json` | The furniture catalogue (committed). Rebuilt by `npm run catalog`. |
| `catalog/generated/*.json` | AI-made 3D models (committed ones ship with the repo; new ones are created at runtime) |
| `tools/harvest-catalog.mjs` | Harvests more furniture with Parallel + Claude (optional, offline task; not needed to run the app) |
| `vendor/teardown-kit/` | Two MIT-licensed files the page build needs (do not delete) |

## 3. What is NOT in the GitHub repository (and where it must come from)

These paths are git-ignored on purpose. The app cannot start without the first group.

1. **The private home model revision** (required). Locally it lives in `data/scans/loft-refinements-2026-11-01/` at the
   repository root: `modeled_room.glb` (~123 MB), `room.json`, `viewer.json`. The user uploads these three files to
   Replit **App Storage** under the object names:
   ```
   rooms/loft-refinements-2026-11-01/modeled_room.glb
   rooms/loft-refinements-2026-11-01/room.json
   rooms/loft-refinements-2026-11-01/viewer.json
   ```
   With `STORAGE=replit`, the server downloads them to `$DATA_DIR/loft-refinements-2026-11-01/` on start if missing.
   Do not try to find these files on the internet, and never add them to git.
2. **The app's own per-home files** (recommended). Locally in `apps/home-teardown/private/loft-refinements-2026-11-01/`:
   `teardown-corrections.json` (the washer/dryer, the one-piece sectional, the upstairs room outlines) and
   `teardown-layouts.json` (the user's saved layouts). Upload them to App Storage as
   `app/loft-refinements-2026-11-01/teardown-corrections.json` and `app/loft-refinements-2026-11-01/teardown-layouts.json`.
   Without the corrections file the home still loads, but the washer/dryer are missing and the sectional is two pieces.
3. **The open 3D models** (`catalog-assets/models/`): fetched by `npm run models` during the build. Not secret.
4. **`node_modules/`, `teardown-out/`**: produced by install and build.
5. **`.env`**: never present on Replit. Use Replit Secrets instead (§4).

If `apps/home-teardown/` itself is missing from the repository you imported, stop and tell the user: the app must be
committed and pushed first (it was developed locally and may not be on GitHub yet).

## 4. Secrets and environment variables

Set these as **Replit Secrets** (both the workspace and the published deployment need them):

| Name | Required | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | The user's Anthropic key (Claude Opus 5.5 for rearranging and 3D generation). Ask the user; never invent one. |
| `APP_PASSCODE` | yes | A passcode the user chooses (12+ characters). The server refuses to listen on a public address without it. |
| `PARALLEL_API_KEY` | no | Only for re-running the furniture harvest (`npm run harvest`). Not used at runtime. |

Set these as plain environment variables (in `.replit` `[run.env]` and in the deployment's environment):

| Name | Value | Why |
|---|---|---|
| `HOST` | `0.0.0.0` | Listen on all interfaces (default is 127.0.0.1, which Replit cannot reach) |
| `PORT` | `5199` | Must match `[[ports]] localPort` |
| `STORAGE` | `replit` | Turn on the App Storage mirror (`server/persist.mjs`) |
| `ALLOWED_HOSTS` | `.replit.dev,.replit.app` | The server rejects any Host header it does not know (HTTP 421). Entries starting with `.` match subdomains. Add a custom domain here if one is used. |
| `PUBLIC_URL` | the published URL, e.g. `https://loft-teardown.replit.app` | Optional once `ALLOWED_HOSTS` covers it; also accepted as an origin |
| `DATA_DIR` | `/home/runner/loft-data` (any writable path outside the repo) | Where the model revision is restored to |
| `APP_DATA_DIR` | `/home/runner/loft-app` | Where layouts, corrections and Claude transcripts are restored to and written |
| `REPLIT_BUCKET_ID` | optional | Only if the bucket is not the Repl's default App Storage bucket |

Security rules the server enforces (do not weaken them): Host header allow-list; POST/PUT only from the app's own origin
with `Content-Type: application/json`; passcode cookie on every route except `/healthz` and the login page; the API
keys never leave the server.

## 5. Replit configuration

Create `.replit` at the **repository root** (adjust only if Replit's schema requires it):

```toml
modules = ["nodejs-22"]

[run]
args = ["bash", "-lc", "cd apps/home-teardown && npm start"]

[run.env]
HOST = "0.0.0.0"
PORT = "5199"
STORAGE = "replit"
ALLOWED_HOSTS = ".replit.dev,.replit.app"
DATA_DIR = "/home/runner/loft-data"
APP_DATA_DIR = "/home/runner/loft-app"

[deployment]
build = ["bash", "-lc", "cd apps/home-teardown && npm ci && npm install @replit/object-storage && npm run build && npm run models"]
run = ["bash", "-lc", "cd apps/home-teardown && npm start"]
deploymentTarget = "gce"

[[ports]]
localPort = 5199
externalPort = 80
```

Notes:
- `deploymentTarget = "gce"` is a **Reserved VM** (recommended: one always-on process; Claude rearrange requests stream
  over SSE for up to several minutes and 3D generation takes 30-60 s per piece). `"cloudrun"` (Autoscale) also works if
  its request timeout allows long requests; cold starts then re-download the 123 MB model from App Storage.
- The deployment's environment MUST include the same `[run.env]` values (set them in the Publish settings if Replit
  does not copy them) and the Secrets from §4.
- Add `@replit/object-storage` as a real dependency of `apps/home-teardown` (`npm install @replit/object-storage` in
  that folder, commit the updated `package.json` and `package-lock.json`). `server/persist.mjs` imports it only when
  `STORAGE=replit`. Then the `npm install @replit/object-storage` in the build command can be removed.

## 6. Step by step

1. Import the GitHub repository into a new Repl. Confirm `apps/home-teardown/server.mjs` exists.
2. Add the Secrets from §4. Ask the user for `ANTHROPIC_API_KEY` and `APP_PASSCODE`.
3. Create `.replit` as in §5.
4. Open **App Storage** (Object Storage) in the Repl and create a bucket (the default bucket is fine). Then put the
   files from §3 items 1 and 2 into App Storage with exactly those object names. The simplest way:
   upload them into the Repl's workspace at the same relative paths (both folders are git-ignored, so they are never
   committed): `data/scans/loft-refinements-2026-11-01/` (the three model files) and
   `apps/home-teardown/private/loft-refinements-2026-11-01/` (the two JSON files). Then run in the shell:
   ```bash
   cd apps/home-teardown && npm install @replit/object-storage && node tools/replit-upload-private.mjs
   ```
   It uploads each file under its object name and lists them back. (Uploading directly in the App Storage tool with
   the same names also works.)
5. In the shell:
   ```bash
   cd apps/home-teardown
   npm ci
   npm install @replit/object-storage
   npm run build
   npm run models
   HOST=0.0.0.0 PORT=5199 STORAGE=replit ALLOWED_HOSTS=.replit.dev,.replit.app DATA_DIR=/home/runner/loft-data APP_DATA_DIR=/home/runner/loft-app npm start
   ```
   Expected log: `restored 3 files from App Storage rooms/loft-refinements-2026-11-01/`, then
   `Loft teardown: http://0.0.0.0:5199/ · passcode required`, the model path and size, and `Claude claude-opus-5-5 · key from environment`.
6. Run the acceptance tests (§7) against the workspace preview URL.
7. Publish as a Reserved VM with the build and run commands from §5 and the same environment and Secrets.
8. Run the acceptance tests again against the published URL.

## 7. Acceptance tests (all MUST pass)

Replace `$U` with the preview or published URL.

1. `curl -s $U/healthz` -> `{"ok":true}`.
2. `curl -s -o /dev/null -w "%{http_code}" $U/catalog.json` -> `401` (signed out).
3. `curl -s -o /dev/null -w "%{http_code}" -r 0-99 $U/model.glb` -> `401` (the private model is not public).
4. Opening `$U` in a browser shows the passcode page; the right passcode opens the app; a wrong one says "Wrong passcode".
5. After sign-in, the page loads the home (a progress bar, then a 3D loft). The header reads
   "WHOLE LOFT · BATHROOM & RIG REFINEMENTS · 2 FLOORS · 158 OBJECTS". The browser console has no errors.
6. `$U/?tab=catalog` opens the CATALOG with thousands of pieces; the filters work; each card shows a 3D status badge.
7. MAKE 3D on a card marked NO 3D MODEL turns into "AI 3D" within about a minute, and a file
   `generated/<id>.json` appears in App Storage.
8. In Rearrange mode, sending "Make the living room work for hosting 8 people" to Claude streams steps and ends with a
   new saved layout.
9. Restart the Repl (or redeploy): the saved layouts and the AI-made model from test 7 are still there.
10. From another site (or curl with `-H "Origin: https://evil.example"`), `POST $U/api/layouts` -> `403`.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Refusing to listen on 0.0.0.0 without APP_PASSCODE` | Add the `APP_PASSCODE` Secret. Do not set `ALLOW_NO_PASSCODE`. |
| HTTP 421 `wrong host` | The request's Host is not allowed: add it to `ALLOWED_HOSTS` (e.g. `.replit.dev`, a custom domain). |
| HTTP 403 `cross-origin request refused` on save | The page's origin is not allowed: same fix, or set `PUBLIC_URL`. |
| `missing .../modeled_room.glb` at start | App Storage objects are missing or misnamed (§3), or `STORAGE` is not `replit`. |
| `Cannot find package '@replit/object-storage'` | Run `npm install @replit/object-storage` in `apps/home-teardown`. |
| esbuild error on build | Run `npm ci` again (its platform binary comes from `@esbuild/*` optional dependencies). |
| Claude features say the key is missing | `ANTHROPIC_API_KEY` Secret not set for this environment (workspace and deployment are separate). |
| Layouts vanish after a restart | `STORAGE=replit` missing, or App Storage writes failing (look for `[persist]` warnings in the log). |
| Page is blank or old | Rebuild (`npm run build`); the page is served with `Cache-Control: no-store`. |

## 9. Rules

- Do not change the server's security checks, the passcode flow, or make any route public other than `/healthz` and
  the login page.
- Do not commit secrets, `.env`, the home model, or anything under `data/scans/` or `apps/home-teardown/private/`.
- Do not replace the plain Node server with a framework, change API routes, or rename catalogue ids (saved layouts
  refer to them).
- Do not run `npm run harvest` or `node tools/generate-3d.mjs --missing` on your own: they spend the user's Parallel and
  Anthropic credits (dollars to hundreds of dollars). Only run them if the user asks.
- Keep the model revision name (`loft-refinements-2026-11-01`) unless the user gives a new one; a new revision is a new
  `rooms/<name>/` prefix plus `LOFT_ROOM=<name>`, and the app files are copied from `app/<old>/` to `app/<new>/`.
- Third-party data: the catalogue holds product facts (names, sizes, prices, links) and links to product photos; the
  page never shows retailer photos and links out with ↗. Keep it that way on a public deployment.
