#if DEBUG
import SwiftUI

/// Attended developer maintenance only. A nonce prevents a repeated launch from
/// archiving the new collection. The normal app exposes the same reversible operation.
struct ScanResetDebugView: View {
    let nonce: String
    var inventoryOnly = false
    @State private var status = "Archiving the previous collection…"
    var body: some View {
        Text(status).padding().task {
            guard UUID(uuidString: nonce) != nil else { status = "Invalid reset request"; return }
            if inventoryOnly {
                do {
                    let files = try await Task.detached(priority: .utility) { try ScanCollectionArchive.inventory() }.value
                    try JSONEncoder().encode(files).write(to: GuidedRoute.documents.appendingPathComponent("scan-inventory-result.json"), options: .atomic)
                    status = "Inventory ready: \(files.count) files. Scans are unchanged."
                    print("SCAN-INVENTORY: \(files.count) files")
                } catch { status = error.localizedDescription }
                return
            }
            let key = "completed-scan-archive-\(nonce)"
            guard !UserDefaults.standard.bool(forKey: key) else { status = "This reset was already completed."; return }
            do {
                let receipt = try await Task.detached(priority: .userInitiated) { try ScanCollectionArchive.archive() }.value
                UserDefaults.standard.set(true, forKey: key)
                try JSONEncoder().encode(receipt).write(to: GuidedRoute.documents.appendingPathComponent("scan-reset-result.json"), options: .atomic)
                status = "Active scans cleared. \(receipt.files.count) files archived for recovery. Your card kit and pairing are preserved."
                print("SCAN-RESET: \(receipt.id) \(receipt.files.count) files archived")
            } catch { status = error.localizedDescription; print("SCAN-RESET-ERROR: \(status)") }
        }
    }
}
#endif
