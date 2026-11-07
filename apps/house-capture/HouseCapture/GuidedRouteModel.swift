import Foundation
import Observation
import RoomPlan

@MainActor @Observable
final class GuidedRouteModel {
    var route: GuidedRoute?
    var state: GuidedRouteState?
    var house: HouseProject?
    var sessions: [String: HouseProject.Session] = [:]
    var floorCaptures: [String: [HouseProject.Session]] = [:]
    var detailCaptures: [String: [HouseProject.Session]] = [:]
    var floorEvidence: [String: FloorStructureEvidence] = [:]
    var floorReviews: [String: FloorStructureReview] = [:]
    var macReviews: [String: FloorMacReview] = [:]
    var reviewedAreas: Set<String> = []
    var boundariesReviewed = false
    var openingsReviewed = false
    var reflectionsReviewed = false
    var error: String?
    var busy = false
    var mirrorPreparation = "not-recorded"
    var selectedStepID: String?
    var detailCoverage: [String: Int] = [:]

    init() { reload() }

    func reload() {
        do {
            let route = try GuidedRoute.load()
            let state = try GuidedRouteState.load(routeID: route.id)
            let house = try state.houseID.map { try HouseProject.load(id: $0) }
            var sessions: [String: HouseProject.Session] = [:]
            var floorCaptures: [String: [HouseProject.Session]] = [:]
            var detailCaptures: [String: [HouseProject.Session]] = [:]
            var attempts: [String: String] = [:]
            for session in (house?.sessions ?? []).sorted(by: { $0.startedAt < $1.startedAt }) {
                guard let house, let context = FloorScanLibrary.context(house: house, session: session, route: route) ?? GuidedCaptureContext.load(in: house.bundle(for: session).url),
                      context.routeID == route.id, context.houseID == house.id, context.sessionID == session.id,
                      context.zoneID == session.zone else { continue }
                guard let step = route.steps.first(where: { $0.id == context.step.id }), step.phase == context.step.phase else { continue }
                if step.isStructure {
                    let attempt = context.attemptID ?? session.id
                    if attempts[step.id] != attempt { floorCaptures[step.id] = []; attempts[step.id] = attempt; sessions[step.id] = nil }
                    floorCaptures[step.id, default: []].append(session)
                } else {
                    guard session.endedAt != nil, !session.rooms.isEmpty,
                          house.bundle(for: session).manifest?.rooms.contains(where: { step.isDetail ? $0.hasDetailEvidence : $0.hasMeasuredGeometry }) == true else { continue }
                    detailCaptures[step.id, default: []].append(session)
                }
                sessions[context.step.id] = session
            }
            self.route = route; self.state = state; self.house = house; self.sessions = sessions
            self.selectedStepID = state.preferredDetailStepID
            self.floorCaptures = floorCaptures
            self.detailCaptures = detailCaptures
            self.floorEvidence = [:]; self.floorReviews = [:]; self.macReviews = [:]; self.detailCoverage = [:]
            if let house {
                for (stepID, captures) in floorCaptures {
                    floorEvidence[stepID] = FloorStructureEvidence.load(house: house, sessions: captures)
                    if let step = route.steps.first(where: { $0.id == stepID }), let evidence = floorEvidence[stepID],
                       captures.allSatisfy({ $0.endedAt != nil }) {
                        macReviews[stepID] = FloorMacReview.load(house: house, routeID: route.id, step: step, evidence: evidence)
                        if let review = macReviews[stepID], let folder = FloorMacReview.folder(house: house, stepID: stepID),
                           let data = try? Data(contentsOf: folder.appendingPathComponent("detail-guide.json")),
                           RoomDetailGuide.hash(data) == review.detailGuideSHA256,
                           let guide = try? JSONDecoder().decode(RoomDetailGuide.self, from: data), (try? guide.validate()) != nil {
                            let saved = (try? Data(contentsOf: folder.appendingPathComponent("detail-progress.json"))).flatMap { try? JSONDecoder().decode(RoomDetailProgress.Saved.self, from: $0) }
                            let quality = saved?.guideRevision == guide.revision && saved?.guideSHA256 == guide.fingerprint ? saved?.quality ?? [:] : [:]
                            for room in guide.rooms {
                                detailCoverage[room.id] = Int(100*Double(room.targets.filter { (quality[$0.id] ?? 0)>=CoverageEngine.goodScore }.count)/Double(room.targets.count))
                            }
                        }
                    }
                    if let last = captures.last { floorReviews[stepID] = FloorStructureReview.load(in: house.bundle(for: last).url) }
                }
            }
        } catch { self.error = error.localizedDescription }
    }

    func verified(_ step: GuidedRoute.Step) -> Bool {
        if macReviews[step.id] != nil { return true }
        guard let house, sessions[step.id] != nil else { return false }
        return captures(for: step).allSatisfy { PairedCaptureModel.hasReceipt(house: house, session: $0) }
    }

    func completed(_ step: GuidedRoute.Step) -> Bool {
        if macReviews[step.id] != nil { return true }
        if step.isStructure {
            guard structureReviewed(step), let house, let state else { return false }
            return captures(for: step).allSatisfy { state.mayAdvance(step: step, session: $0, verifiedOnMac: PairedCaptureModel.hasReceipt(house: house, session: $0)) }
        }
        return state?.mayAdvance(step: step, session: sessions[step.id], verifiedOnMac: verified(step)) ?? false
    }

    func captures(for step: GuidedRoute.Step) -> [HouseProject.Session] {
        step.isStructure ? floorCaptures[step.id, default: []] : detailCaptures[step.id, default: []]
    }

    func checkpointCount(for step: GuidedRoute.Step) -> Int {
        captures(for: step).reduce(0) { $0 + $1.rooms.count }
    }

    func structureReviewed(_ step: GuidedRoute.Step) -> Bool {
        if macReviews[step.id] != nil { return true }
        guard let route, let house, let evidence = floorEvidence[step.id], let review = floorReviews[step.id] else { return false }
        return review.matches(routeID: route.id, step: step, houseID: house.id, evidence: evidence)
    }

    var detailsUnlocked: Bool {
        guard let route else { return false }
        let floors = route.steps.filter(\.isStructure)
        return !floors.isEmpty && floors.allSatisfy(completed)
    }

    func confirmStructure(_ step: GuidedRoute.Step) {
        guard let route, let house, let last = captures(for: step).last, let evidence = floorEvidence[step.id] else { return }
        let review = FloorStructureReview(routeID: route.id, stepID: step.id, houseID: house.id,
            sessionIDs: evidence.sessionIDs, captureSignatures: evidence.signatures,
            reviewedAreas: reviewedAreas, boundariesReviewed: boundariesReviewed,
            openingsReviewed: openingsReviewed, reflectionsReviewed: reflectionsReviewed, reviewedAt: Date())
        guard review.matches(routeID: route.id, step: step, houseID: house.id, evidence: evidence) else {
            error = "Complete the structural checks and review every listed area first."; return
        }
        do { try review.save(in: house.bundle(for: last).url); reload() }
        catch { self.error = error.localizedDescription }
    }

    /// Rebuild already-saved RoomPlan checkpoints after termination; never invent the missing tail.
    func recoverCheckpoints(_ step: GuidedRoute.Step) async {
        guard let house else { return }
        busy = true
        defer { busy = false }
        do {
            for session in captures(for: step) where session.endedAt == nil {
                let bundle = house.bundle(for: session)
                guard var manifest = bundle.manifest, !manifest.rooms.isEmpty else {
                    throw GuidedRouteError("This attempt stopped before its first saved checkpoint. Start a fresh floor attempt; the diagnostic files remain saved.")
                }
                let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
                let rooms = try manifest.rooms.filter { !$0.file.isEmpty }.map { record in
                    try decoder.decode(CapturedRoom.self, from: Data(contentsOf: bundle.file(record.file)))
                }
                guard !rooms.isEmpty else { throw GuidedRouteError("No saved RoomPlan boundaries are available to recover. Start a fresh floor attempt.") }
                let structure = try await StructureBuilder(options: [.beautifyObjects]).capturedStructure(from: rooms)
                try bundle.saveStructure(structure)
                manifest.structure = "structure.json"; manifest.structureError = nil; manifest.endedAt = Date()
                try bundle.writeManifest(manifest)
                _ = try HouseProject.modify(house.id) { $0.endSession(session.id, at: manifest.endedAt!) }
            }
            reload()
        } catch { self.error = error.localizedDescription }
    }

    func detailAvailable(_ step: GuidedRoute.Step) -> Bool {
        guard step.isDetail, let route, let floor = route.steps.first(where: { $0.isStructure && !$0.isConnector && $0.floorID == step.floorID }) else { return false }
        return structureReviewed(floor)
    }

    var current: GuidedRoute.Step? {
        if let selectedStepID, let step = route?.steps.first(where: { $0.id == selectedStepID }), detailAvailable(step) { return step }
        if let floor = state?.preferredDetailFloorID,
           let next = route?.steps.first(where: { $0.isDetail && $0.floorID == floor && !completed($0) && detailAvailable($0) }) { return next }
        return route?.steps.first { !completed($0) }
    }

    func selectDetail(_ step: GuidedRoute.Step) {
        guard detailAvailable(step) else { return }
        selectedStepID = step.id
        if var state { state.preferredDetailFloorID = step.floorID; state.preferredDetailStepID = step.id; persist(state) }
        mirrorPreparation = "not-recorded"
    }

    func nextStructure() {
        selectedStepID = nil
        if var state { state.preferredDetailFloorID = nil; state.preferredDetailStepID = nil; persist(state) }
        mirrorPreparation = "not-recorded"
    }

    func status(_ step: GuidedRoute.Step) -> String {
        if macReviews[step.id] != nil { return "Assembled on Mac · originals verified by USB" }
        if state?.skipped.contains(step.id) == true { return "Skipped for now" }
        guard let session = sessions[step.id] else { return detailCoverage[step.id].map { "\($0)% of known detail targets · not yet saved" } ?? "Not scanned" }
        if step.isStructure && !structureReviewed(step) { return "\(checkpointCount(for: step)) checkpoints saved · continue or review" }
        if verified(step) { return step.isStructure ? "Structure reviewed · verified on Mac" : "Saved on iPhone · verified on Mac" }
        if state?.airDropConfirmed.contains(session.id) == true { return "AirDrop confirmed by you" }
        if state?.uploadDeferred.contains(session.id) == true { return "Saved on iPhone · upload still due" }
        return "Saved on iPhone · ready to upload"
    }

    func begin(_ step: GuidedRoute.Step, startOver: Bool = false) async throws -> CaptureController {
        guard let route, var state, current?.id == step.id else { throw GuidedRouteError("Reload the route before starting the next space.") }
        if step.isDetail && route.steps.contains(where: \.isStructure) && !detailAvailable(step) {
            throw GuidedRouteError("Review this floor before starting its object details.")
        }
        if mirrorPreparation == "not-recorded", step.isStructure, !startOver,
           let house = self.house, let last = captures(for: step).last,
           let context = GuidedCaptureContext.load(in: house.bundle(for: last).url) { mirrorPreparation = context.mirrorPreparation }
        guard step.mirrors.isEmpty || mirrorPreparation != "not-recorded" else { throw GuidedRouteError("Record whether the mirrors are covered before scanning.") }
        try await CaptureReadiness.prepare()
        let house: HouseProject
        if let id = state.houseID { house = try HouseProject.load(id: id) }
        else {
            house = try HouseProject.create(name: route.title)
            state.houseID = house.id
            try state.save(); self.state = state
        }
        // Resume only the same floor attempt through measured relocalization. Never align by a label.
        let previous = step.isStructure && !startOver ? captures(for: step).last : nil
        let previousContext = previous.flatMap { GuidedCaptureContext.load(in: house.bundle(for: $0).url) }
        let floorStructure = route.steps.first { $0.isStructure && $0.floorID == step.floorID }
        let reference = step.isDetail ? floorStructure.flatMap { captures(for: $0).last } : nil
        let zone = previous?.zone ?? reference?.zone
        var detailProgress: RoomDetailProgress?
        var preparedReference: PreparedDetailReference?
        if step.isDetail, let floor = floorStructure, let review = macReviews[floor.id],
           let hash = review.detailGuideSHA256, let folder = FloorMacReview.folder(house: house, stepID: floor.id) {
            let prepared = try await Task.detached(priority: .userInitiated) {
                return try PreparedDetailReference.load(folder: folder, expectedHash: hash, houseID: house.id,
                    floorStepID: floor.id, selectedRoomID: step.id, localizationHash: review.localizationSHA256)
            }.value
            let guide = prepared.guide
            if guide.rooms.contains(where: { $0.id == step.id }) {
                preparedReference = prepared
                detailProgress = RoomDetailProgress(guide: guide, selectedRoomID: step.id, folder: folder,
                    progressURL: folder.appendingPathComponent("detail-progress.json"), sessionReference: prepared.sessionReference)
            }
        }
        let controller = try CaptureController.start(houseID: house.id, zoneID: detailProgress == nil ? zone : nil,
            newZone: detailProgress != nil || zone == nil ? step.title : nil, preserveFloorZone: zone != nil && detailProgress == nil,
            referenceMap: detailProgress.map { $0.folder.appendingPathComponent($0.guide.referenceMap) },
            preparedDetailReference: preparedReference)
        controller.detailProgress = detailProgress
        detailProgress?.persist(bundle: controller.bundle.url)
        let index = route.steps.firstIndex(where: { $0.id == step.id }) ?? 0
        var context = GuidedCaptureContext(routeID: route.id, step: step, sequence: index + 1,
            previousStepID: index > 0 ? route.steps[index-1].id : nil, houseID: house.id,
            sessionID: controller.plan.sessionID, zoneID: controller.plan.zoneID,
            mirrorPreparation: step.mirrors.isEmpty ? "not-applicable" : mirrorPreparation,
            reflectiveGeometryNeedsReview: !step.mirrors.isEmpty)
        context.phase = step.phase; context.floorID = step.floorID
        context.attemptID = previousContext?.attemptID ?? UUID().uuidString
        do { try context.save(in: controller.bundle.url) }
        catch { controller.abandon(); throw error }
        controller.guidedContext = context
        controller.roomName = step.isStructure ? "\(step.title) · section 1" : step.title
        reviewedAreas = []; boundariesReviewed = false; openingsReviewed = false; reflectionsReviewed = false
        self.house = house
        return controller
    }

    func acknowledge(_ step: GuidedRoute.Step, airDrop: Bool) {
        guard var state else { return }
        for session in captures(for: step) {
            if airDrop { state.airDropConfirmed.insert(session.id) }
            else { state.uploadDeferred.insert(session.id) }
        }
        persist(state)
    }

    func skip(_ step: GuidedRoute.Step) {
        guard step.optional, var state else { return }
        state.skipped.insert(step.id); persist(state)
    }

    func revisit(_ step: GuidedRoute.Step) {
        guard var state else { return }
        state.skipped.remove(step.id); persist(state)
    }

    private func persist(_ state: GuidedRouteState) {
        do { try state.save(); self.state = state; mirrorPreparation = "not-recorded" }
        catch { self.error = error.localizedDescription }
    }
}
