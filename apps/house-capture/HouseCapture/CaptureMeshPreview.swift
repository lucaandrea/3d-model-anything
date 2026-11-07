import ARKit

enum CaptureMeshPreview {
    /// A bounded triangle sample for provisional viewing only, never a reconstruction source.
    static func sample(_ frame: ARFrame) -> (vertices: [[Float]], triangles: [Int]) {
        let anchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        let count = anchors.reduce(0) { $0 + $1.geometry.faces.count }
        let step = max(1, Int(ceil(Double(count)/1600)))
        var vertices: [[Float]] = [], triangles: [Int] = [], faceNumber = 0
        for anchor in anchors {
            let geometry = anchor.geometry
            guard geometry.faces.indexCountPerPrimitive == 3 else { continue }
            let indices = geometry.faces.buffer.contents()
            let source = geometry.vertices
            for face in 0..<geometry.faces.count {
                defer { faceNumber += 1 }
                guard faceNumber % step == 0, vertices.count+3 <= 4800 else { continue }
                var points: [[Float]] = []
                for corner in 0..<3 {
                    let offset = (face*3+corner)*geometry.faces.bytesPerIndex
                    let index = geometry.faces.bytesPerIndex == 2 ? Int(indices.load(fromByteOffset: offset, as: UInt16.self)) : Int(indices.load(fromByteOffset: offset, as: UInt32.self))
                    guard index < source.count else { continue }
                    let ptr = source.buffer.contents().advanced(by: source.offset + source.stride*index)
                    let local = SIMD4<Float>(ptr.load(as: Float.self), ptr.load(fromByteOffset: 4, as: Float.self), ptr.load(fromByteOffset: 8, as: Float.self), 1)
                    let world = anchor.transform * local
                    guard world.x.isFinite, world.y.isFinite, world.z.isFinite else { continue }
                    points.append([world.x, world.y, world.z])
                }
                if points.count == 3 { triangles.append(contentsOf: vertices.count..<(vertices.count+3)); vertices.append(contentsOf: points) }
            }
        }
        return (vertices, triangles)
    }
}
