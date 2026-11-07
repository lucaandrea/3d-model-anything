# Reviewed-floor detail guidance

A reviewed floor can unlock its detail rooms before other floors are captured. The user can switch back to the next structural route step without discarding progress. A stairs connector is a separate structural pass, with lower/upper landing overlap; its label never supplies an inter-floor transform.

`floor-mac-review/1` binds an assembled USDZ and USB-verified originals to exact session manifest hashes. A new session or changed manifest invalidates that review. It represents reconstruction review, not physical calibration. Original AR captures remain unchanged.

`room-detail-guide/1` binds explicit room polygons and photographic targets to an immutable reference ARWorldMap and PLY by SHA256. `modelFromReference` is a column-major rigid transform in metres, +Y up. Detail capture starts its own zone from those reviewed references, and verifies the live mesh before and after RoomPlan starts. It never merges the unrepaired raw session frames or relocates home controls.

Location requires stable tracking, measured relocalization and three consecutive room observations. Boundary/overlap regions and wrong elevations are unknown. Entering another room pauses selected-room credit and prompts a deliberate room change. Tracking loss immediately suspends location-based guidance. The user-selected room alone does not prove location.

Two distinct progress metrics:

- `photoCoverage`: photographic coverage of currently observed mesh inside the selected region; existing red/amber/green overlay.
- `detailTargetCoverage`: fraction of known reviewed corner/object-view targets with a sufficiently sharp, close, visible photograph backed by valid depth. Repeated weak views cannot accumulate to completion. Missing/occluded depth earns no credit. Hidden, moved and small unmodelled objects still require explicit human inspection.

Persisted `room-detail-progress/1` is keyed to guide revision and a canonical guide-content fingerprint, and stores per-target best quality and accepted-photo count. It survives room changes/relaunch, and is copied into the capture package with its guide. Structural-pass photographs do not prefill new detail progress.

Live preview optional fields: `detailTargetCoverage`, `detailGuideRevision`, `detectedRoomID`, `roomLocationVerified`, `detailGuidance`. Null/missing coverage is unknown, not zero. A stale preview must not retain a live location claim.

Physical acceptance remains separate: relocalization after camera configuration, actual room transitions, moved furniture, ceiling/occlusion coverage, and sustained iPhone performance must be exercised in the home. No software test claims those physical checks passed.

A stairs connector requires saved mesh and depth evidence, but does not require four walls or a flat merged RoomPlan structure. These exceptions do not apply to normal floor scans. Finished originals can still be uploaded for Mac repair when structural review fails; that transfer does not mark the floor reviewed.

Validation on 27 October 2026: device and simulator builds passed, 231 scanner self-checks passed, and a read-only physical iPhone check verified six checkpoints, the reviewed downstairs model, five guide regions/697 targets and the stairs next step. The guided route launched on the phone. House Control build 5 is running with one receiver; native baseline/progress pages were inspected and active-model, kit and placement fingerprints were preserved. Physical walking guidance remains pending.

## Short room-detail passes

The route displays every available room with a planned-view progress bar. Selecting a room scrolls to its start/preparation controls. An uploaded or explicitly deferred pass does not remove the room from the list. All saved detail passes remain available for transfer; progress is accumulated against the same immutable guide. Mirror preparation remains available when revisiting a room.

During capture, the detail card names the verified room, shows integer progress (never rounded to 100 with missing targets), and suggests a missing target with direction and distance. **What's missing?** opens an accessible room plan with incomplete squares, completed dots, a next-target ring and a verified camera position. It also shows per-room progress on the same floor. The route shows both floors. Rooms without a reviewed guide explicitly offer manual capture without room recognition or a made-up percentage.

The checkpoint recommendation appears after 180 active, localized capture seconds or 120 saved photos, or sooner under resource pressure. After 90 active seconds with no target improvement for 60 seconds it suggests another view or saving. The recommendation never stops recording or marks the room complete. **Save pass** finishes the room and session, then **Return to room progress · upload** exposes checksum-verified transfer. A partial pass can be continued after upload.

Photo-only detail passes are retained and uploadable if RoomPlan produces no new layout. They cannot satisfy the separate measured-geometry requirements for structural review. Existing reviewed floors, original captures, device bindings and calibration records remain unchanged.

DEBUG-only `-preview-detail-guidance` and `-preview-detail-map` render isolated simulated UI fixtures; `-preview-detail-partial`, `-preview-detail-lost` and `-preview-detail-large` exercise partial coverage, tracking loss and larger type. They never run AR, pair, or write user progress. `-check-floor-recovery` verifies the actual saved guide/reference hashes and reconnects using existing capture credentials without uploading or changing captures. Simulator fixtures are not physical recognition evidence.

Readiness review on 29 October 2026: optimized development and simulator builds passed; 252 scanner self-checks passed. The update was installed under the existing team, and the physical iPhone verified 5 downstairs guide regions / 697 targets, 2 upstairs regions / 384 targets, 68 marker images, and the existing authenticated Mac connection. The original five-session house index remained byte-identical. Simulator visual checks covered the room list, missing-view map, partial progress and large-type tracking loss. A new attended room-detail pass, its upload and sustained walking behavior still require physical acceptance; no simulator check substitutes for those observations. Private evidence is under `output/detail-readiness-20261029/`.

## Reviewed-reference startup regression

On 29 October, a physical detail attempt reported `Reviewed floor reference: x isn't float`. The reviewed Open3D meshes use double-precision coordinates and normals; the localization PLY reader previously rejected them despite valid checksums. The earlier read-only check decoded a raw source mesh and hashed the reviewed mesh, so it did not exercise the failing path.

The localization reader now supports `float`, `float32`, `double`, and `float64` fields independently, including mixed coordinate/normal layouts. It rejects incomplete vertex or face payloads before use. `PreparedDetailReference.load` validates hashes, builds the actual localization index and overlay, and decodes the reference ARWorldMap before a guided capture session is created. Capture uses those same prepared objects. The phone readiness diagnostic invokes that same factory for every reviewed floor. Missing reviewed geometry can never fall through to the legacy map-only continuation path.

Saved floor photographs now appear as relocalization landmarks instead of searching the new detail zone, which has no prior photos. The UI explains that uncalibrated printed cards do not establish house position; wider, previously scanned fixed features are required. All existing room progress and original captures remain unchanged. Physical room matching is still a separate live acceptance check.

After installation, the read-only check on the physical iPhone prepared both actual reviewed references through the capture factory: ground floor 285,540 mesh vertices / 216,037 index points / 379,007 overlay triangles / 20,870 map features; upstairs 283,417 vertices / 119,598 index points / 155,078 overlay triangles / 13,157 map features. Both reported no reference errors. The authenticated Mac connection passed, all 68 marker images remained available, and the house index was byte-identical before and after. The 269-check suite and both optimized builds passed. Live room matching, photo progress and a new upload remain separate attended checks. Private evidence: `output/detail-relocalization-fix-20261029/`.

## Room-specific recovery references

A subsequent attended attempt loaded the geometry but remained in ARKit relocalization. The retained end-of-floor map contained only 9 visual feature points inside the Entrance & office region, versus 7,202 in the earlier pass. A successful decode is not evidence that a map covers the requested room. The old photo picker also used the latest checkpoint photographs from the entire zone.

Optional `room-localization/1` catalogs are bound to the reviewed guide file by SHA-256 and to `floor-mac-review/1` via `localizationSHA256`. Each eligible map has a hash, explicit rigid `referenceFromSession` transform, provenance and supported room IDs. Room preferences select the earlier entrance/hallway pass where it has useful coverage; the living area retains its later map. Only registered transforms from the reviewed assembly are used. A room can offer another eligible map before recording starts. The single AR session is reset only during that recovery switch, and no captured pose is reinterpreted.

The localization mesh and normals are transformed into the selected map frame. Room guidance and photographic scoring compose `modelFromReference * referenceFromSession`. Canonical target identities and the accumulated progress fingerprint stay unchanged. Each capture includes `detail-reference.json` (`detail-session-reference/1`) with its exact map hash, canonical exported guide hash and session-to-reference transform. Reconstruction must compose this transform when interpreting poses from such a capture; the map choice does not calibrate home controls.

Reference images are filtered by reviewed camera position, floor elevation and viewing direction, then visually reviewed. They are checksummed, decoded during preflight, and assigned only to their own room. Missing room images remain absent rather than falling back to unrelated rooms. `tools/build_room_localization.py` generates the private assets from an explicit local specification and never estimates registration or edits captures. Discarding an empty failed relocalization keeps one bounded local status diagnostic, without photos, outside the active scan library.

The read-only `-audit-detail-maps` modifier for `-check-floor-recovery` exports actual archived feature positions for local diagnosis without running AR. New self-checks cover wrong-room map exclusion, stale catalogs, invalid transforms, damaged reference images, transformed mesh agreement, transformed depth/photo credit, progress continuity and the exact exported guide hash. Live acceptance remains pending until an attended pass both recognizes the room and saves photos.

The updated read-only check then passed on the physical iPhone for all seven rooms: Entrance & office selected `entry-hall-map` and decoded five room-only images; hallway, guest bath and kitchen selected that same earlier map; dining/living selected `living-map`; both upstairs rooms selected `upstairs-reviewed-map`. All three maps decoded with nonempty transformed meshes and no reference errors, all room-photo hashes and image decodes passed, and the existing Mac connection was active. The final suite passed 287/287 checks. This verifies installed inputs, not the subsequent live AR match.

## Detail-session corrections after the attended retry

The three new attempts recovered a map in 32.3, 16.2 and 6.4 seconds and retained 46 photographs. The user still observed misplaced overlays, slow progress and confusing directions. The third attempt stopped with RoomPlan's `Capture scene exceeded limit`. A good point-to-plane median is not an independent absolute-position measurement.

- Live coverage now uses the same composed session transform as photo scoring. Upstairs clipping bounds include the actual lower and upper elevations. Previously the coverage engine omitted the selected earlier-map transform.
- Guided details use ARKit photography, depth and mesh without starting RoomPlan. A successful map match therefore is not immediately reconfigured by another structural scan. Detail records contain real photo/mesh evidence and no fabricated RoomPlan layout. Structure capture retains RoomPlan.
- Directions use ARKit's orientation-aware display view matrix. Raw sensor poses and intrinsics remain unchanged in captures. Suggestions skip measured foreground occluders and back faces; hidden targets remain incomplete.
- Each saved photo gives immediate feedback separately from planned-target completion. Completion still requires a sharp, depth-supported view. The UI explains why hidden or approximate targets may prevent 100 percent.
- Before capture, users can reject a visibly wrong overlay and reload the recovery map. The selected room must be stably recognized before Start room details enables. The old reference ghost hides during detail capture so green only represents new photo coverage.
- Final save releases camera, renderer, reference and photo-scoring resources. The reference-configuration closure weakly captures the marker manager rather than retaining the entire capture view/controller.

Both optimized builds and 297/297 simulator self-checks passed, including alternate-map live coverage, upstairs elevations, portrait directions, occlusion, and unchanged completion on repeated photos. The build is installed on the physical iPhone. Live acceptance of the new ARKit-only detail lifecycle, alignment, progress and upload remains pending. All three attempts and their originals are preserved privately.

After unlocking, the installed build launched successfully and repeated the physical read-only reference check at 2026-10-29 16:35 PDT. All seven room-specific photo sets and all three maps/meshes passed, 68 cards were available, and the authenticated Mac capture connection succeeded. The normal room route was reopened for the requested attended one-minute capture; that live result is still pending.
