import SwiftUI

struct PairedCaptureView: View {
    @ObservedObject private var model = PairedCaptureModel.shared
    @State private var pairingLink = ""
    @State private var houses: [HouseProject] = []
    @FocusState private var enteringPairing: Bool

    var body: some View {
        Form {
            Section("Mac connection") {
                Label(model.status, systemImage: model.connected ? "checkmark.shield" : "desktopcomputer")
                SecureField("Capture pairing link", text: $pairingLink).textInputAutocapitalization(.never).autocorrectionDisabled().focused($enteringPairing)
                Button("Pair with Mac") { enteringPairing = false; model.pair(link: pairingLink); pairingLink = "" }.disabled(pairingLink.isEmpty)
                Button("Reconnect") { model.reconnect() }
                if model.connected { Button("Disconnect") { model.disconnect() } }
                Text("In House Control on the Mac, open spatial capture and create a capture pairing link. This connection transfers scans and cards; it cannot control home devices.").font(.footnote)
                if let error = model.lastError { Text(error).foregroundStyle(.red).accessibilityLabel("Needs attention: \(error)") }
            }
            Section("Printed reference cards") {
                if let kit = model.kit {
                    Text("\(kit.markers.count) cards · kit \(kit.kitID.prefix(8))")
                    Text("Print at 100%, check the ruler, and keep checkpoint cards on fixed building features. Device cards identify fixtures and never set the room origin.").font(.footnote)
                }
                Button("Download matching card kit") { Task { await model.downloadKit() } }.disabled(!model.connected || model.working)
            }
            if model.working { Section { ProgressView(model.progress) } }
            else if !model.progress.isEmpty { Section { Text(model.progress) } }
            Section("Send saved captures") {
                Text("Transfers resume after disconnection. Only finished sessions are sent; originals and AirDrop remain available.").font(.footnote)
                ForEach(houses) { house in
                    ForEach(house.sessions.filter { $0.endedAt != nil }) { session in
                        Button {
                            Task { await model.upload(house: house, session: session) }
                        } label: {
                            VStack(alignment: .leading) {
                                Text(house.name).font(.headline)
                                Text(session.id).font(.caption)
                            }
                        }.disabled(!model.connected || model.working)
                    }
                }
            }
        }
        .navigationTitle("Paired capture")
        .task { houses = await Task.detached(priority: .utility) { HouseProject.all() }.value }
    }
}
