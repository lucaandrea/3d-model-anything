import SwiftUI

struct ScanLibraryScreen: View {
    @State private var archives: [ScanCollectionArchive.Receipt] = []
    @State private var confirmingReset = false
    @State private var busy = false
    @State private var message = ""
    @ObservedObject private var paired = PairedCaptureModel.shared
    var body: some View {
        List {
            Section {
                Text("Start with an empty scan library. Existing scans move into a recoverable archive on this iPhone; your card kit and Mac pairing stay ready.")
                Button("Clear all active scans", role: .destructive) { confirmingReset = true }.disabled(busy || paired.working)
                    .confirmationDialog("Start fresh?", isPresented: $confirmingReset, titleVisibility: .visible) {
                        Button("Archive prior scans and clear the library", role: .destructive) { archive() }
                    } message: { Text("You can restore the archived scans below. This does not erase copies already sent to your Mac.") }
            }
            if busy { ProgressView("Checking and moving saved files…") }
            if !message.isEmpty { Text(message) }
            Section("Recoverable archives") {
                ForEach(archives) { receipt in
                    VStack(alignment: .leading) {
                        Text(receipt.createdAt.formatted(date: .abbreviated, time: .shortened))
                        Text("\(receipt.files.count) original files").font(.caption)
                        Button("Restore these scans") { restore(receipt) }.disabled(busy || paired.working)
                    }
                }
            }
        }.navigationTitle("Scan library").onAppear { archives = ScanCollectionArchive.receipts() }
    }

    private func archive() {
        busy = true
        Task {
            defer { busy = false; archives = ScanCollectionArchive.receipts() }
            do {
                let receipt = try await Task.detached(priority: .userInitiated) { try ScanCollectionArchive.archive() }.value
                message = "Library cleared. \(receipt.files.count) original files are recoverable below."
            } catch { message = error.localizedDescription }
        }
    }

    private func restore(_ receipt: ScanCollectionArchive.Receipt) {
        busy = true
        Task {
            defer { busy = false; archives = ScanCollectionArchive.receipts() }
            do {
                try await Task.detached(priority: .userInitiated) { try ScanCollectionArchive.restore(receipt) }.value
                message = "Scans restored to the library. Your current route is unchanged."
            } catch { message = error.localizedDescription }
        }
    }
}
