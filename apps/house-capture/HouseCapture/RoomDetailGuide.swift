import Foundation
import CryptoKit
import simd

/// Reviewed spatial regions and fixed photographic targets, in one explicit model frame.
/// Room names never establish alignment. Reference assets are immutable derived files.
struct RoomDetailGuide: Codable {
    var format: String
    var revision: String
    var houseID: String
    var floorStepID: String
    var modelFromReference: [Float]
    var referenceMap: String
    var referenceMapSHA256: String
    var referenceMesh: String
    var referenceMeshSHA256: String
    var rooms: [Room]
    struct Room: Codable, Identifiable {
        var id: String
        var label: String
        var polygon: [[Float]]
        var minY: Float
        var maxY: Float
        var targets: [Target]
    }
    struct Target: Codable, Identifiable {
        var id: String
        var label: String
        var kind: String
        var position: [Float]
        var normal: [Float]
    }

    func validate() throws {
        guard modelFromReference.count == 16 else { throw GuidedRouteError("The room guide transform must contain 16 values.") }
        let matrix = simd_float4x4(columnMajor: modelFromReference)
        guard format == "room-detail-guide/1", !revision.isEmpty, !houseID.isEmpty, !floorStepID.isEmpty,
              modelFromReference.count == 16, modelFromReference.allSatisfy({ $0.isFinite && abs($0)<10000 }),
              abs(simd_determinant(matrix)-1) < 0.02,
              abs(matrix.columns.3.w-1) < 0.001,
              [matrix.columns.0.w, matrix.columns.1.w, matrix.columns.2.w].allSatisfy({ abs($0)<0.001 }),
              [matrix.columns.0, matrix.columns.1, matrix.columns.2].allSatisfy({ abs(simd_length($0)-1)<0.01 }),
              abs(simd_dot(matrix.columns.0,matrix.columns.1))<0.01,
              abs(simd_dot(matrix.columns.0,matrix.columns.2))<0.01,
              abs(simd_dot(matrix.columns.1,matrix.columns.2))<0.01,
              !rooms.isEmpty, rooms.count <= 100, Set(rooms.map(\.id)).count == rooms.count,
              Set(rooms.flatMap(\.targets).map(\.id)).count == rooms.flatMap(\.targets).count,
              rooms.allSatisfy({ !$0.id.isEmpty && !$0.label.isEmpty && $0.polygon.count >= 3 && $0.polygon.count <= 500 && $0.polygon.allSatisfy { $0.count == 2 && $0.allSatisfy(\.isFinite) } && $0.minY.isFinite && $0.maxY.isFinite && $0.maxY > $0.minY && !$0.targets.isEmpty && $0.targets.count <= 3000 && Set($0.targets.map(\.id)).count == $0.targets.count && $0.targets.allSatisfy { t in !t.id.isEmpty && !t.label.isEmpty && ["corner", "object"].contains(t.kind) && t.position.count == 3 && t.normal.count == 3 && t.position.allSatisfy({ $0.isFinite && abs($0)<10000 }) && t.normal.allSatisfy(\.isFinite) && abs(simd_length(SIMD3(t.normal))-1)<0.02 } }),
              Self.safeAsset(referenceMap), Self.safeAsset(referenceMesh),
              Self.validHash(referenceMapSHA256), Self.validHash(referenceMeshSHA256) else {
            throw GuidedRouteError("The room detail guide has invalid coordinates or reference assets. Reimport the reviewed floor.")
        }
    }

    static func load(folder: URL, expectedHash: String, houseID: String, floorStepID: String) throws -> Self {
        let data = try Data(contentsOf: folder.appendingPathComponent("detail-guide.json"))
        guard hash(data) == expectedHash else { throw GuidedRouteError("The room guide changed after floor review.") }
        let guide = try JSONDecoder().decode(Self.self, from: data)
        try guide.validate()
        guard guide.houseID == houseID, guide.floorStepID == floorStepID else { throw GuidedRouteError("This room guide belongs to another floor.") }
        for (file, expected, limit) in [(guide.referenceMap, guide.referenceMapSHA256, 256_000_000), (guide.referenceMesh, guide.referenceMeshSHA256, 150_000_000)] {
            let url = folder.appendingPathComponent(file)
            let size = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard size.isRegularFile == true, let bytes = size.fileSize, bytes > 0, bytes <= limit else { throw GuidedRouteError("A room reference asset is missing or oversized.") }
            guard hash(try Data(contentsOf: url, options: .mappedIfSafe)) == expected else { throw GuidedRouteError("A room reference asset failed its checksum.") }
        }
        return guide
    }
    var fingerprint: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return Self.hash((try? encoder.encode(self)) ?? Data())
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func validHash(_ s: String) -> Bool { s.count == 64 && s.allSatisfy { "0123456789abcdef".contains($0) } }
    static func safeAsset(_ s: String) -> Bool { !s.isEmpty && s != "." && s != ".." && s == URL(fileURLWithPath: s).lastPathComponent && !s.contains("\\") }

    func room(at p: SIMD3<Float>, boundaryMargin: Float = 0.18) -> Room? {
        let matches = rooms.filter { r in
            p.y >= r.minY && p.y <= r.maxY && Self.inside(r.polygon, SIMD2(p.x,p.z), margin: boundaryMargin)
        }
        return matches.count == 1 ? matches[0] : nil
    }
    static func inside(_ polygon: [[Float]], _ p: SIMD2<Float>, margin: Float) -> Bool {
        var inside = false
        for i in polygon.indices {
            let j = (i+1)%polygon.count, a = SIMD2(polygon[i]), b = SIMD2(polygon[j]), edge = b-a
            let length = simd_length_squared(edge)
            if length < 0.000001 { continue }
            let t = min(1,max(0,simd_dot(p-a,edge)/length))
            if simd_distance(p,a+t*edge) < margin { return false }
            if (a.y>p.y) != (b.y>p.y), p.x < (b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x { inside.toggle() }
        }
        return inside
    }
}
