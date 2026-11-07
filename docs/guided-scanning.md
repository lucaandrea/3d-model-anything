# Guided capture

The installed loft workflow now uses [floor structure first, then room details](floor-scanning.md).
The older room route below remains supported for existing projects.

The iPhone home screen offers a guided route when a private `Documents/ScanRoute.json`
configuration is installed. Each step names a space, floor, door state, overlapping
building features, optional checkpoints and mirror reference labels. Personalized
routes and guides live under ignored `output/guide/` and are not app-bundle resources.

## Capture and transfer

1. Open the route and read the next space's preparation and overlap instructions.
2. For a room with mirrors, record whether the reflective faces are covered. This
   declaration is not a depth filter or a verification of the physical preparation.
3. Scan the named space, save the room, review it, and choose **Save space and finish**.
4. Choose **Return to route and upload**, then **Upload this space to Mac**.
5. A checksum-verified receipt unlocks the next route step. Reconnecting to an already
   completed transfer also restores its local receipt. Failed uploads stay pending.

AirDrop exports the entire finished session ZIP, including route evidence. The user
can explicitly confirm reception on the Mac; that confirmation is distinguished from
a network checksum receipt. **Continue offline · upload later** is an explicit override
which leaves an upload-due status. Optional steps can be postponed and restored to the
route. Progress survives app restart and uses stable route/step/session identities.

Each space starts in its own session/zone. Sequence and adjacency never set a house
transform, create a doorway, or prove alignment. Include repeated real openings and
fixed corners across passes. Open-plan areas do not require a fictional doorway.
Measured registration remains a separate reconstruction/calibration step.

## Reflective surfaces and changing door positions

Use spare cards as identification labels beside mirrors. Keep their artwork and
physical dimensions unchanged. The cards remain unassigned in the original marker
kit; route metadata associates them with reflective-surface notes, not hardware or
fixed house checkpoints. **Details & cards → Mirror references** selects one of these
cards for observation alongside the existing checkpoint references.

A small label does not prevent reflected room geometry. For the structural pass,
cover the reflective face with flat, opaque matte material, keeping frame edges
visible. Keep it still throughout capture. After saving, uncover it for separate
reference photographs and record mirror dimensions and height above the floor.
Uncovered structural captures require geometry review and may need correction.
Apple identifies full-height mirrors and glass as a LiDAR challenge in its
[RoomPlan presentation](https://developer.apple.com/videos/play/wwdc2022/10127/).

Capture closed closet fronts as part of the surrounding room. Save that pass before
opening the doors, then capture the accessible interior in a separate pass with the
doors fully open and stationary. Preserve both states as separate evidence.

## Additive export contract

`house-project/1` and `house-capture/5` remain unchanged. A finished guided session
includes `route-step.json`, format `guided-capture/1`, with:

- route/step IDs, sequence, previous planned step, floor and instructions;
- house/session/zone IDs, door state and overlap guidance;
- mirror labels, card IDs and the user's preparation declaration;
- `alignmentVerified: false`, `automaticReflectionRemoval: false`, and a reflection
  review flag when applicable.

The context is written before capture and transferred without edits. Room-scoped
exports retain it. The Mac inbox preserves this as evidence; it does not convert
these declarations into accepted geometry, device bindings or exclusions.

## Starting fresh and recovery

An empty RoomPlan result is not a completed space, even if the framework successfully
writes JSON and USDZ files. The scanner keeps failed-attempt evidence without adding
a measured room, and the route also excludes older saved entries with no surfaces or
triangle mesh. Partial measured geometry is retained for review.

If tracking has never initialized after 12 seconds, the capture screen offers an
explicit startup warning and an action to end the attempt. Check the rear-camera
picture in Apple's Camera app. Keep Device Hub's live phone-screen viewer closed:
on the attended iPhone test, closing it restored camera tracking and LiDAR after
both the scanner and Apple Camera had shown black output. If Camera remains black,
restart the phone and verify
the picture there before retrying the same space. A successful launch or a green
camera indicator alone does not establish a functioning capture.

**Scan library and archives → Clear all active scans** moves `Houses` and route progress
into a recoverable collection under `Documents/ScanArchives`. The operation hashes
every file before moving it, handles canonical iOS sandbox paths, and preserves the
matching marker kit and Keychain pairing. A Mac backup should also be retained.

Restore validates checksums and refuses conflicting house IDs before moving anything.
Restored houses do not overwrite the current route's progress. A reset empties the
active library; it does not reclaim the disk space occupied by the recovery archive.

## Validation

The app self-tests cover route/configuration round trips, duplicate identities,
finished/empty/interrupted session gates, receipt versus explicit deferral, optional
steps, provisional mirror semantics, aliased sandbox paths, archive reset/restore,
checksum rejection, and preservation of the printed kit. The integration harness
checks exact-byte route/mirror transfer against House Control in an isolated inbox.
Actual room capture, mirror preparation, overlap quality and physical registration
still require an attended pilot; these cannot be validated by a software test.
