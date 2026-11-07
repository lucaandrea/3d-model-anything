# Floor structure, then object details

The private `ScanRoute.json` lists ground-floor structure, a separate stairs connector,
upstairs structure and the room-by-room object/detail route. Each reviewed floor
unlocks its own detail rooms; the user may choose details or the next structural pass. Personal room names, mirror
assignments and guides remain in ignored output files and the phone's Documents.
Legacy `scan-route/1` routes without phases retain their original behavior.

## User flow

1. Walk the whole ground floor while one ARSession stays active. The app automatically
   saves a RoomPlan section after 120 seconds of stable tracking with measured walls.
   Pause walking during the checkpoint save; the next section starts automatically.
2. Finish the floor. Inspect its 3D capture and confirm the area checklist, boundaries,
   doorways/open transitions and absence of reflected false rooms.
3. Upload every saved part, confirm AirDrop reception explicitly, or defer upload to
   continue offline. Original capture files stay on the phone.
4. Choose details for this reviewed floor, or capture the stairs with lower and upper
   landing overlap, then start upstairs as a separate floor pass.
5. Detail captures retain named photographic views and the red/green observed-mesh
   overlay. Reviewed room guides additionally provide bounded room recognition and
   persistent known-target coverage; see [room detail guidance](room-detail-guidance.md).

The structure pass uses cyan mesh and no photo-completion ring. It continues recording
reference photos automatically, but photo coverage does not gate structural completion.
The two floors have independent coordinate frames; capture order does not align them.
Cards remain observations, not automatic acceptance of a house origin.

## What confirmation means

`FloorStructureEvidence` checks for finished captures, readable indexes, at least four
wall observations (not necessarily distinct walls), triangle mesh, depth frames, a
successfully merged structure and a consistent zone frame. A recorded tracking jump
during active capture blocks confirmation. Repeated camera observations cannot prove
that an unseen room is complete, so the user's explicit area and geometry review is
required as well. This is capture readiness, not a guarantee of dimensions, calibrated
floor alignment, accepted `house-spatial/1` geometry, or a finished Blender model.

`structure-review.json`, format `floor-structure-review/1`, binds that review to the
house, step, session IDs and SHA-256 hashes of their final manifests. It records the
reviewed areas, boundaries, openings and reflections, date and `alignmentVerified: false`.
An added or replaced capture invalidates an older review. Finished original captures can be uploaded for Mac reconstruction even when their
alignment requires repair. Open/incomplete sessions cannot upload. A transfer receipt
never substitutes for structure review or unlocks an unreviewed floor.

`route-step.json` retains `guided-capture/1` with additive `phase`, `floorID` and
`attemptID` fields. Its step also has optional `phase`, `floorID` and `areas`. Existing
`house-project/1` and `house-capture/5` formats remain unchanged. Room-scoped exports
do not carry a floor-wide completion review.

## Recovery and limits

The RoomPlan section stop uses `pauseARSession: false`. Automatic section restart is
suppressed after an error, failed file save, or safety limit. The floor is limited to
12 sections per session. Floor captures pause at a saved checkpoint when their map
reaches 128 MB or iOS reports memory pressure; the legacy 40 MB room cutoff does not
end a floor scan. Reloading a floor map is bounded at 256 MB, leaving room to resume
a checkpoint that crossed the pause budget. The pause is not floor completion.
A warm phone continues to reduce capture rate using the existing thermal/memory budget.

The library groups checkpoint rooms and continuation sessions by route, floor step
and attempt ID. Originals keep their IDs and paths. Both house-level Continue and
older checkpoint-level Continue reopen the floor workflow, preserving structure mode,
the attempt and the zone. A fresh attempt remains a separate group.

A floor continuation loads the same zone's saved ARWorldMap and verifies the live
mesh match. It never silently allocates a new zone because of the legacy four-room
limit. Missing or oversized maps give a clear error; starting a fresh floor attempt
keeps earlier files in a separate attempt. Unaligned continuation cannot pass review.

After an app termination, **Recover saved checkpoints** rebuilds only completed
RoomPlan sections from their stored JSON and closes the interrupted session. The
unfinished tail is not invented. Empty attempts require a fresh attempt. Additional
sections require a new review. Detail captures do not overwrite the reviewed floor's
merged structural model.

Keep Device Hub and phone mirroring closed during camera capture. The earlier attended
camera test established that mirroring could block both ARKit and Apple's Camera app.

## Validation

The iPhone app self-tests include usable versus empty/interrupted structure, missing
depth, failed merging, tracking jumps, unaligned continuations, incomplete physical
area review, replacement/additional session invalidation, phase ordering, checkpoint
pause/tracking guards, and prevention of saved-library upload bypasses. The baseline
suite plus floor cases passed 189 checks in the simulator.

The attended `-autotest-floor` debug path uses 20-second checkpoints solely to exercise
two save/restart transitions promptly. Production floor capture uses 120 seconds.
A short physical checkpoint test is not full-floor completeness, sustained thermal
qualification, printed-card recognition, or cross-floor alignment acceptance.

Apple's underlying workflow uses continuous ARSession or measured relocalization:
https://developer.apple.com/documentation/roomplan/scanning-the-rooms-of-a-single-structure

## Attended iPhone check · 27 October 2026

The signed development build was installed under Luca Andrea Collins team
`9FNNQ6J269`. The physical iPhone 17 Pro Max saved two automatic checkpoints,
resumed capture after each and finished with a merged three-section structure,
11 photographs, 96 depth frames and no recorded world jumps. This was a short
one-room diagnostic with a 20-second interval, not whole-floor coverage validation.
All 321 resulting files (40,060,825 bytes) matched their phone SHA-256 inventory
in the private Mac backup, then were moved into a recoverable phone archive.
The active route was returned to the fresh ground-floor step; the kit and pairing
were preserved.

## Ground-floor continuation regression (27 October)

The user's six-minute capture ended at the third automatic checkpoint when its map
reached 54,390,201 bytes. All three RoomPlan sections, 197 photos, depth frames and
meshes were saved; the log recorded no world jumps or memory warnings. The old 40 MB
cutoff caused the stop, and generic Continue lost the guided context.

A private Mac backup matched all 4,591 phone inventory SHA-256 entries. On the physical
iPhone, the revised map loader plus saved-mesh verification data loaded in 2.15 seconds
at a sampled 317 MB process footprint: 24,790 feature points and 690,871 reference
vertices, with no reference/evidence errors. This is read-only recovery evidence;
the user subsequently confirmed live relocalization reached **Resume floor structure**
near the kitchen/dining transition. Sustained walking remains a separate check. The simulator suite
passes 202/202 checks, including floor grouping, continuation routing and bounded map
policies. Use `-check-floor-recovery` in Debug for this read-only probe; it never runs AR.

After installation, all 4,588 original session files were recopied from the phone and
compared byte-for-byte with the verified backup; no mismatch was found. The active
continuation was left running, and the Mac capture receiver stayed available.

## Post-configuration frame continuity

The initial relocalization result can become stale when a later AR configuration changes
the coordinate frame. Marker references now enter the controller-owned configuration
before verification, rather than rerunning ARSession from view polling. A resumed capture
requires three stable geometry checks after RoomPlan starts. Persistent mismatch invalidates
alignment and stops recording; legacy alignment-drift diagnostics also block raw floor review.
Mac reconstruction can issue a separate, source-hash-bound corrected-model review without
rewriting original captures or claiming physical accuracy.

## Interrupted upstairs recovery (27 October)

A camera interruption can re-express RoomPlan geometry even when the pre-stop LiDAR
mesh still has its original coordinates. Stop and preserve the active section on an
AR interruption; flag its alignment for Mac review and prevent post-interruption
frames from entering the accepted mesh. Every automatic checkpoint reloads its own
saved mesh as the continuation reference and requires a new stable match after
RoomPlan starts. Older asynchronous checks cannot authorize a newer section.

`reviews/capture-route-review.json` (`capture-route-review/1`) can correct a floor
label after Mac review without editing the original `route-step.json`, manifest,
zone or alignment. Each entry binds the session, old/new route step and attempt to
SHA-256 hashes of both original files. Changed files, duplicate entries, wrong
house/route and non-structural destinations are rejected. A label correction does
not accept geometry; a matching `floor-mac-review/1` receipt remains required.

The updated simulator suite passed 236 checks. The signed development build's
read-only physical-phone check verified three logical floor groups, matching Mac
reviews for ground/stairs/upstairs, and both immutable detail guides (five downstairs
rooms/697 targets and two upstairs rooms/384 targets). The next route step is room
details. The new interruption/checkpoint behavior and upstairs localization still
require an attended live-camera walking test; these file and simulator checks do
not establish independent physical alignment.
