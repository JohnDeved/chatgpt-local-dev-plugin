import Foundation
import Darwin

struct TunnelSetup: Decodable {
    let alias: String
    let binaryPath: String
    let tunnelId: String
    let runtimeKeyRef: String
    let mcpCommand: String

    func validate() throws {
        guard binaryPath.hasPrefix("/"), !alias.isEmpty, tunnelId.hasPrefix("tunnel_"),
              runtimeKeyRef.hasPrefix("env:") || runtimeKeyRef.hasPrefix("file:/"), !mcpCommand.isEmpty else {
            throw connectionError("Local Dev setup is incomplete. Run local-dev setup to repair it.")
        }
    }
    var statusArguments: [String] { ["runtimes", "status", alias, "--json"] }
    var stopArguments: [String] { ["runtimes", "stop", alias, "--json"] }
    var connectArguments: [String] {
        ["runtimes", "connect", "--alias", alias, "--tunnel-id", tunnelId,
         "--runtime-api-key", runtimeKeyRef, "--mcp-command", mcpCommand, "--json"]
    }
}

struct ConnectionHealth {
    var title: String
    var explanation: String
    var configured = false
    var running = false
    var healthy = false
    var transcript = ""
    static let checking = ConnectionHealth(title: "Checking connection", explanation: "Looking for a Local Dev runtime on this Mac.")

    static func fromStatus(_ value: [String: Any]) -> ConnectionHealth {
        let running = value["process_running"] as? Bool == true
        let ready = value["healthy"] as? Bool == true && value["ready"] as? Bool == true
        return ConnectionHealth(
            title: running ? "Runtime update needed" : "Runtime is offline",
            explanation: running
                ? "The tunnel is running, but it has not connected to this activity app. Reconnect it to load the updated Local Dev server."
                : "The saved tunnel is not running. Connect it to enable live activity and approval controls.",
            configured: true, running: running, healthy: ready)
    }
}

private func connectionError(_ message: String) -> NSError {
    NSError(domain: "LocalDev.Connection", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// Fixed tunnel-management commands only. This is not an arbitrary command runner.
/// Foundation Process receives an argv array, never a shell-evaluated command.
final class RuntimeConnection: @unchecked Sendable {
    let home: URL
    private let queue = DispatchQueue(label: "local-dev.connection", qos: .userInitiated)
    init(home: URL) { self.home = home }

    func setup() throws -> TunnelSetup {
        let file = home.appendingPathComponent(".local-dev/setup.json")
        let state = try JSONDecoder().decode(TunnelSetup.self, from: Data(contentsOf: file))
        try state.validate()
        return state
    }

    func inspect(completion: @escaping (ConnectionHealth) -> Void) {
        queue.async { [self] in
            var health: ConnectionHealth
            do {
                let state = try setup()
                let result = try run(state.binaryPath, state.statusArguments)
                if let data = result.output.data(using: .utf8), let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    health = ConnectionHealth.fromStatus(status)
                } else {
                    health = ConnectionHealth(title: "Cannot read tunnel status", explanation: "The tunnel client did not return a valid status. Open Connection details for its exact response.", configured: true)
                }
                health.transcript = result.transcript
            } catch {
                health = ConnectionHealth(title: "Connection needs attention", explanation: error.localizedDescription)
            }
            DispatchQueue.main.async { completion(health) }
        }
    }

    /// Only call after the owner confirms the visible reconnect warning.
    func reconnect(completion: @escaping (Result<String, Error>) -> Void) {
        queue.async { [self] in
            let result = Result { () throws -> String in
                let state = try setup()
                var transcript = ""
                let status = try run(state.binaryPath, state.statusArguments)
                transcript += status.transcript
                let data = status.output.data(using: .utf8) ?? Data()
                let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
                if object["process_running"] as? Bool == true {
                    let stop = try run(state.binaryPath, state.stopArguments)
                    transcript += "\n" + stop.transcript
                    if stop.code != 0 { throw connectionError("The existing tunnel did not stop cleanly.\n\n" + transcript) }
                }
                let started = try run(state.binaryPath, state.connectArguments, timeout: 45)
                transcript += "\n" + started.transcript
                if started.code != 0 {
                    // The existing watchdog may have reconnected it first. Confirm status rather than retrying blindly.
                    let check = try run(state.binaryPath, state.statusArguments)
                    transcript += "\n" + check.transcript
                    let value = (try? JSONSerialization.jsonObject(with: Data(check.output.utf8))) as? [String: Any] ?? [:]
                    if value["healthy"] as? Bool != true || value["ready"] as? Bool != true {
                        throw connectionError("The tunnel did not reconnect.\n\n" + transcript)
                    }
                }
                return transcript
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    private struct CommandResult {
        var code: Int32
        var output: String
        var transcript: String
    }

    private func run(_ executable: String, _ arguments: [String], timeout: TimeInterval = 15) throws -> CommandResult {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("local-dev-connection-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: temporary) }
        let outURL = temporary.appendingPathComponent("stdout")
        let errURL = temporary.appendingPathComponent("stderr")
        guard FileManager.default.createFile(atPath: outURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
              FileManager.default.createFile(atPath: errURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw connectionError("Cannot create private connection diagnostics.") }
        let output = try FileHandle(forWritingTo: outURL)
        let errors = try FileHandle(forWritingTo: errURL)
        defer { try? output.close(); try? errors.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = errors
        process.standardInput = FileHandle.nullDevice
        process.currentDirectoryURL = home
        try process.run()
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isRunning {
            process.terminate()
            let grace = Date().addingTimeInterval(1)
            while process.isRunning && Date() < grace { Thread.sleep(forTimeInterval: 0.05) }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw connectionError("The tunnel-management command timed out: " + shellDisplay([executable] + arguments))
        }
        process.waitUntilExit()
        try output.synchronize(); try errors.synchronize()
        let text = String(decoding: try Data(contentsOf: outURL), as: UTF8.self)
        let stderr = String(decoding: try Data(contentsOf: errURL), as: UTF8.self)
        let transcript = "$ \(shellDisplay([executable] + arguments))\n\(text)\(stderr)\nExit \(process.terminationStatus)\n"
        return CommandResult(code: process.terminationStatus, output: text, transcript: transcript)
    }
}
