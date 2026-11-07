# Paired scanning delivery status — 27 October 2026

The software and private pilot artifacts are implemented. Physical calibration,
combined-sensor comparisons, fixture command/readback and whole-loft acceptance are
still required. This is a development delivery, not a new TestFlight release.

## Camera recovery — late-afternoon physical check

The user's black camera and empty preview were reproduced. Apple Camera was also
black on the phone. A restart restored it briefly, but scanning still failed while
Device Hub's live phone-screen viewer was running. Closing Device Hub restored both
the basic RoomPlan test and the full scanner without another restart or a change to
AR camera configuration. Keep that viewer closed during scanning on this setup.

The updated development build rejects empty RoomPlan results, retains diagnostics,
and prevents older empty records from advancing the guided route. Startup delays
and failed attempts have explicit recovery messages. The automated physical test
now fails unless it actually saves measured geometry, mesh, photos and depth.

- 169/169 app self-tests passed on the physical iPhone.
- Full live test passed with six checkpoint reference images configured, normal
  tracking, one measured wall, 19,314 mesh vertices / 34,611 triangles, one reference
  photo, three depth records and a saved world map. The user confirmed the live room
  and overlay on the phone. The copied reference photo was visually inspected.
- The same build's failed attempt retained diagnostics and created zero house-room
  records; it did not masquerade as a successful room.
- Private evidence: `build/camera-unmirrored-autotest.log`,
  `build/camera-recovery-selftest.log`, and
  `output/device-backup/camera-recovered-house/`.

This short diagnostic pass verifies capture operation, not full-room completeness,
printed-card recognition, house alignment or the whole-loft route.

## Fresh guided collection — afternoon update

The scanner now supports a private ordered route, one saved session per space,
upload receipts before progression, explicit AirDrop/offline alternatives, floor and
overlap guidance, door-state notes and provisional mirror-card labels. See
[guided-scanning.md](guided-scanning.md). The user's itinerary and updated offline
HTML guide remain private under ignored `output/guide/`.

- Signed development build installed on the physical iPhone under the existing team.
- 164/164 app self-tests passed on the phone, including route progression and reversible
  collection reset/restore. The optional real-bundle performance fixture was not run.
- Cross-repository transfer harness passed, including checksum receipt and exact-byte
  preservation of `route-step.json`. This uses an isolated test inbox.
- Before reset, all 9,582 original scan files (974,710,306 bytes) matched the Mac backup
  against SHA-256 hashes computed on the physical phone. The archive receipt matches
  that inventory exactly. The active `Houses` directory is cleared; a recoverable phone
  archive, printed card kit and pairing remain. Earlier data-retention rows below
  describe the pre-reset milestone.
- The fresh route opened on the actual iPhone at Entrance & office, connected to the
  Mac. Safari displayed the updated route and mirror/laundry instructions.

The new workflow has not yet completed a real room capture/upload. Mirror labels do
not remove reflected depth, establish planes or calibrate the house. Those physical
checks remain part of the attended first pass.

## Delivered

- Matching Letter/A4 PDFs: 25 pages each, six checkpoint cards, 58 current mapped
  device cards and four spares. All 68 IDs, QR links, reference pixels and dimensions
  match the private manifest. Replacement/additional generation preserves identities.
- Scanner integration on the existing AR session, separate capture indicators,
  object-detail photographs, provisional card observations and room-scoped AirDrop
  evidence. Legacy `house-project/1` and `house-capture/5` remain compatible.
- Authenticated capture-only Mac transfer, durable resume, hash verification, bounded
  previews and exact-byte spatial manifests. Upload identity survives sandbox relocation.
- Editable Blender source plus matching GLB/USDZ/collision assets, stable object IDs,
  hierarchy/provenance and validated `house-spatial/1` packaging. Explicit multi-floor
  assembly never infers alignment from room names.
- House Control implements Scan & Calibrate, Home Model and Around Me. Room verification
  is stored separately from imported geometry and tied to its revision. Device placement
  and deliberate capability-driven controls remain gated by tracking and physical checks.
  The Vision Pro inspection overlay preserves source metres at 1:1 and hides unverified
  rooms or all geometry when tracking/registration becomes uncertain. Incoming photo
  detail is explicitly provisional, ages to stale, and does not imply room completeness.
- In-app privacy/help and prepared public pages describe optional pairing accurately.
  Public publishing and App Store metadata review remain distribution steps.

## Evidence

| Check | Result |
| --- | --- |
| Scanner self-tests | 144/144 passed on simulator and the actual iPhone; optional real-bundle benchmark skipped |
| Marker/spatial Python tests | 10 passed |
| Legacy importer/object-photo tests | 8 passed |
| CaptureLink Swift tests | 4 passed, including aliased sandbox path reopening |
| Independent scanner-to-House-Control TLS harness | Passed Bonjour TXT discovery, authentication, all card hashes, exact manifest bytes, restart/resume, receipts, checksum/path/command rejection and wrong-key denial |
| HouseCore suite | 174 tests, 2 existing skips, zero failures (`house-control/build/spatial/core-tests-build4.log`) |
| PDF inspection | All 50 pages rendered and visually inspected; all 136 printed QR instances decoded |
| PDF geometry/pixel checks | Exact registered pixels, 70/140 mm images, card trim, margins, text placement and 100 mm rulers passed |
| Apple reference-image compilation | All 68 images accepted |
| Blender interchange | GLB/USDZ round-trip bounds agree within 0.000001 m; rename retains object identity, duplicate identity rejects |
| Safari | Rebuilt pilot and original scan visually inspected; viewer build passed |
| Scanner signing/install | Signed with Luca Andrea Collins team; installed without uninstalling/resetting data |
| Physical iPhone launch | Passed after unlock; existing two rooms/three sessions and saved preview visible |
| Physical iPhone pairing | Approved Mac channel discovered and authenticated; connected status and all 68 loaded cards visibly confirmed |
| Physical card-kit download | All 69 files downloaded into the phone's validated kit folder |
| Physical saved-capture transfer | 2,207 files / 189,677,374 bytes received; every SHA-256 matches the original backup; Mac receipt and iPhone success UI confirmed |
| House Control development installs | Mac 0.5.0 (3), iPhone 0.5.0 (10), Vision Pro 0.5.0 (4); signed installs completed |
| House Control physical model preview | iPhone rendered the pilot using SceneKit after RealityKit loading stalled on hardware; phone AR and Vision Pro spatial views retain RealityKit |
| Existing scanner data | 9,583 original files backed up with local SHA-256; post-install device paths/sizes preserved |

Format agreement is not a physical measurement of room accuracy. Simulator checks do
not demonstrate RoomPlan/image-provider coexistence, printed-card recognition, physical
device commands or sustained thermal performance.

Real-phone setup exposed two integration gaps that are now regression-tested: discovery
must request Bonjour TXT records, and upload paths must compare canonical components
because iOS can spell the same sandbox as `/var` and `/private/var`. The empty failed
upload descriptor was preserved outside the active inbox; no scan payload was discarded.

Private artifacts are ignored by Git under `output/pdf/`, `output/marker-kit/`,
`output/spatial-assets/office-entrance-v3/`, `output/spatial-home/office-entrance-v3/`
and `output/device-backup/`. Original capture and Blender sources are retained.

## Remaining attended steps

1. The scanner is installed and launched successfully on the physical iPhone after
   unlock. The full kit is installed; its 68-card loader UI and matching-kit download
   are verified on the phone. Luca reports printing the Letter kit. Ruler measurement,
   mounting and physical card-recognition tests remain pending.
2. The Mac capture channel is enabled after explicit user confirmation. House Control
   has the kit and reviewed model loaded. The approved capture link opens Paired capture
   on the iPhone. Local-network permission is granted and the actual phone connection
   is verified. The card kit and a complete saved session have transferred successfully,
   with independent checksum verification against the original backup.
   Pair using the Mac's capture link, never a printed card's identification QR.
3. Open the updated House Control on the awake Vision Pro to complete its final-build
   launch check. Build 3 previously connected with all 68 cards and the accepted pilot;
   that historical sample is not a build-4 runtime check. On iPhone House Control, the
   physical model preview renders; activate the reviewed pilot and confirm Capture Mac
   connection. The scanner's own phone connection and complete transfer are already verified.
4. Check the printed Letter kit's 100 mm ruler before cutting or mounting. Preserve each
   complete card inside its outer cut lines, including labels, QR quiet zones and artwork.
   Mount C001 flat on a fixed building feature in Office / Entrance and record its
   repeatable position. Place the pilot's named cards beside two nearby lamps and one
   other device category; confirm card-to-device offsets during binding. Keep the four
   unassigned device cards aside until they have a device assignment. If reprinting,
   use Actual Size / 100%; pages 1 and 4 contain the ruler and first checkpoint.
5. Confirm the visible card axes and validate three independent building points at
   least 50 cm apart, each with no more than 10 cm error. Card recognition alone cannot
   establish the house origin or authorize anchored actions.
6. Complete the four physical gates in [paired-scanning.md](paired-scanning.md), including
   hallway capture, phone-only/combined comparison, two adjacent lamps plus another
   category, restart/recenter/moved-card recovery, both floors and sustained profiling.

The House Control owner's current installation and hardware evidence is maintained in
the sibling repository's `docs/spatial-implementation-handoff.md`. No actual print-scale,
alignment, device-control readback or whole-loft success is inferred from this report.
