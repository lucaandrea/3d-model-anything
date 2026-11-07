import Foundation

/// A private, user-supplied itinerary. Sequence describes walking order, never geometry.
struct GuidedRoute: Codable, Equatable {
    var format = "scan-route/1"
    var id: String
    var title: String
    var steps: [Step]

    struct Step: Codable, Identifiable, Equatable {
        var id: String
        var title: String
        var floor: String
        var instructions: String
        var overlap: String
        var doorState: String
        var checkpoints: [String]
        var mirrors: [Mirror]
        var optional: Bool
        /// Absent on legacy room routes. The floor workflow keeps these phases distinct.
        var phase: String? = nil
        var floorID: String? = nil
        var areas: [String]? = nil
        var isStructure: Bool { phase == "structure" || phase == "connector" }
        var isConnector: Bool { phase == "connector" }
        var isDetail: Bool { phase == "details" }
    }

    struct Mirror: Codable, Identifiable, Equatable {
        var id: String
        var label: String
        var cardID: String
    }

    static var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    static var configurationURL: URL { documents.appendingPathComponent("ScanRoute.json") }
    static var stateURL: URL { documents.appendingPathComponent("ScanRouteState.json") }

    static func load() throws -> GuidedRoute {
        let route = try JSONDecoder().decode(Self.self, from: Data(contentsOf: configurationURL))
        try route.validate()
        return route
    }

    func validate() throws {
        guard format == "scan-route/1", !id.isEmpty, !title.isEmpty, !steps.isEmpty, steps.count <= 100,
              Set(steps.map(\.id)).count == steps.count,
              steps.allSatisfy({ !$0.id.isEmpty && !$0.title.isEmpty }),
              steps.allSatisfy({ $0.phase == nil || ["structure", "connector", "details"].contains($0.phase!) }),
              steps.filter(\.isStructure).allSatisfy({ !$0.optional && $0.floorID?.isEmpty == false && !($0.areas ?? []).isEmpty && Set($0.areas ?? []).count == ($0.areas ?? []).count }) else {
            throw GuidedRouteError("The scan route has missing or duplicate identifiers. Keep the previous route and correct the configuration.")
        }
        // Reusing a mirror in the structure and detail phases is intentional. Its identity must agree.
        var mirrors: [String: Mirror] = [:]
        var cards: [String: String] = [:]
        for mirror in steps.flatMap(\.mirrors) {
            guard mirrors[mirror.id] == nil || mirrors[mirror.id] == mirror,
                  cards[mirror.cardID] == nil || cards[mirror.cardID] == mirror.id else {
                throw GuidedRouteError("A mirror card has conflicting assignments.")
            }
            mirrors[mirror.id] = mirror; cards[mirror.cardID] = mirror.id
        }
        if let firstDetail = steps.firstIndex(where: \.isDetail), steps[firstDetail...].contains(where: \.isStructure) {
            throw GuidedRouteError("Finish all required floor structure steps before the detail steps.")
        }
    }
}

struct GuidedRouteError: LocalizedError {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Bundled with each session and transferred unchanged. Mirror labels are review evidence,
/// not automatic depth masks, accepted planes, device assignments or house anchors.
struct GuidedCaptureContext: Codable, Equatable {
    var format = "guided-capture/1"
    var routeID: String
    var step: GuidedRoute.Step
    var sequence: Int
    var previousStepID: String?
    var houseID: String
    var sessionID: String
    var zoneID: String
    var mirrorPreparation: String
    var alignmentVerified = false
    var reflectiveGeometryNeedsReview: Bool
    var automaticReflectionRemoval = false
    var phase: String? = nil
    var floorID: String? = nil
    /// A fresh floor attempt never silently combines geometry with an earlier attempt.
    var attemptID: String? = nil
    static let filename = "route-step.json"

    func save(in folder: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: folder.appendingPathComponent(Self.filename), options: .atomic)
    }

    static func load(in folder: URL) -> Self? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(filename)) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}

struct GuidedRouteState: Codable, Equatable {
    var routeID: String
    var houseID: String?
    var skipped: Set<String> = []
    /// Separate from checksum-verified receipts. The app cannot independently verify AirDrop.
    var airDropConfirmed: Set<String> = []
    var uploadDeferred: Set<String> = []
    var preferredDetailFloorID: String? = nil
    var preferredDetailStepID: String? = nil

    func save() throws {
        try JSONEncoder().encode(self).write(to: GuidedRoute.stateURL, options: .atomic)
    }

    static func load(routeID: String) throws -> Self {
        guard FileManager.default.fileExists(atPath: GuidedRoute.stateURL.path) else { return .init(routeID: routeID) }
        let state = try JSONDecoder().decode(Self.self, from: Data(contentsOf: GuidedRoute.stateURL))
        guard state.routeID == routeID else { throw GuidedRouteError("The saved progress belongs to another route. Archive that collection before changing routes.") }
        return state
    }

    func mayAdvance(step: GuidedRoute.Step, session: HouseProject.Session?, verifiedOnMac: Bool) -> Bool {
        if step.optional && skipped.contains(step.id) { return true }
        guard let session, session.endedAt != nil, !session.rooms.isEmpty else { return false }
        return verifiedOnMac || airDropConfirmed.contains(session.id) || uploadDeferred.contains(session.id)
    }
}
