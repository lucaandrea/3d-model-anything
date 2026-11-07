# Local room imports

The development viewer discovers prepared captures in `data/scans/<folder>/`. These folders and original exports in `data/captures-in/` are ignored by Git. The local Vite plugin serves the prepared files on loopback; production builds do not include the local registry, measurements, photos or scan meshes.

Each prepared folder contains:

```text
viewer.json           { "id": "my-room", "label": "My room" }
room.json             bundle_to_room.py output, including worldToRoom and photo poses
scan_room.glb         photo-colored scan in the same room-local coordinates
photos/0000.jpg        upright images in room.json photo order
photos/0001.jpg
...
```

Use lowercase letters, digits and hyphens for the folder and a unique room ID. Create `viewer.json` after conversion succeeds, then reload Safari. Open `http://localhost:5188/?room=my-room&source=scan` or choose the room from the home page's existing-room list.

The **Measured** view is editable geometry generated from RoomPlan walls, openings and furniture bounds. Its wall thickness and colors are schematic. **Scan** shows the photographic LiDAR reference; **Overlay** combines the two; **Layout** shows the measured floor outline. A successful import is not a detailed furniture reconstruction.

For a photo-guided Blender reconstruction, keep the editable `.blend`, textures and modeling scripts in the same ignored capture folder. Export a separate `modeled_room.glb` with glTF's standard Y-up axes matching `room.json`, then add `"model": "modeled_room.glb"` to `viewer.json`. The local viewer will show **Rebuilt** and retain the original Scan/Overlay comparison. The Blender file remains the editable source; procedural material details may be simplified in glTF.

The authored glTF may include these node extras: `capture_wall_index` (number matching a measured wall) for camera cutaways, `capture_ceiling` (true) for overhead geometry, and `capture_item` (true) for separable furniture assemblies. Keep wall-mounted details under the corresponding wall node. The browser batches geometry within visibility groups; it does not merge or modify the Blender source. Neither authored models nor personal reference photos are copied into production builds.

Preserve the original ZIP, bundle and session-to-room transform. If filtering surrounding geometry, use the capture's `inroom` flags, matching the iOS any-corner-in-room rule, and retain an unfiltered copy. Never infer alignment between separate capture sessions from matching room names.

Matched-camera comparisons are available in Safari:

```text
http://localhost:5188/tools/capture.html?room=my-room&src=scan&photo=0&size=480&compare=1
http://localhost:5188/tools/capture.html?room=my-room&src=model&photo=0&size=480&compare=1
```

These preserve the original photo framing, including missing scan areas. Vertex-color coverage measures available photographic color, not room completeness or dimensional accuracy. Browser warnings and errors are forwarded to the local development terminal.
