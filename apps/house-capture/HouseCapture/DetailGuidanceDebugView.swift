#if DEBUG
import SwiftUI
import simd

/// Isolated UI fixture. No AR session, saved progress, pairing or user captures are changed.
struct DetailGuidanceDebugView: View {
    @State private var progress = Self.fixture()
    var body: some View {
        Group {
        if ProcessInfo.processInfo.arguments.contains("-preview-detail-map") {
            NavigationStack { RoomDetailStatusView(progress: progress) }
        } else {
        VStack(spacing: 20) {
            Text("UI preview · simulated location and photos").font(.caption).padding()
            Spacer()
            RoomDetailGuidanceView(progress: progress)
            HStack {
                Button("Clear photo") {
                    if let next = progress.nextTarget { progress.saved.quality[next.id] = 1 }
                    locate()
                }
                Button("Lose position") { progress.update(camera: nil, localized: false) }
                Button("Locate") { locate() }
            }.buttonStyle(.bordered).padding()
        }
        }
        }
        .task {
            locate()
            if ProcessInfo.processInfo.arguments.contains("-preview-detail-partial"), let target = progress.nextTarget {
                progress.saved.quality[target.id] = 1; locate()
            }
            if ProcessInfo.processInfo.arguments.contains("-preview-detail-lost") { progress.update(camera: nil, localized: false) }
        }
        .environment(\.dynamicTypeSize, ProcessInfo.processInfo.arguments.contains("-preview-detail-large") ? .accessibility2 : .large)
    }
    private func locate() {
        var camera = matrix_identity_float4x4; camera.columns.3.y = 1.5
        for _ in 0..<3 { progress.update(camera: camera, localized: true) }
    }
    private static func fixture() -> RoomDetailProgress {
        let targets = [
            RoomDetailGuide.Target(id: "desk", label: "Desk front", kind: "object", position: [-1,1,-1], normal: [0,0,1]),
            .init(id: "corner", label: "Wall corner", kind: "corner", position: [1,1,-1], normal: [0,0,1]),
            .init(id: "chair", label: "Chair back", kind: "object", position: [0,0.6,-1], normal: [0,0,1])
        ]
        let room = RoomDetailGuide.Room(id: "office", label: "Example office", polygon: [[-2,-2],[2,-2],[2,2],[-2,2]], minY: 0, maxY: 3, targets: targets)
        let guide = RoomDetailGuide(format: "room-detail-guide/1", revision: "ui-fixture", houseID: "fixture", floorStepID: "ground", modelFromReference: matrix_identity_float4x4.columnMajor, referenceMap: "unused.arworldmap", referenceMapSHA256: String(repeating: "a", count: 64), referenceMesh: "unused.ply", referenceMeshSHA256: String(repeating: "a", count: 64), rooms: [room])
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        return RoomDetailProgress(guide: guide, selectedRoomID: room.id, folder: folder, progressURL: folder.appendingPathComponent("unused.json"))
    }
}
#endif
