import AppKit
import Foundation
import SwiftUI

@MainActor
func runNativeChecks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("local-dev-native-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("fixture.jsonl")
    let initialEvent: [String: Any] = [
        "version": 1, "runtimeId": "test-runtime", "sequence": 1,
        "timestamp": "2026-09-05T00:00:00.000Z", "type": "tool.requested", "operationId": "operation",
        "detail": ["tool": "dev.run", "arguments": ["argv": ["/usr/bin/printf", "visible-secret-🔐"]]],
    ]
    let data = try JSONSerialization.data(withJSONObject: initialEvent, options: [.sortedKeys])
    try data.write(to: file)
    let reader = ArchiveReader()
    let (_, incomplete, _) = try reader.scan(root)
    precondition(incomplete.isEmpty, "An incomplete journal record must not be parsed")
    let handle = try FileHandle(forWritingTo: file)
    try handle.seekToEnd(); try handle.write(contentsOf: Data([10])); try handle.close()
    let (_, complete, _) = try reader.scan(root)
    precondition(complete.count == 1)
    let original = try complete[0].rawData()
    precondition(original == data, "Raw records must be byte-for-byte intact")
    precondition(String(decoding: original, as: UTF8.self).contains("visible-secret"), "Local details must not be masked")
    let (_, repeated, _) = try reader.scan(root)
    precondition(repeated.count == 1, "Rescanning must not duplicate records")
    precondition(reader.timeline.count == 1, "The journal index must populate the human timeline")

    let store = ActivityStore(home: root, startMonitoring: false)
    precondition(!store.autoApprove, "Auto-approve must default to off")
    store.setPolicy(auto: true, remember: false)
    precondition(store.autoApprove && store.policyPending, "Session-only auto-approval must be selectable offline")
    precondition(store.lastError == nil, "Offline session selection must not produce an error")
    let settingsFile = root.appendingPathComponent(".local-dev/activity/settings.json")
    let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: settingsFile)) as! [String: Any]
    precondition(settings["autoApprove"] as? Bool == false && settings["remember"] as? Bool == false, "Session intent must not become a persisted permission")
    let restarted = ActivityStore(home: root, startMonitoring: false)
    precondition(!restarted.autoApprove, "App restart must clear session-only auto-approval")
    store.setPolicy(auto: true, remember: true)
    let remembered = ActivityStore(home: root, startMonitoring: false)
    precondition(remembered.autoApprove && remembered.remember)
    store.setPolicy(auto: false, remember: true)
    precondition(!store.autoApprove)
    store.setPaused(true)
    precondition(store.paused)

    let read = ToolPresentation.make(tool: "serena.read_file", arguments: ["relative_path": "native/ActivityStore.swift", "start_line": 10, "end_line": 30])
    precondition(read.title == "Read ActivityStore.swift" && read.subtitle == "native/ActivityStore.swift")
    precondition(read.input.contains("File\nnative/ActivityStore.swift"), "Readable inputs should use labels, not event JSON")
    let command = ToolPresentation.make(tool: "dev.run", arguments: ["argv": ["/opt/node/bin/npm", "run", "check"]])
    precondition(command.title == "Run npm run check")
    precondition(command.command == "/opt/node/bin/npm run check", "Expanded command must retain the complete executable path")
    let script = ToolPresentation.make(tool: "dev.run", arguments: ["argv": ["/usr/bin/node", "-e", "console.log('all details')"]])
    precondition(script.title == "Run node script" && script.input.contains("all details"))
    let edit = ToolPresentation.make(tool: "serena.replace_content", arguments: ["relative_path": "src/server.ts", "needle": "old", "repl": "new"])
    precondition(edit.title == "Edit server.ts" && edit.input.contains("Replacement\nnew"))
    precondition(readableValue(["result": "{\"files\":[\"one.ts\",\"two.ts\"]}"]).contains("one.ts\ntwo.ts"))
    precondition(readableValue(["content": [["type": "text", "text": "A readable result"]]]) == "A readable result")

    var index = TimelineIndex()
    var sequence = 0
    func event(_ type: String, operation: String = "one", detail: [String: Any] = [:], parent: String? = nil) {
        sequence += 1
        var value: [String: Any] = ["runtimeId": "fixture", "operationId": operation, "sequence": sequence,
            "timestamp": String(format: "2026-09-05T10:00:%02d.000Z", sequence), "type": type, "detail": detail]
        if let parent { value["parentId"] = parent }
        index.accept(value)
    }
    event("tool.requested", detail: ["tool": "dev.run", "arguments": ["argv": ["/opt/node/bin/npm", "run", "check"]]])
    event("approval.accepted", detail: ["source": "auto-approve-all"])
    event("tool.started")
    event("process.requested", detail: ["processId": "process", "argv": ["/opt/node/bin/npm", "run", "check"], "cwd": "/project"])
    event("process.started", detail: ["processId": "process"])
    event("process.output", detail: ["text": "Typecheck passed\n", "bytes": 17])
    event("process.exited", detail: ["processId": "process", "exitCode": 0])
    event("tool.result", detail: ["result": ["structuredContent": ["data": ["exitCode": 0]]]])
    event("tool.completed")
    precondition(index.ordered.count == 1, "Nine lifecycle events must be one tool-call row")
    let row = index.ordered[0]
    precondition(row.state == "completed" && row.approval == "Auto-approved" && row.outcome == "Exited with code 0")
    precondition(row.outputPreview == "Typecheck passed\n" && row.steps.count == 1 && row.steps[0].state == "Exit 0")
    precondition(row.duration == "8.0 s")
    event("tool.requested", operation: "nested", detail: ["tool": "project.hook", "arguments": [:]], parent: "one")
    precondition(index.ordered.last?.parentId == "one", "Nested operations must retain their parent")
    event("approval.denied", operation: "nested")
    event("tool.failed", operation: "nested", detail: ["error": ["message": "APPROVAL_DENIED"]])
    precondition(index.ordered.last?.state == "denied")
    event("tool.requested", operation: "lost", detail: ["tool": "serena.read_file", "arguments": ["relative_path": "README.md"]])
    index.accept(["runtimeId": "fixture", "type": "runtime.closed", "timestamp": "2026-09-05T10:01:00.000Z"])
    precondition(index.ordered.last?.state == "interrupted", "A closed runtime is not proof of successful completion")
    precondition(index.ordered.first?.state == "completed", "Completed history must remain completed")
    store.history = index.ordered
    precondition(store.timelineRows.count == 3)

    let health = ConnectionHealth.fromStatus(["process_running": true, "healthy": true, "ready": true])
    precondition(health.title == "Runtime update needed" && health.configured && health.running)
    precondition(ConnectionHealth.fromStatus(["process_running": false]).title == "Runtime is offline")
    let setup = TunnelSetup(alias: "local-dev", binaryPath: "/usr/local/bin/tunnel-client", tunnelId: "tunnel_fixture", runtimeKeyRef: "file:/private/key-reference", mcpCommand: "'/path with spaces/node' '/project/dist/server.js'")
    try setup.validate()
    precondition(setup.connectArguments.last == "--json" && setup.connectArguments.contains(setup.mcpCommand), "The MCP command must be a single tunnel argument, not shell-evaluated by the app")

    try runWorkerRunChecks(in: root.appendingPathComponent("run-fixture"))
    try runCommandPresentationChecks(in: root.appendingPathComponent("command-fixture"))
    try runConnectionRecoveryCheck(in: root.appendingPathComponent("connection-fixture"))

    // Numeric sequence order matters when several output chunks share one millisecond.
    let journal = try FileHandle(forWritingTo: file)
    try journal.seekToEnd()
    for number in 2...12 {
        var next = initialEvent; next["sequence"] = number; next["type"] = "operation.progress"
        var bytes = try JSONSerialization.data(withJSONObject: next); bytes.append(10)
        try journal.write(contentsOf: bytes)
    }
    try journal.close()
    let (_, orderedRecords, _) = try reader.scan(root)
    precondition(orderedRecords.map(\.sequence) == Array(1...12), "Same-timestamp records must preserve numeric sequence order")

    let hosting = NSHostingView(rootView: ActivityPanel(store: store))
    hosting.setFrameSize(NSSize(width: 820, height: 730))
    hosting.layoutSubtreeIfNeeded()
    precondition(hosting.fittingSize.width >= 800 && hosting.fittingSize.height >= 700, "The timeline panel must have a usable layout")
    print("Native checks: archive integrity, offline/session approval, remembered policy, readable labels, timeline reduction, nested calls, outcomes, connection diagnosis, argv preservation, and layout")
}


@MainActor
private func runConnectionRecoveryCheck(in root: URL) throws {
    guard let node = ProcessInfo.processInfo.environment["LOCAL_DEV_TEST_NODE"], node.hasPrefix("/") else {
        throw NSError(domain: "NativeChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: "Run native checks through scripts/menu-bar.mjs so the fixture has the exact Node executable."])
    }
    try FileManager.default.createDirectory(at: root.appendingPathComponent(".local-dev"), withIntermediateDirectories: true)
    let executable = root.appendingPathComponent("fake-tunnel.mjs")
    let script = """
    #!\(node)
    import { appendFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    const args = process.argv.slice(2);
    appendFileSync(fileURLToPath(new URL('calls.jsonl', import.meta.url)), JSON.stringify(args) + '\\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ process_running: true, healthy: true, ready: true }));
    """
    try script.write(to: executable, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let command = "'/fixture/path with spaces/node' '/fixture/dist/server.js'"
    let setup: [String: Any] = ["alias": "fixture", "binaryPath": executable.path, "tunnelId": "tunnel_fixture", "runtimeKeyRef": "file:/fixture/not-a-real-key", "mcpCommand": command]
    try JSONSerialization.data(withJSONObject: setup).write(to: root.appendingPathComponent(".local-dev/setup.json"))
    let connection = RuntimeConnection(home: root)
    var result: Result<String, Error>?
    connection.reconnect { result = $0 }
    let deadline = Date().addingTimeInterval(12)
    while result == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
    guard let result else { throw NSError(domain: "NativeChecks", code: 2, userInfo: [NSLocalizedDescriptionKey: "Fake reconnect did not complete"] ) }
    let transcript = try result.get()
    precondition(transcript.contains("Exit 0"))
    let calls = try String(contentsOf: root.appendingPathComponent("calls.jsonl"), encoding: .utf8).split(separator: "\n").map {
        try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String]
    }
    precondition(calls.map { $0[1] } == ["status", "stop", "connect"], "Recovery must inspect, stop the old runtime, then connect the saved configuration")
    precondition(calls.last?.contains(command) == true, "Commands containing spaces must remain a single argv value")
}
