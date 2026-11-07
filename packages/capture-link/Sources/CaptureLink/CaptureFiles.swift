import Foundation
import CryptoKit

public struct CaptureFile: Codable, Sendable {
    public let path: String
    public let byteLength: Int
    public let sha256: String
    public var json: [String: Any] { ["path": path, "byteLength": byteLength, "sha256": sha256] }
}

public enum CaptureFiles {
    public static func collect(_ folder: URL) throws -> [CaptureFile] {
        // iOS may enumerate /private/var URLs for a /var sandbox URL. Compare
        // canonical path components, never offsets in differently spelled paths.
        let root = folder.resolvingSymlinksInPath().standardizedFileURL
        let rootComponents = root.pathComponents
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]) else { throw CaptureLinkError("Cannot read the saved scan.") }
        var files: [CaptureFile] = []; var total = 0
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isSymbolicLink != true else { throw CaptureLinkError("Scan folders cannot contain symbolic links.") }
            guard values.isRegularFile == true else { continue }
            let components = url.resolvingSymlinksInPath().standardizedFileURL.pathComponents
            guard components.count > rootComponents.count,
                  Array(components.prefix(rootComponents.count)) == rootComponents else {
                throw CaptureLinkError("A saved scan file is outside its capture folder.")
            }
            let path = components.dropFirst(rootComponents.count).joined(separator: "/")
            guard !path.hasPrefix("."), !path.split(separator: "/").contains("..") else { continue }
            let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
            var hasher = SHA256(); var count = 0
            while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty { hasher.update(data: data); count += data.count }
            total += count
            guard total <= 20*1024*1024*1024, files.count < 10_000 else { throw CaptureLinkError("Split this capture into smaller saved sessions before transfer.") }
            files.append(CaptureFile(path: path, byteLength: count, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined()))
        }
        guard !files.isEmpty else { throw CaptureLinkError("This capture has no saved files.") }
        return files.sorted { $0.path < $1.path }
    }
}
