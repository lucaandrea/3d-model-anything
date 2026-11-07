import XCTest
@testable import CaptureLink

final class ContractTests: XCTestCase {
    func testPairingIsCaptureOnlyAndRejectsDuplicateParameters() {
        let id = UUID().uuidString, key = Data(repeating: 7, count: 32).base64EncodedString()
        let link = "housecapture://pair?v=1&id=\(id)&name=Mac&key=\(key)"
        XCTAssertNotNil(CapturePairing(link: link))
        XCTAssertNil(CapturePairing(link: link.replacingOccurrences(of: "housecapture:", with: "housecontrol:")))
        XCTAssertNil(CapturePairing(link: link + "&key=bad"))
        XCTAssertNil(CapturePairing(link: link + "&command=on"))
        XCTAssertNil(CapturePairing(link: link + "&command"))
        XCTAssertNil(CapturePairing(link: link.replacingOccurrences(of: "//pair?", with: "//pair:80?")))
    }
    func testMarkerLinkCannotCarryCommandsOrPairing() {
        let link = "housecontrol://marker?v=1&kit=\(UUID().uuidString)&id=D001"
        XCTAssertNotNil(MarkerLink(url: link))
        XCTAssertNil(MarkerLink(url: link + "&action=on"))
        XCTAssertNil(MarkerLink(url: link + "&id=D002"))
        XCTAssertNil(MarkerLink(url: link + "&action"))
    }
    func testCaptureFilesHashBinaryAndRejectLinks() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data([0, 255, 2]).write(to: dir.appendingPathComponent("depth.bin"))
        let records = try CaptureFiles.collect(dir)
        XCTAssertEqual(records.first?.path, "depth.bin")
        XCTAssertEqual(records.first?.byteLength, 3)
        XCTAssertEqual(records.first?.sha256, MarkerKit.hash(Data([0, 255, 2])))
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("linked"), withDestinationURL: dir.appendingPathComponent("depth.bin"))
        XCTAssertThrowsError(try CaptureFiles.collect(dir))
    }
    func testCapturePathsReopenThroughAnAliasedSandboxAndDatedSession() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let session = dir.appendingPathComponent("real/2026-10-25 11.08.17")
        try fm.createDirectory(at: session.appendingPathComponent("depth"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let bytes = Data([0, 1, 255])
        try bytes.write(to: session.appendingPathComponent("depth/00000.conf"))
        let alias = dir.appendingPathComponent("sandbox-alias")
        try fm.createSymbolicLink(at: alias, withDestinationURL: dir.appendingPathComponent("real"))
        let aliasedSession = alias.appendingPathComponent("2026-10-25 11.08.17", isDirectory: true)
        let record = try XCTUnwrap(CaptureFiles.collect(aliasedSession).first)
        XCTAssertEqual(record.path, "depth/00000.conf")
        XCTAssertEqual(try Data(contentsOf: aliasedSession.appendingPathComponent(record.path)), bytes)
    }
}
