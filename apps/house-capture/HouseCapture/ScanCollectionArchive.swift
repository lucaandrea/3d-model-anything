import CryptoKit
import Foundation

/// A reversible reset. The active library becomes empty without destroying originals,
/// pairing, or the printed kit. Archives can be restored through the app.
enum ScanCollectionArchive {
    struct Receipt: Codable, Identifiable {
        var id: String
        var createdAt: Date
        var files: [FileRecord]
    }
    struct FileRecord: Codable {
        var path: String
        var bytes: Int
        var sha256: String
    }
    static let names = ["Houses", "ScanRouteState.json"]
    static func root(_ documents: URL) -> URL { documents.appendingPathComponent("ScanArchives", isDirectory: true) }

    static func archive(documents: URL = GuidedRoute.documents) throws -> Receipt {
        let fm = FileManager.default
        let documents = documents.resolvingSymlinksInPath().standardizedFileURL
        let id = UUID().uuidString
        let destination = root(documents).appendingPathComponent(id, isDirectory: true)
        let present = names.filter { fm.fileExists(atPath: documents.appendingPathComponent($0).path) }
        guard present.contains("Houses") else { throw GuidedRouteError("There are no saved scans to clear.") }
        let receipt = Receipt(id: id, createdAt: Date(), files: try inventory(documents: documents))
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        try JSONEncoder().encode(receipt).write(to: destination.appendingPathComponent("archive.json"), options: .atomic)
        var moved: [String] = []
        do {
            for name in present {
                try fm.moveItem(at: documents.appendingPathComponent(name), to: destination.appendingPathComponent(name))
                moved.append(name)
            }
        } catch {
            for name in moved.reversed() {
                try? fm.moveItem(at: destination.appendingPathComponent(name), to: documents.appendingPathComponent(name))
            }
            throw error
        }
        return receipt
    }

    static func inventory(documents: URL = GuidedRoute.documents) throws -> [FileRecord] {
        let fm = FileManager.default
        let documents = documents.resolvingSymlinksInPath().standardizedFileURL
        let rootComponents = documents.pathComponents
        let present = names.filter { fm.fileExists(atPath: documents.appendingPathComponent($0).path) }
        var files: [FileRecord] = []
        for name in present {
            let source = documents.appendingPathComponent(name)
            var urls = [source]
            if name == "Houses" {
                var enumerationError: Error?
                guard let enumerator = fm.enumerator(at: source, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey], errorHandler: { _, error in enumerationError = error; return false }) else {
                    throw GuidedRouteError("Could not enumerate the existing scans. Nothing was moved.")
                }
                urls = enumerator.allObjects.compactMap { $0 as? URL }
                if let enumerationError { throw enumerationError }
            }
            for url in urls {
                let properties = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard properties.isSymbolicLink != true else { throw GuidedRouteError("A scan contains a symbolic link. Nothing was moved.") }
                guard properties.isRegularFile == true else { continue }
                let components = url.resolvingSymlinksInPath().standardizedFileURL.pathComponents
                guard components.count > rootComponents.count, Array(components.prefix(rootComponents.count)) == rootComponents else {
                    throw GuidedRouteError("A scan file is outside its collection. Nothing was moved.")
                }
                let relative = components.dropFirst(rootComponents.count).joined(separator: "/")
                files.append(try fileRecord(url: url, relative: relative))
            }
        }
        return files.sorted { $0.path < $1.path }
    }

    static func receipts(documents: URL = GuidedRoute.documents) -> [Receipt] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: root(documents), includingPropertiesForKeys: nil)) ?? []
        return urls.compactMap { url in
            guard FileManager.default.fileExists(atPath: url.appendingPathComponent("Houses").path),
                  let data = try? Data(contentsOf: url.appendingPathComponent("archive.json")),
                  let receipt = try? JSONDecoder().decode(Receipt.self, from: data), receipt.id == url.lastPathComponent else { return nil }
            return receipt
        }.sorted { $0.createdAt > $1.createdAt }
    }

    static func restore(_ receipt: Receipt, documents: URL = GuidedRoute.documents) throws {
        guard UUID(uuidString: receipt.id) != nil else { throw GuidedRouteError("Invalid archive identifier.") }
        let fm = FileManager.default
        let source = root(documents).appendingPathComponent(receipt.id)
        let sourceHouses = source.appendingPathComponent("Houses")
        let targetHouses = documents.appendingPathComponent("Houses")
        let houses = try fm.contentsOfDirectory(at: sourceHouses, includingPropertiesForKeys: nil)
        // Preflight every conflict before moving anything. Never replace an active collection.
        guard houses.allSatisfy({ !fm.fileExists(atPath: targetHouses.appendingPathComponent($0.lastPathComponent).path) }) else {
            throw GuidedRouteError("A house with the same ID is already active. Nothing was replaced.")
        }
        for file in receipt.files {
            guard !file.path.hasPrefix("/"), !file.path.split(separator: "/").contains(".."),
                  names.contains(String(file.path.split(separator: "/").first ?? "")) else { throw GuidedRouteError("Invalid archive file path.") }
            let actual = try fileRecord(url: source.appendingPathComponent(file.path), relative: file.path)
            guard actual.bytes == file.bytes, actual.sha256 == file.sha256 else { throw GuidedRouteError("Archive checksum failed. Keep the Mac backup and do not replace current scans.") }
        }
        try fm.createDirectory(at: targetHouses, withIntermediateDirectories: true)
        var moved: [URL] = []
        do {
            for house in houses {
                try fm.moveItem(at: house, to: targetHouses.appendingPathComponent(house.lastPathComponent)); moved.append(house)
            }
        } catch {
            for house in moved.reversed() { try? fm.moveItem(at: targetHouses.appendingPathComponent(house.lastPathComponent), to: house) }
            throw error
        }
        // An archived itinerary is retained as history; it must not overwrite the current route.
        try? fm.removeItem(at: sourceHouses)
    }

    private static func fileRecord(url: URL, relative: String) throws -> FileRecord {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256(), bytes = 0
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk); bytes += chunk.count }
        return .init(path: relative, bytes: bytes, sha256: hash.finalize().map { String(format: "%02x", $0) }.joined())
    }
}
