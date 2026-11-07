# Apple Vision Pro M2 versus iPhone 17 Pro Max for house scanning

Research checked: 27 October 2026. Scope: the original M2 Vision Pro, not the newer M5 model. This is documentation research and inspection of the current capture source; no physical comparison scan was performed.

## Decision

Keep the iPhone 17 Pro Max as the primary capture device for the house. The most promising development direction is a paired workflow: phone capture plus Vision Pro coverage guidance and full-scale review, with supplemental headset geometry considered after validation. The evidence does not establish that Vision Pro alone produces more accurate or more detailed house scans.

The headset has a richer tracking sensor arrangement. That supports an expectation of strong continuous wearer tracking, not a claim of superior exported mesh detail. I found no controlled M2 Vision Pro versus iPhone 17 Pro Max house-scan benchmark, and Apple's specifications do not give a comparable LiDAR accuracy, point-density, or range specification that establishes a winner.

## What the hardware tells us

| Capability | M2 Vision Pro | iPhone 17 Pro Max | Implication |
| --- | --- | --- | --- |
| Tracking hardware | Six world-facing tracking cameras, four IMUs, LiDAR, TrueDepth, and R1 processing | LiDAR, cameras, gyro and accelerometer | Vision Pro is designed around continuous spatial tracking. More sensors do not by themselves establish better surface reconstruction. |
| Reference imagery | Apple specifies 6.5 stereo megapixels for spatial capture | Main camera supports 24MP/48MP photographs | The phone is the stronger candidate for separately captured detailed reference photos. These specifications are not the resolutions of the LiDAR sensors or a guarantee about ARKit frame resolution. |
| Capture position | Head mounted | Handheld | The headset is hands-free; the phone is easier to aim underneath furniture and close to small details. This is a workflow assessment, not a measured accuracy result. |

Sources: [M2 Vision Pro specifications](https://support.apple.com/en-us/117810), [iPhone 17 Pro Max specifications](https://support.apple.com/en-us/125091).

## The app-access distinction matters more than the chip

**Vision Pro can supply geometry to ordinary native apps.** `SceneReconstructionProvider` delivers mesh anchors. `RoomTrackingProvider` supplies room boundaries and room transitions; it updates the room currently occupied. We could implement capture/export from these providers with world-sensing permission, saving geometry and transforms as the wearer visits rooms. A persistent house model, export pipeline, room alignment and drift checks would be our responsibility. This is feasibility inferred from the APIs, not an implemented or tested scanner. [Scene reconstruction](https://developer.apple.com/documentation/arkit/scenereconstructionprovider), [Apple's room-tracking explanation](https://developer.apple.com/videos/play/wwdc2024/10100/).

**RoomPlan is not available on visionOS.** Apple's platform migration documentation explicitly lists it among unavailable frameworks. Room tracking is useful, but does not give our existing iPhone app a drop-in equivalent of its RoomPlan capture and structure-building workflow. A native visionOS capture implementation would be needed. [Apple's platform availability guidance](https://developer.apple.com/documentation/visionos/bringing-your-app-to-visionos/).

**Camera access is a separate constraint.** Current visionOS documentation supports left/right stereo camera frames through `CameraFrameProvider`, but requires the main-camera enterprise entitlement and license. Apple's current rules require organization enrollment and business use; individual enrollment cannot request an enterprise API license. Development-only access exists for eligible teams and still requires approval. The team name alone does not establish enrollment type; this research did not inspect account eligibility. A personal headset and ordinary app signing are insufficient to assume this access. [Main-camera API](https://developer.apple.com/documentation/visionos/accessing-the-main-camera), [current eligibility and licensing rules](https://developer.apple.com/documentation/visionos/building-spatial-experiences-for-business-apps-with-enterprise-apis).

The standard mesh-provider path therefore does not reproduce our phone's geometry-plus-aligned-photo capture. A visible passthrough view is not the same thing as an app receiving the underlying images. Nor should we assume access to the system's full internal map or raw LiDAR sensor output.

## Fit with this repository

The current iPhone capture source records RoomPlan structures, mesh data, photos with camera poses/intrinsics, depth/confidence frames and world maps. `HouseProject` represents separate sessions and zones with transforms into a house frame. This is source-level verification, not a new physical-device acceptance test or confirmation of which version is installed.

Relevant source: [ScanBundle.swift](../apps/house-capture/HouseCapture/ScanBundle.swift), [HouseProject.swift](../apps/house-capture/HouseCapture/HouseProject.swift), [CaptureController.swift](../apps/house-capture/HouseCapture/CaptureController.swift).

For editable Blender reconstruction, the reference photographs are particularly valuable for identifying individual objects and reproducing their appearance. A geometry-only headset scan could add coverage but would not automatically recover small controls, cables, upholstery or hidden surfaces. Combining phone imagery with headset meshes would also require explicit cross-device alignment; their coordinate systems cannot be assumed identical.

## Recommended paired workflow

This is a proposed implementation, not a feature already present in the installed apps.

| Device | Primary role | Data to retain |
| --- | --- | --- |
| iPhone 17 Pro Max | Capture room structure, depth, mesh and detailed reference images | Original photos/depth, camera poses, calibration, RoomPlan output and capture quality |
| M2 Vision Pro | Display the growing model, show missing coverage and inspect it at full scale | Headset pose, alignment checkpoints and optional separately identified scene meshes |
| Mac | Preserve originals, validate alignment, reconstruct and author the final model | Session/zone transforms, provenance, derived meshes and Blender assets |

The simplest first version sends a lightweight phone mesh and coverage updates over the local network to a native visionOS companion. It can initially show a floating miniature, which avoids needing exact alignment with the physical room. Apple's Network framework provides the cross-platform transport building blocks; this repository would still need the pairing, transfer, reconnection and visualization code. [Network framework](https://developer.apple.com/documentation/network).

For an overlay registered to the actual room, give both apps the same printed reference image with a known physical size. Standard ARKit image detection on iPhone and image tracking on visionOS can locate that reference. From the two observed marker poses, estimate a rigid transform between the devices' independent coordinate systems. The transform calculation is our proposed design, not an automatic Apple phone/headset map merge. Check it against additional room features and reacquire checkpoints as the route progresses. Marker detection alone is not a survey-accuracy guarantee. [iPhone image detection](https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/detectionimages), [visionOS image tracking](https://developer.apple.com/documentation/visionos/tracking-images-in-3d-space).

This design does not require the headset's main-camera enterprise entitlement: images come from the phone, while Vision Pro uses ordinary rendering and, for registered overlays or supplemental geometry, standard world-sensing APIs. World-sensing authorization and a suitable immersive app experience are still needed. [ARKit data access](https://developer.apple.com/documentation/visionos/setting-up-access-to-arkit-data/).

The first expected gain is better coverage and feedback: show where the phone lacks views or depth support, guide another pass, and inspect walls/doors/furniture at real scale before leaving the room. Coverage indicators must distinguish observed surfaces from inferred surfaces, and geometry coverage from photo coverage. Do not imply a visually complete mesh has met a measurement tolerance.

Only then consider merging headset geometry. Retain each device's observations separately, verify registration, and fuse only validated regions. Misaligned meshes create doubled walls and blurred furniture. Sending data over Wi-Fi does not establish a spatial alignment, and adding two consumer LiDAR streams does not inherently increase accuracy or range.

The first pilot should compare phone-only capture with paired capture in the same room and hallway. Evaluate completeness, time, dimensions and drift. A successful pilot would justify extending the approach across house zones.

## A useful test before a whole-house commitment

1. Capture the same furnished room and connecting hallway with each device. Keep lighting and furniture fixed and record comparable scan time. Use a geometry-only Vision Pro prototype unless camera access has actually been approved.
2. Measure wall lengths, doorway widths and selected object dimensions independently with a tape or laser measure. Those measurements, rather than either device's mesh, establish the comparison reference.
3. Compare dimension errors, missing surfaces, thin-object detail, door alignment and whether the route closes consistently after returning to the starting doorway. Repeat the scans to distinguish repeatable quality from a lucky pass.
4. Assess geometry separately from texture quality and reference-photo coverage. Do not judge LiDAR accuracy from a polished Blender render or the apparent clarity of passthrough.
5. Adopt Vision Pro for primary geometry only if it shows a repeatable benefit on the properties that matter. Continue using the phone for detail photos where useful. Otherwise use Vision Pro for model review and keep capturing in manageable phone sessions/zones.

No numerical accuracy target is asserted here: acceptable error depends on whether the house model is for visualization, furniture planning or more demanding measurement.

## Evidence that does not settle the comparison

A published Vision Pro study evaluated manual tree-diameter measurements using two apps, not house reconstruction or a head-to-head iPhone 17 Pro Max test. Its reported errors cannot be reused as a room-scanning accuracy guarantee. [Study and limitations](https://www.mdpi.com/2072-4292/17/1/141).

No app port, entitlement request, deployment or new scan was performed as part of this assessment.
