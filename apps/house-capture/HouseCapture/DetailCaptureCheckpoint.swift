import Foundation

/// A save recommendation never marks a room complete or interrupts an accepted write.
enum DetailCaptureCheckpoint {
    static let recommendedSeconds: TimeInterval = 180
    static let recommendedPhotos = 120

    static func reason(activeSeconds: TimeInterval, photos: Int, remaining: Int,
                       constrained: Bool, stalledSeconds: TimeInterval) -> String? {
        guard photos > 0 else { return nil }
        if constrained { return "Capture is reducing its workload. Save this pass and upload it before continuing. If the iPhone feels warm, let it cool first." }
        if remaining == 0 { return "All planned views have photos. Check hidden or moved objects, then save and upload this pass." }
        if activeSeconds >= recommendedSeconds || photos >= recommendedPhotos {
            return "Good time for a checkpoint. Save and upload this pass; you can return to this room with its progress kept."
        }
        if activeSeconds >= 90 && stalledSeconds >= 60 {
            return "Progress has slowed. Try another accessible angle, or save and upload what you have for review."
        }
        return nil
    }
}
