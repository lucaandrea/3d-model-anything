import ARKit
import Foundation
import simd

/// Immutable startup inputs, decoded off-main with the same readers used by live capture.
/// ARWorldMap is handed to the one managed ARSession; callers do not mutate it.
struct PreparedDetailReference: @unchecked Sendable {
    let guide: RoomDetailGuide
    let mapURL: URL
    let map: ARWorldMap
    let mesh: ZoneReference
    let landmarks: [URL]
    let sessionReference: DetailSessionReference
    let referenceLabel: String
    let request: Request
    let alternatives: [RoomLocalizationCatalog.Reference]

    struct Request: Sendable {
        var folder: URL
        var expectedHash: String
        var houseID: String
        var floorStepID: String
        var roomID: String?
        var localizationHash: String?
        func load(referenceID: String? = nil) throws -> PreparedDetailReference {
            try PreparedDetailReference.load(folder: folder, expectedHash: expectedHash, houseID: houseID,
                floorStepID: floorStepID, selectedRoomID: roomID, localizationHash: localizationHash, referenceID: referenceID)
        }
    }

    static func load(folder: URL, expectedHash: String, houseID: String, floorStepID: String,
                     selectedRoomID: String? = nil, localizationHash: String? = nil, referenceID: String? = nil) throws -> PreparedDetailReference {
        let guide = try RoomDetailGuide.load(folder: folder, expectedHash: expectedHash, houseID: houseID, floorStepID: floorStepID)
        let catalog = try localizationHash.map { try RoomLocalizationCatalog.load(folder: folder, hash: $0, guide: guide, guideHash: expectedHash) }
        let options = selectedRoomID.map { catalog?.references(for: $0) ?? [] } ?? []
        if referenceID != nil, !options.contains(where: { $0.id == referenceID }) {
            throw GuidedRouteError("That recovery map does not belong to the selected room.")
        }
        let selected = referenceID.flatMap { id in options.first { $0.id == id } } ?? options.first
        let transform = selected?.referenceFromSession ?? matrix_identity_float4x4.columnMajor
        let mapURL = folder.appendingPathComponent(selected?.mapFile ?? guide.referenceMap)
        let mapHash = selected?.mapSHA256 ?? guide.referenceMapSHA256
        _ = try RoomLocalizationCatalog.verified(mapURL, hash: mapHash, limit: 256_000_000)
        let mesh = try ZoneReference.reviewed(folder.appendingPathComponent(guide.referenceMesh), sessionFromReference: simd_float4x4(columnMajor: transform).inverse)
        let map = try WorldMapFile.load(mapURL)
        guard !map.rawFeaturePoints.points.isEmpty else {
            throw GuidedRouteError("The reviewed floor map has no saved visual features. Keep your scans and repair the reference before starting guided details.")
        }
        let landmarks = try selectedRoomID.map { try catalog?.landmarks(for: $0, folder: folder) ?? [] } ?? []
        let record = DetailSessionReference(guideSHA256: guide.fingerprint, referenceID: selected?.id ?? "reviewed-floor",
            mapSHA256: mapHash, referenceFromSession: transform)
        return .init(guide: guide, mapURL: mapURL, map: map, mesh: mesh, landmarks: landmarks, sessionReference: record,
            referenceLabel: selected?.label ?? "Reviewed floor map", request: .init(folder: folder, expectedHash: expectedHash,
                houseID: houseID, floorStepID: floorStepID, roomID: selectedRoomID, localizationHash: localizationHash), alternatives: options)
    }
}
