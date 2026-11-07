// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "CaptureLink", platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "CaptureLink", targets: ["CaptureLink"])],
    targets: [.target(name: "CaptureLink"), .testTarget(name: "CaptureLinkTests", dependencies: ["CaptureLink"])])
