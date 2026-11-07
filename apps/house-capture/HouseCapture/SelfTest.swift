import ARKit
import CaptureLink
import SwiftUI
import simd

/// Launch with `-selftest` (works in the simulator): exercises everything of a multi-day
/// house that doesn't need the camera (house.json round trips, session folders, room history,
/// session deletion, the saved-mesh ghost + alignment check, earlier-photo loading, manifests,
/// zipping), prints `SELFTEST:` lines and exits 0 (all passed) or 1.
struct SelfTestView: View {
  @State private var lines: [String] = []
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(Array(lines.enumerated()), id: \.offset) { _, l in Text(l).font(.system(size: 10, design: .monospaced)) }
      }
      .padding()
    }
    .task {
      let runner = SelfTest { lines.append($0) }
      let ok = await runner.run()
      try? await Task.sleep(for: .milliseconds(300))
      exit(ok ? 0 : 1)
    }
  }
}

@MainActor
final class SelfTest {
  private let output: (String) -> Void
  private var passed = 0
  private var failed = 0

  init(output: @escaping (String) -> Void) { self.output = output }

  private func log(_ s: String) {
    print("SELFTEST: \(s)")
    output(s)
  }

  private func expect(_ ok: Bool, _ what: String) {
    if ok { passed += 1; log("ok   \(what)") } else { failed += 1; log("FAIL \(what)") }
  }

  private func roomExperience() throws {
    expect(!CaptureQuality(percent: 99, walls: 0, photos: 0).ready, "finish signal requires measured room and photos")
    expect(CaptureQuality(percent: 88, walls: 4, photos: 20).ready, "finish signal accepts sufficient coverage")
    let observed = CoverageEngine.Stats(meshCovered: 0.82601947, meshArea: 20, targetsCovered: 0.1, ceilingCovered: 0, floorCovered: 0)
    expect(observed.percent == 83, "room photo detail ignores inferred hidden surfaces and ceiling penalty")
    expect(CoverageEngine.Stats(meshCovered: 1, meshArea: 0, targetsCovered: 1).percent == 0, "no observed mesh cannot report photo detail")
    expect(!CaptureQuality(percent: 40, walls: 4, photos: 156).ready, "many photos do not hide poor observed detail")
    expect(CaptureQuality(percent: 88, walls: 4, photos: 20).ready, "finish suggestion does not require inferred floor or ceiling coverage")
    let legacy = try JSONDecoder().decode(RoomRecord.self, from: Data(#"{"index":0,"name":"Play room","file":"room.json","usdz":"room.usdz","capturedAt":0,"walls":15,"doors":4,"windows":0,"openings":0,"objects":16,"coverage":0.82601947,"photoCoverage":53}"#.utf8))
    expect(legacy.photographedPercent == 83, "saved scans use measured coverage instead of legacy mixed percentage")
    expect(legacy.hasMeasuredGeometry, "legacy measured room remains usable")
    var emptyRoom = legacy
    emptyRoom.walls = 0; emptyRoom.doors = 0; emptyRoom.windows = 0; emptyRoom.openings = 0; emptyRoom.objects = 0
    expect(!emptyRoom.hasMeasuredGeometry, "empty RoomPlan JSON and USDZ paths cannot count as a captured room")
    emptyRoom.detailPhotos = 12
    expect(!emptyRoom.hasMeasuredGeometry, "reference photos alone cannot complete structural scanning")
    expect(emptyRoom.hasDetailEvidence, "photo-only detail passes remain saveable and uploadable without claiming geometry")
    var noEvidence = emptyRoom; noEvidence.detailPhotos = 0
    expect(!noEvidence.hasDetailEvidence, "empty detail pass cannot count as saved reference evidence")
    emptyRoom.mesh = .init(file: "mesh.ply", anchors: 1, vertices: 3, faces: 0)
    expect(!emptyRoom.hasMeasuredGeometry, "vertices without mesh faces cannot complete a room")
    emptyRoom.mesh?.faces = 1
    expect(emptyRoom.hasMeasuredGeometry && !emptyRoom.hasRoomPlanGeometry, "partial LiDAR geometry remains usable without RoomPlan surfaces")
    expect(CaptureBudget(thermal: .serious, photos: 2, memoryPressure: false).depthInterval > 0.2, "warm phone reduces depth rate")
    expect(CaptureBudget(thermal: .nominal, photos: 2, memoryPressure: true).constrained, "memory pressure reduces capture work")
    var h = try HouseProject.create(name: "Experience selftest")
    defer { try? FileManager.default.removeItem(at: h.url) }
    let z = h.addZone(named: "test")
    h.beginSession(id: "fixture", zone: z.id, alignment: .init(method: "first"))
    let original = h.recordRoomScan(name: "Office", session: "fixture", index: 0, capturedAt: Date(), matchName: false)!
    _ = h.recordRoomScan(name: "Office", session: "fixture", index: 1, capturedAt: Date(), matchName: false)
    try h.save()
    expect(h.rooms.count == 2, "same-name rooms stay separate when selected by identity")
    try HouseProject.renameRoom(houseID: h.id, roomID: original.id, name: "Studio")
    h = try HouseProject.load(id: h.id)
    _ = h.recordRoomScan(name: "Studio", session: "fixture", index: 2, capturedAt: Date(), roomID: original.id, matchName: false)
    try h.save()
    expect(h.rooms.first { $0.id == original.id }?.history.count == 2, "rescan retains identity after rename")
    try HouseProject.moveRoomToTrash(houseID: h.id, roomID: original.id)
    h = try HouseProject.load(id: h.id)
    expect(h.rooms.count == 1 && h.deletedRooms.count == 1, "soft deletion hides only selected room")
    try HouseProject.restoreRoom(houseID: h.id, roomID: original.id)
    h = try HouseProject.load(id: h.id)
    expect(h.rooms.count == 2 && h.deletedRooms.isEmpty && h.rooms.first { $0.id == original.id }?.history.count == 2, "restore preserves identity and scan history")
    let current = h.rooms.first { $0.id == original.id }!
    try HouseProject.deleteScan(houseID: h.id, roomID: original.id, ref: current.active!)
    h = try HouseProject.load(id: h.id)
    expect(h.rooms.first { $0.id == original.id }?.active?.index == 0 && h.deletedRooms.count == 1, "deleting active version restores previous version and remains recoverable")
  }

  private func floorWorkflow() throws {
    let previousRouteState = try? Data(contentsOf: GuidedRoute.stateURL)
    defer {
      if let previousRouteState { try? previousRouteState.write(to: GuidedRoute.stateURL, options: .atomic) }
      else { try? FileManager.default.removeItem(at: GuidedRoute.stateURL) }
    }
    var step = GuidedRoute.Step(id: "ground", title: "Ground floor", floor: "Ground", instructions: "Walk the floor",
      overlap: "Doorways", doorState: "Still", checkpoints: [], mirrors: [], optional: false)
    step.phase = "structure"; step.floorID = "ground"; step.areas = ["Hall", "Living"]
    let session = HouseProject.Session(id: "floor-part", zone: "ground-zone", startedAt: Date(), endedAt: Date(), alignment: .init(method: "first"), rooms: [0])
    let room = RoomRecord(index: 0, name: "Section", file: "room.json", usdz: "room.usdz", capturedAt: Date(), walls: 4, doors: 1, windows: 1, openings: 1, objects: 0, mesh: .init(file: "mesh.ply", anchors: 1, vertices: 30, faces: 10))
    let manifest = Manifest(createdAt: Date(), device: "fixture", systemVersion: "test", house: "test-house", session: session.id, zone: session.zone,
      endedAt: Date(), rooms: [room], structure: "structure.json", photos: "photos/photos.json", photoCount: 0, depthFrameCount: 2)
    let evidence = FloorStructureEvidence.evaluate(sessions: [session], manifests: [manifest], signatures: [session.id: "hash"], depthFrames: 2, merged: true, trackingDiscontinuity: false)
    expect(evidence.usable, "structure data checks do not require object photos or photo coverage")
    expect(!FloorStructureEvidence.evaluate(sessions: [], manifests: [], signatures: [:], depthFrames: 0, merged: false, trackingDiscontinuity: false).usable, "empty floor cannot pass structure checks")
    var interrupted = session; interrupted.endedAt = nil
    expect(!FloorStructureEvidence.evaluate(sessions: [interrupted], manifests: [manifest], signatures: [session.id: "hash"], depthFrames: 2, merged: true, trackingDiscontinuity: false).usable, "interrupted floor cannot pass checks")
    var misplaced = session; misplaced.alignment = .init(method: "unaligned")
    expect(!FloorStructureEvidence.evaluate(sessions: [misplaced], manifests: [manifest], signatures: [session.id: "hash"], depthFrames: 2, merged: true, trackingDiscontinuity: false).usable, "unaligned continuation cannot confirm a floor")
    expect(!FloorStructureEvidence.evaluate(sessions: [session], manifests: [manifest], signatures: [session.id: "hash"], depthFrames: 2, merged: false, trackingDiscontinuity: false).usable, "failed merge cannot confirm a floor")
    expect(!FloorStructureEvidence.evaluate(sessions: [session], manifests: [manifest], signatures: [session.id: "hash"], depthFrames: 2, merged: true, trackingDiscontinuity: true).usable, "tracking jump blocks confirmation")
    expect(!FloorStructureEvidence.evaluate(sessions: [session], manifests: [manifest], signatures: [session.id: "hash"], depthFrames: 0, merged: true, trackingDiscontinuity: false).usable, "missing depth cannot pass structure checks")
    var review = FloorStructureReview(routeID: "test-route", stepID: step.id, houseID: "test-house", sessionIDs: [session.id], captureSignatures: evidence.signatures, reviewedAreas: ["Hall"], boundariesReviewed: true, openingsReviewed: true, reflectionsReviewed: true, reviewedAt: Date())
    expect(!review.matches(routeID: "test-route", step: step, houseID: "test-house", evidence: evidence), "all physical areas need explicit review")
    review.reviewedAreas.insert("Living")
    expect(review.matches(routeID: "test-route", step: step, houseID: "test-house", evidence: evidence), "complete review unlocks usable structure")
    var changed = evidence; changed.signatures[session.id] = "replacement"
    expect(!review.matches(routeID: "test-route", step: step, houseID: "test-house", evidence: changed), "replacement capture invalidates prior floor review")
    changed = evidence; changed.sessionIDs.append("new-part")
    expect(!review.matches(routeID: "test-route", step: step, houseID: "test-house", evidence: changed), "a continuation requires a new whole-floor review")
    review.reflectionsReviewed = false
    expect(!review.matches(routeID: "test-route", step: step, houseID: "test-house", evidence: evidence), "unreviewed reflections block structure confirmation")
    expect(FloorCapturePolicy.checkpointDue(elapsed: 120, tracking: true, paused: false, walls: 1), "floor checkpoints due after bounded stable capture")
    expect(!FloorCapturePolicy.checkpointDue(elapsed: 120, tracking: false, paused: false, walls: 4), "lost tracking never triggers automatic checkpoint restart")
    expect(!FloorCapturePolicy.checkpointDue(elapsed: 120, tracking: true, paused: true, walls: 4), "pause does not trigger automatic checkpoint")
    expect(!FloorCapturePolicy.checkpointDue(elapsed: 120, tracking: true, paused: false, walls: 0), "empty capture cannot trigger checkpoint loop")
    expect(FloorCapturePolicy.acceptsResumeMap(bytes: 54_390_201), "real six-minute floor map can resume above legacy 40 MB cutoff")
    expect(!FloorCapturePolicy.shouldPause(sections: 3, mapBytes: 54_390_201, memoryWarning: false), "third checkpoint does not end a healthy floor capture")
    expect(FloorCapturePolicy.shouldPause(sections: 3, mapBytes: 128_000_000, memoryWarning: false), "floor map pause budget remains bounded")
    expect(FloorCapturePolicy.shouldPause(sections: 3, mapBytes: 54_390_201, memoryWarning: true), "real memory pressure pauses after saved checkpoint")
    expect(FloorCapturePolicy.shouldPause(sections: 12, mapBytes: 1, memoryWarning: false), "long floor session pauses at checkpoint count budget")
    expect(!FloorCapturePolicy.acceptsResumeMap(bytes: 0) && !FloorCapturePolicy.acceptsResumeMap(bytes: 256_000_001), "empty and oversized maps cannot be loaded")
    var detail = step; detail.id = "hall-detail"; detail.phase = "details"; detail.areas = nil
    var route = GuidedRoute(id: "test-route", title: "Test floors", steps: [step, detail])
    try route.validate()
    expect(try JSONDecoder().decode(GuidedRoute.self, from: JSONEncoder().encode(route)) == route, "floor route round-trips phases and physical area checklist")
    route.steps = [detail, step]
    do { try route.validate(); expect(false, "details cannot precede a floor structure step") } catch { expect(true, "details cannot precede a floor structure step") }
    var h = try HouseProject.create(name: "Floor workflow selftest")
    defer { try? FileManager.default.removeItem(at: h.url) }
    let zone = h.addZone(named: "floor")
    h.beginSession(id: "pending", zone: zone.id, alignment: .init(method: "first")); try h.save()
    let bundle = try ScanBundle.create(in: h, id: "pending")
    let ctx = GuidedCaptureContext(routeID: route.id, step: step, sequence: 1, houseID: h.id, sessionID: "pending", zoneID: zone.id,
      mirrorPreparation: "covered-matte", reflectiveGeometryNeedsReview: false, phase: "structure", floorID: "ground", attemptID: "attempt")
    try ctx.save(in: bundle.url)
    expect(!FloorStructureReview.permitsUpload(house: h, session: h.sessions[0]), "incomplete session cannot freeze an upload package")
    for i in 0..<3 { _ = h.recordRoomScan(name: "Section \(i + 1)", session: "pending", index: i, capturedAt: Date(), matchName: false) }
    try h.save()
    let groups = FloorScanLibrary.groups(in: h)
    expect(groups.count == 1 && groups[0].checkpointCount == 3 && groups[0].roomIDs.count == 3, "three automatic checkpoints appear as one logical floor without changing originals")
    expect(FloorScanLibrary.summary(house: h, groups: groups) == "1 floor capture · 3 checkpoints", "floor library does not call checkpoints separate rooms")
    expect(FloorScanLibrary.continuation(house: h, roomID: h.rooms[1].id, zoneID: zone.id)?.attemptID == "attempt", "legacy checkpoint Continue restores its floor attempt")
    expect(FloorScanLibrary.continuation(house: h, roomID: nil, zoneID: zone.id)?.step.isStructure == true, "house Continue routes to floor mode")
    h.beginSession(id: "resumed", zone: zone.id, alignment: .init(method: "relocalized"))
    let resumed = try ScanBundle.create(in: h, id: "resumed")
    var next = ctx; next.sessionID = "resumed"; try next.save(in: resumed.url)
    _ = h.recordRoomScan(name: "Section 4", session: "resumed", index: 0, capturedAt: Date(), matchName: false)
    try h.save()
    expect(FloorScanLibrary.groups(in: h).count == 1 && FloorScanLibrary.groups(in: h)[0].checkpointCount == 4, "continuation sessions stay in the same floor group")
    next.attemptID = "fresh-attempt"; try next.save(in: resumed.url)
    expect(FloorScanLibrary.groups(in: h).count == 2, "fresh attempts remain separate and retain earlier checkpoints")
    next.houseID = "wrong-house"; try next.save(in: resumed.url)
    expect(FloorScanLibrary.groups(in: h).count == 1 && FloorScanLibrary.groups(in: h)[0].checkpointCount == 3, "mismatched context cannot take over a floor")
    let model = GuidedRouteModel(); model.route = route; model.state = .init(routeID: route.id); model.house = h
    model.sessions = [step.id: session]; model.floorCaptures = [step.id: [session]]; model.floorEvidence = [step.id: evidence]
    expect(!model.completed(step) && !model.detailsUnlocked, "saved measurements alone do not unlock details")
    var gate = AlignmentContinuity(); gate.beginConfirmation(required: true)
    for _ in 0..<2 { gate.observe(known: 100, matches: true, mismatch: false) }
    expect(gate.awaitingConfirmation, "two post-configuration matches cannot start capture")
    gate.observe(known: 100, matches: true, mismatch: false)
    expect(!gate.awaitingConfirmation && !gate.invalidated, "three stable post-configuration matches authorize capture")
    for _ in 0..<3 { gate.observe(known: 100, matches: false, mismatch: true) }
    expect(gate.invalidated, "persistent live frame mismatch invalidates earlier relocalization")
    gate.observe(known: 100, matches: true, mismatch: false)
    expect(gate.invalidated, "invalidated alignment cannot silently recover in the same capture")
    var connector = step; connector.id = "stairs-structure"; connector.phase = "connector"
    try GuidedRoute(id: "test-route", title: "Floors and stairs", steps: [step,connector,detail]).validate()
    expect(connector.isStructure && connector.isConnector, "stairs preserve structural checkpointing and a separate route identity")
    var stairManifest = manifest; stairManifest.rooms[0].walls = 0
    expect(FloorStructureEvidence.evaluate(sessions: [session], manifests: [stairManifest], signatures: [session.id: "hash"], depthFrames: 2, merged: false, trackingDiscontinuity: false, isConnector: true).usable, "stairs retain usable mesh and depth without requiring a flat RoomPlan floor merge")
    expect(!FloorStructureEvidence.evaluate(sessions: [session], manifests: [stairManifest], signatures: [session.id: "hash"], depthFrames: 2, merged: false, trackingDiscontinuity: false).usable, "connector rules do not weaken normal floor evidence")
    let hash = String(repeating: "a", count: 64)
    let correctedRoute = GuidedRoute(id: ctx.routeID, title: "Reviewed floors", steps: [connector, step, detail])
    let entry = CaptureRouteReview.Entry(sessionID: ctx.sessionID, originalStepID: ctx.step.id, stepID: connector.id, attemptID: "reviewed-attempt", manifestSHA256: hash, contextSHA256: hash, reason: "Geometry and photographs reviewed on Mac")
    var correction = CaptureRouteReview(format: "capture-route-review/1", houseID: ctx.houseID, routeID: ctx.routeID, entries: [entry])
    let resolved = correction.resolve(ctx, route: correctedRoute, manifestHash: hash, contextHash: hash)
    expect(resolved?.step.id == connector.id && resolved?.zoneID == ctx.zoneID && resolved?.alignmentVerified == false, "reviewed label correction preserves the original coordinate frame and calibration status")
    expect(correction.resolve(ctx, route: correctedRoute, manifestHash: String(repeating: "b", count: 64), contextHash: hash) == nil, "changed capture cannot reuse a Mac route correction")
    expect(correction.resolve(ctx, route: correctedRoute, manifestHash: hash, contextHash: String(repeating: "b", count: 64)) == nil, "changed original route invalidates its correction")
    correction.entries.append(entry)
    expect(correction.resolve(ctx, route: correctedRoute, manifestHash: hash, contextHash: hash) == nil, "duplicate route corrections cannot silently choose an assignment")
    gate.beginConfirmation(required: true)
    expect(gate.awaitingConfirmation && !gate.invalidated, "a new checkpoint reconfiguration requires fresh alignment evidence")
    var fixedEvidence = evidence; fixedEvidence.signatures = [session.id: hash]
    var mac = FloorMacReview(routeID: route.id, stepID: step.id, houseID: h.id, sessionIDs: [session.id], captureSignatures: fixedEvidence.signatures, reviewedAreas: Set(step.areas ?? []), modelFile: "floor.usdz", modelSHA256: hash, verifiedBackupFiles: 10, verifiedBackupBytes: 100, registrationMethod: "overlap", notes: ["Physical checks pending"])
    expect(mac.matches(routeID: route.id, step: step, houseID: h.id, evidence: fixedEvidence), "Mac review binds exact source manifests without claiming physical calibration")
    fixedEvidence.signatures[session.id] = String(repeating: "b", count: 64)
    expect(!mac.matches(routeID: route.id, step: step, houseID: h.id, evidence: fixedEvidence), "changed source invalidates corrected Mac result")
    fixedEvidence.signatures[session.id] = hash; mac.modelFile = "../floor.usdz"
    expect(!mac.matches(routeID: route.id, step: step, houseID: h.id, evidence: fixedEvidence), "Mac preview path cannot escape its review folder")
    mac.modelFile = "floor.usdz"; model.macReviews[step.id] = mac
    expect(model.completed(step) && model.detailAvailable(detail), "reviewed ground floor unlocks its details independently")
    var upper = step; upper.id = "upper"; upper.floorID = "upper"
    model.route = .init(id: route.id, title: "Choice", steps: [step,connector,upper,detail])
    expect(!model.detailsUnlocked && model.detailAvailable(detail), "upstairs can remain pending while downstairs details are available")
    model.selectDetail(detail); expect(model.current?.id == detail.id, "user can select downstairs details before stairs")
    model.nextStructure(); expect(model.current?.id == connector.id, "structure choice returns to stairs without losing the floor review")
    var secondPass = session; secondPass.id = "second-detail-pass"
    model.sessions[detail.id] = secondPass
    model.detailCaptures[detail.id] = [session, secondPass]
    model.state?.uploadDeferred.formUnion([session.id, secondPass.id])
    expect(model.captures(for: detail).map(\.id) == [session.id, secondPass.id], "every saved detail pass remains available for upload")
    expect(model.completed(detail), "explicit offline continuation preserves the previous route behavior")
    model.selectDetail(detail)
    expect(model.current?.id == detail.id, "a transferred or deferred partial room stays available for more detail")
    expect(DetailCaptureCheckpoint.reason(activeSeconds: 180, photos: 0, remaining: 2, constrained: true, stalledSeconds: 100) == nil, "no-photo pass never receives an upload-ready reminder")
    expect(DetailCaptureCheckpoint.reason(activeSeconds: 20, photos: 10, remaining: 2, constrained: false, stalledSeconds: 0) == nil, "fresh productive pass has no premature checkpoint reminder")
    expect(DetailCaptureCheckpoint.reason(activeSeconds: 180, photos: 10, remaining: 2, constrained: false, stalledSeconds: 0) != nil, "three active minutes recommends saving a resumable pass")
    expect(DetailCaptureCheckpoint.reason(activeSeconds: 180, photos: 10, remaining: -1, constrained: false, stalledSeconds: 0) != nil, "manual detail passes also receive timed upload reminders without invented target counts")
    expect(DetailCaptureCheckpoint.reason(activeSeconds: 50, photos: 120, remaining: 2, constrained: false, stalledSeconds: 0) != nil, "large photo pass recommends upload before pressure grows")
    expect(DetailCaptureCheckpoint.reason(activeSeconds: 50, photos: 10, remaining: 2, constrained: true, stalledSeconds: 0) != nil, "resource pressure recommends a checkpoint")
    expect(DetailCaptureCheckpoint.reason(activeSeconds: 90, photos: 10, remaining: 2, constrained: false, stalledSeconds: 60) != nil, "stalled detail coverage suggests a different view or checkpoint")
    expect(DetailCaptureCheckpoint.reason(activeSeconds: 50, photos: 10, remaining: 0, constrained: false, stalledSeconds: 0)?.contains("hidden") == true, "known target completion still calls for a hidden-object check")
    let target = RoomDetailGuide.Target(id: "target", label: "Desk front", kind: "object", position: [0,1,-1], normal: [0,0,1])
    let region = RoomDetailGuide.Room(id: detail.id, label: "Hall", polygon: [[-2,-2],[2,-2],[2,2],[-2,2]], minY: 0, maxY: 2.5, targets: [target])
    var guide = RoomDetailGuide(format: "room-detail-guide/1", revision: "test-guide", houseID: h.id, floorStepID: step.id, modelFromReference: matrix_identity_float4x4.columnMajor, referenceMap: "ref.arworldmap", referenceMapSHA256: hash, referenceMesh: "ref.ply", referenceMeshSHA256: hash, rooms: [region])
    try guide.validate()
    expect(guide.room(at: [0,1,0])?.id == detail.id && guide.room(at: [1.95,1,0]) == nil, "room recognition excludes doorway and boundary uncertainty")
    expect(guide.room(at: [0,3,0]) == nil, "room recognition rejects another floor elevation")
    guide.modelFromReference = [1]
    do { try guide.validate(); expect(false, "short coordinate matrix rejected without crashing") } catch { expect(true, "short coordinate matrix rejected without crashing") }
    guide.modelFromReference = matrix_identity_float4x4.columnMajor
    let progress = RoomDetailProgress(guide: guide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("test-detail-progress.json"))
    var camera = matrix_identity_float4x4; camera.columns.3.y = 1
    progress.update(camera: camera, localized: false)
    expect(!progress.locationReady && progress.percent == 0, "selected room and saved structure alone cannot credit photographic targets")
    for _ in 0..<3 { progress.update(camera: camera, localized: true) }
    expect(progress.locationReady, "stable measured location recognizes the selected room")
    progress.update(camera: camera, localized: false)
    expect(!progress.locationReady && progress.detectedRoomID == nil && progress.nextTarget == nil && progress.cameraInModel == nil, "tracking loss immediately suspends room claims, map position and guidance")
    var ph = CoverageEngine.Photo(worldToCamera: camera.inverse, position: [0,1,0], fx: 100, fy: 100, cx: 50, cy: 50, width: 100, height: 100, sharpness: 1, depth: nil, room: 0)
    expect(!RoomDetailProgress.depthSupports(ph, point: [0,1,-1]), "missing depth cannot credit a known detail target")
    ph.depth = .init(width: 1, height: 1, values: [0.3], worldToCamera: camera.inverse, fx: 1, fy: 1, cx: 0, cy: 0)
    expect(!RoomDetailProgress.depthSupports(ph, point: [0,1,-1]), "foreground occlusion prevents detail credit")
    ph.depth?.values = [1]
    expect(RoomDetailProgress.depthSupports(ph, point: [0,1,-1]), "measured target depth permits photographic scoring")
    for _ in 0..<3 { progress.update(camera: camera, localized: true) }
    ph.fx = 500; ph.fy = 500
    let testBundle = h.url.appendingPathComponent("detail-test-bundle")
    try FileManager.default.createDirectory(at: testBundle, withIntermediateDirectories: true)
    ph.sharpness = 0.2
    for _ in 0..<10 { progress.record(ph, bundle: testBundle) }
    expect(progress.percent == 0, "repeated weak photographs never accumulate to completed detail coverage")
    ph.sharpness = 1; progress.record(ph, bundle: testBundle)
    expect(progress.percent == 100 && progress.needsViews == 0, "sharp visible depth-supported target earns known-target credit")
    let restored = RoomDetailProgress(guide: guide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("test-detail-progress.json"))
    expect(restored.percent == 100 && !restored.locationReady, "detail coverage persists but live location never survives restart")
    var referenceFromSession = simd_float4x4(simd_quatf(angle: .pi/4, axis: [0,1,0]))
    referenceFromSession.columns.3 = [4,0,-3,1]
    let record = DetailSessionReference(guideSHA256: guide.fingerprint, referenceID: "earlier-room-map", mapSHA256: hash, referenceFromSession: referenceFromSession.columnMajor)
    let alternate = RoomDetailProgress(guide: guide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("alternate-progress.json"), sessionReference: record)
    let alternateCamera = referenceFromSession.inverse*camera
    for _ in 0..<3 { alternate.update(camera: alternateCamera, localized: true) }
    expect(alternate.locationReady && simd_distance(alternate.cameraInModel ?? .zero,[0,1,0]) < 0.001, "an earlier map locates the same room through its explicit rigid transform")
    var alternatePhoto = ph
    alternatePhoto.position = simd_make_float3(alternateCamera.columns.3)
    alternatePhoto.worldToCamera = alternateCamera.inverse
    alternatePhoto.depth?.worldToCamera = alternateCamera.inverse
    // Keep this one-pixel fixture's target inside its pixel, not on the zero edge
    // where floating-point roundoff after rotation legitimately falls outside.
    alternatePhoto.depth?.cx = 0.5; alternatePhoto.depth?.cy = 0.5
    expect(RoomDetailProgress.depthSupports(alternatePhoto, point: simd_make_float3(referenceFromSession.inverse*SIMD4<Float>(0,1,-1,1))), "depth lookup preserves the target across the earlier map transform")
    alternate.record(alternatePhoto, bundle: testBundle)
    expect(alternate.percent == 100, "photo target scoring composes the earlier map transform with camera and depth poses")
    let scope = alternate.reviewedScope!
    let expectedTarget = simd_make_float3(referenceFromSession.inverse*SIMD4<Float>(0,1,-1,1))
    expect(simd_distance(scope.targets[0].position, expectedTarget)<0.001, "live coverage and saved photo scoring use the same alternate-map target")
    expect(scope.outline.count == 4 && abs(scope.floor)<0.001 && abs(scope.ceiling-2.5)<0.001, "alternate-map room bounds preserve the actual vertical range")
    var upstairsGuide = guide
    upstairsGuide.rooms[0].minY = 3; upstairsGuide.rooms[0].maxY = 5.5
    upstairsGuide.modelFromReference[13] = 1.5
    let upstairsProgress = RoomDetailProgress(guide: upstairsGuide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("upstairs-scope.json"), sessionReference: record)
    let upstairsScope = upstairsProgress.reviewedScope!
    expect(abs(upstairsScope.floor-1.5)<0.001 && abs(upstairsScope.ceiling-4)<0.001, "upstairs scope starts at the upstairs elevation, not model zero")
    var directionGuide = guide
    directionGuide.rooms[0].targets[0].position = [1,1,-1]
    let directions = RoomDetailProgress(guide: directionGuide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("directions.json"))
    let portraitSensor = camera * simd_float4x4(simd_quatf(angle: -.pi/2, axis: [0,0,1]))
    for _ in 0..<3 { directions.update(camera: portraitSensor, viewFromSession: camera.inverse, localized: true) }
    expect(directions.instruction.hasPrefix("Look right"), "portrait guidance follows screen right, not the rotated sensor x axis")
    directionGuide.rooms[0].targets[0].position = [0,2,-1]
    let upDirections = RoomDetailProgress(guide: directionGuide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("up-directions.json"))
    for _ in 0..<3 { upDirections.update(camera: portraitSensor, viewFromSession: camera.inverse, localized: true) }
    expect(upDirections.instruction.hasPrefix("Aim higher"), "portrait guidance follows screen up")
    var occlusion = ph.depth!; occlusion.values = [0.3]; occlusion.fx = 0.1; occlusion.fy = 0.1; occlusion.cx = 0.5; occlusion.cy = 0.5
    for _ in 0..<3 { directions.update(camera: portraitSensor, viewFromSession: camera.inverse, liveDepth: occlusion, localized: true) }
    expect(directions.nextTarget == nil && directions.instruction.contains("accessible"), "guidance never points through a measured foreground obstacle")
    expect(RoomDetailProgress.occluded([1,1,-1], by: nil) == false, "missing depth alone cannot invent an occluder")
    expect(alternate.photoFeedback.contains("completed"), "a newly credited photo provides immediate progress feedback")
    alternate.record(alternatePhoto, bundle: testBundle)
    expect(alternate.percent == 100 && alternate.photoFeedback.contains("Photo saved for the model"), "a repeated useful photo is saved without inventing new completion")
    let sameProgress = RoomDetailProgress(guide: guide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("alternate-progress.json"))
    expect(sameProgress.percent == 100 && !sameProgress.locationReady, "changing recovery maps preserves target progress without preserving a location claim")
    let savedReference = try JSONDecoder().decode(DetailSessionReference.self, from: Data(contentsOf: testBundle.appendingPathComponent("detail-reference.json")))
    expect(savedReference.referenceFromSession == record.referenceFromSession && savedReference.mapSHA256 == hash, "capture exports preserve the actual session-to-reference transform and map identity")
    expect(savedReference.guideSHA256 == RoomDetailGuide.hash(try Data(contentsOf: testBundle.appendingPathComponent("detail-guide.json"))), "session reference hashes the exact canonical guide included in the capture")
    var denseGuide = guide
    denseGuide.rooms[0].targets = (0..<201).map { i in
      var item = target; item.id = "dense-\(i)"; return item
    }
    let denseProgress = RoomDetailProgress(guide: denseGuide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("dense-test.json"))
    for item in denseGuide.rooms[0].targets.dropLast() { denseProgress.saved.quality[item.id] = 1 }
    expect(denseProgress.percent == 99 && denseProgress.needsViews == 1, "progress cannot round up to 100 while a planned view remains")
    var otherRoom = region; otherRoom.id = "adjacent"; otherRoom.label = "Kitchen"
    otherRoom.polygon = [[3,-2],[7,-2],[7,2],[3,2]]
    otherRoom.targets[0].id = "adjacent-target"
    var twoRoomGuide = guide; twoRoomGuide.rooms.append(otherRoom)
    let twoRooms = RoomDetailProgress(guide: twoRoomGuide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("two-room-test.json"))
    var otherCamera = camera; otherCamera.columns.3.x = 4
    for _ in 0..<3 { twoRooms.update(camera: otherCamera, localized: true) }
    expect(twoRooms.detectedRoomName == "Kitchen" && !twoRooms.locationReady && twoRooms.instruction.contains("choose that room"), "room change names the observed room and pauses the selected room's progress")
    twoRooms.record(ph, bundle: testBundle)
    expect(twoRooms.percent == 0, "wrong-room observation cannot earn selected room credit")
    guide.revision = "replacement-guide"
    let replaced = RoomDetailProgress(guide: guide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("test-detail-progress.json"))
    expect(replaced.percent == 0, "changed geometry guide invalidates previous target progress")
    guide.revision = "test-guide"; guide.rooms[0].targets[0].position[0] += 0.1
    let movedGuide = RoomDetailProgress(guide: guide, selectedRoomID: detail.id, folder: h.url, progressURL: h.url.appendingPathComponent("test-detail-progress.json"))
    expect(movedGuide.percent == 0, "same revision with changed target geometry also invalidates progress")
    var secondRegion = guide.rooms[0]; secondRegion.id = "different-room"; guide.rooms.append(secondRegion)
    do { try guide.validate(); expect(false, "target identities must be unique across rooms") } catch { expect(true, "target identities must be unique across rooms") }



  }

  private func guidedRouteAndArchive() throws {
    let first = GuidedRoute.Step(id: "entry", title: "Entrance & office", floor: "Ground floor",
      instructions: "Scan the entrance then the office.", overlap: "Include the real hall opening.",
      doorState: "Closet closed", checkpoints: ["C001"],
      mirrors: [.init(id: "mirror-entry", label: "Closet panel", cardID: "D059")], optional: false)
    var second = first; second.id = "hall"; second.title = "Hallway"; second.mirrors = []; second.optional = true
    let route = GuidedRoute(id: "test-route", title: "Test route", steps: [first, second])
    try route.validate()
    expect(try JSONDecoder().decode(GuidedRoute.self, from: JSONEncoder().encode(route)) == route, "guided route preserves walking order and reflective-surface labels")
    var duplicate = route; duplicate.steps.append(first)
    do { try duplicate.validate(); expect(false, "duplicate route IDs reject") } catch { expect(true, "duplicate route IDs reject") }
    let session = HouseProject.Session(id: "step-session", zone: "new-zone", startedAt: Date(), endedAt: Date(), alignment: .init(method: "first"), rooms: [0])
    var state = GuidedRouteState(routeID: route.id)
    expect(!state.mayAdvance(step: first, session: nil, verifiedOnMac: true), "a receipt without a saved capture cannot advance the route")
    expect(!state.mayAdvance(step: first, session: session, verifiedOnMac: false), "a saved space waits for upload by default")
    expect(state.mayAdvance(step: first, session: session, verifiedOnMac: true), "checksum receipt advances a saved space")
    var unfinished = session; unfinished.endedAt = nil
    expect(!state.mayAdvance(step: first, session: unfinished, verifiedOnMac: true), "unfinished capture never advances")
    var empty = session; empty.rooms = []
    expect(!state.mayAdvance(step: first, session: empty, verifiedOnMac: true), "empty session never advances")
    state.uploadDeferred.insert(session.id)
    expect(state.mayAdvance(step: first, session: session, verifiedOnMac: false), "explicit offline continuation preserves an upload-due state")
    var other = session; other.id = "other-session"
    expect(!state.mayAdvance(step: first, session: other, verifiedOnMac: false), "old upload deferral cannot advance a replacement session")
    state.skipped.insert(first.id); state.skipped.insert(second.id)
    expect(!state.mayAdvance(step: first, session: nil, verifiedOnMac: false), "required route spaces cannot be skipped")
    expect(state.mayAdvance(step: second, session: nil, verifiedOnMac: false), "optional patio or interior pass can be postponed")
    let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: temp) }
    let fm = FileManager.default
    try fm.createDirectory(at: temp.appendingPathComponent("Houses/old/sessions/capture"), withIntermediateDirectories: true)
    try fm.createDirectory(at: temp.appendingPathComponent("MarkerKit"), withIntermediateDirectories: true)
    let bytes = Data("original scan bytes".utf8)
    try bytes.write(to: temp.appendingPathComponent("Houses/old/sessions/capture/depth.bin"))
    try Data("kit identity".utf8).write(to: temp.appendingPathComponent("MarkerKit/manifest.json"))
    try JSONEncoder().encode(state).write(to: temp.appendingPathComponent("ScanRouteState.json"))
    let context = GuidedCaptureContext(routeID: route.id, step: first, sequence: 1, houseID: "old", sessionID: "capture",
      zoneID: "new-zone", mirrorPreparation: "covered-matte", reflectiveGeometryNeedsReview: true)
    try context.save(in: temp.appendingPathComponent("Houses/old/sessions/capture"))
    let restoredContext = GuidedCaptureContext.load(in: temp.appendingPathComponent("Houses/old/sessions/capture"))
    expect(restoredContext == context && !context.alignmentVerified && !context.automaticReflectionRemoval, "route and mirror metadata round-trip without claiming registration or reflection filtering")
    let alias = temp.appendingPathExtension("alias")
    try fm.createSymbolicLink(at: alias, withDestinationURL: temp)
    defer { try? fm.removeItem(at: alias) }
    let receipt = try ScanCollectionArchive.archive(documents: alias)
    expect(receipt.files.allSatisfy { $0.path.hasPrefix("Houses/") || $0.path == "ScanRouteState.json" }, "archive paths survive aliased iPhone sandbox roots")
    expect(!fm.fileExists(atPath: temp.appendingPathComponent("Houses").path) && !fm.fileExists(atPath: temp.appendingPathComponent("ScanRouteState.json").path), "reset clears active houses and route progress together")
    expect(fm.fileExists(atPath: temp.appendingPathComponent("MarkerKit/manifest.json").path), "reset preserves the matching printed kit")
    expect(receipt.files.count == 3 && ScanCollectionArchive.receipts(documents: temp).count == 1, "reset stores a recoverable checksum inventory")
    let archivedFile = ScanCollectionArchive.root(temp).appendingPathComponent(receipt.id + "/Houses/old/sessions/capture/depth.bin")
    try Data("corruption".utf8).write(to: archivedFile)
    do { try ScanCollectionArchive.restore(receipt, documents: temp); expect(false, "corrupt archive restore rejects") }
    catch { expect(true, "corrupt archive restore rejects") }
    try bytes.write(to: archivedFile)
    try ScanCollectionArchive.restore(receipt, documents: temp)
    expect(try Data(contentsOf: temp.appendingPathComponent("Houses/old/sessions/capture/depth.bin")) == bytes, "archive restore preserves exact original bytes")
    expect(ScanCollectionArchive.receipts(documents: temp).isEmpty, "restored archives are no longer offered twice")
    expect(!fm.fileExists(atPath: temp.appendingPathComponent("ScanRouteState.json").path), "restore does not replace the current itinerary")
  }

  func run() async -> Bool {
    var houseID: String?
    do {
      try await coveragePerformance()
      trackingRecovery()
      try roomExperience()
      try guidedRouteAndArchive()
      try floorWorkflow()
      try localizationReferenceFormats()
      try roomLocalizationSelection()
      try objectDetailCompatibility()
      try captureUploadIdentity()
      try captureDiagnostics()
      try await previewNormals()
      try await photoTextures()
      houseID = try await tests()
    } catch {
      failed += 1
      log("FAIL threw: \(error)")
    }
    if let houseID { try? FileManager.default.removeItem(at: HouseProject.url(forHouse: houseID)) }
    do {
      try await realBundle()
    } catch {
      failed += 1
      log("FAIL real bundle threw: \(error)")
    }
    log(failed == 0 ? "PASS \(passed)/\(passed)" : "FAILED \(failed) of \(passed + failed)")
    return failed == 0
  }

  private func coveragePerformance() async throws {
    let mailbox = CoverageMailbox<Int, Int>()
    expect(mailbox.offer(1, 0), "first mesh update schedules one consumer")
    for i in 1...10_000 { _ = mailbox.offer(1, i) }
    _ = mailbox.offer(2, 20)
    expect(mailbox.counts.pending == 2 && mailbox.counts.replaced == 10_000,
           "busy mesh input retains latest per anchor, not 10,000 obsolete snapshots")
    let first = mailbox.take(limit: 1)
    expect(first.first?.0 == 1 && first.first?.1 == 10_000, "bounded drain gets newest geometry")
    _ = mailbox.offer(1, 10_001)
    expect(mailbox.finish() && mailbox.take(limit: 1).first?.0 == 2, "busy anchor does not starve other anchors")
    _ = mailbox.take()
    expect(!mailbox.finish() && mailbox.offer(3, 30), "idle consumer can be scheduled again")
    let concurrent = CoverageMailbox<Int, Int>()
    await Task.detached {
      DispatchQueue.concurrentPerform(iterations: 1000) { i in _ = concurrent.offer(i % 8, i) }
    }.value
    expect(concurrent.counts.pending == 8 && concurrent.counts.replaced == 992,
           "concurrent producers remain bounded by anchor count")

    let photo = CoverageEngine.Photo(worldToCamera: matrix_identity_float4x4, position: .zero,
      fx: 1000, fy: 1000, cx: 960, cy: 720, width: 1920, height: 1440, sharpness: 1, room: 0)
    var occluded = photo
    occluded.depth = .init(width: 2, height: 2, values: [0.5, 0.5, 0.5, 0.5],
      worldToCamera: matrix_identity_float4x4, fx: 1, fy: 1, cx: 1, cy: 1)
    let photos = Array(repeating: photo, count: 154)
    let points: [SIMD3<Float>] = [SIMD3(0,0,-1), SIMD3(0,0,-4), SIMD3(0,0,1), SIMD3(10,0,-1)]
    for point in points {
      let normal = SIMD3<Float>(0,0,1)
      let baseline = min(2, photos.reduce(Float(0)) { $0 + CoverageEngine.contribution($1, point, normal) })
      expect(CoverageEngine.coverageScore(photos, at: point, normal: normal) == baseline,
             "early saturation preserves score for point \(point)")
    }
    expect(CoverageEngine.coverageScore([occluded], at: SIMD3(0,0,-2), normal: SIMD3(0,0,1)) == 0,
           "occluded surface stays uncovered")
    expect(CoverageEngine.coverageScore([], at: SIMD3(0,0,-1), normal: SIMD3(0,0,1)) == 0,
           "discarding photos clears coverage")

    let engine = CoverageEngine()
    let id = UUID()
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("coverage-barrier-\(UUID()).ply")
    defer { try? FileManager.default.removeItem(at: url) }
    for x: Float in [0, 1, 2] {
      engine.update(snapshot: .init(id: id, transform: matrix_identity_float4x4,
        positions: [SIMD3(x,0,0), SIMD3(x+0.1,0,0), SIMD3(x,0.1,0)],
        normals: Array(repeating: SIMD3(0,0,1), count: 3), faces: [0,1,2], classes: [1]))
    }
    engine.remove(id) // RoomPlan may remove anchors as it stops.
    let result = await withCheckedContinuation { continuation in
      engine.exportPLY(to: url) { continuation.resume(returning: $0) }
    }
    _ = try result.get()
    let mesh = try PLYMesh.load(url: url)
    expect(mesh.vertexCount == 3 && mesh.position(0).x == 2,
           "export flushes newest pending geometry even after anchor removal")

    // Reusing unchanged vertices must still respect added/discarded photos and changed normals.
    func exportCoverage(_ e: CoverageEngine) async throws -> PLYMesh {
      let result = await withCheckedContinuation { continuation in
        e.exportPLY(to: url) { continuation.resume(returning: $0) }
      }
      _ = try result.get()
      return try PLYMesh.load(url: url)
    }
    let snapshot = ARMeshAnchor.Snapshot(id: id, transform: matrix_identity_float4x4,
      positions: [SIMD3(0,0,-1), SIMD3(0.1,0,-1), SIMD3(0,0.1,-1)],
      normals: Array(repeating: SIMD3(0,0,1), count: 3), faces: [0,1,2], classes: [1])
    engine.update(snapshot: snapshot)
    engine.add(photo)
    let covered = try await exportCoverage(engine)
    engine.update(snapshot: snapshot)
    let unchanged = try await exportCoverage(engine)
    expect(covered.coverageColors == unchanged.coverageColors && covered.coverageColors[1] == 199,
           "unchanged vertex reuse preserves newly added photo coverage")
    var reversed = snapshot
    reversed.normals = Array(repeating: SIMD3(0,0,-1), count: 3)
    engine.update(snapshot: reversed)
    let changed = try await exportCoverage(engine)
    expect(changed.coverageColors[0] == 255, "changed normal invalidates cached vertex score")
    engine.update(snapshot: snapshot)
    engine.reset(photos: [])
    let reset = try await exportCoverage(engine)
    expect(reset.coverageColors[0] == 255, "reset removes coverage even when geometry is unchanged")

    let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("coverage-benchmark")
    if FileManager.default.fileExists(atPath: base.appendingPathComponent("mesh/room-0.ply").path) {
      let report = try await Task.detached(priority: .utility) { () throws -> (Float, Double, Double, Int) in
        let mesh = try PLYMesh.load(url: base.appendingPathComponent("mesh/room-0.ply"))
        let records = try JSONDecoder().decode([PhotoRecord].self, from: Data(contentsOf: base.appendingPathComponent("photos/photos.json")))
        let photos = records.map { p -> CoverageEngine.Photo in
          let t = simd_float4x4(columnMajor: p.transform), k = p.intrinsics
          return .init(worldToCamera: t.inverse, position: simd_make_float3(t.columns.3),
            fx:k[0], fy:k[4], cx:k[6], cy:k[7], width:Float(p.width), height:Float(p.height),
            sharpness:1, room:p.room)
        }
        let indices = Array(stride(from: 0, to: mesh.vertexCount, by: max(1,mesh.vertexCount/20_000)))
        let t0 = CACurrentMediaTime()
        let baseline = indices.map { i in min(2, photos.reduce(Float(0)) {
          $0 + CoverageEngine.contribution($1,mesh.position(i),mesh.normal(i))
        }) }
        let t1 = CACurrentMediaTime()
        let optimized = indices.map { CoverageEngine.coverageScore(photos,at:mesh.position($0),normal:mesh.normal($0)) }
        let t2 = CACurrentMediaTime()
        let error = zip(baseline,optimized).map { abs($0-$1) }.max() ?? 0
        return (error,(t1-t0)*1000,(t2-t1)*1000,indices.count)
      }.value
      expect(report.0 < 0.00001, "actual office sampled geometry preserves baseline scores")
      log(String(format:"coverage benchmark: %d office vertices, no-depth photo poses, baseline %.1f ms → optimized %.1f ms (%.2fx); max error %.8f", report.3,report.1,report.2,report.1/max(report.2,0.001),report.0))
    } else { log("skip optional coverage-benchmark fixture") }
  }

  private func trackingRecovery() {
    var recovery = TrackingRecovery()
    expect(!recovery.canCapture, "tracking starts blocked until stable")
    recovery.update(problem: nil, now: 0)
    recovery.update(problem: nil, now: 1.4)
    expect(!recovery.canCapture, "one normal frame does not resume capture")
    recovery.update(problem: nil, now: 1.5)
    expect(recovery.canCapture, "stable tracking resumes capture")
    recovery.update(problem: .motion, now: 2)
    expect(!recovery.canCapture && recovery.issue == .motion, "motion immediately blocks capture with guidance")
    recovery.update(problem: nil, now: 3)
    recovery.update(problem: .features, now: 4)
    recovery.update(problem: nil, now: 5)
    recovery.update(problem: nil, now: 6)
    expect(!recovery.canCapture, "tracking flicker restarts stability timer")
    recovery.update(problem: nil, now: 6.5)
    expect(recovery.canCapture, "recovery succeeds after new stable interval")
    recovery.update(problem: .stalled, now: 7)
    expect(!recovery.canCapture, "stale camera frame blocks capture despite normal tracking")
    recovery.update(problem: .interrupted, now: 8)
    expect(recovery.issue == .interrupted, "interruption supplies recovery guidance")
    expect(TrackingRecovery.problem(for: .limited(.excessiveMotion)) == .motion &&
           TrackingRecovery.problem(for: .limited(.insufficientFeatures)) == .features &&
           TrackingRecovery.problem(for: .limited(.relocalizing)) == .relocalizing &&
           TrackingRecovery.problem(for: .normal) == nil, "ARKit tracking reasons map to specific guidance")
  }

  private func captureDiagnostics() throws {
    let underlying = NSError(domain: "test.tracking", code: 42,
        userInfo: [NSLocalizedDescriptionKey: "tracking stopped", NSLocalizedFailureReasonErrorKey: "test reason"])
    let outer = NSError(domain: "test.roomplan", code: 7,
        userInfo: [NSLocalizedDescriptionKey: "World tracking failure", NSUnderlyingErrorKey: underlying])
    let chain = Diagnostics.errorChain(outer)
    expect(chain.count == 2 && chain[0].domain == "test.roomplan" && chain[1].code == 42,
           "diagnostics retain nested error domains and codes")
    expect(chain.last?.reason == "test reason", "diagnostics retain underlying failure reason")
    var diagnostics = Diagnostics()
    for _ in 0..<40 { diagnostics.recordFailure(source: "test", chain: chain, since: Date()) }
    expect(diagnostics.failures?.count == 32, "failure history is bounded")
    for i in 0..<250 {
      diagnostics.recordSample(.init(t: Double(i), phase: "scanning", thermal: "nominal", memoryMB: 123,
        frameAgeSeconds: 0.1, tracking: "normal", mapping: "mapped", featurePoints: 100,
        meshAnchors: 2, meshVertices: 50, photos: 1, depthFrames: 3, photosInFlight: 0))
    }
    expect(diagnostics.resourceSamples?.count == 240 && diagnostics.resourceSamples?.first?.t == 10,
           "resource sampling retains only the latest 240 samples")
    let decoded = try JSONDecoder().decode(Diagnostics.self, from: JSONEncoder().encode(diagnostics))
    expect(decoded.failures?.last?.chain.last?.code == 42 && decoded.resourceSamples?.last?.memoryMB == 123,
           "detailed capture diagnostics survive JSON round trip")
    let old = try JSONDecoder().decode(Diagnostics.self, from: Data("{\"worldJumps\":[]}".utf8))
    expect(old.failures == nil && old.resourceSamples == nil, "older diagnostics remain readable")
    expect(Diagnostics.memoryFootprintMB().map { $0 > 0 } == true, "memory footprint is measurable")
  }

  private func tests() async throws -> String {
    let fm = FileManager.default

    // --- house + first zone + first session
    var house = try HouseProject.create(name: "Selftest \(HouseProject.folderName(for: Date()))")
    let houseID = house.id
    let zone1 = house.addZone(named: "Area 1")
    try house.save()
    expect(zone1.aligned && zone1.id == "area-1", "first zone is placed in the house frame")
    let first = try CaptureController.start(houseID: houseID, zoneID: zone1.id)
    expect(first.usesRoomPlan, "structure capture still uses RoomPlan")
    expect(first.phase == .betweenRooms && first.plan.worldMap == nil && first.alignment.method == "first", "first session starts fresh, alignment first")
    let s1 = first.plan.sessionID
    for dir in ScanBundle.subfolders {
      var isDir: ObjCBool = false
      expect(fm.fileExists(atPath: first.bundle.file(dir).path, isDirectory: &isDir) && isDir.boolValue, "session folder has \(dir)/")
    }
    expect(first.bundle.url.deletingLastPathComponent().lastPathComponent == "sessions", "session folder is under sessions/")
    house = try HouseProject.load(id: houseID)
    expect(house.session(s1)?.endedAt == nil && house.session(s1)?.zone == zone1.id, "session recorded in house.json at start")

    // --- rooms + history
    try HouseProject.modify(houseID) { h in
      h.recordRoomScan(name: "Office", session: s1, index: 0, capturedAt: Date(timeIntervalSince1970: 1000))
      h.recordRoomScan(name: "Kitchen", session: s1, index: 1, capturedAt: Date(timeIntervalSince1970: 1100))
      h.recordRoomScan(name: " office ", session: s1, index: 2, capturedAt: Date(timeIntervalSince1970: 1200)) // rescan, same session
      h.endSession(s1)
    }
    house = try HouseProject.load(id: houseID)
    let office = house.rooms.first { $0.name == "Office" }
    expect(house.rooms.count == 2, "rescan by name doesn't add a room (\(house.rooms.map(\.name)))")
    expect(office?.history.count == 2 && office?.active?.index == 2, "rescan goes into history and becomes active")
    expect(house.session(s1)?.rooms == [0, 1, 2], "session lists its room indices")
    try HouseProject.modify(houseID) { $0.removeRoomScan(session: s1, index: 2) }
    house = try HouseProject.load(id: houseID)
    expect(house.rooms.first { $0.name == "Office" }?.active?.index == 0, "redo last room: previous scan active again")
    try HouseProject.modify(houseID) { $0.recordRoomScan(name: "Office", session: s1, index: 2, capturedAt: Date(timeIntervalSince1970: 1200)) }

    // --- saved mesh + photos for session 1 (a 3 m × 2.4 m wall at z = -2 and a floor)
    try writeTestPLY(to: first.bundle.file("mesh/room-0.ply"))
    try writeTestPhotos(first.bundle)

    // --- JSON round trip
    house = try HouseProject.load(id: houseID)
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys]
    e.dateEncodingStrategy = .iso8601
    let a = try e.encode(house)
    let d = JSONDecoder()
    d.dateDecodingStrategy = .iso8601
    let b = try e.encode(try d.decode(HouseProject.self, from: a))
    expect(a == b, "house.json round-trips byte for byte")
    expect(house.format == "house-project/1", "house.json format")

    // --- world map → Continue plans a relocalization
    let mapPath = WorldMapFile.zoneRelativePath(zone1.id)
    try fm.createDirectory(at: house.url.appendingPathComponent("zones/\(zone1.id)"), withIntermediateDirectories: true)
    try Data("not a real map".utf8).write(to: house.url.appendingPathComponent(mapPath))
    try HouseProject.modify(houseID) { $0.setWorldMap(zone: zone1.id, path: mapPath) }
    try await Task.sleep(for: .seconds(1.1)) // session folders are named by the second
    let cont = try CaptureController.start(houseID: houseID, zoneID: zone1.id)
    expect(cont.phase == .relocalizing && cont.plan.worldMap != nil, "Continue with a saved map starts relocalizing")
    expect(cont.alignment.method == "unaligned" && cont.alignment.note != nil, "until verified the session is recorded as unaligned")
    expect(cont.existingRoomNames.sorted() == ["Kitchen", "Office"], "Continue suggests the zone's rooms for rescans")
    let s2 = cont.plan.sessionID
    expect(s2 != s1, "second session gets its own folder")

    // --- ghost + alignment check against session 1's mesh
    house = try HouseProject.load(id: houseID)
    let ref = ZoneReference.load(house: house, zone: zone1.id, excludingSession: s2)
    expect(ref.files.count == 1 && ref.errors.isEmpty, "zone reference reads the saved PLY (\(ref.errors))")
    expect((ref.ghost?.triangleCount ?? 0) > 100, "ghost is decimated but not empty (\(ref.ghost?.triangleCount ?? 0) triangles from \(ref.sourceVertices) vertices)")
    typealias LP = ZoneReference.LivePoint
    var backWall: [LP] = [], sideWall: [LP] = [], floor: [LP] = []
    for i in 0..<60 { for j in 0..<40 { backWall.append(LP(p: SIMD3(-1.4 + Float(i) * 0.047, 0.1 + Float(j) * 0.055, -2 + 0.004 * sin(Float(i * j))), n: SIMD3(0, 0, 1))) } }
    for i in 0..<30 { for j in 0..<40 { sideWall.append(LP(p: SIMD3(-1.5 + 0.004 * cos(Float(i * j)), 0.1 + Float(j) * 0.055, -1.9 + Float(i) * 0.05), n: SIMD3(1, 0, 0))) } }
    for i in 0..<30 { for j in 0..<20 { floor.append(LP(p: SIMD3(-1.4 + Float(i) * 0.09, 0.003, -1.9 + Float(j) * 0.08), n: SIMD3(0, 1, 0))) } }
    let corner = backWall + sideWall + floor
    let good = ref.check(corner)
    expect(good.isGood && (good.median ?? 1) < 0.01, "live points on the saved corner pass (median \(good.median ?? -1), walls \(good.wallMatched)/\(good.wallKnown), spread \(good.spreadDegrees)°)")
    let oneWall = ref.check(backWall + floor)
    expect(!oneWall.isGood && oneWall.needsCorner, "one flat wall alone can't verify (spread \(oneWall.spreadDegrees)°)")
    let shifted = ref.check(corner.map { LP(p: $0.p + SIMD3(0.25, 0, 0.25), n: $0.n) })
    expect(shifted.isMismatch && !shifted.isGood, "a 35 cm offset is a mismatch (walls \(shifted.wallMatched)/\(shifted.wallKnown))")
    let slid = ref.check(corner.map { LP(p: $0.p + SIMD3(0.3, 0, 0), n: $0.n) })
    expect(!slid.isGood, "a 30 cm slide along the back wall doesn't verify (walls \(slid.wallMatched)/\(slid.wallKnown), spread \(slid.spreadDegrees)°)")
    let slightly = ref.check(corner.map { LP(p: $0.p + SIMD3(0.07, 0, 0.07), n: $0.n) })
    expect(!slightly.isGood, "a 10 cm offset doesn't verify (median \(slightly.median ?? -1))")
    // the back side of the saved wall (seen from the next room, 12 cm away through the wall)
    let behind = ref.check(backWall.map { LP(p: $0.p - SIMD3(0, 0, 0.12), n: -$0.n) })
    expect(behind.known == 0 && !behind.isMismatch, "the far side of a scanned wall isn't a mismatch (known \(behind.known))")
    let far = ref.check(corner.map { LP(p: $0.p + SIMD3(0, 0, 3), n: $0.n) })
    expect(far.known == 0 && !far.isGood && !far.isMismatch, "points far from anything scanned are neither")

    // --- earlier photos (with occlusion depth) for coverage
    let prior = PriorPhotos.load(house: house, zone: zone1.id, excludingSession: s2)
    expect(prior.count == 1, "earlier photo with a matching depth frame loads (\(prior.count))")
    if let p = prior.first, let g = p.depth {
      let center = g.values[24 * g.width + 32]
      expect(abs(center - 2) < 0.01, "depth grid inflated from .f16z (center \(center) m)")
    }
    expect(PriorPhotos.landmarks(house: house, zone: zone1.id).count == 1, "landmark photo found")

    // --- manifests: current session format round trip
    try first.bundle.writeManifest(Manifest(createdAt: Date(), device: "test", systemVersion: "0", house: houseID, session: s1, zone: zone1.id,
                                            alignment: .init(method: "first"), worldMap: WorldMapFile.sessionFile, rooms: [], photos: "photos/photos.json", photoCount: 1))
    expect(first.bundle.manifest?.format == "house-capture/5" && first.bundle.manifest?.alignment?.method == "first", "v5 manifest round-trips")
    // --- single-room export excludes sibling recordings and session-wide assets.
    let exportTest = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? fm.removeItem(at: exportTest) }
    let source = ScanBundle(url: exportTest.appendingPathComponent("source"))
    for dir in ScanBundle.subfolders {
      try fm.createDirectory(at: source.file(dir), withIntermediateDirectories: true)
    }
    try writeTestPhotos(source)
    var photo = source.photos[0]
    photo.room = 2; photo.file = "photos/0002.jpg"
    try Data([1, 2, 3]).write(to: source.file(photo.file))
    try source.savePhotos(source.photos + [photo])
    var depth = source.depthFrames[0]
    depth.room = 2; depth.file = "depth/00002.f16z"; depth.confidence = "depth/00002.conf"; depth.rgb = "depth/00002.jpg"
    for path in [depth.file, depth.confidence, depth.rgb!] { try Data([4, 5, 6]).write(to: source.file(path)) }
    try JSONEncoder().encode(source.depthFrames + [depth]).write(to: source.file("depth/frames.json"))
    let roomRecords = [0, 2].map { i in
      RoomRecord(index: i, name: "Room \(i)", file: "rooms/room-\(i).json", usdz: "", capturedAt: Date(), walls: 4, doors: 1, windows: 0, openings: 0, objects: 0,
                 mesh: MeshRecord(file: "mesh/room-\(i).ply", anchors: 1, vertices: 3, faces: 1))
    }
    for room in roomRecords {
      try Data("{}".utf8).write(to: source.file(room.file))
      try Data([7, 8, 9]).write(to: source.file(room.mesh!.file))
    }
    for path in ["worldmap.arworldmap", "structure.json", "structure.usdz"] { try Data([0]).write(to: source.file(path)) }
    try JSONSerialization.data(withJSONObject: ["format": "marker-observations/1", "observations": [
      ["markerID": "C001", "roomIndex": 0], ["markerID": "C002", "roomIndex": 2], ["markerID": "C003"]
    ]]).write(to: source.file("marker-observations.json"))
    try source.writeManifest(Manifest(createdAt: Date(), device: "test", systemVersion: "0", house: houseID, session: s1, zone: zone1.id,
                                      worldMap: "worldmap.arworldmap", rooms: roomRecords, structure: "structure.json", mesh: roomRecords[0].mesh,
                                      photos: "photos/photos.json", photoCount: 2, depthFrames: "depth/frames.json", depthFrameCount: 2))
    let exported = ScanBundle(url: exportTest.appendingPathComponent("export"))
    try source.exportRoom(index: 2, name: "Renamed room", to: exported.url)
    expect(exported.manifest?.rooms.map(\.index) == [2] && exported.manifest?.rooms.first?.name == "Renamed room", "room export preserves nonzero index and current name")
    expect(exported.photos.map(\.room) == [2] && exported.depthFrames.map(\.room) == [2], "room export filters photo and depth indexes")
    expect(exported.manifest?.photoCount == 1 && exported.manifest?.depthFrameCount == 1 && exported.manifest?.mesh?.file == "mesh/room-2.ply", "room export updates counts and mesh reference")
    expect(exported.manifest?.worldMap == nil && exported.manifest?.structure == nil, "room export clears session-wide references")
    let exportedMarkers = try JSONSerialization.jsonObject(with: Data(contentsOf: exported.file("marker-observations.json"))) as? [String: Any]
    let selectedMarkers = exportedMarkers?["observations"] as? [[String: Any]]
    expect(selectedMarkers?.count == 1 && selectedMarkers?.first?["markerID"] as? String == "C002", "AirDrop room export retains only its own provisional marker observations")
    for path in [photo.file, depth.file, depth.confidence, depth.rgb!, "rooms/room-2.json", "mesh/room-2.ply"] {
      expect(fm.fileExists(atPath: exported.file(path).path), "room export includes \(path)")
    }
    for path in ["photos/0000.jpg", "depth/00000.f16z", "rooms/room-0.json", "mesh/room-0.ply", "worldmap.arworldmap", "structure.json", "structure.usdz"] {
      expect(!fm.fileExists(atPath: exported.file(path).path), "room export excludes \(path)")
      expect(fm.fileExists(atPath: source.file(path).path), "room export preserves original \(path)")
    }
    let roomZip = try source.zippedRoom(index: 2, name: "Room / test")
    expect(((try? fm.attributesOfItem(atPath: roomZip.path)[.size] as? Int) ?? 0) > 0, "single room zips with a safe filename")
    do {
      try source.exportRoom(index: 99, name: "Missing", to: exportTest.appendingPathComponent("missing"))
      expect(false, "missing room rejects export")
    } catch { expect(true, "missing room rejects export") }
    let secondRoomZip = try source.zippedRoom(index: 2, name: "Room / test")
    expect(roomZip != secondRoomZip && fm.fileExists(atPath: roomZip.path), "independent room exports do not replace an existing share")
    FolderZipper.removeArchive(secondRoomZip)
    expect(!fm.fileExists(atPath: secondRoomZip.path) && fm.fileExists(atPath: roomZip.path), "share cleanup removes only its own archive")
    FolderZipper.removeArchive(source.file(photo.file))
    expect(fm.fileExists(atPath: source.file(photo.file).path), "share cleanup cannot delete original captures")
    let importedID = try ScanImport.importFolder(exported.url)
    defer { try? fm.removeItem(at: HouseProject.url(forHouse: importedID)) }
    let imported = try HouseProject.load(id: importedID)
    expect(imported.rooms.count == 1 && imported.rooms[0].name == "Renamed room" && imported.rooms[0].active?.index == 2, "folder import creates an independent house with original room index")
    expect(imported.sessions.count == 1 && imported.zones.count == 1, "folder import reconstructs session and tracking group references")
    let importedBundle = imported.bundle(for: imported.sessions[0])
    expect(importedBundle.photos.count == 1 && importedBundle.manifest?.house == importedID, "folder import copies photos and normalizes manifest ownership")
    try fm.createSymbolicLink(at: exported.file("outside"), withDestinationURL: source.url)
    do {
      _ = try ScanImport.importFolder(exported.url)
      expect(false, "folder import rejects symbolic links")
    } catch { expect(true, "folder import rejects symbolic links") }
    try fm.removeItem(at: exported.file("outside"))
    var invalidManifest = exported.manifest!
    invalidManifest.photos = "../source/photos/photos.json"
    try exported.writeManifest(invalidManifest)
    do {
      try exported.exportRoom(index: 2, name: "Unsafe", to: exportTest.appendingPathComponent("unsafe"))
      expect(false, "room export rejects escaping index paths")
    } catch { expect(true, "room export rejects escaping index paths") }
    try CaptureReadiness.checkStorage(available: CaptureReadiness.reserve, required: CaptureReadiness.reserve)
    try CaptureReadiness.checkStorage(available: nil, required: CaptureReadiness.reserve)
    do {
      try CaptureReadiness.checkStorage(available: CaptureReadiness.reserve - 1, required: CaptureReadiness.reserve)
      expect(false, "low-storage preflight blocks below its reserve")
    } catch { expect(true, "low-storage preflight blocks below its reserve") }
    expect(HelpDocument.load("PrivacyPolicy") != nil && HelpDocument.load("Support") != nil, "offline privacy and support ship in the app")
    try Data("broken".utf8).write(to: source.file("photos/photos.json"))
    do {
      try source.exportRoom(index: 2, name: "Broken", to: exportTest.appendingPathComponent("broken"))
      expect(false, "corrupt photo index rejects export")
    } catch { expect(true, "corrupt photo index rejects export") }

    // --- abandoning a Continue session removes it; relocalized-session rooms join the history
    cont.abandon()
    house = try HouseProject.load(id: houseID)
    expect(house.session(s2) == nil && !fm.fileExists(atPath: house.url.appendingPathComponent("sessions/\(s2)").path), "discarded session leaves no trace")
    expect(house.existingWorldMap(zone: house.zone(zone1.id)!) != nil, "discarding a Continue session keeps the zone map")
    try await Task.sleep(for: .seconds(1.1))
    let third = try CaptureController.start(houseID: houseID, zoneID: zone1.id)
    let s3 = third.plan.sessionID
    try HouseProject.modify(houseID) { h in
      h.setAlignment(session: s3, .init(method: "relocalized", residualMeters: 0.02))
      h.recordRoomScan(name: "Kitchen", session: s3, index: 0, capturedAt: Date(timeIntervalSince1970: 2000))
      h.recordRoomScan(name: "Hallway", session: s3, index: 1, capturedAt: Date(timeIntervalSince1970: 2100))
      h.endSession(s3)
    }
    house = try HouseProject.load(id: houseID)
    let kitchen = house.rooms.first { $0.name == "Kitchen" }
    expect(kitchen?.history.map(\.session) == [s1, s3] && kitchen?.active?.session == s3, "rescan in a later session: history across sessions, newest active")
    if let kitchen, let old = kitchen.history.first {
      try HouseProject.modify(houseID) { $0.setActive(room: kitchen.id, old) }
      expect(try HouseProject.load(id: houseID).rooms.first { $0.id == kitchen.id }?.active == old, "use this scan: older scan active again")
    }
    expect(house.lastZone?.id == zone1.id, "Continue defaults to the last session's zone")

    // --- new area
    try await Task.sleep(for: .seconds(1.1))
    let area2 = try CaptureController.start(houseID: houseID, zoneID: nil, newZone: "Upstairs")
    house = try HouseProject.load(id: houseID)
    let z2 = house.zone(area2.plan.zoneID)
    expect(z2?.name == "Upstairs" && z2?.aligned == false && area2.alignment.method == "first" && area2.plan.worldMap == nil, "new area: own frame, not placed in house, session 'first'")

    // --- zip one session and the whole house
    let sessionZip = try FolderZipper.zip(first.bundle.url, name: "\(house.name) \(s1)")
    expect(((try? fm.attributesOfItem(atPath: sessionZip.path)[.size] as? Int) ?? 0) > 1000, "session zips")
    let houseZip = try FolderZipper.zip(house.url, name: house.name)
    expect(((try? fm.attributesOfItem(atPath: houseZip.path)[.size] as? Int) ?? 0) > 1000, "house zips")

    // Room deletion preserves a sibling recorded in the same session.
    let scratch = house.addZone(named: "Deletion test")
    house.beginSession(id: "delete-test", zone: scratch.id, alignment: .init(method: "first"))
    let deleteA = house.recordRoomScan(name: "Delete A", session: "delete-test", index: 0, capturedAt: Date())!
    _ = house.recordRoomScan(name: "Keep B", session: "delete-test", index: 1, capturedAt: Date())
    try house.save()
    try HouseProject.deleteRoom(houseID: houseID, roomID: deleteA.id)
    house = try HouseProject.load(id: houseID)
    expect(!house.rooms.contains { $0.id == deleteA.id } && house.session("delete-test")?.rooms == [1], "room deletion preserves sibling session entries")
    expect(house.zone(zone1.id)?.worldMap != nil, "room deletion preserves unrelated tracking maps")
    let deleteB = house.rooms.first { $0.name == "Keep B" }!
    try HouseProject.deleteRoom(houseID: houseID, roomID: deleteB.id)
    house = try HouseProject.load(id: houseID)
    expect(house.session("delete-test") == nil && house.zone(scratch.id) == nil, "last room deletion removes empty session and tracking group")

    // --- deleting sessions
    try HouseProject.deleteSession(houseID: houseID, sessionID: s3)
    house = try HouseProject.load(id: houseID)
    expect(house.rooms.first { $0.name == "Kitchen" }?.active?.session == s1 && !house.rooms.contains { $0.name == "Hallway" }, "deleting a session rolls its rooms back")
    try HouseProject.deleteSession(houseID: houseID, sessionID: s1)
    house = try HouseProject.load(id: houseID)
    expect(house.roomsInZone(zone1.id).isEmpty && house.zone(zone1.id)?.worldMap == nil && !fm.fileExists(atPath: house.url.appendingPathComponent(mapPath).path),
           "deleting the zone's last placed session drops its map")
    return houseID
  }

  /// Regression: a zero ARKit normal used to become NaN and trap during photo-color baking.
  private func previewNormals() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("selftest-preview-normals.ply")
    defer { try? FileManager.default.removeItem(at: url) }
    let normals: [SIMD3<Float>] = [SIMD3(.nan, .nan, .nan), SIMD3(0, .infinity, 0),
                                  .zero, SIMD3(0, 1e-10, 0), SIMD3(0, 2, 0)]
    try writeTestPLY(to: url, initialNormals: normals)
    let mesh = try PLYMesh.load(url: url)
    expect(mesh.normals.allSatisfy { $0.isFinite }, "preview replaces non-finite normals")
    expect((0..<4).allSatisfy { mesh.normal($0) == .zero }, "invalid and degenerate normals stay unknown")
    expect(mesh.normal(4) == SIMD3(0, 1, 0), "preview normalizes valid directions")
    let result = await Task.detached {
      VertexColorBaker.bake(mesh: mesh, photos: [], progress: { _, _ in }, isCancelled: { false })
    }.value
    expect(result?.rgba.count == mesh.vertexCount * 4 && result?.seen == 0,
           "unphotographed vertices bake without crashing on invalid normals")
    expect(result.map { Array($0.rgba.prefix(4)) == [138, 138, 144, 255] } ?? false,
           "unknown normals receive neutral clay shading")
  }

  /// Texture projection preserves per-pixel detail, face accounting, and bounded allocations.
  private func photoTextures() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("selftest-textures")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let meshURL = folder.appendingPathComponent("test.ply"), photoURL = folder.appendingPathComponent("test.jpg")
    try writeTestPLY(to: meshURL)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: CGSize(width: 1920, height: 1440), format: format).image { context in
      UIColor.white.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 1920, height: 1440))
      UIColor.red.setFill()
      for x in stride(from: 0, to: 1920, by: 8) { context.fill(CGRect(x: x, y: 0, width: 4, height: 1440)) }
    }
    try image.jpegData(compressionQuality: 1)!.write(to: photoURL)
    let mesh = try PLYMesh.load(url: meshURL)
    let photo = PreviewPhoto(id: 0, session: 0, url: photoURL, room: 0, timestamp: 0,
                             cameraToHouse: matrix_identity_float4x4, fx: 1400, fy: 1400, cx: 960, cy: 720,
                             width: 1920, height: 1440, sharpness: 1, gain: 1)
    let result = await Task.detached {
      PhotoTextures.build(mesh: mesh, inside: mesh.indices, outside: [], photos: [photo], pixelBudget: 2_000_000,
                          progress: { _ in }, isCancelled: { false })
    }.value
    expect(result != nil && (result?.triangleCount ?? 0) > 100, "photo texture assigned to visible mesh triangles")
    if let result {
      expect(result.triangleCount + result.insideFallback.count / 3 == mesh.faceCount, "textured and fallback faces cover the mesh exactly")
      expect(result.pixelCount > mesh.vertexCount * 10 && result.pixelCount <= 2_010_000, "texture detail exceeds vertex density within pixel budget")
      let sources = result.inside?.sources(for: .texcoord) ?? []
      expect(!sources.isEmpty && sources.allSatisfy { source in
        source.data.withUnsafeBytes { raw in
          raw.bindMemory(to: Float.self).allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1 }
        }
      }, "cropped photo coordinates stay finite and inside their image")
    }
    let cancelled = PhotoTextures.build(mesh: mesh, inside: mesh.indices, outside: [], photos: [photo], pixelBudget: 2_000_000,
                                        progress: { _ in }, isCancelled: { true })
    expect(cancelled == nil, "texture building cancels without publishing partial geometry")
  }

  /// With a real bundle copied to Documents/selftest-bundle (photos, depth, mesh/room-*.ply in
  /// the app's format): load it as a zone's earlier session, with timings
  private func realBundle() async throws {
    let fm = FileManager.default
    let src = fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("selftest-bundle", isDirectory: true)
    guard fm.fileExists(atPath: src.path) else {
      log("skip real bundle (no Documents/selftest-bundle)")
      return
    }
    var house = try HouseProject.create(name: "Selftest real \(HouseProject.folderName(for: Date()))")
    defer { try? fm.removeItem(at: house.url) }
    let zone = house.addZone(named: "Area 1")
    house.beginSession(id: "real", zone: zone.id, alignment: .init(method: "first"))
    try house.save()
    try fm.copyItem(at: src, to: house.url.appendingPathComponent("sessions/real", isDirectory: true))

    var t = Date()
    let snapshot = house
    let newestOnly = ZoneReference.load(house: snapshot, zone: zone.id, excludingSession: nil)
    expect(newestOnly.files == ["real/room-0.ply"], "newest non-empty PLY per session (\(newestOnly.files))")
    t = Date()
    let ref = await Task.detached { ZoneReference.load(house: snapshot, zone: zone.id, excludingSession: nil, allFiles: true) }.value
    let loadMs = Int(Date().timeIntervalSince(t) * 1000)
    log("real: \(ref.files) \(ref.sourceVertices) vertices → ghost \(ref.ghost?.triangleCount ?? 0) triangles / \(ref.ghost?.positions.count ?? 0) vertices, index \(ref.index.points.count) voxels, \(loadMs) ms, errors \(ref.errors)")
    expect(ref.errors.isEmpty && ref.sourceVertices > 100_000, "real PLYs parse (empty one included)")
    expect((ref.ghost?.triangleCount ?? 0) > 10_000 && (ref.ghost?.triangleCount ?? 0) < 600_000, "real ghost is a sane size")
    expect(loadMs < 20_000, "real zone loads in < 20 s (\(loadMs) ms)")

    // live-like samples: saved surface points with ±5 mm noise
    let step = max(1, ref.index.points.count / 3000)
    var pts: [ZoneReference.LivePoint] = []
    var k = 0
    while k < ref.index.points.count {
      let m = ref.index.normals[k]
      let n = simd_length(m) > 0.5 ? simd_normalize(m) : SIMD3<Float>.zero
      pts.append(.init(p: ref.index.points[k] + n * (Float((k * 7919) % 11) - 5) * 0.001, n: n))
      k += step
    }
    func describe(_ c: ZoneReference.Check) -> String {
      "walls \(c.wallMatched)/\(c.wallKnown) flat \(c.flatMatched)/\(c.flatKnown) all \(c.matched)/\(c.known) spread \(c.spreadDegrees)° median \(c.median.map { String(format: "%.3f", $0) } ?? "-")"
    }
    t = Date()
    let good = ref.check(pts)
    let checkMs = Int(Date().timeIntervalSince(t) * 1000)
    expect(good.isGood, "real: noisy samples of the saved surface verify (\(describe(good)), \(checkMs) ms)")
    for (label, offset) in [("36 cm shift", SIMD3<Float>(0.3, 0, 0.2)), ("15 cm shift", SIMD3<Float>(0.1, 0, 0.11)), ("10 cm up", SIMD3<Float>(0, 0.1, 0))] {
      let c = ref.check(pts.map { .init(p: $0.p + offset, n: $0.n) })
      expect(!c.isGood, "real: a \(label) doesn't verify (\(describe(c)))")
    }
    let center = ref.index.points.reduce(SIMD3<Float>.zero, +) / Float(max(1, ref.index.points.count))
    // where the line is (logged, not asserted): small errors the check tolerates
    for (label, offset) in [("3 cm", SIMD3<Float>(0.02, 0, 0.02)), ("6 cm", SIMD3<Float>(0.045, 0, 0.04)), ("9 cm", SIMD3<Float>(0.065, 0, 0.06))] {
      let c = ref.check(pts.map { .init(p: $0.p + offset, n: $0.n) })
      log("real: \(label) shift → good=\(c.isGood) (\(describe(c)))")
    }
    for degrees: Float in [1, 2] {
      let yaw = simd_quatf(angle: degrees * .pi / 180, axis: SIMD3(0, 1, 0))
      let c = ref.check(pts.map { .init(p: yaw.act($0.p - center) + center, n: yaw.act($0.n)) })
      log("real: \(Int(degrees))° turn → good=\(c.isGood) (\(describe(c)))")
    }
    for degrees: Float in [9, 4] {
      let yaw = simd_quatf(angle: degrees * .pi / 180, axis: SIMD3(0, 1, 0))
      let c = ref.check(pts.map { .init(p: yaw.act($0.p - center) + center, n: yaw.act($0.n)) })
      expect(!c.isGood, "real: a \(Int(degrees))° turn doesn't verify (\(describe(c)))")
    }

    t = Date()
    let prior = await Task.detached { PriorPhotos.load(house: snapshot, zone: zone.id, excludingSession: nil) }.value
    let photoCount = house.bundle(for: house.sessions[0]).photos.count
    log("real: \(prior.count) of \(photoCount) photos have a depth frame (\(Int(Date().timeIntervalSince(t) * 1000)) ms)")
    expect(prior.count > photoCount / 3, "real: most photos get occlusion depth")
    expect(PriorPhotos.landmarks(house: house, zone: zone.id).count >= 2, "real: landmarks")
  }

  // MARK: fixtures

  private func captureUploadIdentity() throws {
    let house = "selftest-" + UUID().uuidString
    let first = PairedCaptureModel.captureID(houseID: house, sessionID: "session", legacyFolder: URL(fileURLWithPath: "/old-container/Documents/session"))
    let relocated = PairedCaptureModel.captureID(houseID: house, sessionID: "session", legacyFolder: URL(fileURLWithPath: "/new-container/Documents/session"))
    let other = PairedCaptureModel.captureID(houseID: house, sessionID: "other-session", legacyFolder: URL(fileURLWithPath: "/new-container/Documents/other-session"))
    expect(first == relocated, "upload resumes with the same identity after sandbox relocation")
    expect(first != other, "distinct sessions have distinct upload identities")
    let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("UploadPathCheck-" + UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let session = root.appendingPathComponent("2026-10-25 11.08.17", isDirectory: true)
    try FileManager.default.createDirectory(at: session.appendingPathComponent("depth"), withIntermediateDirectories: true)
    let bytes = Data([0, 1, 255])
    try bytes.write(to: session.appendingPathComponent("depth/00000.conf"))
    let files = try CaptureFiles.collect(session)
    expect(files.count == 1 && files[0].path == "depth/00000.conf", "device sandbox enumeration produces the correct relative depth path")
    let reopened = try Data(contentsOf: session.appendingPathComponent(files[0].path))
    expect(reopened == bytes, "upload reopens the enumerated depth file from the original sandbox URL")
  }

  private func objectDetailCompatibility() throws {
    let legacy = PhotoRecord(file: "photos/0000.jpg", room: 0, timestamp: 1, width: 1920, height: 1440,
      transform: matrix_identity_float4x4.columnMajor, intrinsics: [1400,0,0,0,1400,0,960,720,1],
      tracking: "normal", manual: true, exposure: 0.01, blurPixels: nil)
    let old = try JSONDecoder().decode(PhotoRecord.self, from: JSONEncoder().encode(legacy))
    expect(old.objectID == nil && old.referenceView == nil, "legacy photos decode without object-detail fields")
    var detail = legacy
    detail.objectID = "fixture-object"; detail.objectName = "Lamp"; detail.referenceView = "back"; detail.cleanReferenceReported = true
    let saved = try JSONDecoder().decode(PhotoRecord.self, from: JSONEncoder().encode(detail))
    expect(saved.objectID == detail.objectID && saved.referenceView == "back" && saved.cleanReferenceReported == true,
      "object-detail identity, view and clean-photo report round trip")
  }

  /// Same layout CoverageEngine.writePLY produces: a wall (z = -2, facing +z) and a floor
  private func localizationReferenceFormats() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let original = folder.appendingPathComponent("original.ply")
    try writeTestPLY(to: original)
    let baseline = try ZoneReference.reviewed(original)
    let live = baseline.index.points.enumerated().map { ZoneReference.LivePoint(p: $0.element, n: baseline.index.normals[$0.offset]) }
    var sessionFromReference = simd_float4x4(simd_quatf(angle: -.pi/4, axis: [0,1,0]))
    sessionFromReference.columns.3 = [3,0,-4,1]
    let movedReference = try ZoneReference.reviewed(original, sessionFromReference: sessionFromReference)
    let movedLive = live.map { ZoneReference.LivePoint(p: simd_make_float3(sessionFromReference*SIMD4($0.p,1)), n: simd_make_float3(sessionFromReference*SIMD4($0.n,0))) }
    expect(movedReference.check(movedLive).isGood, "reviewed geometry and normals transform into an earlier map before geometric validation")
    expect(!movedReference.check(live).isGood, "an earlier map cannot validate geometry in the wrong coordinate frame")
    for (coordinates, normals) in [("double", "double"), ("float64", "float32"), ("float", "float64")] {
      let url = folder.appendingPathComponent("\(coordinates)-\(normals).ply")
      try writeTestPLY(to: url, coordinateType: coordinates, normalType: normals)
      let decoded = try ZoneReference.reviewed(url)
      expect(decoded.sourceVertices == baseline.sourceVertices && decoded.index.points == baseline.index.points,
             "\(coordinates)/\(normals) reference preserves exact metre coordinates")
      expect(decoded.index.normals == baseline.index.normals && decoded.ghost?.triangleCount == baseline.ghost?.triangleCount,
             "\(coordinates)/\(normals) reference preserves normals and the alignment overlay")
      expect(decoded.check(live).isGood, "\(coordinates)/\(normals) reference passes matching-corner validation")
      let shifted = live.map { ZoneReference.LivePoint(p: $0.p + SIMD3(0.25,0,0.25), n: $0.n) }
      expect(!decoded.check(shifted).isGood, "\(coordinates)/\(normals) reference does not accept a shifted room")
      let truncated = Data(try Data(contentsOf: url).dropLast(20))
      try truncated.write(to: url)
      do { _ = try ZoneReference.reviewed(url); expect(false, "truncated reviewed faces rejected before capture") }
      catch { expect(true, "truncated reviewed faces rejected before capture") }
    }
    let missing = folder.appendingPathComponent("missing.ply")
    do { _ = try ZoneReference.reviewed(missing); expect(false, "missing reference fails preflight instead of waiting for room recognition") }
    catch { expect(true, "missing reference fails preflight instead of waiting for room recognition") }
    let malformed = folder.appendingPathComponent("malformed.ply")
    try Data("ply\nformat binary_little_endian 1.0\nelement vertex 9223372036854775807\nproperty double x\nproperty double y\nproperty double z\nelement face 0\nend_header\n".utf8).write(to: malformed)
    do { _ = try ZoneReference.reviewed(malformed); expect(false, "invalid vertex count is rejected without overflowing") }
    catch { expect(true, "invalid vertex count is rejected without overflowing") }
  }

  private func roomLocalizationSelection() throws {
    let hash = String(repeating: "a", count: 64)
    let room = RoomDetailGuide.Room(id: "entry", label: "Entrance", polygon: [[-2,-2],[2,-2],[2,2],[-2,2]], minY: 0, maxY: 3,
        targets: [.init(id: "t", label: "Corner", kind: "corner", position: [0,1,-1], normal: [0,0,1])])
    var second = room; second.id = "living"; second.label = "Living"; second.polygon = [[3,-2],[7,-2],[7,2],[3,2]]; second.targets[0].id = "other"
    let guide = RoomDetailGuide(format: "room-detail-guide/1", revision: "test", houseID: "home", floorStepID: "ground", modelFromReference: matrix_identity_float4x4.columnMajor, referenceMap: "map", referenceMapSHA256: hash, referenceMesh: "mesh", referenceMeshSHA256: hash, rooms: [room,second])
    let early = RoomLocalizationCatalog.Reference(id: "early", label: "Entry pass", roomIDs: ["entry","living"], mapFile: "early.map", mapSHA256: hash, referenceFromSession: matrix_identity_float4x4.columnMajor, provenance: "registered")
    var late = early; late.id = "late"; late.mapFile = "late.map"; late.roomIDs = ["living"]
    var catalog = RoomLocalizationCatalog(houseID: "home", floorStepID: "ground", guideSHA256: hash, references: [late,early], photos: [], preferredReferenceByRoom: ["entry":"early","living":"late"])
    try catalog.validate(guide: guide, expectedGuideHash: hash)
    expect(catalog.references(for: "entry").map(\.id) == ["early"], "Entrance never selects a later map with no declared entrance coverage")
    expect(catalog.references(for: "living").map(\.id) == ["late","early"], "each room prefers its own reviewed map while preserving eligible alternatives")
    do { try catalog.validate(guide: guide, expectedGuideHash: String(repeating: "b",count: 64)); expect(false,"stale recovery catalog rejected") } catch { expect(true,"stale recovery catalog rejected") }
    catalog.photos = [.init(roomID: "entry", file: "entry.jpg", sha256: hash, positionInModel: [4,1,0], forwardInModel: [0,0,-1])]
    do { try catalog.validate(guide: guide, expectedGuideHash: hash); expect(false,"a photo located in another room cannot be labelled as Entrance") } catch { expect(true,"a photo located in another room cannot be labelled as Entrance") }
    catalog.photos[0].positionInModel = [0,1,0]
    try catalog.validate(guide: guide, expectedGuideHash: hash)
    expect(true,"correctly positioned room photo accepted")
    catalog.references[0].referenceFromSession[0] = 2
    do { try catalog.validate(guide: guide, expectedGuideHash: hash); expect(false,"scaled recovery transforms rejected") } catch { expect(true,"scaled recovery transforms rejected") }
    catalog.references[0] = late; catalog.references[0].mapFile = "../another-home.map"
    do { try catalog.validate(guide: guide, expectedGuideHash: hash); expect(false,"recovery assets cannot escape their reviewed folder") } catch { expect(true,"recovery assets cannot escape their reviewed folder") }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let image = Data("not an image".utf8); try image.write(to: folder.appendingPathComponent("entry.jpg"))
    catalog.photos[0].sha256 = RoomDetailGuide.hash(image)
    do { _ = try catalog.landmarks(for: "entry", folder: folder); expect(false,"matching checksum does not accept an unreadable reference photo") } catch { expect(true,"matching checksum does not accept an unreadable reference photo") }
    expect(try catalog.landmarks(for: "living", folder: folder).isEmpty,"missing room photos never fall back to another room's images")
    catalog.photos[0].sha256 = hash
    do { _ = try catalog.landmarks(for: "entry", folder: folder); expect(false,"changed room photograph fails checksum") } catch { expect(true,"changed room photograph fails checksum") }
  }

  private func writeTestPLY(to url: URL, initialNormals: [SIMD3<Float>] = [], coordinateType: String = "float", normalType: String = "float") throws {
    var verts: [(SIMD3<Float>, SIMD3<Float>)] = []
    var faces: [(UInt32, UInt32, UInt32)] = []
    func grid(_ origin: SIMD3<Float>, _ u: SIMD3<Float>, _ v: SIMD3<Float>, _ n: SIMD3<Float>, _ nu: Int, _ nv: Int) {
      let base = UInt32(verts.count)
      for j in 0...nv { for i in 0...nu { verts.append((origin + u * Float(i) + v * Float(j), n)) } }
      let w = UInt32(nu + 1)
      for j in 0..<UInt32(nv) {
        for i in 0..<UInt32(nu) {
          let a = base + j * w + i
          faces.append((a, a + 1, a + w + 1))
          faces.append((a, a + w + 1, a + w))
        }
      }
    }
    grid(SIMD3(-1.5, 0, -2), SIMD3(0.03, 0, 0), SIMD3(0, 0.03, 0), SIMD3(0, 0, 1), 100, 80)
    grid(SIMD3(-1.5, 0, -2), SIMD3(0.03, 0, 0), SIMD3(0, 0, 0.03), SIMD3(0, 1, 0), 100, 60)
    grid(SIMD3(-1.5, 0, -2), SIMD3(0, 0, 0.03), SIMD3(0, 0.03, 0), SIMD3(1, 0, 0), 60, 80)
    var header = "ply\nformat binary_little_endian 1.0\n"
    header += "comment selftest\n"
    header += "element vertex \(verts.count)\nproperty \(coordinateType) x\nproperty \(coordinateType) y\nproperty \(coordinateType) z\n"
    header += "property \(normalType) nx\nproperty \(normalType) ny\nproperty \(normalType) nz\nproperty float coverage\n"
    header += "property uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar inroom\n"
    header += "element face \(faces.count)\nproperty list uchar uint vertex_indices\nproperty uchar class\nend_header\n"
    var data = Data(header.utf8)
    func put<T>(_ v: T) { withUnsafeBytes(of: v) { data.append(contentsOf: $0) } }
    for (i, vertex) in verts.enumerated() {
      let (p, normal) = vertex
      let n = i < initialNormals.count ? initialNormals[i] : normal
      if ["double", "float64"].contains(coordinateType) { put(Double(p.x)); put(Double(p.y)); put(Double(p.z)) }
      else { put(p.x); put(p.y); put(p.z) }
      if ["double", "float64"].contains(normalType) { put(Double(n.x)); put(Double(n.y)); put(Double(n.z)) }
      else { put(n.x); put(n.y); put(n.z) }
      put(Float(1))
      put(UInt8(52)); put(UInt8(199)); put(UInt8(89)); put(UInt8(1))
    }
    for f in faces { put(UInt8(3)); put(f.0); put(f.1); put(f.2); put(UInt8(1)) }
    try data.write(to: url)
  }

  /// One photo looking at the wall from 2 m, and a depth frame from the same spot (2 m everywhere)
  private func writeTestPhotos(_ bundle: ScanBundle) throws {
    let pose = matrix_identity_float4x4 // at the origin, looking down -z at the wall
    let photo = PhotoRecord(file: "photos/0000.jpg", room: 0, timestamp: 1, width: 1920, height: 1440, transform: pose.columnMajor,
                            intrinsics: [1400, 0, 0, 0, 1400, 0, 960, 720, 1], tracking: "normal", manual: false, exposure: 0.01, blurPixels: 0.5)
    try bundle.savePhotos([photo])
    try Data([0xFF, 0xD8, 0xFF, 0xD9]).write(to: bundle.file(photo.file))
    let w = 256, h = 192
    let depth = [Float16](repeating: 2, count: w * h).withUnsafeBufferPointer { Data(buffer: $0) }
    try ((depth as NSData).compressed(using: .zlib) as Data).write(to: bundle.file("depth/00000.f16z"))
    try Data(repeating: 2, count: w * h).write(to: bundle.file("depth/00000.conf"))
    let record = DepthRecorder.Record(file: "depth/00000.f16z", confidence: "depth/00000.conf", rgb: nil, rgbIntrinsics: nil, camera: nil, room: 0,
                                      timestamp: 1.05, width: w, height: h, transform: pose.columnMajor, intrinsics: [186.7, 0, 0, 0, 186.7, 0, 128, 96, 1])
    try JSONEncoder().encode([record]).write(to: bundle.file("depth/frames.json"))
  }
}
