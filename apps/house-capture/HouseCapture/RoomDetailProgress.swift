import Foundation
import Observation
import simd

/// Persists only quality-checked views of the reviewed targets. Repeated weak images
/// cannot accumulate to completion. Unseen/hidden objects are explicitly outside this metric.
@MainActor @Observable
final class RoomDetailProgress {
    struct Saved: Codable {
        var format = "room-detail-progress/1"
        var guideRevision: String
        var guideSHA256: String? = nil
        var quality: [String: Float]
        var acceptedPhotos: Int
    }
    let guide: RoomDetailGuide
    let selectedRoomID: String
    let folder: URL
    let progressURL: URL
    private(set) var sessionReference: DetailSessionReference?
    var modelFromSession: simd_float4x4 {
        simd_float4x4(columnMajor: guide.modelFromReference) * simd_float4x4(columnMajor: sessionReference?.referenceFromSession ?? matrix_identity_float4x4.columnMajor)
    }
    struct ReviewedScope {
        var targets: [CoverageEngine.Target]
        var outline: [SIMD2<Float>]
        var floor: Float
        var ceiling: Float
    }
    /// One transform for coverage, photography and guidance, including alternate maps.
    var reviewedScope: ReviewedScope? {
        guard let room = selectedRoom else { return nil }
        let sessionFromModel = modelFromSession.inverse
        func point(_ p: SIMD3<Float>) -> SIMD3<Float> {
            simd_make_float3(sessionFromModel * SIMD4(p, 1))
        }
        let lower = room.polygon.map { point([$0[0], room.minY, $0[1]]) }
        let upper = room.polygon.map { point([$0[0], room.maxY, $0[1]]) }
        let middle = room.polygon.map { point([$0[0], (room.minY + room.maxY)/2, $0[1]]) }
        return ReviewedScope(targets: room.targets.map {
            CoverageEngine.Target(position: point(SIMD3($0.position)),
                normal: simd_normalize(simd_make_float3(sessionFromModel * SIMD4(SIMD3($0.normal), 0))), area: 1)
        }, outline: middle.map { SIMD2($0.x, $0.z) },
           floor: (lower + upper).map(\.y).min() ?? -10,
           ceiling: (lower + upper).map(\.y).max() ?? 10)
    }
    var photoFeedback = "Photos save automatically as you move slowly. The shutter also saves a view."
    var detectedRoomID: String?
    var locationStatus = "Find your position in the saved floor"
    var instruction = "Aim at fixed corners in the previously scanned area."
    var saved: Saved
    var saveError: String?
    var nextTarget: RoomDetailGuide.Target?
    var cameraInModel: SIMD3<Float>?
    var lastImprovementAt = Date()
    private var candidateRoom: String?
    private var stableFrames = 0
    private var locationConfirmed = false
    private var lastViewFromSession: simd_float4x4?
    private var liveDepth: CoverageEngine.DepthGrid?
    var selectedRoom: RoomDetailGuide.Room? { guide.rooms.first { $0.id == selectedRoomID } }
    var percent: Int { percent(roomID: selectedRoomID) }
    var needsViews: Int { selectedRoom?.targets.filter { (saved.quality[$0.id] ?? 0)<CoverageEngine.goodScore }.count ?? 0 }
    var locationReady: Bool { locationConfirmed && detectedRoomID == selectedRoomID }
    var targetCount: Int { selectedRoom?.targets.count ?? 0 }
    var completedCount: Int { targetCount - needsViews }
    var detectedRoomName: String? { guide.rooms.first { $0.id == detectedRoomID }?.label }
    func completedTargets(in room: RoomDetailGuide.Room) -> Int {
        room.targets.filter { (saved.quality[$0.id] ?? 0) >= CoverageEngine.goodScore }.count
    }
    func remaining(kind: String) -> Int {
        selectedRoom?.targets.filter { $0.kind == kind && (saved.quality[$0.id] ?? 0) < CoverageEngine.goodScore }.count ?? 0
    }

    init(guide: RoomDetailGuide, selectedRoomID: String, folder: URL, progressURL: URL, sessionReference: DetailSessionReference? = nil) {
        self.guide = guide; self.selectedRoomID = selectedRoomID; self.folder = folder; self.progressURL = progressURL
        self.sessionReference = sessionReference
        if let data = try? Data(contentsOf: progressURL), let existing = try? JSONDecoder().decode(Saved.self, from: data), existing.format == "room-detail-progress/1", existing.guideRevision == guide.revision, existing.guideSHA256 == guide.fingerprint, existing.quality.values.allSatisfy({ $0.isFinite && $0>=0 && $0<=1 }) {
            saved = existing
        } else { saved = .init(guideRevision: guide.revision, guideSHA256: guide.fingerprint, quality: [:], acceptedPhotos: 0) }
    }
    func useReference(_ reference: DetailSessionReference, bundle: URL) {
        sessionReference = reference
        update(camera: nil, localized: false)
        persist(bundle: bundle)
    }
    func percent(roomID: String) -> Int {
        guard let room = guide.rooms.first(where: { $0.id == roomID }), !room.targets.isEmpty else { return 0 }
        return Int(100 * Double(completedTargets(in: room)) / Double(room.targets.count))
    }
    func update(camera: simd_float4x4?, viewFromSession: simd_float4x4? = nil,
                liveDepth: CoverageEngine.DepthGrid? = nil, localized: Bool) {
        self.liveDepth = liveDepth
        guard localized, let camera else {
            locationConfirmed = false; detectedRoomID = nil; candidateRoom = nil; stableFrames = 0
            nextTarget = nil; cameraInModel = nil; lastViewFromSession = nil
            locationStatus = "Location not verified · progress paused"
            instruction = "Return to a saved fixed corner and move slowly to recover position."
            return
        }
        let pose = modelFromSession*camera
        cameraInModel = simd_make_float3(pose.columns.3)
        lastViewFromSession = viewFromSession ?? camera.inverse
        let id = guide.room(at: simd_make_float3(pose.columns.3))?.id
        if id == candidateRoom { stableFrames += 1 } else { candidateRoom = id; stableFrames = 1 }
        // Caller updates at 1 Hz. Wait for three observations to avoid doorway flicker.
        guard stableFrames >= 3, let id else {
            locationConfirmed = false; detectedRoomID = nil; nextTarget = nil
            locationStatus = "At a room boundary · checking position"
            instruction = "Move slightly into the room and hold the view steady."
            return
        }
        detectedRoomID = id; locationConfirmed = true
        let name = guide.rooms.first { $0.id == id }?.label ?? id
        locationStatus = "Located in \(name)"
        guard id == selectedRoomID else {
            nextTarget = nil
            instruction = "You entered \(name). Save this pass, then choose that room. Progress for \(selectedRoom?.label ?? "this room") is paused."
            return
        }
        updateInstruction(viewFromSession: viewFromSession ?? camera.inverse)
    }
    private func updateInstruction(viewFromSession: simd_float4x4) {
        let sessionFromModel = modelFromSession.inverse
        let cam = simd_make_float3(viewFromSession.inverse.columns.3)
        let missing = (selectedRoom?.targets ?? []).filter { (saved.quality[$0.id] ?? 0) < CoverageEngine.goodScore }
        guard !missing.isEmpty else {
            nextTarget = nil
            instruction = "Planned views have clear photos. Check small and hidden objects before saving."
            return
        }
        // The display view matrix, not the sensor pose, defines left/right and up/down.
        // Do not send the user toward a back face or through a surface visible in LiDAR.
        let accessible = missing.filter { target in
            let p = simd_make_float3(sessionFromModel * SIMD4(SIMD3(target.position), 1))
            let n = simd_make_float3(sessionFromModel * SIMD4(SIMD3(target.normal), 0))
            return (target.kind == "corner" || simd_dot(n, cam-p) > 0) && !Self.occluded(p, by: liveDepth)
        }
        func priority(_ target: RoomDetailGuide.Target) -> Float {
            let local = viewFromSession * sessionFromModel * SIMD4(SIMD3(target.position), 1)
            let distance = simd_length(simd_make_float3(local))
            let offscreen = local.z >= 0 ? Float(8) : abs(local.x) / max(0.1, -local.z)
            return distance + offscreen + (target.kind == "corner" ? 0.5 : 0)
        }
        guard let best = accessible.min(by: { priority($0) < priority($1) }) else {
            nextTarget = nil
            instruction = "Pan slowly to another accessible object. Hidden surfaces can wait; save useful photos with the shutter."
            return
        }
        let target = nextTarget.flatMap { old in accessible.first { $0.id == old.id && priority($0) < priority(best) + 0.5 } } ?? best
        nextTarget = target
        let local = viewFromSession * sessionFromModel * SIMD4(SIMD3(target.position), 1)
        let distance = simd_length(simd_make_float3(local))
        let direction = Self.direction(to: simd_make_float3(local))
        let label = target.label.replacingOccurrences(of: #"\b(sofa|chair|storage|table|bed) \d+"#, with: "$1", options: .regularExpression)
        instruction = "\(direction) · \(label) · \(String(format: "%.1f", distance)) m"
    }
    static func direction(to local: SIMD3<Float>) -> String {
        if local.z >= 0 { return "Pan slowly to find the next view" }
        if abs(local.x) > -local.z * 0.35 { return local.x > 0 ? "Look right" : "Look left" }
        if local.y > 0.6 { return "Aim higher" }
        if local.y < -0.8 { return "Aim lower" }
        return simd_length(local) > 2.2 ? "Move closer if accessible" : "Hold a clear, steady view"
    }
    static func occluded(_ point: SIMD3<Float>, by grid: CoverageEngine.DepthGrid?) -> Bool {
        guard let grid, let sample = depthSample(grid, point: point) else { return false }
        return sample.observed + 0.15 + 0.03*sample.expected < sample.expected
    }
    func record(_ photo: CoverageEngine.Photo, bundle: URL) {
        guard locationReady, let room = selectedRoom, photo.depth != nil,
              guide.room(at: simd_make_float3(modelFromSession*SIMD4(photo.position,1)))?.id == selectedRoomID else {
            photoFeedback = "Photo saved. Planned-view progress waits for a verified room position and depth."
            return
        }
        let completedBefore = completedCount
        let worldFromModel = modelFromSession.inverse
        var improved = false
        for t in room.targets {
            let p = simd_make_float3(worldFromModel*SIMD4(SIMD3(t.position),1))
            let n = simd_normalize(simd_make_float3(worldFromModel*SIMD4(SIMD3(t.normal),0)))
            guard Self.depthSupports(photo, point: p) else { continue }
            let quality = CoverageEngine.contribution(photo,p,n,twoSided: t.kind == "corner")
            if quality > (saved.quality[t.id] ?? 0) { saved.quality[t.id] = quality; improved = true }
        }
        saved.acceptedPhotos += 1
        if improved {
            lastImprovementAt = Date()
            if let lastViewFromSession { updateInstruction(viewFromSession: lastViewFromSession) }
        }
        let completed = completedCount - completedBefore
        photoFeedback = completed > 0 ? "Photo saved · \(completed) more planned view\(completed == 1 ? "" : "s") completed."
            : improved ? "Photo saved · clearer detail added."
            : "Photo saved for the model. Try another angle for new planned views."
        persist(bundle: bundle)
    }
    static func depthSupports(_ photo: CoverageEngine.Photo, point: SIMD3<Float>) -> Bool {
        guard let grid = photo.depth, let sample = depthSample(grid, point: point) else { return false }
        return abs(sample.observed-sample.expected)<0.12+0.025*sample.expected
    }
    private static func depthSample(_ g: CoverageEngine.DepthGrid, point: SIMD3<Float>) -> (observed: Float, expected: Float)? {
        let c = g.worldToCamera*SIMD4(point,1), d = -c.z
        guard d>0.1 else { return nil }
        let projectedX = g.fx*c.x/d+g.cx, projectedY = g.fy * -c.y/d+g.cy
        guard projectedX.isFinite, projectedY.isFinite, projectedX>=0, projectedX<Float(g.width), projectedY>=0, projectedY<Float(g.height), g.width>0, g.height>0, g.width<=4096, g.height<=4096, g.values.count==g.width*g.height else { return nil }
        let observed = g.values[Int(projectedY)*g.width+Int(projectedX)]
        guard observed.isFinite && observed>0 else { return nil }
        return (observed, d)
    }
    func persist(bundle: URL) {
        do {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(saved)
            try data.write(to: progressURL, options: .atomic)
            try data.write(to: bundle.appendingPathComponent("detail-progress.json"), options: .atomic)
            let guideURL = bundle.appendingPathComponent("detail-guide.json")
            if !FileManager.default.fileExists(atPath: guideURL.path) { try encoder.encode(guide).write(to: guideURL, options: .atomic) }
            if let sessionReference {
                try encoder.encode(sessionReference).write(to: bundle.appendingPathComponent("detail-reference.json"), options: .atomic)
            }
            saveError = nil
        } catch { saveError = "Detail progress could not be saved: \(error.localizedDescription)" }
    }
}
