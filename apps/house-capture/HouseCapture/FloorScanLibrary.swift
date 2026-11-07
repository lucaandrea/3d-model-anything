import Foundation

/// Presentation only: keep every original room record and capture file intact.
struct FloorScanGroup: Identifiable {
    var id: String
    var context: GuidedCaptureContext
    var sessions: [HouseProject.Session]
    var roomIDs: Set<String>
    var checkpointCount: Int { sessions.reduce(0) { $0 + $1.rooms.count } }
}

enum FloorScanLibrary {
    static func context(house: HouseProject, session: HouseProject.Session, route: GuidedRoute? = nil) -> GuidedCaptureContext? {
        guard let context = GuidedCaptureContext.load(in: house.bundle(for: session).url),
              context.step.isStructure, context.phase == context.step.phase,
              context.houseID == house.id, context.sessionID == session.id,
              context.zoneID == session.zone else { return nil }
        let folder = house.bundle(for: session).url
        if let data = try? Data(contentsOf: house.url.appendingPathComponent("reviews/capture-route-review.json")),
           let review = try? JSONDecoder().decode(CaptureRouteReview.self, from: data),
           let route = route ?? (try? GuidedRoute.load()),
           let manifest = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")),
           let original = try? Data(contentsOf: folder.appendingPathComponent("route-step.json")),
           let corrected = review.resolve(context, route: route, manifestHash: RoomDetailGuide.hash(manifest), contextHash: RoomDetailGuide.hash(original)) {
            return corrected
        }
        return context
    }

    static func groups(in house: HouseProject) -> [FloorScanGroup] {
        var groups: [FloorScanGroup] = []
        for session in house.sessions.sorted(by: { $0.startedAt < $1.startedAt }) {
            guard let context = context(house: house, session: session) else { continue }
            let key = [context.routeID, context.step.id, context.attemptID ?? session.id].joined(separator: "/")
            let roomIDs = Set(house.rooms.filter { room in room.history.contains { $0.session == session.id } }.map(\.id))
            if let i = groups.firstIndex(where: { $0.id == key }) {
                groups[i].sessions.append(session)
                groups[i].roomIDs.formUnion(roomIDs)
            } else {
                groups.append(.init(id: key, context: context, sessions: [session], roomIDs: roomIDs))
            }
        }
        return groups
    }

    static func continuation(house: HouseProject, roomID: String?, zoneID: String?) -> GuidedCaptureContext? {
        if let roomID, let ref = house.rooms.first(where: { $0.id == roomID })?.active,
           let session = house.session(ref.session) { return context(house: house, session: session) }
        return groups(in: house).last(where: { zoneID == nil || $0.context.zoneID == zoneID })?.context
    }

    static func summary(house: HouseProject, groups: [FloorScanGroup]) -> String {
        let floorRooms = groups.reduce(into: Set<String>()) { $0.formUnion($1.roomIDs) }
        let rooms = house.rooms.filter { !floorRooms.contains($0.id) }.count
        if groups.isEmpty { return "\(rooms) room\(rooms == 1 ? "" : "s")" }
        let checkpoints = groups.reduce(0) { $0 + $1.checkpointCount }
        return "\(groups.count) floor capture\(groups.count == 1 ? "" : "s") · \(checkpoints) checkpoints"
            + (rooms > 0 ? " · \(rooms) detail rooms" : "")
    }
}

/// A Mac-reviewed label correction, bound to the original files. It never moves
/// geometry or changes a capture's alignment; the separate model review does that.
struct CaptureRouteReview: Codable {
    var format: String
    var houseID: String
    var routeID: String
    var entries: [Entry]
    struct Entry: Codable {
        var sessionID: String
        var originalStepID: String
        var stepID: String
        var attemptID: String
        var manifestSHA256: String
        var contextSHA256: String
        var reason: String
    }
    func resolve(_ original: GuidedCaptureContext, route: GuidedRoute, manifestHash: String, contextHash: String) -> GuidedCaptureContext? {
        guard format == "capture-route-review/1", houseID == original.houseID,
              routeID == original.routeID, routeID == route.id,
              Set(entries.map(\.sessionID)).count == entries.count,
              let entry = entries.first(where: { $0.sessionID == original.sessionID }),
              entry.originalStepID == original.step.id, !entry.attemptID.isEmpty, !entry.reason.isEmpty,
              RoomDetailGuide.validHash(entry.manifestSHA256), RoomDetailGuide.validHash(entry.contextSHA256),
              entry.manifestSHA256 == manifestHash, entry.contextSHA256 == contextHash,
              original.step.isStructure,
              let index = route.steps.firstIndex(where: { $0.id == entry.stepID && $0.isStructure }) else { return nil }
        var corrected = original
        corrected.step = route.steps[index]; corrected.phase = corrected.step.phase
        corrected.floorID = corrected.step.floorID; corrected.sequence = index + 1
        corrected.previousStepID = index > 0 ? route.steps[index - 1].id : nil
        corrected.attemptID = entry.attemptID
        return corrected
    }
}
