import Foundation
import Vision
import ImageIO

// Decode the actual rendered pixels, independently of the PDF/QR encoder.
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let urls = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    .filter { $0.pathExtension.lowercased() == "png" }.sorted { $0.path < $1.path }
var output: [String: [String]] = [:]
for url in urls {
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    try VNImageRequestHandler(url: url).perform([request])
    output[url.lastPathComponent] = (request.results ?? []).compactMap(\.payloadStringValue).sorted()
}
let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
