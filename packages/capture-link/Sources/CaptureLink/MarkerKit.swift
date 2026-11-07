import Foundation
import CryptoKit
import ImageIO

public struct MarkerKit: Codable, Sendable {
    public let format: String
    public let kitID: String
    public let revision: String
    public let createdAt: String
    public let markers: [MarkerDefinition]

    public func validate() throws {
        guard format == "marker-kit/1", UUID(uuidString: kitID) != nil,
              Self.isHash(revision), !markers.isEmpty, markers.count <= 500,
              Set(markers.map(\.id)).count == markers.count else { throw CaptureLinkError("Invalid or unsupported marker kit.") }
        for marker in markers {
            guard marker.id.range(of: "^[CD][0-9]{3,6}$", options: .regularExpression) != nil,
                  ["checkpoint", "device", "spare"].contains(marker.role),
                  marker.physicalWidthMeters.isFinite, marker.physicalWidthMeters >= 0.02,
                  marker.physicalWidthMeters <= 0.5, marker.physicalHeightMeters == marker.physicalWidthMeters,
                  marker.image == "reference-images/\(marker.id).png", Self.isHash(marker.imageSHA256),
                  marker.label.count <= 300 else { throw CaptureLinkError("Invalid marker definition.") }
            guard let link = MarkerLink(url: marker.url), link.kitID == kitID, link.markerID == marker.id else {
                throw CaptureLinkError("Marker link does not match its kit.")
            }
        }
    }

    public func validateImages(in folder: URL) throws {
        try validate()
        for marker in markers {
            let url = folder.appendingPathComponent(marker.image)
            let info = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .fileSizeKey, .isRegularFileKey])
            guard info.isSymbolicLink != true, info.isRegularFile == true, (info.fileSize ?? Int.max) <= 10*1024*1024,
                  try url.deletingLastPathComponent().resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw CaptureLinkError("Linked or oversized image files are not allowed.") }
            let data = try Data(contentsOf: url)
            guard data.count <= 10*1024*1024, Self.hash(data) == marker.imageSHA256 else { throw CaptureLinkError("A marker image is missing or changed. Download the kit again.") }
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  (32...4096).contains(width), (32...4096).contains(height) else {
                throw CaptureLinkError("A marker image has invalid or excessive pixel dimensions.")
            }
        }
    }

    public static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func isHash(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
}

public struct MarkerDefinition: Codable, Identifiable, Sendable {
    public let id: String
    public let role: String
    public let label: String
    public let roomID: String?
    public let roomName: String?
    public let deviceID: String?
    public let image: String
    public let imageSHA256: String
    public let physicalWidthMeters: Double
    public let physicalHeightMeters: Double
    public let url: String
    public let retired: Bool?
}

public struct MarkerLink: Equatable, Sendable {
    public let kitID: String
    public let markerID: String
    public init?(url: String) {
        guard let c = URLComponents(string: url), c.scheme == "housecontrol", c.host == "marker",
              c.path.isEmpty, c.user == nil, c.password == nil, c.fragment == nil, c.port == nil,
              let items = c.queryItems, items.count == 3, Set(items.map(\.name)).count == items.count else { return nil }
        let values = Dictionary(uniqueKeysWithValues: items.compactMap { q in q.value.map { (q.name, $0) } })
        guard Set(values.keys) == Set(["v", "kit", "id"]), values["v"] == "1",
              let kit = values["kit"], UUID(uuidString: kit) != nil,
              let id = values["id"], id.range(of: "^[CD][0-9]{3,6}$", options: .regularExpression) != nil else { return nil }
        kitID = kit; markerID = id
    }
}
