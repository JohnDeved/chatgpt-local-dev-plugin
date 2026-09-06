import AppKit
import Foundation
import ServiceManagement

func prettyJSON(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return String(describing: value) }
    return String(decoding: data, as: UTF8.self)
}

struct RuntimeManifest: Decodable {
    let runtimeId: String
    let pid: Int
    let socketPath: String
    let journalPath: String
    let startedAt: String
}

struct LiveOperation: Identifiable {
    let id: String
    let runtimeId: String
    let tool: String
    let runId: String?
    let title: String
    let arguments: String
    let presentation: ToolPresentation
    let state: String
    let startedAt: String
    init?(_ value: [String: Any], runtime: String) {
        guard let id = value["id"] as? String, let tool = value["tool"] as? String else { return nil }
        self.id = id; runtimeId = runtime; self.tool = tool
        runId = value["runId"] as? String
        title = value["title"] as? String ?? tool
        arguments = prettyJSON(value["arguments"] ?? [:])
        presentation = .make(tool: tool, title: value["title"] as? String, arguments: value["arguments"] as? [String: Any] ?? [:])
        state = value["state"] as? String ?? "unknown"
        startedAt = value["startedAt"] as? String ?? ""
    }
}

struct LiveProcess: Identifiable {
    let id: String
    let runtimeId: String
    let pid: Int
    let argv: [String]
    let cwd: String
    let operationId: String
    let startedAt: String
    init?(_ value: [String: Any], runtime: String) {
        guard let id = value["id"] as? String, let pid = value["pid"] as? Int else { return nil }
        self.id = id; runtimeId = runtime; self.pid = pid
        argv = value["argv"] as? [String] ?? []
        cwd = value["cwd"] as? String ?? ""
        operationId = value["operationId"] as? String ?? ""
        startedAt = value["startedAt"] as? String ?? ""
    }
}

struct RuntimeState {
    let manifest: RuntimeManifest
    var connected = false
    var autoApprove = false
    var remember = false
    var paused = false
    var fault: String?
    var operations: [LiveOperation] = []
    var processes: [LiveProcess] = []
    var runs: [WorkerRunItem] = []
    var supportsRuns = false
}

struct JournalRecord: Identifiable {
    let id: String
    let runtimeId: String
    let sequence: Int
    let timestamp: String
    let type: String
    let operationId: String?
    let parentId: String?
    let processId: String?
    let label: String
    let file: URL
    let offset: UInt64
    let length: Int

    init?(_ json: [String: Any], file: URL, offset: UInt64, length: Int) {
        guard let runtime = json["runtimeId"] as? String, let sequence = json["sequence"] as? Int,
              let type = json["type"] as? String else { return nil }
        id = "\(runtime):\(sequence)"; runtimeId = runtime; self.sequence = sequence
        timestamp = json["timestamp"] as? String ?? ""; self.type = type
        operationId = json["operationId"] as? String; parentId = json["parentId"] as? String
        let detail = json["detail"] as? [String: Any] ?? [:]
        processId = detail["processId"] as? String
        if let title = detail["title"] as? String { label = title }
        else if let tool = detail["tool"] as? String { label = tool }
        else if let argv = detail["argv"] as? [String], let executable = argv.first {
            label = "\(URL(fileURLWithPath: executable).lastPathComponent) · \(max(0, argv.count - 1)) arguments"
        } else if let stream = detail["stream"] as? String {
            label = "\(stream) · \(detail["bytes"] as? Int ?? 0) bytes"
        } else if let message = detail["message"] as? String { label = message }
        else if let server = detail["server"] as? String { label = server }
        else { label = type.replacingOccurrences(of: ".", with: " ") }
        self.file = file; self.offset = offset; self.length = length
    }

    func rawData() throws -> Data {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        return try handle.read(upToCount: length) ?? Data()
    }
}

/// Metadata index only. Original payloads remain on disk and are read on selection.
// Mutable cursor state is accessed exclusively on ActivityStore.archiveQueue.
final class ArchiveReader: @unchecked Sendable {
    private struct Cursor { var offset: UInt64 = 0; var pending = Data() }
    private var cursors: [String: Cursor] = [:]
    private var records: [JournalRecord] = []
    private var timelineIndex = TimelineIndex()
    private var runIndex = RunTimelineIndex()
    var runs: [WorkerRunItem] { runIndex.ordered }
    var timeline: [ToolTimelineItem] { timelineIndex.ordered }

    func scan(_ directory: URL) throws -> ([RuntimeManifest], [JournalRecord], Bool) {
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        var manifests: [RuntimeManifest] = []
        var loading = false
        for file in files.sorted(by: { $0.path < $1.path }) {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true && values.isSymbolicLink != true else { continue }
            if file.pathExtension == "json", file.lastPathComponent != "settings.json",
               let data = try? Data(contentsOf: file), let manifest = try? JSONDecoder().decode(RuntimeManifest.self, from: data) {
                manifests.append(manifest)
            }
            guard file.pathExtension == "jsonl" else { continue }
            var cursor = cursors[file.path] ?? Cursor()
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            let size = try handle.seekToEnd()
            if size < cursor.offset {
                throw NSError(domain: "LocalDev", code: 2, userInfo: [NSLocalizedDescriptionKey: "An activity archive was shortened externally: \(file.lastPathComponent)"])
            }
            try handle.seek(toOffset: cursor.offset)
            for _ in 0..<16 {
                guard let chunk = try handle.read(upToCount: 65_536), !chunk.isEmpty else { break }
                cursor.offset += UInt64(chunk.count)
                cursor.pending.append(chunk)
                while let newline = cursor.pending.firstIndex(of: 10) {
                    let start = cursor.offset - UInt64(cursor.pending.count)
                    let line = Data(cursor.pending[..<newline])
                    cursor.pending.removeSubrange(...newline)
                    guard !line.isEmpty else { continue }
                    let json = try JSONSerialization.jsonObject(with: line)
                    if let object = json as? [String: Any], let record = JournalRecord(object, file: file, offset: start, length: line.count) {
                        records.append(record); timelineIndex.accept(object); runIndex.accept(object)
                    }
                }
            }
            if cursor.offset < size { loading = true }
            cursors[file.path] = cursor
        }
        return (manifests, records.sorted {
            if $0.timestamp != $1.timestamp { return $0.timestamp < $1.timestamp }
            if $0.runtimeId == $1.runtimeId { return $0.sequence < $1.sequence }
            return $0.runtimeId < $1.runtimeId
        }, loading)
    }
}

enum InspectorSelection: Equatable {
    case operation(runtime: String, id: String)
    case process(runtime: String, id: String)
    case record(String)
}

struct ApprovalChoice: Equatable {
    var autoApprove: Bool
    var remember: Bool
}

@MainActor
final class ActivityStore: ObservableObject {
    @Published var runtimes: [String: RuntimeState] = [:]
    @Published var records: [JournalRecord] = []
    @Published var section = "Timeline"
    @Published var history: [ToolTimelineItem] = []
    @Published var historyRuns: [WorkerRunItem] = []
    @Published var steeringDraft = ""
    @Published var steeringTarget: String?
    @Published var sendingSteering = false
    @Published var steeringNotice: String?
    private var pendingSteeringAttempt: (target: String, text: String, id: String)?
    @Published var connectionHealth = ConnectionHealth.checking
    @Published var reconnecting = false
    @Published var desiredPolicy: ApprovalChoice?
    @Published var reviewedFailureID: String?
    private var policyRevision = UUID()
    private var sentPolicyRevisions: [String: UUID] = [:]
    private var connectionCheckInFlight = false
    private var lastConnectionCheck = Date.distantPast
    private let runtimeConnection: RuntimeConnection
    @Published var search = ""
    @Published var lastError: String?
    @Published var loadingArchive = false
    @Published var selection: InspectorSelection? { didSet { refreshInspector() } }
    @Published var inspectorMode = "Readable" { didSet { refreshInspector() } }
    @Published var inspectorText = "Select an operation or event to inspect its complete local record."
    @Published var inspectorImages: [NSImage] = []
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled
    @Published var offlineAuto = false
    @Published var offlineRemember = false
    @Published var offlinePaused = false
    let directory: URL
    private var connections: [String: LocalSocket] = [:]
    private var acknowledgements: [String: (Bool) -> Void] = [:]
    private var scanInFlight = false
    private var inspectorGeneration = 0
    private var timer: Timer?
    private let archiveQueue = DispatchQueue(label: "local-dev.archive", qos: .utility)
    private let inspectionQueue = DispatchQueue(label: "local-dev.inspection", qos: .userInitiated)
    private let reader = ArchiveReader()

    init(home overrideHome: URL? = nil, startMonitoring: Bool = true) {
        let arguments = CommandLine.arguments
        let custom = arguments.firstIndex(of: "--activity-home").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
        let home = overrideHome ?? custom.map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser
        directory = home.appendingPathComponent(".local-dev/activity", isDirectory: true)
        runtimeConnection = RuntimeConnection(home: home)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let settings = directory.appendingPathComponent("settings.json")
            if let data = try? Data(contentsOf: settings), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                offlineRemember = json["remember"] as? Bool ?? false
                offlineAuto = offlineRemember && (json["autoApprove"] as? Bool ?? false)
                offlinePaused = json["paused"] as? Bool ?? false
            }
        } catch { lastError = error.localizedDescription }
        guard startMonitoring else { return }
        scan()
        inspectConnection()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.scan() }
        }
    }

    var connected: [RuntimeState] { runtimes.values.filter(\.connected) }
    var operations: [LiveOperation] { connected.flatMap(\.operations).sorted { $0.startedAt < $1.startedAt } }
    var processes: [LiveProcess] { connected.flatMap(\.processes).sorted { $0.startedAt < $1.startedAt } }
    var pending: [LiveOperation] { operations.filter { $0.state == "waiting" } }
    var autoApprove: Bool { desiredPolicy?.autoApprove ?? (connected.isEmpty ? offlineAuto : connected.contains { $0.autoApprove }) }
    var remember: Bool { desiredPolicy?.remember ?? (connected.isEmpty ? offlineRemember : connected.allSatisfy { $0.remember }) }
    var policyPending: Bool {
        guard let choice = desiredPolicy else { return false }
        return connected.isEmpty || connected.contains { $0.autoApprove != choice.autoApprove || $0.remember != choice.remember }
    }
    var paused: Bool { connected.isEmpty ? offlinePaused : connected.allSatisfy { $0.paused } }
    var hasFault: Bool { connected.contains { $0.fault != nil } }
    var status: String {
        if hasFault { return "Capture error" }
        if reconnecting { return "Connecting…" }
        if connected.isEmpty { return connectionHealth.running ? "Update needed" : "Disconnected" }
        if paused { return "Paused" }
        if !pending.isEmpty { return "\(pending.count) approval\(pending.count == 1 ? "" : "s")" }
        let running = operations.filter { $0.state != "waiting" }.count
        if running > 0 { return "\(running) running" }
        if !activeRuns.isEmpty { return "Run open" }
        if !processes.isEmpty { return "\(processes.count) process\(processes.count == 1 ? "" : "es")" }
        return "Ready"
    }
    var icon: String {
        if hasFault || needsReview { return "exclamationmark.octagon.fill" }
        if !pending.isEmpty { return "hand.raised.fill" }
        if paused { return "pause.circle.fill" }
        return autoApprove ? "bolt.shield.fill" : "terminal"
    }

    func scan() {
        guard !scanInFlight else { return }
        scanInFlight = true
        let root = directory
        if connected.isEmpty && !reconnecting && Date().timeIntervalSince(lastConnectionCheck) > 20 { inspectConnection() }
        archiveQueue.async { [weak self, reader] in
            let result = Result {
                let (manifests, records, loading) = try reader.scan(root)
                return (manifests, records, loading, reader.timeline, reader.runs)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.scanInFlight = false
                switch result {
                case .failure(let error): self.lastError = error.localizedDescription
                case .success(let (manifests, records, loading, timeline, runs)):
                    let changed = self.records.count != records.count
                    self.records = records; self.loadingArchive = loading
                    if changed { self.history = timeline; self.historyRuns = runs }
                    self.reconcile(manifests)
                    if changed, self.selection != nil { self.refreshInspector() }
                }
            }
        }
    }

    private func reconcile(_ manifests: [RuntimeManifest]) {
        let activeIds = Set(manifests.map(\.runtimeId))
        for (id, connection) in connections where !activeIds.contains(id) {
            connection.stop(); connections.removeValue(forKey: id); runtimes[id]?.connected = false; sentPolicyRevisions.removeValue(forKey: id)
        }
        for manifest in manifests {
            let id = manifest.runtimeId
            if runtimes[id] == nil { runtimes[id] = RuntimeState(manifest: manifest) }
            guard connections[id] == nil else { continue }
            // The runtime advertises only a private, per-user local IPC endpoint.
            guard manifest.socketPath.hasPrefix("/tmp/local-dev-\(getuid())/") else {
                lastError = "Refusing an unexpected activity socket path"; continue
            }
            let connection = LocalSocket(path: manifest.socketPath)
            connections[id] = connection
            connection.onMessage = { [weak self] message in self?.receive(message, runtime: id) }
            connection.onState = { [weak self, weak connection] isConnected, _ in
                guard let self else { return }
                self.runtimes[id]?.connected = isConnected
                if isConnected { connection?.send(["action": "hello", "id": UUID().uuidString, "client": "Local Dev menu bar", "pid": Int(getpid())]) }
                if !isConnected, self.connections[id] === connection {
                    self.connections[id]?.stop(); self.connections.removeValue(forKey: id); self.sentPolicyRevisions.removeValue(forKey: id)
                }
            }
            connection.start()
        }
    }

    private func receive(_ message: [String: Any], runtime id: String) {
        switch message["kind"] as? String {
        case "snapshot":
            guard var state = runtimes[id] else { return }
            state.connected = true
            reconnecting = false
            let policy = message["policy"] as? [String: Any] ?? [:]
            state.autoApprove = policy["autoApprove"] as? Bool ?? false
            state.remember = policy["remember"] as? Bool ?? false
            state.paused = policy["paused"] as? Bool ?? false
            state.fault = message["fault"] as? String
            state.operations = (message["operations"] as? [[String: Any]] ?? []).compactMap { LiveOperation($0, runtime: id) }
            state.processes = (message["processes"] as? [[String: Any]] ?? []).compactMap { LiveProcess($0, runtime: id) }
            state.supportsRuns = (message["capabilities"] as? [String: Any])?["workerRuns"] as? Bool == true
            state.runs = (message["runs"] as? [[String: Any]] ?? []).compactMap { WorkerRunItem($0, runtime: id) }
            runtimes[id] = state
            if steeringTarget == nil { steeringTarget = activeRuns.last?.id }
            if desiredPolicy == nil { offlineAuto = state.autoApprove; offlineRemember = state.remember }
            offlinePaused = state.paused
            applyDesiredPolicy(to: id)
            if let fault = state.fault { lastError = "Activity capture failed. New actions are blocked. \(fault)" }
        case "ack":
            let ok = message["ok"] as? Bool ?? false
            if !ok { lastError = message["error"] as? String ?? "Local control failed" }
            if let key = message["id"] as? String { acknowledgements.removeValue(forKey: key)?(ok) }
        default: break // The on-disk journal is authoritative; the scanner reads incremental bytes.
        }
    }

    func send(_ action: String, runtime: String? = nil, values: [String: Any] = [:], completion: ((Bool) -> Void)? = nil) {
        let targets = connected.filter { runtime == nil || $0.manifest.runtimeId == runtime }
        guard !targets.isEmpty else { lastError = "No updated runtime is connected."; completion?(false); return }
        for target in targets {
            let id = UUID().uuidString
            var request = values; request["action"] = action; request["id"] = id
            if let completion { acknowledgements[id] = completion }
            connections[target.manifest.runtimeId]?.send(request)
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let callback = self?.acknowledgements.removeValue(forKey: id) else { return }
                self?.lastError = "The runtime did not confirm the control request."; callback(false)
            }
        }
    }

    func setPolicy(auto: Bool, remember: Bool) {
        do {
            if connected.isEmpty { try writeOfflinePolicy(auto: auto, remember: remember, paused: offlinePaused) }
            offlineAuto = auto; offlineRemember = remember
            desiredPolicy = ApprovalChoice(autoApprove: auto, remember: remember)
            policyRevision = UUID()
            for runtime in connected { applyDesiredPolicy(to: runtime.manifest.runtimeId) }
        } catch { lastError = error.localizedDescription }
    }

    private func applyDesiredPolicy(to runtime: String) {
        guard let choice = desiredPolicy, let state = runtimes[runtime], state.connected,
              sentPolicyRevisions[runtime] != policyRevision else { return }
        if state.autoApprove == choice.autoApprove && state.remember == choice.remember { return }
        sentPolicyRevisions[runtime] = policyRevision
        send("policy", runtime: runtime, values: ["autoApprove": choice.autoApprove, "remember": choice.remember, "confirmed": choice.autoApprove]) { [weak self] ok in
            if !ok { self?.lastError = "Your approval preference has not been applied. Reconnect or select the setting again to retry." }
        }
    }

    func confirmAutoApproval() {
        let alert = NSAlert()
        alert.messageText = "Auto-approve all Local Dev actions?"
        alert.informativeText = "Commands, edits, deletions, and supported approval requests will run without asking. All activity stays visible.\n\n" + (connected.isEmpty ? "The choice will apply when the runtime connects. Session-only approval lasts while this app is open; it does not require Remember across restarts." : "You can turn this off or pause new actions at any time.")
        alert.addButton(withTitle: "Enable Auto-approve All")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { setPolicy(auto: true, remember: remember) }
    }

    var timelineRows: [ToolTimelineItem] {
        var rows = Dictionary(uniqueKeysWithValues: history.map { ($0.id, $0) })
        for operation in operations {
            let key = operation.runtimeId + ":" + operation.id
            if rows[key] == nil {
                rows[key] = ToolTimelineItem(runtimeId: operation.runtimeId, operationId: operation.id,
                    runId: operation.runId, tool: operation.tool, presentation: operation.presentation, startedAt: operation.startedAt)
            }
            rows[key]?.state = operation.state
        }
        for key in Array(rows.keys) {
            if let row = rows[key], row.active, runtimes[row.runtimeId]?.connected != true {
                rows[key]?.state = "interrupted"
            }
        }
        return rows.values.sorted { $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt }
    }

    var workerRuns: [WorkerRunItem] {
        var values = Dictionary(uniqueKeysWithValues: historyRuns.map { ($0.id, $0) })
        for state in connected {
            for live in state.runs {
                var run = live
                if let archived = values[live.id] {
                    run.notes = archived.notes
                    for index in run.steering.indices {
                        run.steering[index].response = archived.steering.first(where: { $0.id == run.steering[index].id })?.response
                    }
                }
                run.connected = true
                values[run.id] = run
            }
        }
        for key in Array(values.keys) {
            guard let runtimeID = values[key]?.runtimeId else { continue }
            values[key]?.connected = runtimes[runtimeID]?.connected == true
        }
        return values.values.sorted { $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt }
    }

    var activeRuns: [WorkerRunItem] {
        let liveIDs = Set(connected.flatMap(\.runs).filter(\.active).map(\.id))
        return workerRuns.filter { liveIDs.contains($0.id) && $0.connected && $0.active }
    }
    var runReportingAvailable: Bool { connected.contains { $0.supportsRuns } }

    func sendSteering() {
        let text = steeringDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sendingSteering, !text.isEmpty, text.utf16.count <= 4000,
              let run = activeRuns.first(where: { $0.id == steeringTarget }) else {
            steeringNotice = "Select a connected, open run before sending. A finished chat cannot be resumed from this panel."
            return
        }
        let messageID: String
        if let previous = pendingSteeringAttempt, previous.target == run.id && previous.text == text { messageID = previous.id }
        else { messageID = UUID().uuidString; pendingSteeringAttempt = (run.id, text, messageID) }
        sendingSteering = true
        steeringNotice = nil
        send("steer", runtime: run.runtimeId, values: ["runId": run.runId, "messageId": messageID, "text": text]) { [weak self] accepted in
            guard let self else { return }
            self.sendingSteering = false
            if accepted {
                if self.steeringDraft.trimmingCharacters(in: .whitespacesAndNewlines) == text { self.steeringDraft = "" }
                self.pendingSteeringAttempt = nil
                self.steeringNotice = "Queued. It will be included in the next tool response; it has not been acknowledged yet."
            } else {
                self.steeringNotice = "No queue confirmation. Your draft is retained; retrying the same message will not duplicate it."
            }
        }
    }

    var latestFailure: ToolTimelineItem? { timelineRows.last { $0.state == "failed" } }
    var needsReview: Bool { latestFailure != nil && latestFailure?.id != reviewedFailureID }
    func reviewFailure() {
        guard let failure = latestFailure else { return }
        reviewedFailureID = failure.id
        section = "Timeline"
        selection = .operation(runtime: failure.runtimeId, id: failure.operationId)
    }

    func inspectConnection() {
        guard !connectionCheckInFlight, !reconnecting, connected.isEmpty else { return }
        connectionCheckInFlight = true
        lastConnectionCheck = Date()
        runtimeConnection.inspect { [weak self] health in
            self?.connectionCheckInFlight = false
            self?.connectionHealth = health
        }
    }

    func requestReconnect() {
        guard !reconnecting else { return }
        let alert = NSAlert()
        alert.messageText = "Reconnect the Local Dev runtime?"
        alert.informativeText = "This loads the updated server and connects its activity stream to this app. ChatGPT tools will disconnect briefly. Commands managed by the old runtime, including development servers, may stop. Your approval preference is not changed.\n\nReconnect only when those processes can be interrupted."
        alert.addButton(withTitle: "Reconnect Runtime")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        reconnecting = true
        connectionHealth.title = "Reconnecting runtime"
        connectionHealth.explanation = "Starting the updated tunnel. Its activity connection will appear here when ready."
        runtimeConnection.reconnect { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.reconnecting = false
                self.lastError = error.localizedDescription
                self.connectionHealth.title = "Reconnection failed"
                self.connectionHealth.explanation = "The runtime did not reconnect. Open Connection details to inspect the error."
                self.connectionHealth.transcript = error.localizedDescription
            case .success(let transcript):
                self.connectionHealth.transcript = transcript
                self.scan()
                DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
                    guard let self else { return }
                    self.reconnecting = false
                    if self.connected.isEmpty {
                        self.connectionHealth.title = "Waiting for activity connection"
                        self.connectionHealth.explanation = "The tunnel command finished, but no activity stream is connected yet. Inspect Connection details or retry the status check."
                    }
                }
            }
        }
    }

    private func writeOfflinePolicy(auto: Bool, remember: Bool, paused: Bool) throws {
        let file = directory.appendingPathComponent("settings.json")
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "autoApprove": auto && remember, "remember": remember, "paused": paused])
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        // Retain session intent in the app, but persist it only when explicitly remembered.
        offlineAuto = auto; offlineRemember = remember; offlinePaused = paused
    }

    func setPaused(_ value: Bool) {
        if connected.isEmpty {
            do { try writeOfflinePolicy(auto: offlineAuto, remember: offlineRemember, paused: value) }
            catch { lastError = error.localizedDescription }
        } else { send("pause", values: ["paused": value]) }
    }

    func setLaunchAtLogin(_ value: Bool) {
        Task {
            do {
                if value { try SMAppService.mainApp.register() } else { try await SMAppService.mainApp.unregister() }
                launchAtLogin = SMAppService.mainApp.status == .enabled
                if value && !launchAtLogin { lastError = "Approve Local Dev in System Settings → General → Login Items." }
            } catch { lastError = error.localizedDescription }
        }
    }

    func requestQuit() {
        let alert = NSAlert()
        alert.messageText = "Pause Local Dev and quit?"
        alert.informativeText = "New actions will be blocked before the menu-bar app closes. Existing processes remain running unless you choose Stop all work."
        alert.addButton(withTitle: "Pause and Quit")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Stop All Work and Quit")
        let choice = alert.runModal()
        guard choice != .alertSecondButtonReturn else { return }
        let quit = { MenuAppDelegate.mayQuit = true; NSApp.terminate(nil) }
        if connected.isEmpty {
            do { try writeOfflinePolicy(auto: offlineAuto, remember: offlineRemember, paused: true); quit() }
            catch { lastError = error.localizedDescription }
            return
        }
        var remaining = connected.count
        var allOK = true
        send(choice == .alertThirdButtonReturn ? "stopAll" : "pause", values: ["paused": true]) { ok in
            allOK = allOK && ok; remaining -= 1
            if remaining == 0 && allOK { quit() }
        }
    }

    func revealArchive() { NSWorkspace.shared.open(directory) }

    func exportInspection() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "local-dev-activity.txt"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try inspectorText.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { lastError = error.localizedDescription }
    }

    func refreshInspector() {
        inspectorGeneration += 1
        let generation = inspectorGeneration
        guard let selection else { return }
        let all = records
        let mode = inspectorMode
        let live = operations
        inspectionQueue.async { [weak self] in
            let result = Result { () throws -> (String, [Data]) in
                var selected: [JournalRecord]
                switch selection {
                case .record(let id): selected = all.filter { $0.id == id }
                case .process(let runtime, let id): selected = all.filter { $0.runtimeId == runtime && $0.processId == id }
                case .operation(let runtime, let id):
                    var related = Set([id]); var previous = -1
                    while previous != related.count {
                        previous = related.count
                        for record in all where record.runtimeId == runtime {
                            if let parent = record.parentId, related.contains(parent), let child = record.operationId { related.insert(child) }
                        }
                    }
                    selected = all.filter { $0.runtimeId == runtime && $0.operationId.map { related.contains($0) } == true }
                }
                var text = ""
                var outputDecoders: [String: OutputTextDecoder] = [:]
                var images: [Data] = []
                var seenImages = Set<String>()
                func collectImages(_ value: Any) {
                    if let object = value as? [String: Any] {
                        if object["type"] as? String == "image", let base64 = object["data"] as? String,
                           seenImages.insert(base64).inserted, let data = Data(base64Encoded: base64) { images.append(data) }
                        for child in object.values { if child is [String: Any] || child is [Any] { collectImages(child) } }
                    } else if let values = value as? [Any] { for child in values { collectImages(child) } }
                }
                for record in selected {
                    let isOutput = record.type == "process.output" || record.type == "downstream.stderr"
                    if mode == "Output" && !isOutput && record.type != "tool.result" { continue }
                    if mode == "Readable" && (isOutput || record.type.hasSuffix(".progress")) { continue }
                    let raw = try record.rawData()
                    if mode == "Raw events" { text += String(decoding: raw, as: UTF8.self) + "\n"; continue }
                    let object = try JSONSerialization.jsonObject(with: raw)
                    let json = object as? [String: Any] ?? [:]
                    let detail = json["detail"] as? [String: Any] ?? [:]
                    if mode == "Output" {
                        if record.type == "tool.result" {
                            if !selected.contains(where: { $0.type == "process.output" }) { text += readableValue(detail["result"] ?? [:]) }
                        } else {
                            let key = (record.processId ?? record.operationId ?? "runtime") + ":" + (detail["stream"] as? String ?? "stderr")
                            var decoder = outputDecoders[key] ?? OutputTextDecoder()
                            text += decoder.append(detail["text"] as? String ?? "")
                            outputDecoders[key] = decoder
                        }
                    } else {
                        if record.type == "tool.requested" {
                            text += readableInputs(detail["arguments"] as? [String: Any] ?? [:]) + "\n\n"
                        } else if record.type == "tool.result" {
                            text += "Result\n" + readableValue(detail["result"] ?? [:]) + "\n\n"
                        } else if record.type == "tool.failed" {
                            text += "Failed\n" + readableValue(detail["error"] ?? detail) + "\n\n"
                        }

                        collectImages(object)
                    }
                }
                if text.isEmpty, case .operation(_, let id) = selection, let operation = live.first(where: { $0.id == id }) {
                    text = "\(operation.tool)\n\(operation.arguments)\n\nWaiting for the local journal index…"
                }
                if text.isEmpty { text = mode == "Output" ? "No stdout or stderr has been captured for this selection." : "No records for this selection yet." }
                return (text, images)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.inspectorGeneration == generation else { return }
                switch result {
                case .success(let (text, images)): self.inspectorText = text; self.inspectorImages = images.compactMap { NSImage(data: $0) }
                case .failure(let error): self.inspectorText = "Cannot read the complete record: \(error.localizedDescription)"; self.lastError = error.localizedDescription
                }
            }
        }
    }
}
