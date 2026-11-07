import Foundation
import simd

/// Optional, reviewed recovery maps and room-specific photographs. Every map has
/// an explicit rigid transform into the guide reference; names never align data.
struct RoomLocalizationCatalog: Codable {
    var format = "room-localization/1"
    var houseID: String
    var floorStepID: String
    var guideSHA256: String
    var references: [Reference]
    var photos: [Photo]
    var preferredReferenceByRoom: [String: String] = [:]

    struct Reference: Codable, Identifiable {
        var id: String
        var label: String
        var roomIDs: [String]
        var mapFile: String
        var mapSHA256: String
        var referenceFromSession: [Float]
        var provenance: String
    }
    struct Photo: Codable {
        var roomID: String
        var file: String
        var sha256: String
        var positionInModel: [Float]
        var forwardInModel: [Float]
    }

    static func validTransform(_ values: [Float]) -> Bool {
        guard values.count == 16, values.allSatisfy({ $0.isFinite && abs($0) < 10000 }) else { return false }
        let m = simd_float4x4(columnMajor: values)
        return abs(simd_determinant(m)-1) < 0.02 && abs(m.columns.3.w-1) < 0.001
            && [m.columns.0.w,m.columns.1.w,m.columns.2.w].allSatisfy({ abs($0)<0.001 })
            && [m.columns.0,m.columns.1,m.columns.2].allSatisfy({ abs(simd_length($0)-1)<0.01 })
            && abs(simd_dot(m.columns.0,m.columns.1))<0.01 && abs(simd_dot(m.columns.0,m.columns.2))<0.01
            && abs(simd_dot(m.columns.1,m.columns.2))<0.01
    }

    func validate(guide: RoomDetailGuide, expectedGuideHash: String) throws {
        let rooms = Set(guide.rooms.map(\.id))
        guard format == "room-localization/1", houseID == guide.houseID, floorStepID == guide.floorStepID,
              guideSHA256 == expectedGuideHash, !references.isEmpty, references.count <= 12, photos.count <= 100,
              Set(references.map(\.id)).count == references.count,
              preferredReferenceByRoom.allSatisfy({ room, id in references.contains { $0.id == id && $0.roomIDs.contains(room) } }),
              references.allSatisfy({ !$0.id.isEmpty && !$0.label.isEmpty && !$0.provenance.isEmpty
                  && !$0.roomIDs.isEmpty && Set($0.roomIDs).isSubset(of: rooms)
                  && Self.validTransform($0.referenceFromSession) && RoomDetailGuide.safeAsset($0.mapFile)
                  && RoomDetailGuide.validHash($0.mapSHA256) }),
              photos.allSatisfy({ photo in
                  guard rooms.contains(photo.roomID), RoomDetailGuide.safeAsset(photo.file), RoomDetailGuide.validHash(photo.sha256),
                        photo.positionInModel.count == 3, photo.forwardInModel.count == 3,
                        photo.positionInModel.allSatisfy(\.isFinite), photo.forwardInModel.allSatisfy(\.isFinite),
                        abs(simd_length(SIMD3(photo.forwardInModel))-1)<0.02,
                        let room = guide.rooms.first(where: { $0.id == photo.roomID }) else { return false }
                  let p = SIMD3(photo.positionInModel)
                  return p.y >= room.minY && p.y <= room.maxY
                      && RoomDetailGuide.inside(room.polygon, SIMD2(p.x,p.z), margin: 0.05)
              }) else { throw GuidedRouteError("The room recovery references are invalid or belong to another reviewed floor.") }
    }

    static func load(folder: URL, hash: String, guide: RoomDetailGuide, guideHash: String) throws -> Self {
        let data = try verified(folder.appendingPathComponent("localization.json"), hash: hash, limit: 1_000_000)
        let value = try JSONDecoder().decode(Self.self, from: data)
        try value.validate(guide: guide, expectedGuideHash: guideHash)
        return value
    }
    static func verified(_ url: URL, hash: String, limit: Int) throws -> Data {
        let attrs = try url.resourceValues(forKeys: [.fileSizeKey,.isRegularFileKey])
        guard attrs.isRegularFile == true, let bytes = attrs.fileSize, bytes > 0, bytes <= limit else {
            throw GuidedRouteError("A room recovery reference is missing or too large.")
        }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        guard RoomDetailGuide.validHash(hash), RoomDetailGuide.hash(data) == hash else {
            throw GuidedRouteError("A room recovery reference failed its checksum.")
        }
        return data
    }
    func references(for roomID: String) -> [Reference] {
        let options = references.filter { $0.roomIDs.contains(roomID) }
        guard let preferred = preferredReferenceByRoom[roomID] else { return options }
        return options.filter { $0.id == preferred } + options.filter { $0.id != preferred }
    }
    func landmarks(for roomID: String, folder: URL) throws -> [URL] {
        try photos.filter { $0.roomID == roomID }.prefix(6).map {
            let url = folder.appendingPathComponent($0.file)
            _ = try Self.verified(url, hash: $0.sha256, limit: 3_000_000)
            guard PriorPhotos.thumbnail(url, maxPixel: 120) != nil else { throw GuidedRouteError("A room reference photo cannot be opened.") }
            return url
        }
    }
}

/// Captured poses remain in their real AR session. This record makes the mapping
/// into the unchanged guide explicit without resetting accumulated room progress.
struct DetailSessionReference: Codable {
    var format = "detail-session-reference/1"
    var guideSHA256: String
    var referenceID: String
    var mapSHA256: String
    var referenceFromSession: [Float]
}
