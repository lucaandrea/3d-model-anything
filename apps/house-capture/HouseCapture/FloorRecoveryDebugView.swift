#if DEBUG
import ARKit
import SwiftUI

/// Read-only recovery qualification on a physical phone. Never creates a capture or runs AR.
struct FloorRecoveryDebugView: View {
    @State private var status = "Checking saved floor…"
    var body: some View {
        Text(status).padding().task {
            do {
                if ProcessInfo.processInfo.arguments.contains("-audit-detail-maps") {
                    try await Task.detached(priority: .userInitiated) { try Self.auditMaps() }.value
                    status = "Saved map audit written. Camera was not started."
                    return
                }
                var report = try await Task.detached(priority: .userInitiated) { () -> [String: String] in
                    guard let house = HouseProject.all().last,
                          let group = FloorScanLibrary.groups(in: house).last,
                          let zone = house.zone(group.context.zoneID),
                          let url = house.existingWorldMap(zone: zone) else { throw GuidedRouteError("No saved floor map.") }
                    let start = Date()
                    let map = try WorldMapFile.load(url)
                    let ref = ZoneReference.load(house: house, zone: zone.id, excludingSession: nil)
                    let evidence = FloorStructureEvidence.load(house: house, sessions: group.sessions)
                    return ["house": house.id, "zone": zone.id, "attemptID": group.context.attemptID ?? "",
                        "checkpoints": String(group.checkpointCount), "groups": String(FloorScanLibrary.groups(in: house).count),
                        "worldMapBytes": String((try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0),
                        "featurePoints": String(map.rawFeaturePoints.points.count), "anchors": String(map.anchors.count),
                        "referenceVertices": String(ref.sourceVertices), "referenceErrors": ref.errors.joined(separator: "; "),
                        "referenceUsable": String(!ref.isEmpty), "evidenceUsable": String(evidence.usable),
                        "evidenceIssues": evidence.issues.joined(separator: "; "),
                        "seconds": String(Date().timeIntervalSince(start)),
                        "memoryMB": String(Diagnostics.memoryFootprintMB() ?? -1)]
                }.value
                let route = GuidedRouteModel()
                let paired = PairedCaptureModel.shared
                paired.reconnect()
                for _ in 0..<20 where !paired.connected { try await Task.sleep(for: .milliseconds(500)) }
                report["captureMacConnected"] = String(paired.connected)
                report["markerCount"] = String(paired.kit?.markers.count ?? 0)
                report["nextStep"] = route.current?.id ?? "none"
                report["macReviewedFloors"] = route.macReviews.keys.sorted().joined(separator: ",")
                report["availableDetailRooms"] = route.route?.steps.filter { route.detailAvailable($0) }.map(\.id).joined(separator: ",") ?? ""
                for floor in route.route?.steps.filter({ route.macReviews[$0.id]?.detailGuideSHA256 != nil }) ?? [] {
                if let house = route.house,
                   let review = route.macReviews[floor.id], let hash = review.detailGuideSHA256,
                   let folder = FloorMacReview.folder(house: house, stepID: floor.id) {
                    let prepared = try await Task.detached(priority: .userInitiated) {
                        try PreparedDetailReference.load(folder: folder, expectedHash: hash, houseID: house.id, floorStepID: floor.id, localizationHash: review.localizationSHA256)
                    }.value
                    let guide = prepared.guide
                    report["detailGuideRooms"] = String(guide.rooms.count)
                    report["detailGuideTargets"] = String(guide.rooms.reduce(0) { $0+$1.targets.count })
                    report["detailGuideAssetsVerified"] = "true"
                    report["\(floor.id).guideRooms"] = String(guide.rooms.count)
                    report["\(floor.id).guideTargets"] = String(guide.rooms.reduce(0) { $0+$1.targets.count })
                    report["\(floor.id).preparedMapFeatures"] = String(prepared.map.rawFeaturePoints.points.count)
                    report["\(floor.id).preparedMeshVertices"] = String(prepared.mesh.sourceVertices)
                    report["\(floor.id).preparedIndexPoints"] = String(prepared.mesh.index.points.count)
                    report["\(floor.id).preparedGhostTriangles"] = String(prepared.mesh.ghost?.triangleCount ?? 0)
                    report["\(floor.id).preparedReferenceErrors"] = prepared.mesh.errors.joined(separator: "; ")
                    if let localizationHash = review.localizationSHA256 {
                        let catalog = try RoomLocalizationCatalog.load(folder: folder, hash: localizationHash, guide: guide, guideHash: hash)
                        for room in guide.rooms {
                            report["\(room.id).landmarks"] = String(try catalog.landmarks(for: room.id, folder: folder).count)
                            report["\(room.id).preferredMap"] = catalog.references(for: room.id).first?.id ?? "missing"
                        }
                        for candidate in catalog.references {
                            let checked = try await Task.detached(priority: .userInitiated) {
                                try PreparedDetailReference.load(folder: folder, expectedHash: hash, houseID: house.id,
                                    floorStepID: floor.id, selectedRoomID: candidate.roomIDs[0],
                                    localizationHash: localizationHash, referenceID: candidate.id)
                            }.value
                            report["\(candidate.id).mapFeatures"] = String(checked.map.rawFeaturePoints.points.count)
                            report["\(candidate.id).meshVertices"] = String(checked.mesh.sourceVertices)
                            report["\(candidate.id).meshErrors"] = checked.mesh.errors.joined(separator: "; ")
                        }
                    }
                }
                }
                try JSONEncoder().encode(report).write(to: GuidedRoute.documents.appendingPathComponent("floor-recovery-check.json"), options: .atomic)
                status = "Saved floor checked. Originals unchanged."
                print("FLOOR-RECOVERY: \(report)")
            } catch { status = error.localizedDescription; print("FLOOR-RECOVERY-ERROR: \(status)") }
        }
    }
    /// DEBUG-only inspection of the actual archived visual-feature coverage; never starts AR.
    private static func auditMaps() throws {
        struct MapAudit: Codable {
            var source: String
            var hash: String
            var features: [[Float]]
            var center: [Float]
            var extent: [Float]
        }
        guard let house = HouseProject.all().last else { throw GuidedRouteError("No house to audit.") }
        var inputs: [(String, URL)] = house.sessions.compactMap { session in
            let url = house.bundle(for: session).file(WorldMapFile.sessionFile)
            return FileManager.default.fileExists(atPath: url.path) ? (session.id, url) : nil
        }
        for floor in ["ground-structure", "upstairs-structure"] {
            if let folder = FloorMacReview.folder(house: house, stepID: floor) {
                inputs.append((floor, folder.appendingPathComponent("reference.arworldmap")))
            }
        }
        var results: [MapAudit] = []
        for (source, url) in inputs {
            let map = try WorldMapFile.load(url)
            results.append(.init(source: source, hash: RoomDetailGuide.hash(try Data(contentsOf: url)),
                features: map.rawFeaturePoints.points.map { [$0.x, $0.y, $0.z] },
                center: [map.center.x, map.center.y, map.center.z], extent: [map.extent.x, map.extent.y, map.extent.z]))
        }
        try JSONEncoder().encode(results).write(to: GuidedRoute.documents.appendingPathComponent("detail-map-audit.json"), options: .atomic)
    }

}
#endif
