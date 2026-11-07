import ARKit
import RoomPlan
import SwiftUI

/// Full-screen capture: one pass per room. Camera + coverage mesh + RoomPlan's live walls.
struct CaptureScreen: View {
  @ObservedObject var controller: CaptureController
  let onClose: () -> Void
  @State private var reviewing = false
  @State private var confirmClose = false
  @State private var showingDetails = false
  @State private var savingDetailPass = false
  @StateObject private var markers = CaptureMarkers()
  @ObservedObject private var paired = PairedCaptureModel.shared
  @FocusState private var nameFocused: Bool
  @Environment(\.scenePhase) private var scenePhase
  static let roomSuggestions = ["Living room", "Kitchen", "Dining room", "Office", "Bedroom", "Primary bedroom", "Bathroom", "Hallway", "Basement", "Playroom", "Laundry", "Garage"]

  private var scanning: Bool { controller.phase == .scanning }

  var body: some View {
    ZStack {
      ARViewContainer(view: controller.scanView.view).ignoresSafeArea()

      VStack {
        topBar
        if let notice = controller.notice {
          Label(notice, systemImage: "checkmark.circle.fill")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .padding(10)
            .background(.green.opacity(0.85), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
            .transition(.opacity)
        }
        Spacer()
        if scanning, let issue = controller.trackingIssue {
          VStack(alignment: .leading, spacing: 6) {
            Label(controller.cameraStartupDelayed ? "Camera isn't ready" : "Recovering your position", systemImage: "viewfinder.trianglebadge.exclamationmark")
              .font(.headline)
            Text(controller.cameraStartupDelayed ? "Camera tracking hasn't started. Check that the rear lenses are uncovered. If Apple's Camera app is also black, restart the iPhone before trying this space again." : issue.message).font(.subheadline)
            Text(controller.cameraStartupDelayed ? "This attempt hasn't measured a room. Ending it will keep diagnostic files without completing this space." : "Recording is paused. Saved photos are safe; capture resumes when your position is stable.").font(.caption)
            if let url = controller.recoveryPhoto, let image = UIImage(contentsOfFile: url.path) {
              Image(uiImage: image).resizable().scaledToFit().frame(height: 100)
              Text("Return to this view and pan slowly.").font(.caption)
            }
            Button(controller.cameraStartupDelayed ? "End this attempt" : "Save what I have", action: finishCapture)
          }
          .padding(12)
          .frame(maxWidth: 500, alignment: .leading)
          .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
          .padding(.horizontal)
          .accessibilityElement(children: .combine)
        }
        if let warning = controller.lastWarning {
          Text(warning)
            .font(.footnote)
            .padding(10)
            .background(.orange.opacity(0.9), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
        }
        if scanning, controller.checkingPostStartAlignment {
          Text("Confirming position after camera setup. Keep looking at the previously scanned area; recording will begin when the match is stable.")
            .font(.footnote).padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)).padding(.horizontal)
        }
        if scanning, let progress = controller.detailProgress { RoomDetailGuidanceView(progress: progress) }
        bottomPanel
      }
      .padding(.bottom, 8)
      .animation(.easeInOut(duration: 0.3), value: controller.notice)
    }
    .confirmationDialog("Leave this session?", isPresented: $confirmClose, titleVisibility: .visible) {
      if !controller.rooms.isEmpty && controller.phase == .betweenRooms {
        Button("Save \(controller.rooms.count) room\(controller.rooms.count == 1 ? "" : "s") and finish") {
          Task { await controller.finishSession() }
        }
      }
      Button(controller.rooms.isEmpty ? "Discard session" : "Discard session and its \(controller.rooms.count) room\(controller.rooms.count == 1 ? "" : "s")", role: .destructive) {
        controller.abandon()
        onClose()
      }
      Button("Keep scanning", role: .cancel) {}
    }
    .sheet(isPresented: $reviewing) {
      if let source = controller.reviewSource {
        NavigationStack { ScanReview(source: source).toolbar { Button("Done") { reviewing = false } } }
      }
    }
    .sheet(isPresented: $showingDetails) { NavigationStack { ObjectDetailView(controller: controller, markers: markers) } }
    .onChange(of: controller.phase) { old, next in
      if old == .finishingRoom, next == .betweenRooms, savingDetailPass {
        savingDetailPass = false
        if !controller.rooms.isEmpty { Task { await controller.finishSession() } }
      }
      if old == .finishingRoom, next == .betweenRooms, !controller.sessionNeedsRestart, controller.reviewSource != nil, !controller.captureBudget.constrained, !controller.isFloorStructure, !controller.isGuidedDetail { reviewing = true }
    }
    .onAppear { if controller.isFloorStructure { controller.scanView.useStructureAppearance() }; controller.configureReferences = { [weak markers] in markers?.apply(to: $0) }; controller.begin() }
    .task {
      while !Task.isCancelled {
        controller.updateDetailGuidance()
        if controller.phase == .betweenRooms || controller.phase == .scanning {
          markers.observe(frame: controller.arSession.currentFrame, folder: controller.bundle.url,
            roomIndex: controller.phase == .scanning ? controller.rooms.count : nil,
            canRecord: controller.captureReady || controller.phase == .betweenRooms)
        }
        if paired.connected, !controller.captureBudget.constrained, controller.phase == .scanning,
           let frame = controller.arSession.currentFrame {
          let mesh = CaptureMeshPreview.sample(frame)
          await paired.preview(["captureID": PairedCaptureModel.captureID(houseID: controller.plan.houseID,
            sessionID: controller.plan.sessionID, legacyFolder: controller.bundle.url),
            "roomName": controller.isFloorStructure ? controller.floorTitle : controller.roomName, "phase": controller.guidedContext?.step.phase ?? "capture", "tracking": controller.captureReady && !controller.paused ? "normal" : "limited",
            "photoCount": controller.photoCount, "depthFrameCount": controller.captureDepthCount,
            "photoCoverage": Double(controller.stats.percent)/100, "alignmentVerified": false,
            "detailTargetCoverage": controller.detailProgress.map { Double($0.percent)/100 } as Any? ?? NSNull(),
            "detailGuideRevision": controller.detailProgress?.guide.revision as Any? ?? NSNull(),
            "detectedRoomID": controller.detailProgress?.detectedRoomID as Any? ?? NSNull(),
            "roomLocationVerified": (controller.detailProgress?.locationReady ?? false) && !controller.paused,
            "detailGuidance": controller.detailProgress?.instruction as Any? ?? NSNull(),
            "vertices": mesh.vertices, "triangles": mesh.triangles])
        }
        do { try await Task.sleep(for: .seconds(1)) } catch { break }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      // leaving the app interrupts the camera: don't keep counting coverage across the gap
      if phase != .active { controller.pause() }
    }
    .statusBarHidden()
  }

  // MARK: top

  private var topBar: some View {
    HStack(alignment: .top) {
      Button {
        if controller.phase == .done { onClose() } else { confirmClose = true }
      } label: {
        Image(systemName: "xmark")
          .font(.headline)
          .frame(width: 44, height: 44)
          .background(.ultraThinMaterial, in: Circle())
      }
      .accessibilityLabel("Leave scanning")
      Spacer()
      VStack(alignment: .trailing, spacing: 6) {
        HStack(spacing: 10) {
          if scanning && !controller.isFloorStructure && controller.detailProgress == nil {
            VStack(spacing: 3) {
              CoverageRing(percent: controller.stats.percent).frame(width: 44, height: 44)
              Text("Photo detail").font(.system(size: 9, weight: .semibold))
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Photo detail, \(controller.stats.percent) percent of observed surfaces")
          }
          VStack(alignment: .trailing, spacing: 2) {
            if scanning {
              Text(controller.isFloorStructure ? controller.floorTitle : controller.roomName).font(.headline)
              Text(controller.detailProgress != nil ? "Detail pass · photos save automatically" : controller.meshReady ? "\(controller.coverage.walls.count) walls measured" : "Starting LiDAR…")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            }
            Text("\(controller.rooms.count) room\(controller.rooms.count == 1 ? "" : "s") · \(controller.photoCount) photos")
              .font(.caption.monospacedDigit())
            if controller.phase != .relocalizing {
              HStack(spacing: 6) {
                AlignmentBadge(alignment: controller.alignment)
                MapStatusDot(status: controller.mappingStatus)
              }
            }
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        if controller.hasGhost, controller.alignment.method == "relocalized", controller.phase == .betweenRooms || scanning {
          Toggle(isOn: $controller.ghostVisible) {
            Label("Earlier scan", systemImage: controller.ghostVisible ? "eye" : "eye.slash")
              .font(.caption.weight(.semibold))
          }
          .toggleStyle(.button)
          .buttonStyle(.bordered)
          .controlSize(.small)
          .tint(.green)
        }
        if scanning && controller.detailProgress == nil {
          liveMap
        }
      }
    }
    .padding(.horizontal)
    .padding(.top, 8)
  }

  /// Heading-up map: walls go green once a sharp photo sees them roughly head-on
  private var liveMap: some View {
    VStack(spacing: 4) {
      CoverageMap(coverage: controller.coverage, camera: controller.cameraPose, photos: controller.photoPositions,
                  redSpots: controller.stats.redSpots)
        .frame(width: 130, height: 130)
    }
    .padding(8)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
  }

  // MARK: bottom

  @ViewBuilder
  private var bottomPanel: some View {
    switch controller.phase {
    case .relocalizing:
      RelocalizationPanel(controller: controller)
    case .betweenRooms:
      if controller.sessionNeedsRestart {
        panel {
          Label(controller.rooms.isEmpty ? "Room wasn't captured" : "Scan ended", systemImage: "exclamationmark.triangle.fill").font(.headline)
          Text(controller.rooms.isEmpty ? "The camera did not produce usable room geometry. Check Apple's Camera app; if its picture is black too, restart the iPhone. Return here to retry the same space." : "This section is saved. Keep it for Mac review before continuing. You do not need to repeat the whole floor. The Mac can recover usable sections even when alignment needs repair.")
            .font(.subheadline)
          roomList
          Button(controller.rooms.isEmpty ? "Keep diagnostics and close" : "Finish and keep saved rooms") {
            Task {
              await controller.finishSession()
              if controller.rooms.isEmpty, controller.phase == .done { onClose() }
            }
          }
            .buttonStyle(.borderedProminent)
        }
      } else if let context = controller.guidedContext { guidedBetweenRooms(context) }
      else { betweenRooms }
    case .scanning:
      if controller.paused { pausedPanel } else { scanControls }
    case .finishingRoom:
      status(controller.floorSavingCheckpoint ? "Saving a floor checkpoint. Pause walking; scanning resumes automatically…" : "Saving \(controller.roomName)…")
    case .finishing:
      status(controller.finishingStep.isEmpty ? "Saving…" : controller.finishingStep)
    case .done:
      done
    case .failed(let message):
      panel {
        Text("Couldn't save the scan").font(.headline)
        Text(message).font(.footnote)
        Text("Keep this screen open while freeing storage, then retry. Files already written are kept.").font(.caption)
        Button("Retry saving") { Task { await controller.finishSession() } }.buttonStyle(.borderedProminent)
        Button("Close", action: onClose).buttonStyle(.bordered)
      }
    }
  }

  private var betweenRooms: some View {
    panel {
      if controller.rooms.isEmpty {
        if controller.alignment.method == "relocalized" {
          Text("You're lined up with \(controller.zoneName). The faint green is what you scanned before\(controller.priorPhotoCount > 0 ? "; surfaces its \(controller.priorPhotoCount) photos already cover start out green" : ""). Scan a new room, or rescan one to replace it.")
            .font(.subheadline)
        } else {
          Text("Scan each room once: as you move, a triangle mesh appears. **Green** means good photo coverage, including aligned earlier scans. **Red** needs more photos. Areas without triangles still need scanning. The white outlines are the walls, doors and windows being measured. **Photo detail** measures photography on surfaces already seen by LiDAR; it is not the percentage of the room scanned. Save and review for missing areas.")
            .font(.subheadline)
        }
      } else {
        CoverageMap(coverage: controller.coverage, camera: nil, photos: controller.photoPositions)
          .frame(height: 150)
          .frame(maxWidth: .infinity)
        if let last = controller.rooms.last {
          Text("\(last.name): \(last.photographedPercent.map { "\($0)% photo detail" } ?? "not measured") · \(last.detailPhotos ?? 0) photos\(last.mesh == nil ? " · no mesh" : "")")
            .font(.footnote)
        }
        Button("Review saved room in 3D") { reviewing = true }.buttonStyle(.borderedProminent)
        Text("Inspect the textured scan before leaving. Use coverage colours in the preview to check gaps.").font(.caption)
        roomList
        Text("Walk into the next room, then start it. Stay in this session so the rooms line up.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      if controller.requiresFreshScan {
        Text("This scan is saved. Finish this session, then tap Scan a room to continue with a fresh capture.").font(.headline)
      }
      Text("Which room are you in?").font(.subheadline.weight(.semibold))
      TextField("Room name", text: $controller.roomName)
        .textFieldStyle(.roundedBorder)
        .submitLabel(.go)
        .focused($nameFocused)
        .onSubmit(controller.startRoom)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          // rooms scanned before in this area first: picking one rescans (replaces) it
          ForEach(controller.existingRooms) { existing in
            let name = existing.name
            Button {
              controller.selectRoom(existing)
            } label: {
              Label(name, systemImage: "arrow.triangle.2.circlepath")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(controller.roomName == name ? .accentColor : .green)
          }
          ForEach(Self.roomSuggestions.filter { n in !scannedHere(n) && !controller.existingRoomNames.contains { HouseProject.roomKey($0) == HouseProject.roomKey(n) } }, id: \.self) { name in
            Button(name) { controller.selectedRoomID = nil; controller.roomName = name }
              .buttonStyle(.bordered)
              .controlSize(.small)
              .tint(controller.roomName == name ? .accentColor : .secondary)
          }
        }
      }
      if controller.selectedRoomID != nil {
        Text("Rescan: this becomes \(controller.roomName)'s active scan (the old one stays in its history).")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      Toggle("High-resolution automatic photos", isOn: $controller.highResolutionPhotos)
        .font(.subheadline)
      Text("Regular photos use camera frames for a lighter scan. High-resolution photos add processing and are limited to one request every 3 seconds while the phone is cool. The shutter always saves a regular photo.")
        .font(.caption).foregroundStyle(.secondary)
      Button {
        controller.startRoom()
      } label: {
        Label(controller.canStartRoom ? "Scan \(controller.roomName)" : "Name the room to start", systemImage: "viewfinder")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(!controller.canStartRoom)
      if !controller.rooms.isEmpty {
        HStack {
          Button("Redo last room", role: .destructive, action: controller.discardLastRoom)
          Spacer()
          Button("Finish session") { Task { await controller.finishSession() } }
            .buttonStyle(.bordered)
        }
      }
    }
  }

  private func guidedBetweenRooms(_ context: GuidedCaptureContext) -> some View {
    panel {
      Text(context.step.title).font(.title2.bold())
      if controller.isFloorStructure { floorBetweenSections(context) }
      else if controller.rooms.isEmpty {
        if let progress = controller.detailProgress {
          Text(progress.locationStatus).font(.subheadline.weight(.semibold))
          Text("Check the reference overlay against fixed corners. When it lines up and you are inside \(progress.selectedRoom?.label ?? "this room"), start details. The old overlay then hides; red and green show only new photo coverage.").font(.subheadline)
          Button("Overlay doesn't line up", systemImage: "arrow.clockwise", action: controller.rejectDetailAlignment)
            .buttonStyle(.bordered)
        }
        Text(context.step.instructions).font(.subheadline)
        Text("Include overlap: \(context.step.overlap)").font(.footnote)
        Text("Doors: \(context.step.doorState)").font(.footnote)
        if !context.step.mirrors.isEmpty {
          Text(context.mirrorPreparation == "covered-matte" ? "Mirrors recorded as covered. Keep the covering still." : "Mirrors are uncovered. Reflected geometry will need correction.").font(.footnote)
        }
        Button(controller.isGuidedDetail ? "Start room details" : "Start this space", systemImage: "viewfinder", action: controller.startRoom)
          .buttonStyle(.borderedProminent).controlSize(.large).disabled(!controller.canStartRoom)
      } else {
        Label(controller.detailProgress == nil ? "Space captured" : "Detail pass captured", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        Text(controller.detailProgress.map { "\($0.percent)% of this room's planned views photographed. Save this pass and upload it. Remaining views stay on your room checklist." } ?? "Review the room before leaving. Save this session, upload it from the route, then continue to the next space.").font(.subheadline)
        Button("Review saved room in 3D") { reviewing = true }.buttonStyle(.bordered)
        Button(controller.detailProgress == nil ? "Save space and finish" : "Save pass · then upload") { Task { await controller.finishSession() } }
          .buttonStyle(.borderedProminent).controlSize(.large)
      }
    }
  }

  @ViewBuilder private func floorBetweenSections(_ context: GuidedCaptureContext) -> some View {
    if controller.rooms.isEmpty {
      Text(context.step.isConnector ? "Start with the stair base and living-area approach. Capture steps, railings and fixed walls from stable positions, then finish with the upper landing and bedroom opening. Watch your footing between positions." : "Walk the whole floor, keeping the phone upright and pointing into the space. Follow wall edges, doorways and corners. Include each bathroom and return through the real doorway.").font(.subheadline)
      Text("Sections save automatically every two minutes while tracking is stable. Pause walking when saving appears, then carry on. You do not need to name rooms or make objects turn green.").font(.footnote)
      Button(controller.guidedContext?.step.isConnector == true ? (controller.isContinue ? "Resume stairs" : "Start stairs") : (controller.isContinue ? "Resume floor structure" : "Start floor structure"), systemImage: "viewfinder", action: controller.startRoom)
        .buttonStyle(.borderedProminent).controlSize(.large).disabled(!controller.canStartRoom)
    } else {
      Text("\(controller.rooms.count) structural sections saved. Review the whole floor after saving; details come later.").font(.subheadline)
      Button(context.step.isConnector ? "Save stairs and review" : "Save floor and review") { Task { await controller.finishSession() } }.buttonStyle(.borderedProminent)
    }
  }

  private func scannedHere(_ name: String) -> Bool {
    controller.rooms.contains { HouseProject.roomKey($0.name) == HouseProject.roomKey(name) }
  }

  private var pausedPanel: some View {
    panel {
      Label("Paused", systemImage: "pause.circle.fill").font(.headline)
      Text("No photos, depth or coverage while paused. Tracking keeps running: keep the camera pointed at the room (not the floor or your pocket) so it doesn't lose its place.")
        .font(.footnote)
        .foregroundStyle(.secondary)
      Button {
        controller.resume()
      } label: {
        Label("Resume \(controller.roomName)", systemImage: "play.fill").frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      Button(controller.isGuidedDetail ? "Save pass" : controller.isFloorStructure ? "Finish floor and save" : "Finish room and save what is available", action: finishCapture)
        .buttonStyle(.bordered)
    }
  }

  private var roomList: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(controller.rooms) { room in
        HStack {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
          Text(room.name)
          Spacer()
          if let pc = room.photographedPercent {
            Text("\(pc)% photo detail").font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(pc >= 85 ? .green : .orange)
          }
          Text("\(room.walls)w \(room.doors + room.openings)d \(room.windows)win \(room.objects)obj")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  private var scanControls: some View {
    VStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(!controller.isGuidedDetail ? "Structure: \(controller.captureWallCount) walls · \(controller.captureDepthCount) depth frames" : "\(controller.detailPassPhotoCount) photos this pass · \(Int(controller.detailActiveSeconds)/60)m \(Int(controller.detailActiveSeconds)%60)s")
          Spacer()
          Button("Object photos & cards", systemImage: "square.text.square") { showingDetails = true }.frame(minHeight: 44)
        }
        if controller.isFloorStructure {
          Text("Structure pass · \(controller.rooms.count) checkpoints saved · details later")
        } else if controller.detailProgress == nil { Text("Photos: \(controller.stats.percent)% of observed surfaces") }
        if controller.detailProgress == nil { Text("Tracking: \(controller.captureReady ? "stable" : "recovering") · House alignment: needs calibration") }
      }.font(.caption).padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
      if !controller.detailObjectName.isEmpty { Text("Object: \(controller.detailObjectName) · \(controller.detailView) · use shutter").font(.caption).padding(6).background(.regularMaterial) }
      if let reason = controller.detailCheckpointReason {
        VStack(alignment: .leading, spacing: 4) {
          Label("Save & upload checkpoint", systemImage: "arrow.up.circle.fill").font(.subheadline.bold())
          Text(reason).font(.caption)
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
      }
      if controller.captureReady && !controller.isGuidedDetail {
        tip(controller.isFloorStructure ? (controller.instruction ?? "Follow wall edges and openings. Walk into every area on this floor.") : controller.quality.ready ? controller.quality.message : (controller.instruction ?? controller.quality.message))
        if !controller.isFloorStructure && controller.coveragePlateau && !controller.quality.ready {
          tip("Photo detail isn't improving much. You can save and review what you have; you don't need to keep circling.")
        }
        if controller.captureBudget.constrained { Text("Reducing background capture to keep scanning responsive.").font(.caption).foregroundStyle(.white) }
      }
      HStack(spacing: 14) {
        if controller.isFloorStructure {
          Label("Measured", systemImage: "square.fill").font(.caption).foregroundStyle(.cyan)
        } else { Legend() }
        Button(action: controller.pause) {
          Image(systemName: "pause.fill")
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("Pause capture")
        .frame(minWidth: 44, minHeight: 44)
        shutter
        Button(controller.isGuidedDetail ? "Save pass" : controller.isFloorStructure ? (controller.guidedContext?.step.isConnector == true ? "Finish stairs" : "Finish floor") : controller.quality.ready ? "Finish room ✓" : "Save room", action: finishCapture)
          .buttonStyle(.borderedProminent)
          .tint(controller.detailProgress == nil && !controller.isFloorStructure && controller.quality.ready ? .green : .accentColor)
          .controlSize(.large)
      }
    }
    .padding(.horizontal)
  }

  private func finishCapture() {
    if controller.isFloorStructure { controller.finishFloor() }
    else { savingDetailPass = controller.isGuidedDetail; controller.finishRoom() }
  }

  private var shutter: some View {
    Button(action: controller.takePhoto) {
      Image(systemName: "camera.fill")
        .font(.title2)
        .frame(width: 60, height: 60)
        .background(.white, in: Circle())
        .foregroundStyle(.black)
    }
    .disabled(!controller.canTakePhoto)
    .opacity(controller.canTakePhoto ? 1 : 0.4)
    .accessibilityLabel("Take reference photo")
  }

  private func tip(_ text: String) -> some View {
    Text(text)
      .font(.caption)
      .multilineTextAlignment(.center)
      .padding(8)
      .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
  }

  private var done: some View {
    panel {
      Label(controller.rooms.isEmpty ? "No room captured" : controller.floorPausedForResources ? "Floor paused · checkpoints saved" : "Saved", systemImage: controller.rooms.isEmpty ? "exclamationmark.triangle" : "checkmark.seal.fill")
        .font(.headline).foregroundStyle(controller.rooms.isEmpty ? .orange : .green)
      if controller.isFloorStructure {
        Text("\(controller.rooms.count) checkpoints saved together for \(controller.floorTitle).")
        if controller.floorPausedForResources {
          Text("The app paused to keep capture responsive. Your floor is not marked complete. Return to the floor screen and choose Continue; start in the last area you scanned.").font(.subheadline)
        }
      } else if let progress = controller.detailProgress {
        Text("\(progress.percent)% of planned views photographed in \(progress.selectedRoom?.label ?? "this room").")
        Text("This pass is saved. Upload it, then continue missing views in this room or choose another room.").font(.subheadline)
      } else { roomList }
      HStack(spacing: 8) {
        AlignmentBadge(alignment: controller.alignment)
        Text(controller.mapSummary ?? "Map not saved").font(.caption).foregroundStyle(.secondary)
      }
      Text(controller.rooms.isEmpty ? "Diagnostic files are kept. Return and retry this space; the route has not advanced." : controller.isFloorStructure ? "The floor capture is saved. Return to review its structure. Missing areas can be filled before you confirm the floor. A saved checkpoint alone does not mean the floor is complete." : controller.detailProgress != nil ? "The next screen shows Upload to Mac. Wait for Verified on Mac before putting the phone away." : controller.guidedContext == nil ? "Come back any time and tap **Scan a room**, or open a saved room and choose **Continue scanning from this room**. Share from the house screen (AirDrop the .zip to your Mac)." : "This space is saved on your iPhone. Return to the route to upload it and see the next space. Room alignment will be reviewed later.")
        .font(.footnote)
        .foregroundStyle(.secondary)
      Button(controller.guidedContext == nil ? "Close" : controller.isFloorStructure ? "Return to floor scan" : "Return to room progress · upload", action: onClose).buttonStyle(.borderedProminent)
    }
  }

  private func status(_ text: String) -> some View {
    panel {
      HStack(spacing: 12) {
        ProgressView()
        Text(text)
      }
    }
  }

  private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 12, content: content)
      .padding()
      .frame(maxWidth: 500)
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
      .padding(.horizontal)
  }
}

/// Continue: find your place in the zone's saved map
private struct RelocalizationPanel: View {
  @ObservedObject var controller: CaptureController

  private var r: CaptureController.Relocalization { controller.reloc }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text(title).font(.headline)
        Spacer()
        if r.seconds > 0 { Text("\(r.seconds) s").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
      }
      Text(message).font(.subheadline)
      if controller.detailProgress != nil, !controller.detailReferenceLabel.isEmpty {
        Text("Recovery map: \(controller.detailReferenceLabel)").font(.caption.weight(.semibold))
      }
      if controller.detailProgress != nil, r.stage == .searching || r.stage == .checking {
        Text("Use the wider doorway, pictures and furniture around you. A printed card identifies a checkpoint; it cannot locate the home until its physical position has been calibrated.")
          .font(.caption).foregroundStyle(.secondary)
      }
      if r.stage == .checking {
        ProgressView(value: Double(r.progress))
          .tint(.green)
        if let c = r.check, c.known > 0 {
          Text("\(Int((c.wallKnown > 0 ? c.wallFraction : c.inlierFraction) * 100))% of the walls you see match\(c.median.map { String(format: " · off by %.1f cm", $0 * 100) } ?? "")")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
          if c.needsCorner {
            Text("Now pan across a corner, a door frame or some furniture: one flat wall can't show whether it's slid sideways.")
              .font(.caption.weight(.semibold))
          } else if c.wallKnown < 100 {
            Text("Aim at walls and furniture you scanned before (not just the floor).")
              .font(.caption.weight(.semibold))
          }
        }
      }
      Text(r.tracking + " · " + r.reference).font(.caption).foregroundStyle(.secondary)
      if !controller.landmarks.isEmpty, r.stage == .searching || r.stage == .mismatch {
        Text(controller.detailProgress.map { "Reference views in \($0.selectedRoom?.label ?? "this room"):" } ?? "Spots you scanned before:")
          .font(.caption.weight(.semibold))
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(controller.landmarks, id: \.self) { LandmarkThumb(url: $0) }
          }
        }
      }
      if r.seconds >= 20 || r.timedOut || r.stage == .mismatch {
        tips
        if let next = controller.nextDetailReference {
          Button("Try \(next.label)", action: controller.tryNextDetailReference)
            .buttonStyle(.bordered).disabled(controller.switchingDetailReference)
        }
      }
      if r.timedOut, r.stage != .mismatch {
        Text("Still can't find where you are.").font(.subheadline.weight(.semibold))
        HStack {
          Button("Keep trying", action: controller.keepTrying).buttonStyle(.bordered)
          Spacer()
          if controller.detailProgress == nil { Button("Start a fresh scan", action: controller.startUnaligned).buttonStyle(.borderedProminent) }
        }
      } else {
        HStack {
          if r.stage == .mismatch {
            Button("Try again", action: controller.retryRelocalization).buttonStyle(.borderedProminent)
          }
          Spacer()
          if controller.detailProgress == nil, r.seconds >= 20 || r.stage == .mismatch || isFailed {
            Button("Start a fresh scan", action: controller.startUnaligned).buttonStyle(.bordered)
          }
        }
      }
    }
    .padding()
    .frame(maxWidth: 500)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
    .padding(.horizontal)
  }

  private var isFailed: Bool {
    if case .failed = r.stage { return true }
    return false
  }

  private var title: String {
    switch r.stage {
    case .loadingMap: "Loading \(controller.zoneName)…"
    case .searching: controller.detailProgress.map { "Locate \($0.selectedRoom?.label ?? "this room")" } ?? "Continue in \(controller.zoneName)"
    case .checking: "Checking the saved floor against this view"
    case .mismatch: "This doesn't line up"
    case .done: "Lined up"
    case .failed: "Can't continue from the saved map"
    }
  }

  private var message: String {
    switch r.stage {
    case .loadingMap: "Reading the saved map."
    case .searching: "Point at an area you already scanned and move slowly. When the phone recognizes it, your earlier scan appears in green."
    case .checking: "Hold on the area you scanned before. The green should sit right on the walls and furniture."
    case .mismatch: controller.detailProgress != nil ? "The saved geometry does not line up with this view. Try again from one of this room's reference views. No room progress is being credited." : "The phone thinks it knows this place, but the green doesn't sit on the real surfaces. Try again from a spot with lots of detail, or start unaligned."
    case .done: ""
    case .failed(let m): controller.detailProgress != nil ? m : m + " You can still scan: the session gets its own frame. Use Connect room afterward to align it with another room."
    }
  }

  private var tips: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("• Turn on the same lights as last time.")
      Text("• Stand where you scanned before, like a doorway or a corner with furniture, 1–2 m back, and pan slowly.")
      Text("• Bare walls and floors don't work; aim at shelves, pictures, door frames.")
      Text("• Things moved since last time? Aim at something that didn't.")
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }
}

/// One earlier photo, loaded off main
private struct LandmarkThumb: View {
  let url: URL
  @State private var image: CGImage?
  var body: some View {
    Group {
      if let image {
        Image(decorative: image, scale: 1).resizable().scaledToFill()
      } else {
        Color.gray.opacity(0.3)
      }
    }
    .frame(width: 84, height: 112)
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .task {
      let u = url
      image = await Task.detached(priority: .utility) { PriorPhotos.thumbnail(u) }.value
    }
  }
}

/// "Relocalized ±2 cm" / "Unaligned" / "First in area"
struct AlignmentBadge: View {
  var alignment: HouseProject.Alignment
  var body: some View {
    let (text, color): (String, Color) = switch alignment.method {
    case "first": ("New scan", .blue)
    case "relocalized": (alignment.residualMeters.map { String(format: "Matched ±%.1f cm", $0 * 100) } ?? "Matched", .green)
    case "unaligned": ("Not connected yet", .orange)
    case "manual", "icp": ("Connected", .teal)
    default: (alignment.method, .gray)
    }
    Text(text)
      .font(.caption2.weight(.semibold))
      .padding(.horizontal, 6).padding(.vertical, 2)
      .background(color.opacity(0.25), in: Capsule())
      .foregroundStyle(color)
  }
}

/// ARKit's world-mapping status: green once the map is good enough to save
private struct MapStatusDot: View {
  var status: ARFrame.WorldMappingStatus
  var body: some View {
    let (text, color): (String, Color) = switch status {
    case .mapped: ("map", .green)
    case .extending: ("map", .yellow)
    case .limited: ("map", .orange)
    default: ("map", .gray)
    }
    HStack(spacing: 3) {
      Circle().fill(color).frame(width: 6, height: 6)
      Text(text).font(.caption2)
    }
  }
}

/// Percent photographed, as a ring
struct CoverageRing: View {
  var percent: Int
  var body: some View {
    ZStack {
      Circle().stroke(.white.opacity(0.25), lineWidth: 5)
      Circle()
        .trim(from: 0, to: CGFloat(min(100, percent)) / 100)
        .stroke(percent >= 85 ? Color.green : percent >= 50 ? .orange : .red, style: StrokeStyle(lineWidth: 5, lineCap: .round))
        .rotationEffect(.degrees(-90))
        .animation(.easeOut(duration: 0.4), value: percent)
      Text("\(percent)%").font(.caption2.monospacedDigit().weight(.bold))
    }
  }
}

private struct Legend: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach([(Color.red, "needs photos"), (.green, "captured")], id: \.1) { color, label in
        HStack(spacing: 4) {
          Circle().fill(color).frame(width: 7, height: 7)
          Text(label).font(.system(size: 9))
        }
      }
    }
    .padding(6)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
  }
}

/// Hosts the scan's ARSCNView (camera + coverage mesh + RoomPlan outlines)
struct ARViewContainer: UIViewRepresentable {
  let view: ARSCNView
  func makeUIView(context: Context) -> ARSCNView { view }
  func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
