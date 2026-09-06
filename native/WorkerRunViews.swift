import AppKit
import SwiftUI

struct WorkerRunCard: View {
    @ObservedObject var store: ActivityStore
    let run: WorkerRunItem
    let calls: [ToolTimelineItem]
    let inspect: (InspectorSelection, String) -> Void
    @State private var expanded: Bool?
    @State private var allSteps = false
    @State private var allNotes = false
    @State private var allSteering = false

    private var isExpanded: Bool { expanded ?? run.active }
    private var roots: [ToolTimelineItem] {
        let ids = Set(calls.map(\.operationId))
        return calls.filter { $0.parentId.map { !ids.contains($0) } ?? true }
    }
    private var busy: Bool { calls.contains { $0.active && $0.state != "interrupted" } }
    private var waiting: [ToolTimelineItem] { calls.filter { $0.state == "waiting" } }
    private var shownSteps: [ToolTimelineItem] {
        if allSteps { return roots }
        let recent = Set(roots.suffix(run.active ? 4 : 6).map(\.id))
        let waitingParents = Set(waiting.compactMap(\.parentId))
        return roots.filter { recent.contains($0.id) || $0.state == "waiting" || waitingParents.contains($0.operationId) }
    }
    private var color: Color { run.state == "completed" ? .green : run.state == "failed" ? .red : run.state == "interrupted" ? .orange : .accentColor }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded = !isExpanded } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: run.state == "completed" ? "checkmark.circle.fill" : run.state == "failed" ? "xmark.circle.fill" : "play.circle")
                        .font(.system(size: 20)).foregroundStyle(color)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 7) {
                            Text("CHATGPT RUN").font(.system(size: 9, weight: .semibold, design: .rounded)).tracking(1)
                            Text("· \(roots.count) steps").font(.system(size: 10)).foregroundStyle(.secondary)
                            if !waiting.isEmpty { Text("· \(waiting.count) awaiting approval").font(.system(size: 10)).foregroundStyle(.orange) }
                            Spacer()
                            if !run.elapsed.isEmpty { Text(run.elapsed).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary) }
                        }
                        Text(verbatim: run.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.primary).lineLimit(isExpanded ? nil : 2).multilineTextAlignment(.leading)
                    }
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).padding(.top, 3)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).padding(16)
            VStack(alignment: .leading, spacing: 12) {
                if let goal = run.goal, goal != run.title || isExpanded {
                    HStack(alignment: .top, spacing: 9) {
                        Text("GOAL").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary).padding(.top, 3)
                        Text(verbatim: goal).font(.system(size: 12)).textSelection(.enabled).lineLimit(isExpanded ? nil : 2)
                    }
                } else if run.goal == nil {
                    Text("Goal not reported by ChatGPT yet. Tool activity is still recorded.").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                marker("START", timestamp: run.startedAt, detail: run.origin == "assistant" ? "Run declared by ChatGPT" : "First local tool observed")
                if let summary = run.summary, !run.active {
                    Text(verbatim: summary).font(.system(size: 12)).textSelection(.enabled).lineLimit(isExpanded ? nil : 3)
                }
                if isExpanded {
                    if let last = run.notes.last {
                        VStack(alignment: .leading, spacing: 7) {
                            Label(last.label, systemImage: last.kind == "decision" ? "lightbulb" : "text.bubble").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                            Text(verbatim: last.text).font(.system(size: 12)).textSelection(.enabled)
                            if run.notes.count > 1 {
                                DisclosureGroup("\(run.notes.count - 1) earlier updates", isExpanded: $allNotes) {
                                    ForEach(run.notes.dropLast()) { note in
                                        VStack(alignment: .leading, spacing: 5) {
                                            HStack { Text(note.label).fontWeight(.medium); Spacer(); time(note.timestamp) }.font(.system(size: 10)).foregroundStyle(.secondary)
                                            Text(verbatim: note.text).font(.system(size: 11)).textSelection(.enabled)
                                        }.padding(.vertical, 6)
                                    }
                                }.font(.system(size: 10)).padding(.top, 3)
                            }
                        }.padding(12).background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 8))
                    } else {
                        Text("No public plan or progress summary has been reported. Private model thinking is not available through this connection.")
                            .font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                    if roots.count > (run.active ? 4 : 6) && !allSteps {
                        Button("Show all \(roots.count) steps · latest \(run.active ? 4 : 6) below") { allSteps = true }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.tint)
                    }
                    ForEach(shownSteps) { call in
                        ToolCallRow(store: store, row: call, children: calls.filter { $0.parentId == call.operationId }, inspect: inspect)
                    }
                    if allSteps && roots.count > 6 {
                        Button("Show fewer steps") { allSteps = false }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    if !run.steering.isEmpty {
                        VStack(alignment: .leading, spacing: 9) {
                            HStack {
                                Label("Your steering", systemImage: "arrow.triangle.turn.up.right.diamond").font(.system(size: 11, weight: .medium))
                                Spacer()
                                if run.steering.count > 3 { Button(allSteering ? "Show less" : "Show all \(run.steering.count)") { allSteering.toggle() }.buttonStyle(.plain).font(.system(size: 10)) }
                            }
                            ForEach(allSteering ? run.steering : Array(run.steering.suffix(3))) { message in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(verbatim: message.text).font(.system(size: 12)).textSelection(.enabled)
                                    Text(message.label).font(.system(size: 10)).foregroundStyle(message.state == "acknowledged" ? .green : .orange)
                                    if let response = message.response {
                                        Text("ChatGPT: " + response).font(.system(size: 11)).foregroundStyle(.secondary).textSelection(.enabled)
                                    }
                                }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Color.accentColor.opacity(0.045), in: RoundedRectangle(cornerRadius: 7))
                            }
                        }
                    }
                    if run.contextScope == "runtime" {
                        Text("The client did not supply a conversation identifier. Attribution is limited to this local runtime; separate concurrent chats cannot be identified reliably.").font(.system(size: 9)).foregroundStyle(.tertiary)
                    }
                }
                if run.active {
                    HStack(spacing: 8) {
                        Circle().fill(run.connected ? Color.accentColor : .orange).frame(width: 6, height: 6)
                        Text(run.connected ? (busy ? "Working · end not yet reported" : "Waiting for the next tool call · end not reported") : "Connection lost · end not reported")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                        Spacer()
                        if run.connected {
                            Button(store.steeringTarget == run.id ? "Steering this run" : "Steer this run") { store.steeringTarget = run.id }
                                .buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(.tint)
                        }
                    }
                } else {
                    marker(run.state == "interrupted" ? "INTERRUPTED" : "END", timestamp: run.endedAt ?? "", detail: run.completionLabel)
                    if run.state != "interrupted" { Text("Outcome reported by ChatGPT, not inferred from idle time.").font(.system(size: 9)).foregroundStyle(.tertiary) }
                    if run.backgroundProcesses > 0 { Text("\(run.backgroundProcesses) background process(es) remained running when this run ended. See Processes.").font(.system(size: 10)).foregroundStyle(.secondary) }
                }
            }.padding(.horizontal, 16).padding(.bottom, 16)
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.09)))
        .padding(.bottom, 16)
    }

    private func marker(_ label: String, timestamp: String, detail: String) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 9, weight: .bold, design: .rounded)).tracking(0.5).foregroundStyle(label == "END" ? color : .secondary)
            Rectangle().fill(Color.primary.opacity(0.08)).frame(height: 1)
            Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
            time(timestamp)
        }
    }
    private func time(_ stamp: String) -> some View {
        Group {
            if let date = activityDate(stamp) { Text(date, style: .time).font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary) }
        }
    }
}

struct SteeringComposer: View {
    @ObservedObject var store: ActivityStore
    private var selected: WorkerRunItem? { store.activeRuns.first { $0.id == store.steeringTarget } }
    private var canSend: Bool { selected != nil && !store.steeringDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.steeringDraft.utf16.count <= 4000 && !store.sendingSteering }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.turn.up.right.diamond").foregroundStyle(.secondary)
                Text("Steer the run").font(.system(size: 11, weight: .semibold))
                Spacer()
                if !store.activeRuns.isEmpty {
                    Picker("Target run", selection: $store.steeringTarget) {
                        Text("Choose run").tag(String?.none)
                        ForEach(store.activeRuns) { run in Text(run.title).lineLimit(1).tag(Optional(run.id)) }
                    }.labelsHidden().frame(maxWidth: 340).controlSize(.small)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Adjust the goal or next step…", text: $store.steeringDraft, axis: .vertical)
                    .lineLimit(1...3).textFieldStyle(.plain).font(.system(size: 12)).padding(10)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.12)))
                Button { store.sendSteering() } label: {
                    Label(store.sendingSteering ? "Queuing…" : "Send", systemImage: "arrow.up")
                }.buttonStyle(.borderedProminent).controlSize(.small).disabled(!canSend)
                if selected == nil && !store.steeringDraft.isEmpty {
                    Button("Copy") {
                        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(store.steeringDraft, forType: .string)
                    }.controlSize(.small).help("Copy this instruction into ChatGPT when no active run can receive it.")
                }
            }
            Text(footer).font(.system(size: 9)).foregroundStyle(store.steeringDraft.utf16.count > 4000 ? .orange : .secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(.horizontal, 22).padding(.vertical, 12).background(Color.primary.opacity(0.018))
    }
    private var footer: String {
        if store.steeringDraft.utf16.count > 4000 { return "Keep steering under 4,000 characters; your draft has not been sent." }
        if let notice = store.steeringNotice { return notice }
        if !store.runReportingAvailable && !store.connected.isEmpty { return "Reconnect the updated runtime to enable runs and steering. Existing activity remains readable." }
        if selected == nil { return "Steering needs a connected, open run. It cannot start a new ChatGPT response or wake a finished chat." }
        return "Sent with the next tool response—not an instant chat message. New actions wait for acknowledgement; already-running work is not undone."
    }
}
