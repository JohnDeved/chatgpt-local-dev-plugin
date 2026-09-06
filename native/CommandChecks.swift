import AppKit
import Foundation
import SwiftUI

@MainActor
func runCommandPresentationChecks(in root: URL) throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let source = "const value = 'unmasked 🔐';\nconsole.log(value);"
    let command = CommandDisplay(argv: ["/opt/node/bin/node", "--input-type=module", "-e", source, "argument with spaces"])
    precondition(command.name == "node" && command.script == source)
    precondition(command.invocation == "node --input-type=module -e ‹inline script below› 'argument with spaces'")
    precondition(command.exact.contains("/opt/node/bin/node") && command.exact.contains("unmasked 🔐"))
    precondition(command.exact == shellDisplay(command.argv), "Copy command must use the original argv, not a display placeholder")
    precondition(CommandDisplay(argv: ["/bin/echo", "-e", "plain text"]).script == nil)
    precondition(CommandDisplay(argv: ["/usr/bin/python3", "-c", "print('hello')"]).script == "print('hello')")
    precondition(CommandDisplay(argv: ["/usr/bin/node", "-e"]).script == nil)
    precondition(CommandDisplay(argv: ["/bin/echo", "", "a'b", "🔐"]).exact == "/bin/echo '' 'a'\\''b' '🔐'")

    var terminal = CapturedCommandOutput(limit: 30)
    terminal.append(text: "\u{1B}[3", stream: "stdout", byteCount: 3)
    terminal.append(text: "2mhello", stream: "stdout", byteCount: 7)
    terminal.append(text: " world\u{1B}[0m\r", stream: "stdout", byteCount: 11)
    terminal.append(text: "\nnext", stream: "stdout", byteCount: 5)
    terminal.append(text: "\u{1B}[31mwarning\u{1B}[0m\n", stream: "stderr", byteCount: 17)
    precondition(terminal.stdout == "hello world\nnext", "Chunk boundaries and CRLF must not introduce extra lines")
    precondition(terminal.stderr == "warning\n")
    precondition(!terminal.combined.contains("\u{1B}"), "Readable output must not expose ANSI control noise")
    precondition(terminal.stderrBytes == 17 && terminal.stdoutBytes == 26)
    terminal.append(text: String(repeating: "x", count: 80), stream: "stdout", byteCount: 80)
    precondition(terminal.earlierOutputOmitted && terminal.combined.count == 30)
    precondition(terminal.bytes == 123, "Preview limits must not change byte counts")
    var decoder = OutputTextDecoder()
    let osc = decoder.append("\u{1B}]8;;https://example.invalid\u{1B}") + decoder.append("\\visible label\u{1B}]8;;\u{7}\n")
    precondition(osc == "visible label\n", "OSC payloads must not execute or pollute visible labels")
    var carriage = OutputTextDecoder()
    precondition(carriage.append("10%\r20%\r") + carriage.append("\nDone") == "10%\n20%\nDone")
    var interleaved = CapturedCommandOutput()
    interleaved.append(text: "\u{1B}[", stream: "stdout", byteCount: 2)
    interleaved.append(text: "warning\n", stream: "stderr", byteCount: 8)
    interleaved.append(text: "32mOK\u{1B}[0m", stream: "stdout", byteCount: 9)
    precondition(interleaved.stderr == "warning\n" && interleaved.stdout == "OK", "Escape-state parsing must be independent per stream")

    var index = TimelineIndex()
    var sequence = 0
    var rows: [[String: Any]] = []
    func event(_ type: String, _ detail: [String: Any]) {
        sequence += 1
        let event: [String: Any] = ["runtimeId": "command-check", "operationId": "batch", "sequence": sequence,
            "timestamp": "2026-09-05T10:00:00.000Z", "type": type, "detail": detail]
        rows.append(event); index.accept(event)
    }
    event("tool.requested", ["tool": "dev.batch", "arguments": ["steps": [
        ["argv": ["/opt/node/bin/npm", "run", "check"], "cwd": "frontend"],
        ["argv": ["/usr/bin/git", "status", "--short"]],
    ]]])
    precondition(index.ordered[0].presentation.pendingCommands.count == 2, "Queued batch commands must be inspectable before execution")
    event("process.requested", ["processId": "first", "argv": ["/opt/node/bin/npm", "run", "check"], "cwd": "/project/frontend"])
    event("process.started", ["processId": "first"])
    event("process.output", ["processId": "first", "stream": "stdout", "text": "Typecheck ", "bytes": 10])
    event("process.output", ["processId": "first", "stream": "stdout", "text": "passed\n", "bytes": 7])
    event("process.output", ["processId": "first", "stream": "stderr", "text": "Warning: fixture\n", "bytes": 17])
    event("process.exited", ["processId": "first", "exitCode": 0])
    event("process.requested", ["processId": "second", "argv": ["/usr/bin/git", "status", "--short"], "cwd": "/project"])
    event("process.started", ["processId": "second"])
    event("process.output", ["processId": "second", "stream": "stdout", "text": " M src/file.ts\n", "bytes": 15])
    event("process.exited", ["processId": "second", "exitCode": 1])
    let steps = index.ordered[0].steps
    precondition(steps.count == 2 && steps[0].output.stdout == "Typecheck passed\n")
    precondition(steps[1].output.stdout == " M src/file.ts\n" && !steps[1].output.combined.contains("fixture"), "Batch output must not leak into another command panel")
    precondition(steps[0].exitCode == 0 && steps[1].exitCode == 1)
    precondition(steps[0].detail == "/project/frontend" && steps[1].detail == "/project")
    event("process.requested", ["processId": "silent", "argv": ["/usr/bin/true"], "cwd": "/project"])
    event("process.started", ["processId": "silent"])
    event("process.exited", ["processId": "silent", "exitCode": 0])
    precondition(index.ordered[0].steps.last?.output.bytes == 0 && index.ordered[0].steps.last?.state == "Exit 0")

    let file = root.appendingPathComponent("command-capture.jsonl")
    var archive = Data()
    var records: [JournalRecord] = []
    for row in rows {
        let bytes = try JSONSerialization.data(withJSONObject: row)
        let record = JournalRecord(row, file: file, offset: UInt64(archive.count), length: bytes.count)!
        records.append(record); archive.append(bytes); archive.append(10)
    }
    try archive.write(to: file)
    let full = try readCommandOutput(records: records.reversed(), runtime: "command-check", processID: "first")
    precondition(full.stdout == "Typecheck passed\n" && full.stderr == "Warning: fixture\n")
    precondition(full.combined == "Typecheck passed\nWarning: fixture\n", "Full output must preserve sequence and not invent chunk separators")
    precondition(!full.earlierOutputOmitted)
    let disk = try Data(contentsOf: file)
    precondition(disk == archive, "Rendering must not rewrite archived bytes")

    let store = ActivityStore(home: root.appendingPathComponent("view-home"), startMonitoring: false)
    var visual = steps[0]
    visual.output = CapturedCommandOutput()
    visual.output.append(text: "> local-dev@0.3.0 check\n> tsc --noEmit && node --test\n\nTypeScript: no errors\n✓ handles split output chunks\n✓ keeps batch commands separate\n✓ preserves complete raw records\n\n60 tests passed\n", stream: "stdout", byteCount: 204)
    visual.output.append(text: "Notice: fixture-only rendering check\n", stream: "stderr", byteCount: 36)
    visual.startedAt = "2026-09-05T10:00:00.000Z"; visual.finishedAt = "2026-09-05T10:00:02.400Z"
    let view = NSHostingView(rootView: CommandCard(store: store, step: visual, runtime: "command-check").padding(18).frame(width: 750))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 750, height: 520), styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = view
    view.setFrameSize(NSSize(width: 750, height: 520)); view.layoutSubtreeIfNeeded()
    precondition(view.fittingSize.height > 180 && view.fittingSize.width <= 755, "A command/output panel must fit the timeline width")
    if let output = ProcessInfo.processInfo.environment["LOCAL_DEV_NATIVE_PREVIEW_DIR"] {
        let directory = URL(fileURLWithPath: output)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            view.appearance = NSAppearance(named: appearance)
            view.needsDisplay = true; view.layoutSubtreeIfNeeded()
            if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                guard let png = bitmap.representation(using: .png, properties: [:]) else { preconditionFailure("Native preview rendering failed") }
                try png.write(to: directory.appendingPathComponent("command-output-\(name).png"))
            } else { preconditionFailure("Native preview bitmap could not be created") }
        }
    }
    window.orderOut(nil)
    print("Command presentation checks passed: exact copy, script separation, ANSI/OSC decoding, CRLF, stream filters, per-command batches, original archive identity, and native rendering")
}
