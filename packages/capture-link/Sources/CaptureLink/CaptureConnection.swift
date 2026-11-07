import Foundation
import Network
import Security
import CryptoKit

/// Capture-only channel. Never shares credentials with the House Control command channel.
@MainActor
public final class CaptureConnection {
    public var onStatus: ((String, Bool) -> Void)?
    private var browser: NWBrowser?
    private var connection: NWConnection?
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var timeouts: [String: Task<Void, Never>] = [:]
    private var generation = UUID()
    public private(set) var connected = false
    public var busy: Bool { !pending.isEmpty }

    public init() {}

    public static func parameters(key: Data) -> NWParameters {
        let tls = NWProtocolTLS.Options()
        let options = tls.securityProtocolOptions
        // A new pairing must prove its own PSK, never reuse a cached TLS session.
        sec_protocol_options_set_tls_resumption_enabled(options, false)
        sec_protocol_options_set_tls_tickets_enabled(options, false)
        let derived = HMAC<SHA256>.authenticationCode(for: Data("House Capture v1".utf8), using: SymmetricKey(data: key))
        let psk = derived.withUnsafeBytes { DispatchData(bytes: $0) }
        let hint = Data("housecapture".utf8).withUnsafeBytes { DispatchData(bytes: $0) }
        sec_protocol_options_add_pre_shared_key(options, psk as __DispatchData, hint as __DispatchData)
        sec_protocol_options_append_tls_ciphersuite(options, tls_ciphersuite_t(rawValue: UInt16(TLS_PSK_WITH_AES_128_GCM_SHA256))!)
        sec_protocol_options_set_min_tls_protocol_version(options, .TLSv12)
        sec_protocol_options_set_max_tls_protocol_version(options, .TLSv12)
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true; tcp.enableKeepalive = true
        return NWParameters(tls: tls, tcp: tcp)
    }

    public func start(_ pairing: CapturePairing) {
        stop()
        let token = generation
        onStatus?("Finding \(pairing.name)…", false)
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_housecapture._tcp", domain: nil), using: .tcp)
        self.browser = browser
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self, self.generation == token, self.connection == nil else { return }
                let match = results.first { result in
                    if case .bonjour(let txt) = result.metadata { return txt["id"] == pairing.id }
                    return false
                }
                if let match { self.connect(match.endpoint, pairing: pairing, token: token) }
            }
        }
        browser.stateUpdateHandler = { [weak self] state in
            if case .failed = state { Task { @MainActor in
                guard let self, self.generation == token else { return }
                self.onStatus?("Discovery failed. Check Local Network permission and the Mac capture host.", false)
            } }
        }
        browser.start(queue: .main)
    }

    /// Exposed for authenticated loopback integration tests, without Bonjour or UI.
    public func connect(_ endpoint: NWEndpoint, pairing: CapturePairing) {
        stop(); connect(endpoint, pairing: pairing, token: generation)
    }

    private func connect(_ endpoint: NWEndpoint, pairing: CapturePairing, token: UUID) {
        let connection = NWConnection(to: endpoint, using: Self.parameters(key: pairing.key))
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                switch state {
                case .ready:
                    self.connected = true; self.onStatus?("Connected to \(pairing.name)", true)
                    self.receiveHeader(token)
                case .failed, .waiting:
                    self.stop(); self.onStatus?("Disconnected. Captures remain on this iPhone; reconnect to resume.", false)
                default: break
                }
            }
        }
        connection.start(queue: .main)
    }

    public func stop() {
        generation = UUID(); connected = false
        browser?.cancel(); browser = nil
        connection?.stateUpdateHandler = nil; connection?.cancel(); connection = nil
        let requests = pending; pending.removeAll()
        timeouts.values.forEach { $0.cancel() }; timeouts.removeAll()
        requests.values.forEach { $0.resume(throwing: CaptureLinkError("The capture connection closed. Reconnect to resume.")) }
    }

    public func request(_ payload: [String: Any]) async throws -> [String: Any] {
        try Task.checkCancellation()
        guard connected, let connection else { throw CaptureLinkError("Connect to the Mac capture host first.") }
        guard pending.isEmpty else { throw CaptureLinkError("The capture channel is busy. Wait for the current request to finish.") }
        let id = UUID().uuidString
        var payload = payload; payload["id"] = id
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard !data.isEmpty, data.count <= 1_048_576 else { throw CaptureLinkError("Capture message exceeds its size limit.") }
        var frame = Data()
        withUnsafeBytes(of: UInt32(data.count).bigEndian) { frame.append(contentsOf: $0) }
        frame.append(data)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                timeouts[id] = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
                    self?.resolve(id, .failure(CaptureLinkError("The Mac did not respond. Reconnect and resume the transfer.")))
                }
                connection.send(content: frame, completion: .contentProcessed { [weak self] error in
                    if error != nil { Task { @MainActor in self?.resolve(id, .failure(CaptureLinkError("The transfer was interrupted."))) } }
                })
            }
        } onCancel: { Task { @MainActor [weak self] in self?.resolve(id, .failure(CancellationError())) } }
    }

    private func resolve(_ id: String, _ result: Result<[String: Any], Error>) {
        timeouts.removeValue(forKey: id)?.cancel()
        pending.removeValue(forKey: id)?.resume(with: result)
    }

    private func receiveHeader(_ token: UUID) {
        connection?.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] data, _, done, error in
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                guard let data, data.count == 4, !done, error == nil else { self.stop(); self.onStatus?("Connection closed. Reconnect to resume.", false); return }
                let size = data.reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
                guard size > 0, size <= 1_048_576 else { self.stop(); return }
                self.receiveBody(Int(size), token)
            }
        }
    }

    private func receiveBody(_ size: Int, _ token: UUID) {
        connection?.receive(minimumIncompleteLength: size, maximumLength: size) { [weak self] data, _, _, error in
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                guard error == nil, let data, data.count == size,
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = value["id"] as? String, let ok = value["ok"] as? Bool else { self.stop(); return }
                self.resolve(id, ok ? .success(value) : .failure(CaptureLinkError(value["error"] as? String ?? "The Mac rejected the request.")))
                self.receiveHeader(token)
            }
        }
    }
}
