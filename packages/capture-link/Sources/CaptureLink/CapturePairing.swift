import Foundation

public struct CapturePairing: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let key: Data

    public init?(link: String) {
        guard let url = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "housecapture", url.host == "pair", url.user == nil, url.password == nil,
              url.fragment == nil, url.port == nil, url.path.isEmpty, let items = url.queryItems, items.count == 4,
              Set(items.map(\.name)).count == items.count else { return nil }
        let fields = Dictionary(uniqueKeysWithValues: items.compactMap { item in item.value.map { (item.name, $0) } })
        guard Set(fields.keys) == Set(["v", "id", "name", "key"]), fields["v"] == "1",
              let id = fields["id"], UUID(uuidString: id) != nil,
              let name = fields["name"], !name.isEmpty, name.count <= 128,
              let encoded = fields["key"], encoded.count <= 48 else { return nil }
        var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4-base64.count%4)%4)
        guard let key = Data(base64Encoded: base64), key.count == 32 else { return nil }
        self.id = id; self.name = name; self.key = key
    }
}

public struct CaptureLinkError: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
