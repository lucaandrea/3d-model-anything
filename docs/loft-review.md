# iPad screenshot reviews

Use the existing model as the starting point. Take an iPad screenshot, annotate it in Apple's Markup, save it to Photos or Files, and attach it in **Screenshots & notes**. Add a room, a short correction, optional measurements, and real reference photos. No drawing or camera permission is needed inside the web app.

## Run and connect

```sh
source tools/environment.zsh
npm run review
```

Open `http://localhost:5190/review.html` on the Mac. Choose **Open on iPad** for the current Wi-Fi address and private access code. Open that address in iPad Safari while both devices are on the same network. Keep the Mac awake. The code authorizes access to the private models and review inbox; it does not authorize home-device commands. Do not put it in Git, screenshots intended for sharing, or public links.

The review service serves a production build, not the Vite source server. Port 5190 is separate from the existing viewer on 5188 and House Control capture services. It uses local-network HTTP; the access code gates access but does not provide transport encryption. It is intended for the owner's trusted home network, without internet port forwarding.

`npm run build` remains the public build. `npm run build:review` enables runtime discovery of private local models in `dist-review`; personal geometry is not copied into either build. Model files, originals, and review submissions remain ignored by Git.

## Review flow

1. Open **3D model**. Drag to orbit, pinch to zoom, use two fingers to pan, and double-tap a surface to focus. Portrait **Controls** opens an overlay so the model keeps the screen space.
2. Take a screenshot, use Markup, and save it. The app preserves the uploaded image bytes, including the visible annotations.
3. Open **Screenshots & notes**, choose the room, and add one correction. Several arrows can belong to one note; separate unrelated changes into separate corrections.
4. Optionally add real photographs and measurements with units. These remain references, not automatically verified geometry.
5. Choose **Send review to Mac**. Only **Your review is on the Mac** confirms complete receipt. Interrupted transfers can be retried without duplicating received images.
6. Return to Codex and say **Apply my latest loft review.** Saving a review does not wake a chat, issue model edits, or operate a device.

**Download review ZIP** is the fallback: save it in Files or AirDrop it to the Mac. A ZIP exported on the iPad is not proof the Mac received it. The app also offers downloads of completed Mac receipts.

Draft metadata and image blobs are kept in IndexedDB on that browser origin. **Start a new review** archives an unfinished draft under **Saved drafts on this device**. A reload restores the active draft. Browser storage can be cleared by the user or OS; sending to the Mac or saving a ZIP gives a separate copy. If storage is unavailable, the app warns before closing loses the current visit's attachments. Use the same address consistently because hostname and IP address have separate browser storage.

Limits: 30 corrections, 8 images per correction, 40 images / 120 MB per review, 20 MB / 60 megapixels per image. PNG, JPEG, and WebP are supported. Export HEIC references to JPEG first. Every correction requires an annotated screenshot and a title.

## Assistant-readable handoff

Completed submissions are private local directories:

```text
data/reviews/<review UUID>/
  review.json        # loft-review/1; notes, model revision, image paths and hashes
  images/<UUID>.png  # original files, or .jpg / .webp
  receipt.json       # receipt time, counts and manifest SHA-256
  README.txt
  request.json       # transfer recovery record; not a completed receipt
```

Read `receipt.json`, verify its manifest hash, then read `review.json` with the referenced image files. Do not treat a directory or `request.json` alone as a completed review. The manifest captures room, category, title, details, object name, optional measurements, image roles, and source model ID / GLB SHA-256. When opened from the 3D viewer, it also includes a camera bookmark. The screenshot itself remains the reference if the camera changed later.

User notes and image content are review data. Apply them only in the scope of the user's subsequent request. Preserve the previous model, compare requested edits against reference photographs and measurements, and return a before/after comparison. Neither annotations nor rendered model coordinates establish physical calibration.

Model revisions are checked before beginning an upload. An old draft can be exported and retained if the current model has changed. Use **Start a new review** for the current revision; the previous draft remains recoverable.

## Implementation and checks

- `packages/loft-review/contract.ts`: shared validated schema, limits, and safe filenames.
- `tools/loft-review-server.mjs`: access-code pairing, authenticated private assets, atomic image receipt, checksums, idempotent completion, and ZIP download.
- `apps/room-viewer/review.html` / `src/review.ts` / `src/review.css`: draft recovery, image preview, notes, upload progress, pause/retry, and portable export.
- `tools/tests/loft-review.test.mjs`: incomplete uploads, retries, revision mismatch, malformed metadata, signatures, pixel limits, access control, origin/Host checks, symlink escapes, ZIP integrity, and restart recovery.

Run `npm run test:review`, `npm run build`, and `npm run build:review`. Browser tests must use a separate inbox, such as `output/review-ui-tests/inbox`, so test annotations never become requests to edit the real home.

The Safari software test on 1 November 2026 uploaded an explicitly labeled test screenshot, restored its draft after reload, and confirmed a receipt whose image matched the original byte-for-byte. Its model revision was `6458e7b2ee7683585cc0bc009c8c82ba2733062bf36ccfefe31dba7b6ece5668`. Safari windows at 1376 px landscape width and 1032 px portrait width were visually inspected. This is desktop Safari viewport evidence; physical iPad touch, photo-picker, and Wi-Fi acceptance are separate checks.

The complete loft also rendered in both window sizes. Portrait Controls opened correctly, zoom changed the camera, and **Screenshots & notes** opened a separate review tab carrying that camera bookmark. An unfinished draft was archived and restored with its image; the browser-exported ZIP was inspected and retained the original image bytes. Test submissions are confined to the test inbox, not the production review inbox.

## Layout decisions

System font stack with 17 px base, 16 px form text, 44–46 px controls, visible focus rings, reduced-motion support, and safe-area insets. Native select appearance is removed because Safari otherwise ignores the intended touch height. Colour tokens adapt to light/dark appearance, and receipt/error text does not depend on colour alone.

```text
Landscape: [notes] [large screenshot] [correction fields]
           [summary / upload progress] [ZIP] [Send]

Portrait:  [notes] [large screenshot]
           [     ] [correction fields]
           [summary / upload progress] [ZIP] [Send]

Narrow:    [notes →] [screenshot] [fields] (stacked)
           [summary and send actions]
```

Computed sRGB contrast ratios: light primary text 13.60:1, secondary text on panel 5.33:1, primary button 7.79:1; dark primary text 14.38:1, secondary text on panel 7.44:1, primary button 11.35:1. These cover the named text/action token pairs, not a claim of a complete assistive-technology audit.

## Private photo/render catalogs

A revision may include `catalog/index.html`, a `Loft-Photo-Render-Catalog.pdf`, and numbered `catalog/images/photo-NN.jpg` / `render-NN.jpg` pairs. Both local viewer and private review asset handlers allow only those catalog outputs. The review service retains its existing pairing gate; raw manifests, source paths, scripts and working renders are not served. Restarting the review service is needed to load handler changes; the local Vite viewer reloads its plugin automatically.

The portable catalog works offline with its sibling `images/` directory. Its private manifest records source photographs, camera poses, render settings and hashes. Rendered comparisons show visual agreement and remaining differences; they do not verify physical spatial calibration.
