import ARKit
import CaptureLink
import Combine
import Foundation
import ImageIO

/// Observations are evidence, not accepted house registration. No marker sets the house origin.
@MainActor
final class CaptureMarkers: ObservableObject {
    @Published private(set) var message = "Download the printed card kit in Paired capture."
    @Published private(set) var seen: [String] = []
    @Published var selectedDevice = ""
    private(set) var references = Set<ARReferenceImage>()
    private var kitID: String?
    private var loadedSelection: String?
    private var observations: [[String: Any]] = []
    private var lastPoses: [String: simd_float4x4] = [:]
    private var needsReview = Set<String>()
    private var lastWrite = Date.distantPast

    func loadReferences() {
        guard let kit = PairedCaptureModel.shared.kit else { return }
        let selection = kit.revision + selectedDevice
        if loadedSelection != selection {
            var images = Set<ARReferenceImage>()
            for marker in kit.markers where marker.retired != true && (marker.role == "checkpoint" || marker.id == selectedDevice) {
                let url = PairedCaptureModel.kitFolder.appendingPathComponent(marker.image)
                guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { continue }
                let image = ARReferenceImage(cg, orientation: .up, physicalWidth: CGFloat(marker.physicalWidthMeters))
                image.name = marker.id; images.insert(image)
            }
            references = images; loadedSelection = selection; kitID = kit.kitID
            message = "\(images.count) reference cards loaded. Observations still need independent alignment checks."
        }
    }

    /// Apply before starting the session, especially before relocalization is verified.
    /// Never run a second AR configuration from the view's polling loop.
    func apply(to configuration: ARWorldTrackingConfiguration) {
        loadReferences()
        configuration.detectionImages = references
        configuration.automaticImageScaleEstimationEnabled = true
        configuration.maximumNumberOfTrackedImages = min(4, references.count)
    }

    func observe(frame: ARFrame?, folder: URL, roomIndex: Int?, canRecord: Bool) {
        guard canRecord, let frame, case .normal = frame.camera.trackingState,
              CACurrentMediaTime()-frame.timestamp < 0.5, let kitID else { seen = []; return }
        let anchors = frame.anchors.compactMap { $0 as? ARImageAnchor }.filter(\.isTracked)
        seen = anchors.compactMap { $0.referenceImage.name }.sorted()
        let duplicateIDs = Set(Dictionary(grouping: seen, by: { $0 }).filter { $0.value.count > 1 }.keys)
        guard Date().timeIntervalSince(lastWrite) >= 1, !anchors.isEmpty else { return }
        lastWrite = Date()
        for anchor in anchors {
            guard let id = anchor.referenceImage.name else { continue }
            let identity = kitID + "/" + id
            // iOS ARImageAnchor's image is XZ. Normalize to printed X-right/Y-up/Z-out.
            let pose = anchor.transform * simd_float4x4(simd_quatf(angle: -.pi/2, axis: [1,0,0]))
            var state = "observed"
            if let old = lastPoses[identity] {
                let moved = simd_distance(simd_make_float3(old.columns.3), simd_make_float3(pose.columns.3))
                let turned = abs(simd_dot(simd_quatf(old), simd_quatf(pose)))
                if moved > 0.10 || turned < cos(Float.pi/72) { state = "needsReview" }
            }
            if duplicateIDs.contains(id) { state = "duplicateCard" }
            if !anchor.estimatedScaleFactor.isFinite || abs(anchor.estimatedScaleFactor-1) > 0.03 { state = "checkPrintScale" }
            if state != "observed" { needsReview.insert(identity) }
            else if needsReview.contains(identity) { state = "needsReview" }
            // Keep the original observation as the baseline; a moved card never silently settles.
            if lastPoses[identity] == nil { lastPoses[identity] = pose }
            observations.append(["markerID": id, "kitID": kitID, "timestamp": frame.timestamp,
                "roomIndex": roomIndex as Any? ?? NSNull(),
                "worldFromMarker": pose.columnMajor, "estimatedScaleFactor": anchor.estimatedScaleFactor,
                "status": state, "verified": false])
            message = state == "observed" ? "Card \(id) observed. House alignment is not yet verified." : "Card \(id) changed. Check its position and print scale before calibration."
        }
        if observations.count > 600 { observations.removeFirst(observations.count-600) }
        do {
            let data = try JSONSerialization.data(withJSONObject: ["format": "marker-observations/1", "source": "iphone",
                "frame": "capture-session", "markerFrame": "X-right Y-printed-up Z-out", "observations": observations], options: [.sortedKeys])
            try data.write(to: folder.appendingPathComponent("marker-observations.json"), options: .atomic)
        } catch { message = "Could not save card observations: \(error.localizedDescription)" }
    }
}
