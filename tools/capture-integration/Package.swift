// swift-tools-version:5.9
import PackageDescription

// Run against the sibling House Control checkout; uses an isolated temporary inbox.
let package = Package(name: "CaptureIntegration", platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../../packages/capture-link"), .package(path: "../../../house-control/core")],
    targets: [.executableTarget(name: "CaptureIntegration", dependencies: [
        .product(name: "CaptureLink", package: "capture-link"), .product(name: "HouseCore", package: "core")])])
