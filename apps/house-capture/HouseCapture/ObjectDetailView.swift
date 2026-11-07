import SwiftUI

struct ObjectDetailView: View {
    @ObservedObject var controller: CaptureController
    @ObservedObject var markers: CaptureMarkers
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var paired = PairedCaptureModel.shared

    var body: some View {
        Form {
            if let progress = controller.detailProgress {
                Section("Room detail progress") {
                    ForEach(progress.guide.rooms) { room in
                        LabeledContent(room.label, value: "\(progress.percent(roomID: room.id))% of known targets")
                    }
                    Text("This estimates clear photographs of the reviewed structure and detected furniture. It does not prove that every small object, hidden surface or material is complete.").font(.footnote)
                }
            }
            if let context = controller.guidedContext, !context.step.mirrors.isEmpty {
                Section("Mirror references") {
                    ForEach(context.step.mirrors) { mirror in
                        Button("Observe \(mirror.cardID) · \(mirror.label)") { markers.selectedDevice = mirror.cardID }
                    }
                    Text("These spare cards label reflective surfaces for review. They do not become checkpoints or device bindings, and do not remove reflections from depth or RoomPlan. Keep mirrors covered through the structural pass; take uncovered reference photos afterward.").font(.footnote)
                }
            }
            Section("Object reference photos") {
                TextField("Object name, such as desk lamp", text: $controller.detailObjectName)
                Picker("Reference view", selection: $controller.detailView) {
                    ForEach(["front", "back", "left", "right", "top", "detail"], id: \.self) { Text($0.capitalized).tag($0) }
                }
                Toggle("Card is outside this photo", isOn: $controller.detailCleanPhoto)
                Text("Close this panel and use the shutter for each accessible view. Keep the object still, and remove temporary cards from clean reference photos.").font(.footnote)
                if !controller.detailObjectName.isEmpty {
                    Text("Saved views: \(controller.detailViewsTaken.isEmpty ? "none yet" : controller.detailViewsTaken.joined(separator: ", "))")
                    Button("Finish object detail") { controller.detailObjectName = ""; dismiss() }
                }
            }
            Section("Card observations") {
                if let kit = paired.kit {
                    Picker("Nearby device card", selection: $markers.selectedDevice) {
                        Text("Checkpoint cards only").tag("")
                        ForEach(kit.markers.filter { $0.role != "checkpoint" && $0.retired != true }) { marker in
                            Text("\(marker.id) · \(marker.label)").tag(marker.id)
                        }
                    }
                }
                Text(markers.message)
                Text("A changed card selection is loaded at the next capture configuration. It never restarts tracking mid-scan.").font(.caption)
                Text("Seeing a card records its pose. Independent checks in House Control are still required before using it to place controls.").font(.footnote)
            }
        }
        .navigationTitle("Details & cards")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
}
