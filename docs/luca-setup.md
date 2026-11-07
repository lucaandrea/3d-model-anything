# Luca's local setup and TestFlight

Prepared October 25, 2026; local development status updated October 27. App Store Connect
name: **3D Model Anything by Luca**. Store/tester status below records the October 25
distribution and has not been refreshed as part of the paired-scanning development update.

## Installed tools

- Web dependencies installed from `package-lock.json`, including the `agent-browser` helper.
- Python 3.12 environment in `.venv`, with Pillow, NumPy and Open3D. The macOS Open3D wheel also needs Homebrew `libusb`, which is installed.
- Xcode 27.1 and XcodeGen 2.46.0 are available. The generated project is `apps/house-capture/HouseCapture.xcodeproj` and is open in Xcode.
- The local scan-to-threejs skill is available at `.agents/skills/scan-to-threejs/SKILL.md`.

The default Homebrew Node 26 installation has a broken npm link on this Mac. The project environment uses the working Node 24 installation without changing global shell settings:

```sh
source tools/environment.zsh
npm run dev
```

Alternatively, double-click `tools/start-viewer.command`. Open <http://localhost:5188> in Safari. Starting it again reuses the existing viewer for this checkout and prints its address. Leave the original server terminal running. If another application occupies port 5188, the launcher reports the conflict without stopping it.

The home page starts with **No scan loaded** and the iPhone-to-Mac workflow. It does not automatically load Wes’s office. Existing rooms are under **Existing rooms & demos**, and explicit `?room=office-v4` links still open the sample. The detailed office can take a while to compile its lighting shaders on first load.

**There is no live iPhone-to-Safari streaming in TestFlight build 1.0 (1).** Capture a room, share its ZIP with AirDrop, and have Codex import/rebuild it with scan-to-threejs. The browser home page does not receive ZIP files or watch Downloads automatically.

The October 27 development build installed directly on Luca's iPhone adds **Paired capture**
through House Control on the Mac. The approved connection, matching 68-card download, and
a complete saved capture transfer have been verified on the phone. This update is not a new
TestFlight release. Safari remains the model viewer; provisional capture previews go to
House Control. AirDrop remains available. Follow [paired-scanning.md](paired-scanning.md)
and the current [delivery status](paired-scanning-status.md) for calibration and capture.

Prepared personal imports now appear in the local viewer with **Scan**, **Measured**, **Overlay** and **Layout** views. See [local-captures.md](local-captures.md) for the private folder layout and comparison tools. Personal room details and import reports stay in ignored capture folders.

To recreate the Python environment:

```sh
brew install python@3.12 libusb
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-capture.txt
```

## iOS signing and distribution

- Bundle identifier: `ooo.luca.modelanything`.
- Signing team: Luca Andrea Collins, `9FNNQ6J269`.
- App Store Connect app ID: `6826895644`.
- Version/build: `1.0 (1)`.
- Distribution profile: `3D Model Anything App Store 2026`, expires October 14, 2027.
- Internal group: **Home Scanning**, automatic distribution enabled.
- Internal tester: `ciao@luca.ooo`.
- Apple finished processing build `1.0 (1)`; it is assigned to Home Scanning, and the tester is invited.
- `ciao@luca.ooo` is also explicitly assigned under **Individual Tester (1)** on the build. Apple required Beta App Review for that route; submission is complete and review is pending. The internal-group invitation remains the immediate installation route.
- [App Store Connect TestFlight](https://appstoreconnect.apple.com/teams/2cea177f-0ba5-41e1-8e6a-6ea98af67b05/apps/6826895644/testflight/ios).

Release uses the existing Apple Distribution certificate and manual profile. Development
signing now works under the same Luca Andrea Collins team: the updated scanner was installed
and launched on the physical iPhone on October 27 without uninstalling it or resetting scans.

The signed archive is in `apps/house-capture/build/3DModelAnything.xcarchive`. Build and upload logs are alongside it. Archive again after incrementing `CURRENT_PROJECT_VERSION` for another upload:

```sh
cd apps/house-capture
xcodegen generate
xcodebuild -project HouseCapture.xcodeproj -scheme HouseCapture \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath build/DerivedData -archivePath build/3DModelAnything.xcarchive archive
xcodebuild -exportArchive -archivePath build/3DModelAnything.xcarchive \
  -exportPath build/AppStore -exportOptionsPlist release/ExportOptions.plist \
  -allowProvisioningUpdates
```

The export command **uploads to App Store Connect**. The export options preserve the version/build number and include symbols.

## October 25 distribution verification

- TypeScript and production viewer build pass; Vite reports the existing large physics chunk warning.
- Safari successfully renders the detailed office.
- Safari opens the clean first-scan home page, and repeated `npm run dev` calls reuse the existing server successfully.
- Seven synthetic house-export/import tests pass.
- App self-tests pass **137/137** in the iOS simulator, and the normal home screen launches.
- Pillow, NumPy and Open3D import successfully; `pip check` passes.
- Public-asset boundary audit passes (374 tracked files and 213 reviewed assets at the time of the check).
- Release archive succeeds; code signature verification passes; Xcode reports **Upload succeeded**.
- Full public App Store release validation still requires pricing, reviewer contact, reviewed iPhone/iPad screenshots and physical-device acceptance. These are not claimed complete by the internal TestFlight upload.

## Scan the first room

1. On the LiDAR-equipped iPhone, open TestFlight signed in as `ciao@luca.ooo`, accept the internal-testing invitation and install **3D Model Anything by Luca**, version **1.0 (1)**.
2. Open the app, tap **New house**, name it, and choose **Create and scan**. Allow Camera when prompted.
3. Begin with one well-lit room. Name the room and move slowly around walls, doors and furniture. Keep at least 500 MB free; allow several GB for a larger home scan.
4. Tap **Finish room**, then **Finish session**, and reopen the saved room to confirm it is preserved.
5. Use **Share room (.zip)** and AirDrop it to this Mac. Extract the bundle into `data/captures-in/<room>/`, then ask Codex to use **scan-to-threejs** on that folder.

Office / Entrance has now been captured, imported and rebuilt as an editable Blender model.
The October 27 paired-transfer check delivered all 2,207 files from the first saved session
and matched every SHA-256 against the original backup. Scanner self-tests pass 144/144 on
both simulator and the physical iPhone. Printed-card recognition, independent alignment
measurements and combined iPhone/Vision Pro capture still require the physical pilot.
Personal capture folders are ignored by Git.
