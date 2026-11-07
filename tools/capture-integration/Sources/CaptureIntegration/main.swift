import Foundation
import Network
import CaptureLink
import HouseCore

/// Exercise the real, independently implemented client and host. No device-control APIs.
@main struct Integration {
    @MainActor static func main() async {
        do { try await run() }
        catch { fputs("FAIL: \(error.localizedDescription)\n", stderr); exit(1) }
    }
    static func check(_ condition: Bool, _ message: String) throws {
        guard condition else { throw CaptureLinkError(message) }
        print("PASS: \(message)")
    }
    @MainActor static func ready(_ client: CaptureConnection) async throws {
        for _ in 0..<200 {
            if client.connected { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw CaptureLinkError("TLS connection did not become ready")
    }
    @MainActor static func rejected(_ client: CaptureConnection, _ request: [String: Any], _ message: String) async throws {
        do { _ = try await client.request(request) }
        catch { print("PASS: \(message)"); return }
        throw CaptureLinkError("Accepted invalid request: \(message)")
    }
    @MainActor static func run() async throws {
        guard CommandLine.arguments.count == 3 else { throw CaptureLinkError("Usage: CaptureIntegration MARKER_KIT SPATIAL_PACKAGE") }
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("CaptureIntegration-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temp) }
        let store = SpatialPackageStore(directory: temp.appendingPathComponent("store"))
        let kit = try await store.importKit(from: URL(fileURLWithPath: CommandLine.arguments[1]))
        let staged = try await store.stagePackage(from: URL(fileURLWithPath: CommandLine.arguments[2]))
        let spatial = try await store.activate(staged)
        try check(!spatial.manifest.rooms.isEmpty, "Generated pilot validates, stages and activates in House Control")
        let repository = CaptureRepository(directory: temp.appendingPathComponent("inbox"), hostName: "Integration Mac")
        await repository.setKit(kit); await repository.setSpatial(spatial)
        let hostPair = HouseCore.CapturePairing.generate(name: "Capture Integration \(UUID().uuidString.prefix(8))")
        let secrets = MemorySecretStore(try JSONEncoder().encode(hostPair))
        let server = CaptureServer(repository: repository, secrets: secrets)
        server.preferredPort = 0
        try server.start(advertise: true)
        defer { server.stop() }
        for _ in 0..<200 {
            if let port = server.port, port > 0 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard let port = server.port, let pairing = CaptureLink.CapturePairing(link: hostPair.link) else { throw CaptureLinkError("Pairing or listener unavailable") }
        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        let client = CaptureConnection(); defer { client.stop() }
        client.onStatus = { message, _ in print("STATUS: \(message)") }
        print("Listener port: \(port)")
        client.start(pairing); try await ready(client)
        try check(client.connected, "Scanner discovers the host by Bonjour TXT identity and authenticates TLS-PSK")
        let catalog = try await client.request(["op": "catalog"])
        guard let rawKit = catalog["kit"] else { throw CaptureLinkError("Missing catalog kit") }
        let decoded = try JSONDecoder().decode(MarkerKit.self, from: JSONSerialization.data(withJSONObject: rawKit))
        try decoded.validate()
        try check(decoded.kitID == kit.manifest.kitID, "Marker kit decodes on both clients with stable identity")
        for marker in decoded.markers {
            let chunk = try await client.request(["op": "asset.get", "assetID": marker.image, "offset": 0, "length": 131072])
            guard let b64 = chunk["data"] as? String, let data = Data(base64Encoded: b64), chunk["eof"] as? Bool == true,
                  MarkerKit.hash(data) == marker.imageSHA256 else { throw CaptureLinkError("Kit asset mismatch") }
        }
        try check(true, "All reference images transfer with matching hashes")
        let spatialCatalog = try await client.request(["op": "spatial.catalog"])
        try check((spatialCatalog["manifest"] as? [String: Any])?["revision"] as? String == spatial.manifest.revision, "Accepted spatial revision is available to paired clients")
        guard let manifestAsset = spatialCatalog["manifestAsset"] as? [String: Any],
              let manifestID = manifestAsset["id"] as? String else { throw CaptureLinkError("Missing original spatial manifest asset") }
        var manifestBytes = Data(), manifestDone = false
        while !manifestDone {
            let chunk = try await client.request(["op": "asset.get", "assetID": manifestID, "offset": manifestBytes.count, "length": 131072])
            guard let b64 = chunk["data"] as? String, let bytes = Data(base64Encoded: b64), let eof = chunk["eof"] as? Bool,
                  !bytes.isEmpty || eof, manifestBytes.count + bytes.count <= 1024 * 1024 else { throw CaptureLinkError("Invalid spatial manifest transfer") }
            manifestBytes.append(bytes); manifestDone = eof
        }
        let originalManifest = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("manifest.json"))
        try check(manifestBytes == originalManifest && MarkerKit.hash(manifestBytes) == manifestAsset["sha256"] as? String,
                  "Spatial manifest transfers byte-for-byte without revision collisions")
        let captureID = UUID().uuidString
        let bytes = Data((0..<300_000).map { UInt8($0 % 251) })
        let begin: [String: Any] = ["op": "capture.begin", "captureID": captureID, "houseID": "fixture-house", "zoneID": "fixture-zone", "sessionID": "fixture-session", "source": "iphone", "files": [["path": "depth/frame.bin", "byteLength": bytes.count, "sha256": MarkerKit.hash(bytes)]]]
        _ = try await client.request(begin)
        let first: [String: Any] = ["op": "capture.put", "captureID": captureID, "path": "depth/frame.bin", "offset": 0, "data": bytes.prefix(131072).base64EncodedString()]
        _ = try await client.request(first)
        _ = try await client.request(first)
        try check(true, "Identical upload retry is idempotent")
        client.stop()
        client.connect(endpoint, pairing: pairing); try await ready(client)
        _ = try await client.request(begin)
        let status = try await client.request(["op": "capture.status", "captureID": captureID])
        let rows = status["files"] as? [[String: Any]]
        try check(rows?.first?["receivedBytes"] as? Int == 131072, "Reconnect resumes at the durable byte offset")
        server.stop()
        try server.start(advertise: false)
        for _ in 0..<100 {
            if let port = server.port, port > 0 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard let restartPort = server.port else { throw CaptureLinkError("Restart failed") }
        client.connect(.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: restartPort)!), pairing: pairing)
        try await ready(client)
        let restarted = try await client.request(["op": "capture.status", "captureID": captureID])
        try check((restarted["files"] as? [[String: Any]])?.first?["receivedBytes"] as? Int == 131072, "Host listener restart preserves upload recovery")
        var offset = 131072
        while offset < bytes.count {
            let end = min(offset+131072, bytes.count)
            _ = try await client.request(["op": "capture.put", "captureID": captureID, "path": "depth/frame.bin", "offset": offset, "data": bytes.subdata(in: offset..<end).base64EncodedString()])
            offset = end
        }
        let finished = try await client.request(["op": "capture.finish", "captureID": captureID])
        try check(finished["complete"] as? Bool == true, "Finished capture is checksum verified and atomically receipted")
        _ = try await client.request(["op": "capture.finish", "captureID": captureID])
        try check(true, "Finish retry reconciles the existing receipt")
        // Additive itinerary evidence must travel unchanged, without becoming geometry.
        let contextID = UUID().uuidString
        let context = try JSONSerialization.data(withJSONObject: ["format": "guided-capture/1", "routeID": "fixture-route",
            "step": ["id": "entry", "floor": "Ground floor", "doorState": "closed", "mirrors": [["id": "mirror-1", "cardID": "D059"]]],
            "alignmentVerified": false, "automaticReflectionRemoval": false], options: [.sortedKeys])
        _ = try await client.request(["op": "capture.begin", "captureID": contextID, "houseID": "fixture-house",
            "zoneID": "fixture-zone", "sessionID": "fixture-route-session", "source": "iphone",
            "files": [["path": "route-step.json", "byteLength": context.count, "sha256": MarkerKit.hash(context)]]])
        _ = try await client.request(["op": "capture.put", "captureID": contextID, "path": "route-step.json", "offset": 0, "data": context.base64EncodedString()])
        let contextReceipt = try await client.request(["op": "capture.finish", "captureID": contextID])
        try check(contextReceipt["complete"] as? Bool == true, "Guided route and mirror evidence receive a verified transfer receipt")
        let inboxFolders = try FileManager.default.contentsOfDirectory(at: temp.appendingPathComponent("inbox"), includingPropertiesForKeys: nil)
        guard let contextFolder = inboxFolders.first(where: { folder in
            guard let data = try? Data(contentsOf: folder.appendingPathComponent("capture.json")),
                  let descriptor = try? JSONDecoder().decode(CaptureRepository.Descriptor.self, from: data) else { return false }
            return descriptor.captureID == contextID
        }) else { throw CaptureLinkError("Missing receipted context payload") }
        let receivedContext = try Data(contentsOf: contextFolder.appendingPathComponent("payload/route-step.json"))
        try check(receivedContext == context, "Mac preserves route, door-state and provisional mirror metadata byte-for-byte")
        let previewID = UUID().uuidString
        let preview: [String: Any] = ["op": "preview", "captureID": previewID, "sequence": 1, "roomName": "Fixture", "tracking": "normal", "photoCount": 2, "depthFrameCount": 1, "alignmentVerified": false, "vertices": [[0.0,0.0,0.0],[1.0,0.0,0.0],[0.0,1.0,0.0]], "triangles": [0,1,2]]
        _ = try await client.request(preview)
        let latest = try await client.request(["op": "preview.latest", "captureID": previewID])
        try check(latest["stale"] as? Bool == false && (latest["preview"] as? [String: Any])?["alignmentVerified"] as? Bool == false, "Provisional live preview works before final capture and stays unverified")
        try await rejected(client, ["op": "device.set", "deviceID": "fixture", "value": true], "Capture credentials cannot operate devices")
        try await rejected(client, ["op": "asset.get", "assetID": "../secret", "offset": 0, "length": 1024], "Asset allowlist rejects traversal")
        var badBegin = begin; badBegin["captureID"] = UUID().uuidString
        badBegin["files"] = [["path": "../escape", "byteLength": 1, "sha256": MarkerKit.hash(Data([1]))]]
        try await rejected(client, badBegin, "Capture descriptors reject traversal")
        let badID = UUID().uuidString
        var mismatch = begin; mismatch["captureID"] = badID
        mismatch["files"] = [["path": "sample.bin", "byteLength": 1, "sha256": MarkerKit.hash(Data([1]))]]
        _ = try await client.request(mismatch)
        _ = try await client.request(["op": "capture.put", "captureID": badID, "path": "sample.bin", "offset": 0, "data": Data([2]).base64EncodedString()])
        try await rejected(client, ["op": "capture.finish", "captureID": badID], "Checksum mismatch cannot become a completed capture")
        let wrong = HouseCore.CapturePairing.generate(name: "Wrong key")
        try check(wrong.key != hostPair.key, "Each pairing generates a different secret")
        let invalid = CaptureConnection(); defer { invalid.stop() }
        invalid.connect(.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: restartPort)!), pairing: CaptureLink.CapturePairing(link: wrong.link)!)
        try await Task.sleep(for: .seconds(1))
        if invalid.connected {
            try await rejected(invalid, ["op": "catalog"], "Different capture credentials cannot read the catalog")
        } else { try check(true, "Different capture credentials cannot authenticate") }
        print("PASS: Cross-repository integration complete; no physical-device acceptance claimed")
    }
}
