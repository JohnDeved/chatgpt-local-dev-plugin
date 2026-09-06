import Foundation

/// Presentation is derived from recorded facts, never from guessed assistant intent.
struct ToolPresentation {
    var title: String
    var subtitle: String
    var symbol: String
    var command: String?
    var input: String
    var argv: [String] = []
    var requestedCwd: String = ""
    var pendingCommands: [TimelineStep] = []

    static func make(tool: String, title: String? = nil, arguments: [String: Any]) -> ToolPresentation {
        let name = tool.split(separator: ".").last.map(String.init) ?? tool
        let path = arguments["relative_path"] as? String ?? arguments["path"] as? String ?? arguments["file_path"] as? String
        let target = path ?? arguments["query"] as? String ?? arguments["project"] as? String ?? ""
        var verb: String
        var symbol = "wrench.and.screwdriver"
        switch name {
        case "read_file": verb = "Read"; symbol = "doc.text"
        case "create_text_file", "write_file": verb = "Write"; symbol = "doc.badge.plus"
        case "replace_content", "replace_symbol_body", "insert_after_symbol", "insert_before_symbol": verb = "Edit"; symbol = "pencil.line"
        case "list_dir": verb = "List folder"; symbol = "folder"
        case "find_file": verb = "Find files"; symbol = "doc.text.magnifyingglass"
        case "find_symbol", "get_symbols_overview", "find_declaration", "find_referencing_symbols": verb = "Inspect code"; symbol = "curlybraces"
        case "search_for_pattern": verb = "Search code"; symbol = "magnifyingglass"
        case "activate_project", "open": verb = "Open project"; symbol = "folder.badge.gearshape"
        case "get_diagnostics_for_file": verb = "Check diagnostics"; symbol = "stethoscope"
        case "current", "get_current_config": verb = "Check project"; symbol = "folder"
        case "initial_instructions": verb = "Read tool instructions"; symbol = "text.book.closed"
        case "diff": verb = "Review changes"; symbol = "square.split.2x1"
        case "poll": verb = "Check running process"; symbol = "terminal"
        case "stop": verb = "Stop process"; symbol = "stop.circle"
        case "batch":
            verb = "Run \((arguments["steps"] as? [Any])?.count ?? 0) commands"; symbol = "terminal"
        default: verb = title ?? tool.replacingOccurrences(of: "_", with: " ")
        }
        var command: String?
        if let argv = arguments["argv"] as? [String], !argv.isEmpty {
            symbol = "terminal"
            command = shellDisplay(argv)
            let executable = URL(fileURLWithPath: argv[0]).lastPathComponent
            if CommandDisplay(argv: argv).script != nil {
                verb = "Run \(executable) script"
            } else {
                verb = "Run " + ([executable] + argv.dropFirst()).joined(separator: " ")
            }
        }
        if tool.contains("chrome") || name == "navigate" || name == "screenshot" {
            symbol = "globe"
            verb = arguments["title"] as? String ?? (name == "screenshot" ? "Capture browser screenshot" : name == "navigate" ? "Open page" : "Use browser")
        }
        var subtitle = target
        if let pattern = arguments["substring_pattern"] as? String { subtitle = pattern + (target.isEmpty ? "" : " · " + target) }
        if let symbolName = arguments["name_path_pattern"] as? String ?? arguments["name_path"] as? String {
            subtitle = symbolName + (target.isEmpty ? "" : " · " + target)
        }
        if let url = arguments["url"] as? String { subtitle = url }
        let titleTarget = path.map { URL(fileURLWithPath: $0).lastPathComponent } ?? target
        let appendTarget = command == nil && !titleTarget.isEmpty && !["search_for_pattern", "find_symbol", "find_referencing_symbols"].contains(name)
        let planned = (arguments["steps"] as? [[String: Any]] ?? []).enumerated().compactMap { index, value -> TimelineStep? in
            guard let argv = value["argv"] as? [String], !argv.isEmpty else { return nil }
            return TimelineStep(id: "queued-\(index)", title: shellDisplay(argv), detail: value["cwd"] as? String ?? "", state: "Queued", argv: argv)
        }
        return ToolPresentation(title: verb + (appendTarget ? " " + titleTarget : ""), subtitle: subtitle, symbol: symbol, command: command, input: readableInputs(arguments), argv: arguments["argv"] as? [String] ?? [], requestedCwd: arguments["cwd"] as? String ?? "", pendingCommands: planned)
    }
}

func shellDisplay(_ argv: [String]) -> String {
    argv.map { part in
        if !part.isEmpty && part.range(of: #"[^a-zA-Z0-9_./:=+@%,~-]"#, options: .regularExpression) == nil { return part }
        return "'" + part.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }.joined(separator: " ")
}

/// Human-readable values; the original JSON and byte records are always available separately.
func readableValue(_ value: Any, depth: Int = 0) -> String {
    guard depth < 8 else { return prettyJSON(value) }
    if let text = value as? String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if (trimmed.hasPrefix("{") || trimmed.hasPrefix("[")), let data = trimmed.data(using: .utf8),
           let nested = try? JSONSerialization.jsonObject(with: data) { return readableValue(nested, depth: depth + 1) }
        return text
    }
    if let values = value as? [String: Any] {
        if values.count == 1, let nested = values["result"] { return readableValue(nested, depth: depth + 1) }
        if let blocks = values["content"] as? [[String: Any]] {
            let hasRunReceipt = (values["_meta"] as? [String: Any])?["localDevRun"] != nil
            let visibleBlocks = hasRunReceipt ? Array(blocks.dropLast()) : blocks
            let texts = visibleBlocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            let structured = values["structuredContent"] as? [String: Any]
            if let data = structured?["data"] as? [String: Any] {
                if let output = data["outputTail"] as? String { return output }
                if let changes = data["changes"] { return readableValue(changes, depth: depth + 1) }
            }
            if !texts.isEmpty { return texts.map { readableValue($0, depth: depth + 1) }.joined(separator: "\n\n") }
            return "Returned \(blocks.count) content item\(blocks.count == 1 ? "" : "s"). Inspect original records for embedded media."
        }
        return values.keys.sorted().map { key in
            let label = key.replacingOccurrences(of: "_", with: " ")
            let content = readableValue(values[key]!, depth: depth + 1)
            return "\(label):\(content.contains("\n") ? "\n" : " ")\(content)"
        }.joined(separator: "\n\n")
    }
    if let values = value as? [Any] { return values.map { readableValue($0, depth: depth + 1) }.joined(separator: "\n") }
    if value is NSNull { return "None" }
    return String(describing: value)
}

func readableInputs(_ values: [String: Any]) -> String {
    var parts: [String] = []
    if let argv = values["argv"] as? [String] { parts.append("Command\n" + shellDisplay(argv)) }
    let labels = ["relative_path": "File", "cwd": "Working directory", "code": "Script", "content": "File contents", "needle": "Find", "repl": "Replacement", "body": "New code", "substring_pattern": "Search pattern", "name_path_pattern": "Symbol", "timeoutMs": "Timeout (milliseconds)"]
    for key in values.keys.sorted() where key != "argv" {
        parts.append((labels[key] ?? key.replacingOccurrences(of: "_", with: " ").capitalized) + "\n" + readableValue(values[key]!))
    }
    return parts.isEmpty ? "No arguments." : parts.joined(separator: "\n\n")
}

struct TimelineStep: Identifiable {
    var id: String
    var title: String
    var detail: String
    var state: String
    var argv: [String] = []
    var output = CapturedCommandOutput()
    var startedAt: String?
    var finishedAt: String?
    var exitCode: Int?
    var signal: String?

    var command: CommandDisplay { CommandDisplay(argv: argv) }
    var isRunning: Bool { state == "Running" || state == "Starting" }
    var duration: String {
        guard let start = startedAt.flatMap(activityDate), let end = finishedAt.flatMap(activityDate) else { return "" }
        return String(format: "%.1f s", max(0, end.timeIntervalSince(start)))
    }
}

struct ToolTimelineItem: Identifiable {
    var runtimeId: String
    var operationId: String
    var parentId: String?
    var runId: String? = nil
    var id: String { runtimeId + ":" + operationId }
    var tool: String
    var presentation: ToolPresentation
    var startedAt: String
    var finishedAt: String?
    var state = "requested"
    var approval: String?
    var outcome = ""
    var latestMessage = ""
    var outputPreview = ""
    var outputBytes = 0
    var eventCount = 0
    var steps: [TimelineStep] = []

    var active: Bool { ["requested", "waiting", "running", "stopping"].contains(state) }
    var statusLabel: String {
        switch state {
        case "waiting": return "Needs approval"
        case "requested": return "Received"
        case "running": return "Running"
        case "stopping": return "Stopping…"
        case "completed": return "Completed"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        case "denied": return "Denied"
        case "interrupted": return "Connection lost"
        default: return state.capitalized
        }
    }
    var duration: String {
        guard let start = activityDate(startedAt), let end = finishedAt.flatMap(activityDate) else { return "" }
        let seconds = max(0, end.timeIntervalSince(start))
        return seconds < 1 ? "\(Int(seconds * 1000)) ms" : String(format: "%.1f s", seconds)
    }
}

func activityDate(_ text: String) -> Date? {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.date(from: text)
}

/// Reduces many lifecycle/output events into one factual row per tool call.
struct TimelineIndex {
    private(set) var items: [String: ToolTimelineItem] = [:]

    mutating func accept(_ event: [String: Any]) {
        guard let runtime = event["runtimeId"] as? String, let type = event["type"] as? String,
              let timestamp = event["timestamp"] as? String else { return }
        if type == "runtime.closed" {
            for key in Array(items.keys) where items[key]?.runtimeId == runtime && items[key]?.active == true {
                items[key]?.state = "interrupted"; items[key]?.finishedAt = timestamp
            }
            return
        }
        guard let operation = event["operationId"] as? String else { return }
        let key = runtime + ":" + operation
        let detail = event["detail"] as? [String: Any] ?? [:]
        if type == "tool.requested" {
            let tool = detail["tool"] as? String ?? "Tool call"
            let args = detail["arguments"] as? [String: Any] ?? [:]
            items[key] = ToolTimelineItem(runtimeId: runtime, operationId: operation, parentId: event["parentId"] as? String, runId: event["runId"] as? String,
                tool: tool, presentation: .make(tool: tool, title: detail["title"] as? String, arguments: args), startedAt: timestamp)
        }
        guard var row = items[key] else { return }
        row.eventCount += 1
        switch type {
        case "approval.requested": row.state = "waiting"
        case "approval.accepted":
            switch detail["source"] as? String {
            case "auto-approve-all": row.approval = "Auto-approved"
            case "user": row.approval = "Approved by you"
            default: row.approval = "Read-only"
            }
        case "approval.denied": row.state = "denied"; row.outcome = "You denied this action. Nothing was dispatched."
        case "tool.started": row.state = "running"
        case "operation.stopRequested": row.state = "stopping"
        case "operation.progress", "downstream.progress": row.latestMessage = detail["message"] as? String ?? ""
        case "process.requested":
            guard let processID = detail["processId"] as? String else { break }
            let argv = detail["argv"] as? [String] ?? []
            row.steps.append(TimelineStep(id: processID, title: shellDisplay(argv), detail: detail["cwd"] as? String ?? "", state: "Starting", argv: argv))
        case "process.started":
            updateStep(&row, detail: detail, state: "Running", timestamp: timestamp)
        case "process.exited":
            let exit = detail["exitCode"] as? Int
            updateStep(&row, detail: detail, state: exit.map { "Exit \($0)" } ?? "Signal \(detail["signal"] as? String ?? "unknown")", timestamp: timestamp)
        case "process.stopUnconfirmed":
            updateStep(&row, detail: detail, state: "Stop not confirmed", timestamp: timestamp)
        case "process.output":
            row.outputBytes += detail["bytes"] as? Int ?? 0
            if let text = detail["text"] as? String {
                if let processID = detail["processId"] as? String, let step = row.steps.firstIndex(where: { $0.id == processID }) {
                    row.steps[step].output.append(text: text, stream: detail["stream"] as? String ?? "stdout", byteCount: detail["bytes"] as? Int ?? 0)
                    row.outputPreview = row.steps[step].output.combined
                } else {
                    // Older incomplete records remain inspectable; never attach them to a guessed command.
                    row.outputPreview = String((row.outputPreview + text).suffix(1600))
                }
            }
        case "tool.result":
            let result = detail["result"] as? [String: Any] ?? [:]
            let structured = result["structuredContent"] as? [String: Any] ?? [:]
            let data = structured["data"] as? [String: Any] ?? [:]
            if let error = structured["error"] as? [String: Any] {
                row.outcome = error["message"] as? String ?? "The tool reported an error."
            } else if let code = data["exitCode"] as? Int {
                row.outcome = "Exited with code \(code)"
            } else if data["background"] as? Bool == true {
                row.outcome = "Started background process \(data["pid"] as? Int ?? 0)"
            } else {
                let text = readableValue(result)
                row.outcome = String(text.split(separator: "\n", omittingEmptySubsequences: true).first?.prefix(220) ?? "")
            }
        case "tool.completed": row.state = "completed"; row.finishedAt = timestamp
        case "tool.cancelled": row.state = "cancelled"; row.finishedAt = timestamp
        case "tool.failed":
            if row.state != "denied" { row.state = "failed" }
            row.finishedAt = timestamp
            if let error = detail["error"] as? [String: Any], let message = error["message"] as? String {
                row.outcome = failureDescription(message)
            }
        default: break
        }
        items[key] = row
    }

    private func updateStep(_ row: inout ToolTimelineItem, detail: [String: Any], state: String, timestamp: String) {
        guard let id = detail["processId"] as? String, let index = row.steps.firstIndex(where: { $0.id == id }) else { return }
        row.steps[index].state = state
        if state == "Running" { row.steps[index].startedAt = timestamp }
        else if detail["exitCode"] != nil || detail["signal"] != nil {
            row.steps[index].finishedAt = timestamp
            row.steps[index].exitCode = detail["exitCode"] as? Int
            row.steps[index].signal = detail["signal"] as? String
        }
    }

    var ordered: [ToolTimelineItem] { items.values.sorted { $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt } }
}

func failureDescription(_ code: String) -> String {
    switch code {
    case "APPROVAL_DENIED": return "You denied this action. Nothing was dispatched."
    case "APPROVAL_TIMED_OUT": return "The approval request expired before it was accepted."
    case "ADMISSION_PAUSED": return "New actions are paused. This tool was not dispatched."
    case "OPERATION_CANCELLED": return "The operation was cancelled."
    case "COMMAND_STOP_UNCONFIRMED": return "A stop was requested, but termination could not be confirmed."
    default: return code
    }
}
