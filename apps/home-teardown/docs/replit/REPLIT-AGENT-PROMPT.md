# Prompt for the Replit AI Agent

Copy everything below the line into the Replit Agent after importing the GitHub repository.

---

You are deploying an existing, working Node.js web app from this repository to Replit. Do not rebuild or redesign it.

**Read first:** `apps/home-teardown/docs/replit/REPLIT-BUILD.md`. It is the source of truth: the exact commands,
environment variables, `.replit` file, App Storage layout, acceptance tests and rules. Follow it step by step. Where
this prompt and that file differ, the file wins.

**The app:** `apps/home-teardown/` (Loft Teardown). It is a plain Node.js server (`server.mjs`, no framework) that serves
one prebuilt HTML page (three.js, built with esbuild by `npm run build`) and a JSON API. It shows a 3D model of the
user's real home, lets them tear it down, rearrange it with Claude Opus 5.5, browse ~7,200 real furniture products, and
have Claude make 3D models of furniture. Everything else in the repository (`apps/house-capture`, `apps/room-viewer`,
`packages/`, `.agents/`) is out of scope: do not build or modify it.

**Your tasks:**
1. Confirm `apps/home-teardown/server.mjs` exists. If it does not, stop and tell me the app has not been pushed yet.
2. Ask me for two Secrets and set them: `ANTHROPIC_API_KEY` and `APP_PASSCODE`. (`PARALLEL_API_KEY` is optional; only
   set it if I give it.) Never print them or write them to files.
3. Create the root `.replit` from section 5 of the build guide.
4. Set up Replit App Storage and ask me to upload my private files with the exact object names in section 3 (the home
   model `modeled_room.glb`, `room.json`, `viewer.json` under `rooms/loft-refinements-2026-11-01/`, and my
   `teardown-corrections.json` and `teardown-layouts.json` under `app/loft-refinements-2026-11-01/`). Wait for me to
   confirm the upload. Do not look for these files anywhere else and never add them to git.
5. In `apps/home-teardown`: `npm ci`, `npm install @replit/object-storage` (commit `package.json` and
   `package-lock.json`), `npm run build`, `npm run models`.
6. Start the app with the environment from section 4 and run every acceptance test in section 7 against the preview URL.
   Report each result. Fix configuration problems using the troubleshooting table in section 8.
7. Publish it as a Reserved VM with the build and run commands from section 5, the same environment variables and the
   Secrets, then run the acceptance tests again on the published URL and give me the URL.

**Hard rules:**
- The app MUST stay behind its built-in passcode login. Do not add public routes, disable the host or origin checks, or
  set `ALLOW_NO_PASSCODE`.
- Do not commit secrets, `.env`, the home model, or anything under `data/scans/` or `apps/home-teardown/private/`.
- Do not change application code unless an acceptance test fails because of a Replit-specific issue; if you must,
  make the smallest change, explain it, and keep the API routes and catalogue ids unchanged.
- Do not run `npm run harvest` or `node tools/generate-3d.mjs --missing`: they spend my Parallel and Anthropic credits.
- When something is unclear or a step needs my files or keys, ask me instead of guessing.

**Done means:** all ten acceptance tests pass on the published URL, the app restarts with my layouts intact, and you
have sent me the URL plus a short list of what you configured.
