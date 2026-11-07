# Spatial capture contract, version 1

This is the shared contract for 3D Model Anything and House Control. Coordinates are
metres, right-handed, +Y up. Matrices are 16 finite numbers in column-major order;
transforms are rigid, never display scales. Unknown registration is absent, not identity.
Private kit and capture instances are never source-controlled.

## Marker kit (`marker-kit/1`)

`manifest.json` contains `format`, `kitID` (UUID), `revision` (SHA-256 of canonical
marker records), `createdAt` (ISO8601), and `markers`:

```json
{"id":"D001","role":"device","label":"Example lamp","roomID":"example",
 "roomName":"Example room","deviceID":"example.lamp","image":"reference-images/D001.png",
 "imageSHA256":"64 lowercase hex characters","physicalWidthMeters":0.07,
 "physicalHeightMeters":0.07,"url":"housecontrol://marker?v=1&kit=UUID&id=D001"}
```

`role` is `checkpoint`, `device`, or `spare`. Checkpoints C001-C006 are 0.14 m square;
device/spare references are 0.07 m square. `deviceID`, `roomID`, and `roomName` may
be absent. Device IDs are the existing plan IDs, not integration or hardware IDs.
Only the image rectangle is tracked; QR, labels, trim and orientation marks sit outside.
IDs and reference pixels never change when labels or assignments change. New records
append IDs. Retired cards remain identifiable and can be marked `retired: true`.
Generation uses a private persistent registry; regeneration does not create a new kit.
Registry image hashes are locked. A missing replacement regenerates the same artwork;
modified existing pixels reject instead of silently changing the registered reference.

Marker poses use X-right, Y-printed-up, Z-out from the printed face. iOS ARImageAnchor
has the image in its XZ plane: multiply its transform by rotation X(-pi/2) before
recording canonical marker poses. Headset provider conventions must be normalized to
the same frame. This convention is covered by code; physical cross-device verification
remains mandatory before accepting registration.

All printed cards start without a physical pose. A card ID is not a trusted location.
Only an explicitly calibrated fixed checkpoint can contribute to house registration.
Deep links identify a card; they cannot pair, authorize, write a device or change a pose.
Unknown kits/IDs, duplicate/moved cards and stale geometry require explicit recovery.

The scanner saves optional `marker-observations.json` alongside its unchanged v5
manifest. Its `marker-observations/1` envelope identifies `source: iphone`,
`frame: capture-session`, and the canonical `markerFrame`. Each observation contains
kit/marker IDs, session timestamp, `worldFromMarker`, estimated scale, review status,
`verified: false`, and optional `roomIndex`. At most 600 recent observations are retained.
Single-room AirDrop exports filter these by room index; full session exports preserve
between-room evidence too. Neither export promotes observations into verified checkpoints.

## Spatial package (`house-spatial/1`)

A directory (or validated archive) has `manifest.json`, relative model/texture assets,
and optional marker kit. Manifest fields:

- `format`, `houseID`, `name`, `revision`, `createdAt`, `producer`.
- `units: "meters"`, `upAxis: "Y"`, `handedness: "right"`.
- `levels`: `{id,name,elevation}` in metres relative to the house origin.
- `rooms`: `{id,name,levelID,polygon:[[x,z]],floorY,ceilingY,roomToHouse:[16],
  source:{sessionID,roomIndex,worldToRoom:[16]},alignment:{method,residualMeters?,verified}}`.
  Room polygons and floor/ceiling Y are room-local; roomToHouse places them. Import
  measured irregular polygons rather than coercing them into estimated rectangles.
- `assets`: `{id,path,sha256,byteLength,mediaType,roomID?,kind,bounds:{min:[x,y,z],max:[x,y,z]}}`.
  `kind` is `display`, `collision`, or `reference`; mediaType is a real MIME type.
  Asset geometry is room-local when roomID is supplied, otherwise house-local.
  USDZ and GLB representations share an asset id plus a `representation` value
  (`usdz` or `glb`); the unique key is `(id,representation)`.
- `checkpoints`: `{markerID,kitID,houseFromMarker:[16],verifiedAt,
  validationPoints:[{house:[x,y,z],observed:[x,y,z],errorMeters}]}`.
  Empty until physically verified. At least three independent points and <=0.10 m
  error at each are required for accepted registration; detecting the card is not a check point.
- `provenance`: `{sourceFormat,sourcePath?,notes:[string],geometryStatus}`.
  geometryStatus is `measured`, `authored`, or `mixed`. SourcePath stays local/private.
- `markerKit`: optional relative path to the marker-kit manifest.

`revision` is SHA-256 of canonical JSON excluding revision itself. Canonical JSON is
UTF-8, sorted keys, no insignificant whitespace, ASCII escaped strings. Keep float
serialization consistent by computing once in the producer; consumers verify asset
hashes and preserve the supplied manifest bytes/revision rather than re-encoding it.
Unknown future formats reject. Legacy phone captures remain unchanged.
Paths must be relative, contained regular files, without symlinks or `..`; reject
nonfinite matrices, reflections, scaling, missing assets and mismatched hashes.
Activate only after staged validation and user review; preserve previous revision.

House Control owns device placements in a separate store, keyed by stable plan IDs:
`{id,deviceID,roomID,levelID,houseFromDevice:[16],panelOffset:[x,y,z],geometryRevision,
markerID?,kitID?,markerFromDevice:[16]?,verifiedAt?,status}`.
`status` is `unverified`, `verified`, or `needsReview`. Geometry changes require
affected placement review. Platform-local anchor UUIDs/world maps never transfer as
if portable. Raw sensor observations stay separate from accepted geometry.

## Capture-only Mac channel (`house-capture-link/1`)

Separate Network.framework listener, Bonjour `_housecapture._tcp`, separate random
32-byte PSK from ordinary House Control sync. Pairing link:
`housecapture://pair?v=1&id=UUID&name=HOST&key=BASE64URL`.
Keychain storage on clients. Do not print or log pairing links. No integration
credentials, command RPC or arbitrary filesystem access exists on this listener.
TLS 1.2 PSK AES-128-GCM-SHA256, derive the PSK as
`HMAC-SHA256(key: pairingKey, message: "House Capture v1")`; identity hint `housecapture`.
This reuses the existing House Control TLS PSK technique, with domain separation.
Disable TLS session resumption and tickets: a changed/revoked pairing must prove its
own PSK and cannot inherit a cached handshake from another pairing.

Frames: four-byte big-endian payload length, then UTF-8 JSON, maximum 1 MiB.
Requests `{id:UUID,op:string,...}`; responses `{id,ok:true,...}` or
`{id,ok:false,error:string}`. One in-flight upload chunk per client, 30 s request
timeout. Serialize requests on each connection; coalesce previews while a transfer
or kit download runs. Unknown ops reject. File chunks <=131072 bytes before base64 encoding.

Operations:

- `catalog` -> `{protocol:"house-capture-link/1",hostName,kit?:MarkerKit,
  assets:[{id,path,byteLength,sha256}]}`. Assets contain only approved kit files;
  asset id is the reference image path in its kit. No plan credentials.
- `asset.get {assetID,offset,length}` -> `{offset,data:base64,eof}` with bounded reads.
- `capture.begin {captureID:UUID,houseID,zoneID,sessionID,source:"iphone"|"visionPro",
  files:[{path,byteLength,sha256}]}` -> `{captureID}`. Resume only identical descriptors.
  Server-generated staging directories, max 10,000 files / 20 GiB per capture.
- `capture.status {captureID}` -> `{files:[{path,receivedBytes}],complete:Bool}`.
- `capture.put {captureID,path,offset,data:base64}` -> `{receivedBytes}`. Require
  contiguous offsets; allow identical already-received chunks, reject differing retries.
- `capture.finish {captureID}` -> `{captureID,complete:true}` only after size/hash
  verification and atomic finalization. An interrupted capture remains resumable.
- `preview {captureID,sequence,roomName,tracking,photoCount,depthFrameCount,
  photoCoverage?:number,alignmentVerified:Bool,vertices?:[[x,y,z]],triangles?:[int]}`
  -> `{accepted:true}`. Maximum 2 Hz, 5,000 vertices/15,000 indices, coalesce updates;
  latest only, display stale after five seconds. Provisional only: cannot move accepted
  geometry or device controls. Preview coordinates are current capture-session space.
- `preview.latest {captureID?:UUID}` -> `{preview?:<original preview fields>,
  receivedAt?:ISO8601,stale:Bool}`. Latest state only, stale after five seconds;
  previews may precede capture.begin because the file descriptor list is not final
  during live capture. Bound retained previews to four capture IDs per paired peer.
- `spatial.catalog` -> `{manifest?:SpatialManifest,manifestAsset?:{id,byteLength,sha256}}` for the Mac's explicitly accepted
  active geometry revision. `asset.get` also accepts
  `spatial/<revision>/<manifest-asset-path>` for that revision's allowlisted assets.
  This never exposes arbitrary paths or activates geometry on a receiving client.
  When present, `manifestAsset.id` is exactly `spatial/<revision>/manifest.json`;
  retrieve these hash-checked original bytes rather than re-encoding catalog JSON.
  Re-encoding can change bytes under an existing revision after an AirDrop import.
  Receivers stage, hash-check and preview before adopting a revision. Empty catalog
  is valid when no spatial package has been accepted on the Mac.

For the scanner, upload each finalized legacy session unchanged. CaptureID is a
persisted UUID keyed by house/session identity, independent of sandbox relocation;
completion receipts are persisted locally.
The headset uses separate `vision-capture/1` observations containing original mesh
anchors, transforms, timestamps and registration evidence. No automatic fusion.
Network loss must not stop original capture or cause unbounded queued frames.

## Implementation ownership

Scanner chat owns this contract, marker generator, Python exporter, iPhone scanner
client/calibration/object-detail UI, and private pilot assets. House Control chat owns
the Mac listener and capture pairing UI, native imports, marker routes, placement store,
visionOS capture / Around Me and iPhone Around Me. Both sides test against this contract.
