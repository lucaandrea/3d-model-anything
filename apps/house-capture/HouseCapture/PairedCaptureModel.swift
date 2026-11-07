import Foundation
import Combine
import Security
import CaptureLink

@MainActor
final class PairedCaptureModel: ObservableObject {
    static let shared = PairedCaptureModel()
    @Published private(set) var status = "Not paired with a Mac"
    @Published private(set) var connected = false
    @Published private(set) var working = false
    @Published private(set) var progress = ""
    @Published private(set) var kit: MarkerKit?
    @Published private(set) var lastError: String?
    @Published var showSetup = false
    private let channel = CaptureConnection()
    private var pairing: CapturePairing?
    private var previewBusy = false
    private var sequence = 0
    private var latestPreviewAt = Date.distantPast
    static var kitFolder: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("MarkerKit") }
    private static let keychainService = "ooo.luca.modelanything.capture-pairing"

    private init() {
        if let data = Self.readPairing() { pairing = try? JSONDecoder().decode(CapturePairing.self, from: data) }
        if let data = try? Data(contentsOf: Self.kitFolder.appendingPathComponent("manifest.json")),
           let kit = try? JSONDecoder().decode(MarkerKit.self, from: data), (try? kit.validateImages(in: Self.kitFolder)) != nil { self.kit = kit }
        if pairing != nil { status = "Mac pairing saved. Tap Reconnect." }
        channel.onStatus = { [weak self] message, online in self?.status = message; self?.connected = online }
    }

    func pair(link: String) {
        guard let pairing = CapturePairing(link: link) else { lastError = "Use the capture pairing link from House Control on your Mac."; return }
        do {
            try Self.savePairing(JSONEncoder().encode(pairing))
            self.pairing = pairing; lastError = nil; channel.start(pairing)
        } catch { lastError = error.localizedDescription }
    }

    func open(_ url: URL) {
        guard url.scheme == "housecapture" else { return }
        showSetup = true; pair(link: url.absoluteString)
    }

    func reconnect() { if let pairing { channel.start(pairing) } }
    func disconnect() { channel.stop(); connected = false; status = "Disconnected; scans remain on this iPhone" }

    func downloadKit() async {
        guard !working else { return }; working = true; lastError = nil
        defer { working = false }
        do {
            try await waitForPreview()
            let result = try await channel.request(["op": "catalog"])
            guard result["protocol"] as? String == "house-capture-link/1", let raw = result["kit"] as? [String: Any] else { throw CaptureLinkError("The Mac has no marker kit loaded yet.") }
            let data = try JSONSerialization.data(withJSONObject: raw)
            let kit = try JSONDecoder().decode(MarkerKit.self, from: data)
            try kit.validate()
            let staging = Self.kitFolder.deletingLastPathComponent().appendingPathComponent("MarkerKit-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: staging) }
            try FileManager.default.createDirectory(at: staging.appendingPathComponent("reference-images"), withIntermediateDirectories: true)
            for (index, marker) in kit.markers.enumerated() {
                progress = "Downloading card \(index+1) of \(kit.markers.count)"
                var bytes = Data(), done = false
                while !done {
                    try Task.checkCancellation()
                    let chunk = try await channel.request(["op": "asset.get", "assetID": marker.image, "offset": bytes.count, "length": 131072])
                    guard let encoded = chunk["data"] as? String, let part = Data(base64Encoded: encoded),
                          chunk["offset"] as? Int == bytes.count, part.count <= 131072, let eof = chunk["eof"] as? Bool,
                          !part.isEmpty || eof, bytes.count + part.count <= 10*1024*1024 else { throw CaptureLinkError("Invalid marker image transfer.") }
                    bytes.append(part); done = eof
                }
                guard MarkerKit.hash(bytes) == marker.imageSHA256 else { throw CaptureLinkError("Marker image checksum failed. Retry the download.") }
                try bytes.write(to: staging.appendingPathComponent(marker.image), options: .atomic)
            }
            try data.write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)
            try kit.validateImages(in: staging)
            let backup = Self.kitFolder.appendingPathExtension("previous")
            if FileManager.default.fileExists(atPath: backup.path) { try FileManager.default.removeItem(at: backup) }
            if FileManager.default.fileExists(atPath: Self.kitFolder.path) { try FileManager.default.moveItem(at: Self.kitFolder, to: backup) }
            do { try FileManager.default.moveItem(at: staging, to: Self.kitFolder) }
            catch { if FileManager.default.fileExists(atPath: backup.path) { try? FileManager.default.moveItem(at: backup, to: Self.kitFolder) }; throw error }
            self.kit = kit; progress = "\(kit.markers.count) cards ready. Verify the printed ruler before calibration."
        } catch { lastError = error.localizedDescription; progress = "Card download paused. Reconnect and retry." }
    }

    static func captureID(houseID: String, sessionID: String, legacyFolder: URL) -> String {
        // An app update can relocate its sandbox. The persisted upload identity belongs
        // to the capture, so recovery must not depend on the current container path.
        let identity = Data("\(houseID.utf8.count):\(houseID)\(sessionID)".utf8)
        let key = "capture-upload-v1-" + MarkerKit.hash(identity)
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let previousKey = "capture-upload-" + MarkerKit.hash(Data(legacyFolder.path.utf8))
        let id = UserDefaults.standard.string(forKey: previousKey) ?? UUID().uuidString
        UserDefaults.standard.set(id, forKey: key); return id
    }

    func upload(house: HouseProject, session: HouseProject.Session) async {
        guard !working, session.endedAt != nil else { return }
        working = true; lastError = nil; progress = "Checking saved files…"
        defer { working = false }
        do {
            guard FloorStructureReview.permitsUpload(house: house, session: session) else {
                throw GuidedRouteError("Finish and save this capture before uploading. Finished originals can be sent to the Mac for review even if their alignment needs repair.")
            }
            try await waitForPreview()
            let folder = house.bundle(for: session).url
            let captureID = Self.captureID(houseID: house.id, sessionID: session.id, legacyFolder: folder)
            let files = try await Task.detached(priority: .utility) { try CaptureFiles.collect(folder) }.value
            _ = try await channel.request(["op": "capture.begin", "captureID": captureID, "houseID": house.id,
                "zoneID": session.zone, "sessionID": session.id, "source": "iphone", "files": files.map(\.json)])
            let state = try await channel.request(["op": "capture.status", "captureID": captureID])
            if state["complete"] as? Bool == true {
                UserDefaults.standard.set(Date(), forKey: "capture-receipt-\(captureID)")
                progress = "Already saved and verified on the Mac."; return
            }
            var offsets: [String: Int] = [:]
            for row in state["files"] as? [[String: Any]] ?? [] {
                if let path = row["path"] as? String, let offset = row["receivedBytes"] as? Int { offsets[path] = offset }
            }
            let total = files.reduce(0) { $0 + $1.byteLength }
            var sent = 0
            for file in files {
                try Task.checkCancellation()
                var offset = offsets[file.path] ?? 0
                guard offset >= 0, offset <= file.byteLength else { throw CaptureLinkError("Invalid resume position from the Mac.") }
                sent += offset
                let handle = try FileHandle(forReadingFrom: folder.appendingPathComponent(file.path))
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(offset))
                while offset < file.byteLength {
                    try Task.checkCancellation()
                    guard let data = try handle.read(upToCount: min(131072, file.byteLength-offset)), !data.isEmpty else { throw CaptureLinkError("The saved capture changed during transfer.") }
                    let result = try await channel.request(["op": "capture.put", "captureID": captureID, "path": file.path,
                        "offset": offset, "data": data.base64EncodedString()])
                    guard result["receivedBytes"] as? Int == offset+data.count else { throw CaptureLinkError("The Mac did not confirm this chunk. Reconnect to resume.") }
                    offset += data.count; sent += data.count
                    progress = "Sending \(Int(Double(sent)/Double(max(1,total))*100))% · \(file.path)"
                }
            }
            let receipt = try await channel.request(["op": "capture.finish", "captureID": captureID])
            guard receipt["complete"] as? Bool == true else { throw CaptureLinkError("The Mac has not verified the capture yet.") }
            UserDefaults.standard.set(Date(), forKey: "capture-receipt-\(captureID)")
            progress = "Capture saved and checksum-verified on the Mac. Originals remain on this iPhone."
        } catch { lastError = error.localizedDescription; progress = "Transfer paused. Originals remain on this iPhone; retry the same session to resume." }
    }

    static func hasReceipt(house: HouseProject, session: HouseProject.Session) -> Bool {
        let id = captureID(houseID: house.id, sessionID: session.id, legacyFolder: house.bundle(for: session).url)
        return UserDefaults.standard.object(forKey: "capture-receipt-\(id)") is Date
    }

    func preview(_ payload: [String: Any]) async {
        guard connected, !previewBusy, !working, !channel.busy, Date().timeIntervalSince(latestPreviewAt) >= 0.5 else { return }
        previewBusy = true; latestPreviewAt = Date(); sequence += 1
        defer { previewBusy = false }
        var value = payload; value["op"] = "preview"; value["sequence"] = sequence
        do { _ = try await channel.request(value) } catch { /* Originals are unaffected by preview loss. */ }
    }

    private func waitForPreview() async throws {
        // Setting working before this wait prevents another preview from starting.
        // A connection timeout or cancellation releases the in-flight preview.
        while previewBusy { try await Task.sleep(for: .milliseconds(50)) }
        try Task.checkCancellation()
    }

    private static func query() -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService, kSecAttrAccount as String: "mac"] }
    private static func readPairing() -> Data? {
        var q = query(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess else { return nil }; return result as? Data
    }
    private static func savePairing(_ data: Data) throws {
        let q = query()
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q; add[kSecValueData as String] = data; add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw CaptureLinkError("Cannot save the pairing securely.") }
        } else if status != errSecSuccess { throw CaptureLinkError("Cannot update the saved pairing.") }
    }
}
