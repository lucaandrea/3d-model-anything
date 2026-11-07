import SwiftUI

struct RoomDetailGuidanceView: View {
    let progress: RoomDetailProgress
    @State private var showingRoomProgress = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(progress.locationStatus, systemImage: progress.locationReady ? "location.fill" : "location.slash")
                .font(.subheadline.weight(.semibold))
            HStack {
                Text("Planned detail views").font(.subheadline)
                Spacer()
                Text("\(progress.percent)%").font(.headline.monospacedDigit())
            }
            ProgressView(value: Double(progress.percent), total: 100)
                .accessibilityLabel("Known room targets photographed")
                .accessibilityValue("\(progress.percent) percent")
            Text(progress.instruction).font(.subheadline.weight(.medium))
            Text(progress.photoFeedback).font(.caption).foregroundStyle(.secondary)
            HStack {
                Text("\(progress.completedCount) / \(progress.targetCount) planned views photographed")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("What's missing?", systemImage: "map") { showingRoomProgress = true }
                    .font(.caption.weight(.semibold)).frame(minHeight: 44)
            }
            if let error = progress.saveError { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(12).frame(maxWidth: 500, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal)
        .sheet(isPresented: $showingRoomProgress) {
            NavigationStack { RoomDetailStatusView(progress: progress) }
        }
    }
}

struct RoomDetailStatusView: View {
    let progress: RoomDetailProgress
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            Section(progress.selectedRoom?.label ?? "Selected room") {
                RoomDetailMap(progress: progress).frame(height: 230)
                Text("Orange squares need a clear photo. Green dots have one. The ring marks the next suggested view; the blue cross is your verified position.")
                    .font(.footnote)
                LabeledContent("Object and surface views left", value: "\(progress.remaining(kind: "object"))")
                LabeledContent("Corner views left", value: "\(progress.remaining(kind: "corner"))")
                Text(progress.instruction)
            }
            Section("Every room on this floor") {
                ForEach(progress.guide.rooms) { room in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack { Text(room.label); Spacer(); Text("\(progress.percent(roomID: room.id))%").monospacedDigit() }
                        ProgressView(value: Double(progress.completedTargets(in: room)), total: Double(room.targets.count))
                        Text("\(progress.completedTargets(in: room)) of \(room.targets.count) planned views")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                }
            }
            Section("What this progress means") {
                Text("Progress counts clear, depth-checked views of the saved room targets. Some targets are behind furniture or inside approximate scan shapes, so 100% may not be reachable. Useful photos are still saved; do not keep repeating a view to force the percentage higher.")
                Text("Also inspect furniture backs, shelves, corners and small objects. Name special objects in Object photos & cards, then use the shutter for front, side, back and detail views where accessible.")
                Text("Save and upload a short pass about every three minutes, before changing rooms, or when the app suggests a checkpoint. You can continue the same room afterward.")
            }
        }
        .navigationTitle("Missing detail views")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
}

private struct RoomDetailMap: View {
    let progress: RoomDetailProgress
    var body: some View {
        Canvas { context, size in
            guard let room = progress.selectedRoom else { return }
            let xs = room.polygon.map { Double($0[0]) }, zs = room.polygon.map { Double($0[1]) }
            guard let x0 = xs.min(), let x1 = xs.max(), let z0 = zs.min(), let z1 = zs.max() else { return }
            let scale = min((size.width-24)/max(0.1,x1-x0), (size.height-24)/max(0.1,z1-z0))
            func point(_ x: Float, _ z: Float) -> CGPoint {
                CGPoint(x: size.width/2+(Double(x)-(x0+x1)/2)*scale,
                        y: size.height/2-(Double(z)-(z0+z1)/2)*scale)
            }
            var outline = Path()
            for (i, p) in room.polygon.enumerated() {
                if i == 0 { outline.move(to: point(p[0], p[1])) } else { outline.addLine(to: point(p[0], p[1])) }
            }
            outline.closeSubpath()
            context.fill(outline, with: .color(.secondary.opacity(0.08)))
            context.stroke(outline, with: .color(.secondary), lineWidth: 2)
            for target in room.targets {
                let p = point(target.position[0], target.position[2])
                let complete = (progress.saved.quality[target.id] ?? 0) >= CoverageEngine.goodScore
                let rect = CGRect(x: p.x-2.5, y: p.y-2.5, width: 5, height: 5)
                if complete { context.fill(Path(ellipseIn: rect), with: .color(.green)) }
                else { context.stroke(Path(rect), with: .color(.orange), lineWidth: 1.5) }
                if target.id == progress.nextTarget?.id {
                    context.stroke(Path(ellipseIn: CGRect(x: p.x-7, y: p.y-7, width: 14, height: 14)), with: .color(.primary), lineWidth: 2)
                }
            }
            if progress.locationReady, let camera = progress.cameraInModel {
                let p = point(camera.x, camera.z)
                var marker = Path(); marker.move(to: CGPoint(x: p.x-7,y: p.y)); marker.addLine(to: CGPoint(x:p.x+7,y:p.y))
                marker.move(to: CGPoint(x:p.x,y:p.y-7)); marker.addLine(to: CGPoint(x:p.x,y:p.y+7))
                context.stroke(marker, with: .color(.blue), lineWidth: 4)
            }
        }
        .accessibilityLabel("Room plan. \(progress.needsViews) planned views need photographs. \(progress.instruction)")
    }
}
