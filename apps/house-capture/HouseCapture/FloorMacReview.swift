import Foundation
import CryptoKit

/// A local reconstruction receipt. This never rewrites a capture's AR frame or
/// claims physical calibration. Any added/changed source invalidates the receipt.
struct FloorMacReview: Codable, Equatable {
    var format = "floor-mac-review/1"
    var routeID: String
    var stepID: String
    var houseID: String
    var sessionIDs: [String]
    var captureSignatures: [String: String]
    var reviewedAreas: Set<String>
    var modelFile: String
    var modelSHA256: String
    var verifiedBackupFiles: Int
    var verifiedBackupBytes: Int64
    var registrationMethod: String
    var notes: [String]
    var physicalAlignmentVerified = false
    var detailGuideSHA256: String? = nil
    var localizationSHA256: String? = nil

    static func folder(house: HouseProject, stepID: String) -> URL? {
        guard !stepID.isEmpty, stepID != ".", stepID != "..",
              stepID.rangeOfCharacter(from: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_")).inverted) == nil else { return nil }
        return house.url.appendingPathComponent("reviews", isDirectory: true).appendingPathComponent(stepID, isDirectory: true)
    }

    func matches(routeID: String, step: GuidedRoute.Step, houseID: String, evidence: FloorStructureEvidence) -> Bool {
        format == "floor-mac-review/1" && self.routeID == routeID && self.stepID == step.id && self.houseID == houseID &&
        !sessionIDs.isEmpty && sessionIDs == evidence.sessionIDs && captureSignatures == evidence.signatures &&
        captureSignatures.count == sessionIDs.count && captureSignatures.values.allSatisfy(Self.validHash) &&
        Set(step.areas ?? []).isSubset(of: reviewedAreas) && verifiedBackupFiles > 0 && verifiedBackupBytes > 0 &&
        !registrationMethod.isEmpty && !notes.isEmpty && !physicalAlignmentVerified &&
        modelFile == URL(fileURLWithPath: modelFile).lastPathComponent && modelFile.hasSuffix(".usdz") && Self.validHash(modelSHA256)
    }

    static func load(house: HouseProject, routeID: String, step: GuidedRoute.Step, evidence: FloorStructureEvidence) -> Self? {
        guard let folder = folder(house: house, stepID: step.id),
              let data = try? Data(contentsOf: folder.appendingPathComponent("review.json")),
              let review = try? JSONDecoder().decode(Self.self, from: data),
              review.matches(routeID: routeID, step: step, houseID: house.id, evidence: evidence),
              let model = try? Data(contentsOf: folder.appendingPathComponent(review.modelFile), options: .mappedIfSafe),
              model.count <= 100_000_000,
              SHA256.hash(data: model).map({ String(format: "%02x", $0) }).joined() == review.modelSHA256 else { return nil }
        return review
    }

    private static func validHash(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
    }
}
