import SwiftUI

struct FloorStructureReviewView: View {
    @Bindable var model: GuidedRouteModel
    let step: GuidedRoute.Step
    let preview: () -> Void
    let resume: () -> Void
    let startOver: () -> Void

    var body: some View {
        if model.structureReviewed(step) {
            Label("Structure checks passed · floor reviewed", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
            Text("Ready to upload. This confirms usable capture data and your coverage review; measured accuracy and alignment between floors still need calibration.").font(.footnote)
        } else {
            Text("\(model.checkpointCount(for: step)) checkpoints saved · one floor capture").font(.headline)
            Button(step.isConnector ? "Continue stairs" : "Continue \(step.floor.lowercased())", systemImage: "viewfinder", action: resume)
                .buttonStyle(.borderedProminent)
                .disabled(model.captures(for: step).contains(where: { $0.endedAt == nil }))
            Text("Return to an area you already scanned near where you stopped. The phone checks its position against the saved scan, then continues this floor. No room name is needed.").font(.footnote)
            Text(step.isConnector ? "Finish at the upper landing. Review this connector, then start Upstairs as a separate scan." : "Finish downstairs, including the stair base. After review, scan Stairs & landing, then start Upstairs separately.").font(.footnote)
            DisclosureGroup("Finished this floor? Review and confirm") {
            if model.captures(for: step).contains(where: { $0.endedAt == nil }) {
                Button("Recover saved checkpoints") { Task { await model.recoverCheckpoints(step) } }
                Text("This closes an interrupted capture using only sections already saved. The unfinished tail may need another pass.").font(.caption)
            }
            if let evidence = model.floorEvidence[step.id] {
                Text("\(evidence.wallObservations) wall observations · \(evidence.depthFrames) depth frames · \(model.captures(for: step).count) saved parts").font(.footnote)
                ForEach(evidence.issues, id: \.self) { Label($0, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange) }
                Button(step.isConnector ? "Inspect the stairs in 3D" : "Inspect the floor in 3D", systemImage: "cube", action: preview)
                Text("The app checks for usable walls, LiDAR data, a merged structure and a consistent tracking frame. It cannot know whether you visited every area. Check these against the preview:").font(.footnote)
                ForEach(step.areas ?? [], id: \.self) { area in
                    Toggle(area, isOn: Binding(get: { model.reviewedAreas.contains(area) }, set: {
                        if $0 { model.reviewedAreas.insert(area) } else { model.reviewedAreas.remove(area) }
                    }))
                }
                Toggle("Wall, floor and upper edges look complete", isOn: $model.boundariesReviewed)
                Toggle("Doorways and open transitions are present", isOn: $model.openingsReviewed)
                Toggle("No false rooms through mirrors or glass", isOn: $model.reflectionsReviewed)
                Button(step.isConnector ? "Confirm stairs structure" : "Confirm floor structure") { model.confirmStructure(step) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!evidence.usable || !Set(step.areas ?? []).isSubset(of: model.reviewedAreas) || !model.boundariesReviewed || !model.openingsReviewed || !model.reflectionsReviewed)
            }
            }
            if !step.mirrors.isEmpty {
                Picker("Mirrors for another pass", selection: $model.mirrorPreparation) {
                    Text("Use earlier preparation when continuing").tag("not-recorded")
                    Text("Covered with matte material").tag("covered-matte")
                    Text("Uncovered · geometry needs review").tag("uncovered-review-required")
                }
            }
            DisclosureGroup("Start over instead") {
                Button("Start a fresh floor attempt", action: startOver)
                Text("Use Continue to keep extending this capture. A fresh attempt preserves earlier files but begins a separate tracking frame.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct FloorPreview: Identifiable {
    let id = UUID()
    var source: PreviewSource
}
