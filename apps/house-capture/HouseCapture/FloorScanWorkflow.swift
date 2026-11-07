import Foundation
import CryptoKit

/// Checkpointing limits RoomPlan work while keeping the same ARSession alive.
enum FloorCapturePolicy {
    static let checkpointSeconds: TimeInterval = 120
    static let maximumSections = 12
    // A serialized tracking map is not a measurement of live memory pressure.
    // Floors outgrow the legacy room budget; retain a bounded pause/reload window.
    static let checkpointMapBudget = 128_000_000
    static let maximumResumeMapBytes = 256_000_000
    static func acceptsResumeMap(bytes: Int) -> Bool { bytes > 0 && bytes <= maximumResumeMapBytes }
    static func shouldPause(sections: Int, mapBytes: Int, memoryWarning: Bool) -> Bool {
        sections >= maximumSections || mapBytes >= checkpointMapBudget || memoryWarning
    }
    static func checkpointDue(elapsed: TimeInterval, tracking: Bool, paused: Bool, walls: Int, interval: TimeInterval = checkpointSeconds) -> Bool {
        elapsed >= interval && tracking && !paused && walls > 0
    }
}

/// Evidence checks are deliberately separate from the user's whole-floor coverage review.
struct FloorStructureEvidence: Equatable {
    var sessionIDs: [String]
    var signatures: [String: String]
    var wallObservations: Int
    var depthFrames: Int
    var meshFaces: Int
    var issues: [String]
    var usable: Bool { !sessionIDs.isEmpty && issues.isEmpty }

    static func evaluate(sessions: [HouseProject.Session], manifests: [Manifest], signatures: [String: String],
                         depthFrames: Int, merged: Bool, trackingDiscontinuity: Bool, isConnector: Bool = false) -> Self {
        let rooms = manifests.flatMap(\.rooms)
        let walls = rooms.reduce(0) { $0 + $1.walls }
        let faces = rooms.reduce(0) { $0 + ($1.mesh?.faces ?? 0) }
        var issues: [String] = []
        if sessions.isEmpty || sessions.contains(where: { $0.endedAt == nil }) { issues.append("Finish and save the floor capture.") }
        if manifests.count != sessions.count || signatures.count != sessions.count { issues.append("A saved capture index is missing or unreadable.") }
        if manifests.contains(where: { !$0.rooms.contains(where: \.hasMeasuredGeometry) }) { issues.append("One capture part has no measured geometry. Start a fresh floor attempt; the failed files stay saved.") }
        if !isConnector && walls < 4 { issues.append("Too few measured walls. Include the surrounding fixed walls.") }
        if faces == 0 || depthFrames == 0 { issues.append("LiDAR mesh or depth is missing. Continue the structure scan.") }
        if !merged && !isConnector { issues.append("The structural sections have not merged successfully. Review the saved parts before retrying.") }
        if Set(sessions.map(\.zone)).count > 1 || sessions.contains(where: { !HouseProject.zoneFrameMethods.contains($0.alignment.method) }) {
            issues.append("Capture parts do not share a verified tracking frame. They cannot confirm one floor yet.")
        }
        if trackingDiscontinuity { issues.append("Tracking or alignment changed during capture. Review and register the saved parts on the Mac before confirming this floor.") }
        return .init(sessionIDs: sessions.map(\.id), signatures: signatures, wallObservations: walls,
                     depthFrames: depthFrames, meshFaces: faces, issues: issues)
    }

    static func load(house: HouseProject, sessions: [HouseProject.Session]) -> Self {
        var manifests: [Manifest] = [], signatures: [String: String] = [:]
        var depth = 0, merged = !sessions.isEmpty, jump = false
        for session in sessions {
            let bundle = house.bundle(for: session)
            if let manifest = bundle.manifest, let data = try? Data(contentsOf: bundle.file("manifest.json")) {
                manifests.append(manifest)
                signatures[session.id] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            }
            depth += bundle.depthFrames.count
            merged = merged && FileManager.default.fileExists(atPath: bundle.file("structure.json").path)
            if let diagnostics = bundle.manifest?.diagnostics,
               diagnostics.alignmentInvalidated == true || diagnostics.events?.contains(where: { $0.what.hasPrefix("alignment drift:") }) == true { jump = true }
            if bundle.manifest?.diagnostics?.worldJumps.contains(where: { $0.phase == "scanning" || $0.phase == "finishingRoom" }) == true { jump = true }
        }
        // Cross-session alignment also needs a successful zone merge, not just per-part structures.
        if sessions.count > 1, let zone = sessions.first?.zone {
            merged = merged && FileManager.default.fileExists(atPath: house.url.appendingPathComponent("zones/\(zone)/structure.json").path)
        }
        return evaluate(sessions: sessions, manifests: manifests, signatures: signatures,
                        depthFrames: depth, merged: merged, trackingDiscontinuity: jump,
                        isConnector: sessions.first.flatMap { GuidedCaptureContext.load(in: house.bundle(for: $0).url) }?.step.isConnector == true)
    }
}

struct FloorStructureReview: Codable, Equatable {
    var format = "floor-structure-review/1"
    var routeID: String
    var stepID: String
    var houseID: String
    var sessionIDs: [String]
    var captureSignatures: [String: String]
    var reviewedAreas: Set<String>
    var boundariesReviewed: Bool
    var openingsReviewed: Bool
    var reflectionsReviewed: Bool
    var reviewedAt: Date
    // This is a capture-readiness review, never acceptance of global coordinates or accuracy.
    var alignmentVerified = false
    static let filename = "structure-review.json"

    func matches(routeID: String, step: GuidedRoute.Step, houseID: String, evidence: FloorStructureEvidence) -> Bool {
        format == "floor-structure-review/1" && self.routeID == routeID && stepID == step.id && self.houseID == houseID &&
        evidence.usable && sessionIDs == evidence.sessionIDs && captureSignatures == evidence.signatures &&
        Set(step.areas ?? []).isSubset(of: reviewedAreas) && boundariesReviewed && openingsReviewed && reflectionsReviewed
    }
    static func permitsUpload(house: HouseProject, session: HouseProject.Session) -> Bool {
        guard let context = GuidedCaptureContext.load(in: house.bundle(for: session).url), context.step.isStructure else { return true }
        // A completed original can be sent for repair before its floor is accepted.
        // Transfer success never bypasses structureReviewed when advancing the route.
        guard session.endedAt != nil, let manifest = house.bundle(for: session).manifest,
              manifest.endedAt != nil, !manifest.rooms.isEmpty else { return false }
        return true
    }

    func save(in folder: URL) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(self).write(to: folder.appendingPathComponent(Self.filename), options: .atomic)
    }
    static func load(in folder: URL) -> Self? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(filename)) else { return nil }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(Self.self, from: data)
    }
}
