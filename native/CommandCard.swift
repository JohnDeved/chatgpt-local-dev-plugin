import AppKit
import SwiftUI

/// A command and its own output stay together, including individual batch steps.
struct CommandCard: View {
    @ObservedObject var store: ActivityStore
    let step: TimelineStep
    let runtime: String
    var ordinal: String? = nil
    var inspectRaw: () -> Void = {}
    @State private var channel: OutputChannel = .all
    @State private var expandedOutput = false
    @State private var expandedScript = false
    @State private var wrapLines = true
    @State private var follow = true
    @State private var complete: CapturedCommandOutput?
    @State private var loading = false
    @State private var loadError: String?

    private var display: CommandDisplay { step.command }
    private var output: CapturedCommandOutput { expandedOutput ? (complete ?? step.output) : step.output }
    private var text: String { output.text(for: channel) }
    private var lines: Int { max(1, text.split(separator: "\n", omittingEmptySubsequences: false).count - (text.hasSuffix("\n") ? 1 : 0)) }
    private var loadKey: String { "\(expandedOutput):\(step.id):\(step.output.revision)" }
    private var statusColor: Color {
        if let code = step.exitCode { return code == 0 ? .green : .red }
        if step.signal != nil || step.state == "Stop not confirmed" { return .orange }
        return step.isRunning ? .blue : .secondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Image(systemName: "terminal").foregroundStyle(.secondary)
                Text(ordinal.map { "COMMAND \($0)" } ?? "COMMAND").font(.system(size: 9, weight: .semibold, design: .rounded)).tracking(0.8)
                Spacer()
                Button { copy(display.exact) } label: { Label("Copy command", systemImage: "doc.on.doc") }
                    .buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(.secondary)
                    .help("Copy the complete original invocation, including any inline script.")
            }.padding(.horizontal, 12).padding(.vertical, 9)
            HStack(alignment: .top, spacing: 9) {
                Text("$").foregroundStyle(.tint).font(.system(size: 12, weight: .semibold, design: .monospaced)).padding(.top, 2)
                Text(verbatim: display.invocation).font(.system(size: 12, weight: .medium, design: .monospaced))
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.horizontal, 12).padding(.bottom, 10)
            VStack(alignment: .leading, spacing: 4) {
                if display.executable != display.name {
                    Label { Text(verbatim: display.executable).textSelection(.enabled) } icon: { Image(systemName: "chevron.left.forwardslash.chevron.right") }
                }
                if !step.detail.isEmpty {
                    Label { Text(verbatim: step.detail).textSelection(.enabled) } icon: { Image(systemName: "folder") }
                }
            }.font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.bottom, 9)
            if let script = display.script {
                Divider()
                DisclosureGroup(isExpanded: $expandedScript) {
                    RawTextView(text: script, wrapLines: wrapLines)
                        .frame(height: min(260, max(70, CGFloat(script.split(separator: "\n").count) * 16 + 24)))
                        .clipShape(RoundedRectangle(cornerRadius: 5)).padding(.top, 6)
                } label: {
                    HStack {
                        Text("Inline script").font(.system(size: 11, weight: .medium))
                        Text("\(script.split(separator: "\n", omittingEmptySubsequences: false).count) lines").font(.system(size: 10)).foregroundStyle(.secondary)
                        Spacer()
                        Button { copy(script) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.plain).help("Copy the exact script source")
                    }
                }.padding(11)
            }
            Divider()
            HStack(spacing: 8) {
                Text("OUTPUT").font(.system(size: 9, weight: .semibold, design: .rounded)).tracking(0.8)
                if step.output.stderrBytes > 0 {
                    Text("stderr").font(.system(size: 9, weight: .medium)).foregroundStyle(.orange)
                        .padding(.horizontal, 5).padding(.vertical, 2).background(Color.orange.opacity(0.1), in: Capsule())
                }
                Spacer()
                Picker("Output stream", selection: $channel) {
                    ForEach(OutputChannel.allCases) { stream in Text(stream.rawValue).tag(stream) }
                }.pickerStyle(.segmented).frame(width: 178).controlSize(.mini)
                Button { wrapLines.toggle() } label: { Image(systemName: "arrow.turn.down.left") }
                    .buttonStyle(.plain).foregroundStyle(wrapLines ? Color.accentColor : .secondary)
                    .help(wrapLines ? "Disable line wrapping" : "Wrap long output lines")
                Button { follow.toggle() } label: { Image(systemName: "arrow.down.to.line") }
                    .buttonStyle(.plain).foregroundStyle(follow ? Color.accentColor : .secondary)
                    .help(follow ? "Stop following new output" : "Follow new output while at the bottom")
                Button { copy(text) } label: { Image(systemName: "doc.on.doc") }
                    .buttonStyle(.plain).disabled(text.isEmpty)
                    .help(output.earlierOutputOmitted ? "Copy displayed output. Expand to load the complete stream." : "Copy the complete displayed stream")
            }.padding(.horizontal, 12).padding(.vertical, 8)
            if text.isEmpty {
                HStack(spacing: 7) {
                    if step.isRunning { ProgressView().controlSize(.mini) }
                    Text(emptyMessage).font(.system(size: 11)).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            } else {
                RawTextView(text: text, wrapLines: wrapLines, followTail: follow)
                    .frame(height: expandedOutput ? 330 : min(190, max(48, CGFloat(lines) * 16 + 22)))
            }
            if let error = loadError {
                Label(error, systemImage: "exclamationmark.triangle").font(.system(size: 10)).foregroundStyle(.orange).padding(10)
            }
            HStack(spacing: 9) {
                if loading { ProgressView().controlSize(.mini) }
                Text(byteLabel).font(.system(size: 9)).foregroundStyle(.secondary)
                Spacer()
                if output.earlierOutputOmitted {
                    Text("Earlier output is in the archive").font(.system(size: 9)).foregroundStyle(.secondary)
                }
                Button(expandedOutput ? "Collapse output" : output.earlierOutputOmitted ? "Load full output" : "Expand output") { expandedOutput.toggle() }
                    .buttonStyle(.plain).font(.system(size: 10)).disabled(step.output.revision == 0)
                Button("Raw") { inspectRaw() }.buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(.secondary)
            }.padding(.horizontal, 12).padding(.vertical, 9)
            Divider()
            HStack(spacing: 8) {
                Image(systemName: step.exitCode == 0 ? "checkmark.circle" : step.exitCode != nil ? "xmark.circle" : "circle.dotted").foregroundStyle(statusColor)
                Text(step.state).foregroundStyle(statusColor)
                Spacer()
                if step.isRunning, let started = step.startedAt.flatMap(activityDate) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text("\(max(0, Int(context.date.timeIntervalSince(started))))s elapsed")
                    }
                } else { Text(step.duration) }
            }.font(.system(size: 10, weight: .medium, design: .monospaced)).padding(.horizontal, 12).padding(.vertical, 8)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.primary.opacity(0.1)))
        .task(id: loadKey) {
            guard expandedOutput, step.output.earlierOutputOmitted else {
                complete = nil; loading = false; return
            }
            loading = true; loadError = nil
            let records = store.records
            let processID = step.id
            let runtimeID = runtime
            do {
                try await Task.sleep(nanoseconds: 120_000_000)
                let loaded = try await Task.detached(priority: .userInitiated) {
                    try readCommandOutput(records: records, runtime: runtimeID, processID: processID)
                }.value
                guard !Task.isCancelled else { return }
                complete = loaded; loading = false
            } catch {
                guard !Task.isCancelled else { return }
                loadError = error.localizedDescription; loading = false
            }
        }
    }

    private var byteLabel: String {
        let count = output.byteCount(for: channel)
        let label = ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
        return label + (text.isEmpty ? "" : " · \(lines) displayed lines")
    }
    private var emptyMessage: String {
        if channel != .all && step.output.bytes > 0 { return "No \(channel.rawValue) output was captured." }
        if step.state == "Awaiting approval" { return "This command has not been approved or started." }
        if step.state == "Not started" || step.state == "Queued" { return "This command has not started." }
        if step.isRunning { return "Waiting for output…" }
        return "No text output was produced."
    }
    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}
