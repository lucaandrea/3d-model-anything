import SwiftUI
import QuickLook

struct GuidedRouteScreen: View {
    @State private var model = GuidedRouteModel()
    @ObservedObject private var paired = PairedCaptureModel.shared
    @State private var capture: CaptureController?
    @State private var sharing: URL?
    @State private var floorPreview: FloorPreview?
    @State private var reviewedModelURL: URL?
    @State private var confirmingAirDrop: GuidedRoute.Step?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollViewReader { proxy in
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Choose a room. Capture a short pass. Save and upload.").font(.headline)
                    if model.route?.steps.contains(where: \.isStructure) == true {
                        let ready = model.route?.steps.contains(where: { model.detailAvailable($0) }) == true
                        Label(ready ? "Reviewed floor · room details available" : "Review a floor to unlock its room details", systemImage: ready ? "checkmark.circle.fill" : "square.stack.3d.up")
                            .font(.subheadline).foregroundStyle(ready ? Color.green : Color.secondary)
                        Text("Room detail progress stays saved across passes. The app checks your location before counting new views.").font(.footnote)
                    } else {
                        Text("Scan one space, save it, upload it, then follow the next step.").font(.footnote)
                    }
                }.padding(.vertical, 4)
                Label(paired.connected ? "Mac connected · ready for uploads" : "Mac not connected · scans save on iPhone", systemImage: paired.connected ? "desktopcomputer" : "wifi.slash")
                    .foregroundStyle(paired.connected ? Color.green : Color.secondary)
                DisclosureGroup("Mac connection") {
                    Button("Manage connection", systemImage: "desktopcomputer") { paired.showSetup = true }
                    Text(paired.status).font(.footnote)
                }
            }
            if let route = model.route {
                let available = route.steps.filter { model.detailAvailable($0) }
                if !available.isEmpty {
                    Section("Room detail progress · choose any room") {
                        if route.steps.contains(where: { $0.isStructure && !model.completed($0) }) {
                            Button("Continue unfinished structure", systemImage: "stairs") { model.nextStructure() }
                        }
                            ForEach(available) { step in
                                Button {
                                    model.selectDetail(step)
                                    withAnimation { proxy.scrollTo("selected-room", anchor: .top) }
                                } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        HStack {
                                            Text(step.title).font(.headline)
                                            Spacer()
                                            Image(systemName: model.current?.id == step.id ? "checkmark.circle.fill" : "chevron.right")
                                        }
                                        if let percent = model.detailCoverage[step.id] {
                                            ProgressView(value: Double(percent), total: 100)
                                            Text("\(percent)% of planned views · \(model.sessions[step.id] == nil ? "Ready for first pass" : model.status(step))").font(.caption).foregroundStyle(.secondary)
                                        } else {
                                            Text("Manual detail pass · room recognition unavailable here").font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }.buttonStyle(.plain).padding(.vertical, 4)
                            }
                        Text("Percentages cover planned photo views, not every hidden object. Save about every 3 minutes and before changing rooms. Uploading a partial pass does not mean the room is finished.").font(.footnote)
                    }
                }
            }
            if let step = model.current {
                currentStep(step).id("selected-room")
            } else if model.route != nil {
                Section {
                    Label("Route recorded", systemImage: "checkmark.circle")
                    Text("Check for uploads still due below. Scanned spaces still need reconstruction and measured alignment before they form an accepted house model.")
                }
            }
            if let route = model.route {
                Section("Saved passes & structure") {
                    ForEach(Array(route.steps.enumerated()), id: \.element.id) { index, step in
                        DisclosureGroup {
                            Text(step.instructions)
                            if let review = model.macReviews[step.id] {
                                Button("View assembled structure", systemImage: "cube") { inspect(step) }
                                ForEach(review.notes, id: \.self) { Text($0).font(.footnote) }
                            }
                            Text("Overlap: \(step.overlap)").font(.footnote)
                            if model.detailAvailable(step) { Button("Choose this room for more detail") {
                                model.selectDetail(step)
                                withAnimation { proxy.scrollTo("selected-room", anchor: .top) }
                            } }
                            if model.sessions[step.id] != nil { transferButtons(step) }
                            if model.state?.skipped.contains(step.id) == true {
                                Button("Put this space back in the route") { model.revisit(step) }
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("\(index + 1). \(step.title)").font(.headline)
                                Text(model.status(step)).font(.caption)
                                    .foregroundStyle(model.verified(step) ? Color.green : Color.secondary)
                            }.padding(.vertical, 5)
                        }
                    }
                }
            }
            Section("Mirrors and moving doors") {
                Text("A mirror card is a label, not a LiDAR filter. Cover the reflective face flat with opaque matte material for the structural pass. Keep frames and edges visible. Later, uncover it for separate reference photos and measurements.")
                Text("Scan the hallway with laundry/pantry doors closed. Finish that pass before opening both doors. Keep them fully open and still during the separate interior pass.")
            }
        }
        .navigationTitle("Scan your home")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .disabled(model.busy)
        .overlay { if model.busy { ProgressView("Preparing…").padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) } }
        .fullScreenCover(item: $capture, onDismiss: { model.reload() }) { controller in
            CaptureScreen(controller: controller) { capture = nil }
        }
        .sheet(isPresented: $paired.showSetup, onDismiss: { model.reload() }) {
            NavigationStack { PairedCaptureView().toolbar { Button("Done") { paired.showSetup = false } } }
        }
        .sheet(item: $floorPreview) { preview in
            NavigationStack { ScanReview(source: preview.source).toolbar { Button("Done") { floorPreview = nil } } }
        }
        .sheet(item: $sharing) { ShareSheet(items: [$0]) }
        .quickLookPreview($reviewedModelURL)
        .confirmationDialog("Was the ZIP received on your Mac?", isPresented: Binding(get: { confirmingAirDrop != nil }, set: { if !$0 { confirmingAirDrop = nil } }), titleVisibility: .visible) {
            Button("I confirmed the file on my Mac") {
                if let step = confirmingAirDrop { model.acknowledge(step, airDrop: true) }
                confirmingAirDrop = nil
            }
            Button("Not yet", role: .cancel) { confirmingAirDrop = nil }
        } message: { Text("This records your confirmation. It is separate from the app’s checksum-verified network upload.") }
        .alert("Needs attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .task { if !paired.connected { paired.reconnect() } }
        .onChange(of: model.current?.id) { _, _ in
            model.mirrorPreparation = "not-recorded"; model.reviewedAreas = []
            model.boundariesReviewed = false; model.openingsReviewed = false; model.reflectionsReviewed = false
        }
        }
    }

    @ViewBuilder private func currentStep(_ step: GuidedRoute.Step) -> some View {
        Section("Next · \(step.floor)") {
            Text(step.title).font(.title2.bold()).accessibilityAddTraits(.isHeader)
            if !step.mirrors.isEmpty, step.isDetail || model.sessions[step.id] == nil {
                ForEach(step.mirrors) { mirror in Text("\(mirror.cardID) · \(mirror.label)").font(.footnote) }
                Picker("Mirror preparation", selection: $model.mirrorPreparation) {
                    Text("Choose before scanning").tag("not-recorded")
                    Text("Reflective faces covered").tag("covered-matte")
                    Text("Cannot cover · needs correction").tag("uncovered-review-required")
                }
                Text("Cards identify mirrors; they do not remove reflections. Keep uncovered mirrors in separate reference photos where possible.").font(.caption)
            }
            if step.isDetail {
                Text(model.detailCoverage[step.id] == nil ? "Photograph this space manually. This area has no reviewed room boundary yet, so automatic room progress is unavailable." : "Stand inside this room and aim at a fixed doorway or corner. Once your position is verified, photos and room progress update automatically.").font(.subheadline)
                if model.sessions[step.id] != nil {
                    Button("Continue details · new short pass", systemImage: "viewfinder") { start(step) }
                        .buttonStyle(.borderedProminent).disabled(paired.working)
                }
            }
            if step.isStructure { Text(step.isConnector ? "Capture the stair base, steps, surrounding walls and upper landing in a separate pass." : "Capture wall, floor and upper edges, doorways and openings across the whole floor.").font(.subheadline) }
            DisclosureGroup("Walking route & preparation") {
                Text(step.instructions)
                Label(step.overlap, systemImage: "arrow.left.and.right")
                Text("Doors: \(step.doorState)")
                if !step.checkpoints.isEmpty { Text("Reference checkpoints: \(step.checkpoints.joined(separator: ", "))").font(.footnote) }
            }
            if model.sessions[step.id] != nil {
                if step.isStructure {
                    FloorStructureReviewView(model: model, step: step, preview: { inspect(step) },
                        resume: { start(step) }, startOver: { start(step, startOver: true) })
                }
                if !step.isStructure || model.structureReviewed(step) { transferButtons(step) }
                else if model.captures(for: step).allSatisfy({ $0.endedAt != nil }) {
                    DisclosureGroup("Send saved originals for Mac review") { transferButtons(step) }
                }
            } else {
                if step.isStructure {
                    Text("Cyan surfaces show measured geometry. Object detail comes later. Pause walking briefly when a checkpoint saves.").font(.footnote)
                    Text(step.isConnector ? "Start at the stair base. Pause at stable positions; watch your footing between them. Finish at the upper landing, then begin Upstairs separately." : "Finish this floor before moving to the next route step. Stairs and upstairs each get a separate capture.").font(.footnote.bold())
                } else if step.isDetail {
                    Text("Follow the missing-view guidance and red/green mesh. Use Object photos & cards for named object closeups. Save this pass when the checkpoint reminder appears; continue the same room or choose another after uploading.").font(.footnote)
                }
                Button("Scan \(step.title)", systemImage: "viewfinder") { start(step) }
                    .disabled(!CaptureController.isSupported || paired.working || (!step.mirrors.isEmpty && model.mirrorPreparation == "not-recorded"))
                if step.optional { Button("Leave this optional space for later") { model.skip(step) } }
            }
        }
    }

    @ViewBuilder private func transferButtons(_ step: GuidedRoute.Step) -> some View {
        if let house = model.house, model.macReviews[step.id] == nil {
            Text(model.status(step)).font(.subheadline)
            ForEach(model.captures(for: step)) { session in
                if !PairedCaptureModel.hasReceipt(house: house, session: session) {
                    if model.captures(for: step).count > 1 { Text("Part: \(session.id)").font(.caption) }
                    Button(paired.connected ? "Upload to Mac" : "Reconnect to upload", systemImage: "arrow.up.circle") {
                        if paired.connected { Task { await paired.upload(house: house, session: session); model.reload() } }
                        else { paired.reconnect() }
                    }.disabled(paired.working)
                    Button("AirDrop ZIP", systemImage: "square.and.arrow.up") { share(house, session) }.disabled(paired.working)
                }
            }
            if !model.verified(step) {
                Button("I received every part by AirDrop") { confirmingAirDrop = step }.disabled(paired.working)
                if !model.completed(step) && (!step.isStructure || model.structureReviewed(step)) {
                    Button("Continue offline · upload later") { model.acknowledge(step, airDrop: false) }.disabled(paired.working)
                }
            }
            if paired.working { ProgressView(paired.progress) }
            if let error = paired.lastError { Text(error).foregroundStyle(.red) }
            if step.isDetail && model.verified(step) {
                Text("Every saved pass for this room is on the Mac. Choose this room again for missing views, or select your next room above.").font(.footnote)
            }
        }
    }

    private func inspect(_ step: GuidedRoute.Step) {
        guard let house = model.house else { return }
        if let review = model.macReviews[step.id], let folder = FloorMacReview.folder(house: house, stepID: step.id) {
            reviewedModelURL = folder.appendingPathComponent(review.modelFile)
            return
        }
        let parts = model.captures(for: step)
        var source = PreviewSource.house(house)
        let ids = Set(parts.map(\.id))
        source.sessions = source.sessions.filter { ids.contains($0.id) }
        let indices = Set(source.sessions.map(\.index))
        source.rooms = source.rooms.filter { indices.contains($0.session) }
        // Do not draw unaligned parts as though they share a frame.
        source.hiddenSessions = Set(source.sessions.filter { $0.alignment == "unaligned" }.map(\.index))
        source.title = step.title; source.subtitle = "Structure review · \(parts.count) saved parts"
        floorPreview = FloorPreview(source: source)
    }

    private func start(_ step: GuidedRoute.Step, startOver: Bool = false) {
        model.busy = true
        Task {
            defer { model.busy = false }
            do { capture = try await model.begin(step, startOver: startOver) }
            catch { model.error = error.localizedDescription }
        }
    }

    private func share(_ house: HouseProject, _ session: HouseProject.Session) {
        model.busy = true
        Task {
            defer { model.busy = false }
            do {
                sharing = try await Task.detached(priority: .userInitiated) {
                    try house.bundle(for: session).zipped(as: session.id)
                }.value
            } catch { model.error = error.localizedDescription }
        }
    }
}
