import AppKit
import SwiftUI

struct RawTextView: NSViewRepresentable {
    let text: String
    var wrapLines = true
    var followTail = false

    final class Coordinator {
        var previousWrap: Bool?
        var firstDisplay = true
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        let view = NSTextView()
        view.isEditable = false; view.isSelectable = true; view.isRichText = false
        view.isAutomaticLinkDetectionEnabled = false
        view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 2
        view.defaultParagraphStyle = paragraph
        view.textColor = .labelColor; view.backgroundColor = .textBackgroundColor
        view.textContainerInset = NSSize(width: 12, height: 10)
        view.isVerticallyResizable = true
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = view
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        let changed = view.string != text
        let wrapChanged = context.coordinator.previousWrap != wrapLines
        guard changed || wrapChanged else { return }
        let selected = view.selectedRanges
        let position = scroll.contentView.bounds.origin
        let wasAtBottom = scroll.contentView.bounds.maxY >= view.bounds.height - 28
        let mayFollow = followTail && (context.coordinator.firstDisplay || wasAtBottom) && view.selectedRange().length == 0
        context.coordinator.previousWrap = wrapLines
        scroll.hasHorizontalScroller = !wrapLines
        view.isHorizontallyResizable = !wrapLines
        view.autoresizingMask = wrapLines ? [.width] : []
        view.textContainer?.widthTracksTextView = wrapLines
        let width = max(100, scroll.contentSize.width)
        view.textContainer?.containerSize = NSSize(width: wrapLines ? max(1, width - 24) : .greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        view.setFrameSize(NSSize(width: width, height: max(1, scroll.contentSize.height)))
        if changed { view.string = text }
        view.sizeToFit()
        if wrapLines { view.setFrameSize(NSSize(width: width, height: max(scroll.contentSize.height, view.frame.height))) }
        if !context.coordinator.firstDisplay && selected.allSatisfy({ $0.rangeValue.location + $0.rangeValue.length <= (text as NSString).length }) { view.selectedRanges = selected }
        if mayFollow { view.scrollRangeToVisible(NSRange(location: (text as NSString).length, length: 0)) }
        else { scroll.contentView.scroll(to: position); scroll.reflectScrolledClipView(scroll.contentView) }
        context.coordinator.firstDisplay = false
    }
}

struct StatusPill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text).font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.1), in: Capsule()).foregroundStyle(color)
    }
}

struct ActivityPanel: View {
    @ObservedObject var store: ActivityStore
    @State private var showStopConfirmation = false
    @State private var showInspector = false
    @State private var showConnectionDetails = false
    @State private var showDiagnostics = false
    @State private var followLatest = true
    @State private var historyLimit = 100

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let error = store.lastError {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(error).font(.system(size: 11)).lineLimit(4).textSelection(.enabled)
                    Spacer()
                    Button { store.lastError = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                }.padding(12).background(Color.orange.opacity(0.07))
            }
            if store.autoApprove {
                HStack(spacing: 8) {
                    Image(systemName: "bolt.shield.fill").foregroundStyle(.orange)
                    Text(store.policyPending ? "Auto-approve selected · waiting to apply" : "Auto-approve all is on").fontWeight(.medium)
                    Spacer()
                    Button("Turn off") { store.setPolicy(auto: false, remember: store.remember) }.buttonStyle(.plain).foregroundStyle(.secondary)
                }.font(.system(size: 11)).padding(.horizontal, 22).padding(.vertical, 9).background(Color.orange.opacity(0.06))
            }
            HStack(spacing: 18) {
                ForEach(["Timeline", "Processes", "Settings"], id: \.self) { section in
                    Button { store.section = section } label: {
                        VStack(spacing: 9) {
                            Text(section).font(.system(size: 12, weight: store.section == section ? .semibold : .regular))
                                .foregroundStyle(store.section == section ? .primary : .secondary)
                            Rectangle().fill(store.section == section ? Color.accentColor : .clear).frame(height: 2)
                        }.padding(.top, 14)
                    }.buttonStyle(.plain)
                }
                Spacer()
                if !store.pending.isEmpty { StatusPill(text: "\(store.pending.count) awaiting approval", color: .orange) }
            }.padding(.horizontal, 24)
            Divider()
            if store.section == "Settings" { settings }
            else if store.section == "Processes" { processList }
            else { timeline }
            Divider()
            footer
        }
        .frame(width: 820, height: 730)
        .background(.background)
        .sheet(isPresented: $showInspector) { inspector }
        .sheet(isPresented: $showConnectionDetails) { connectionDetails }
        .sheet(isPresented: $showDiagnostics) { diagnosticEvents }
        .alert("Stop all Local Dev work?", isPresented: $showStopConfirmation) {
            Button("Stop All Work", role: .destructive) { store.send("stopAll") }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("New actions will be paused. Local Dev will request cancellation of its operations and termination of its owned process groups. Unrelated user processes are not targeted.")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "terminal").font(.system(size: 22, weight: .medium)).foregroundStyle(.primary)
                .frame(width: 38, height: 38).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text("Local Dev").font(.system(size: 16, weight: .semibold))
                HStack(spacing: 5) {
                    Circle().fill(store.connected.isEmpty ? Color.orange : .green).frame(width: 5, height: 5)
                    Text(store.status).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if store.needsReview {
                Button { store.reviewFailure(); showInspector = true } label: { Label("Review failure", systemImage: "exclamationmark.circle") }.controlSize(.small)
            }
            Button { store.setPaused(!store.paused) } label: {
                Label(store.paused ? "Resume" : "Pause", systemImage: store.paused ? "play" : "pause")
            }.help("Pause new actions without suspending existing processes.")
            Button { showStopConfirmation = true } label: { Image(systemName: "stop") }
                .disabled(store.connected.isEmpty).help("Stop all Local Dev work")
        }.padding(.horizontal, 22).padding(.vertical, 15)
    }

    private var connectionCard: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: store.reconnecting ? "arrow.triangle.2.circlepath" : "cable.connector")
                .font(.system(size: 20)).foregroundStyle(.orange).padding(.top, 3)
            VStack(alignment: .leading, spacing: 7) {
                Text(store.connectionHealth.title).font(.system(size: 13, weight: .semibold))
                Text(store.connectionHealth.explanation).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    if store.connectionHealth.configured {
                        Button(store.reconnecting ? "Connecting…" : store.connectionHealth.running ? "Reconnect updated runtime…" : "Connect runtime…") { store.requestReconnect() }
                            .buttonStyle(.borderedProminent).controlSize(.small).disabled(store.reconnecting)
                    }
                    Button("Check again") { store.inspectConnection() }.buttonStyle(.plain).controlSize(.small).disabled(store.reconnecting)
                    Button("Connection details") { showConnectionDetails = true }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
                if store.connectionHealth.running {
                    Text("Reconnecting may stop commands managed by the old runtime. You will be asked to confirm.")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }.padding(16).background(Color.orange.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.orange.opacity(0.15)))
    }

    private var timeline: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.tertiary)
                TextField("Search runs, goals, files, or commands", text: $store.search).textFieldStyle(.plain).font(.system(size: 12))
                Spacer()
                if store.loadingArchive { ProgressView().controlSize(.mini) }
                Toggle("Follow latest", isOn: $followLatest).toggleStyle(.checkbox).font(.system(size: 10)).foregroundStyle(.secondary)
            }.padding(.horizontal, 24).padding(.vertical, 12)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    let rows = store.timelineRows
                    let query = store.search
                    let runs = store.workerRuns.filter { run in
                        query.isEmpty || "\(run.title) \(run.goal ?? "") \(run.summary ?? "")".localizedCaseInsensitiveContains(query)
                            || rows.contains { $0.runId == run.runId && "\($0.presentation.title) \($0.presentation.subtitle) \($0.presentation.command ?? "")".localizedCaseInsensitiveContains(query) }
                    }
                    let ungrouped = rows.filter { $0.runId == nil && (query.isEmpty || "\($0.presentation.title) \($0.presentation.subtitle)".localizedCaseInsensitiveContains(query)) }
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if store.connected.isEmpty { connectionCard.padding(.bottom, 18) }
                        if !store.connected.isEmpty && !store.runReportingAvailable {
                            HStack(alignment: .top) {
                                Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.orange)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("Run reporting needs the updated runtime").font(.system(size: 12, weight: .medium))
                                    Text("Reconnect to enable goals, explicit run endings, and steering. This may interrupt managed commands.").font(.system(size: 11)).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Reconnect…") { store.requestReconnect() }.controlSize(.small)
                            }.padding(12).background(Color.orange.opacity(0.05), in: RoundedRectangle(cornerRadius: 9)).padding(.bottom, 18)
                        }
                        if !ungrouped.isEmpty {
                            DisclosureGroup("Earlier ungrouped activity · \(ungrouped.count) calls") {
                                Text("These calls predate run reporting. No goal, start-of-request, or completed-run boundary can be inferred reliably.")
                                    .font(.system(size: 10)).foregroundStyle(.secondary).padding(.vertical, 10)
                                ForEach(Array(ungrouped.suffix(historyLimit))) { call in
                                    ToolCallRow(store: store, row: call, children: ungrouped.filter { $0.parentId == call.operationId }) { selection, mode in
                                        store.inspectorMode = mode; store.selection = selection; showInspector = true
                                    }
                                }
                                if ungrouped.count > historyLimit { Button("Show earlier calls") { historyLimit += 100 }.font(.caption) }
                            }.font(.system(size: 11)).padding(.bottom, 18)
                        }
                        if runs.isEmpty && ungrouped.isEmpty {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(query.isEmpty ? "The next run starts here" : "No matching runs").font(.system(size: 14, weight: .medium))
                                Text("Each run has a goal, a clear start, expandable steps, public updates, and an explicitly reported ending.")
                                    .font(.system(size: 12)).foregroundStyle(.secondary)
                            }.padding(.vertical, 24)
                        }
                        if runs.count > historyLimit { Button("Show earlier runs") { historyLimit += 100 }.padding(.bottom, 12) }
                        ForEach(Array(runs.suffix(historyLimit))) { run in
                            WorkerRunCard(store: store, run: run, calls: rows.filter { $0.runtimeId == run.runtimeId && $0.runId == run.runId }) { selection, mode in
                                store.inspectorMode = mode; store.selection = selection; showInspector = true
                            }.id(run.id)
                        }
                        Color.clear.frame(height: 1).id("timeline-end")
                    }.padding(.horizontal, 20).padding(.vertical, 16)
                }
                .onChange(of: store.historyRuns.count) { _ in
                    if followLatest && !store.historyRuns.isEmpty { proxy.scrollTo("timeline-end", anchor: .bottom) }
                }
            }
            Divider()
            SteeringComposer(store: store)
        }
    }

    private var processList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if store.connected.isEmpty { connectionCard }
                Text("Background processes").font(.system(size: 18, weight: .semibold))
                Text("A tool call can finish while its development server stays running. These are tracked separately.").font(.system(size: 12)).foregroundStyle(.secondary)
                if store.processes.isEmpty { Text("No processes are tracked by a connected runtime.").font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 20) }
                ForEach(store.processes) { process in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Image(systemName: "terminal").foregroundStyle(.green)
                            Text(process.argv.first.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Process").fontWeight(.medium)
                            Spacer()
                            Text("PID \(process.pid)").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                            Button("Stop") { store.send("stopProcess", runtime: process.runtimeId, values: ["processId": process.id]) }.controlSize(.small)
                        }
                        Text(shellDisplay(process.argv)).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                        Text(process.cwd).font(.system(size: 11)).foregroundStyle(.secondary).textSelection(.enabled)
                        Button("View output") {
                            store.inspectorMode = "Output"; store.selection = .process(runtime: process.runtimeId, id: process.id); showInspector = true
                        }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.tint)
                    }.padding(16).background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10))
                }
            }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var settings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("You're in control").font(.system(size: 22, weight: .semibold))
                VStack(alignment: .leading, spacing: 13) {
                    Toggle(isOn: Binding(get: { store.autoApprove }, set: { value in
                        if value { store.confirmAutoApproval() } else { store.setPolicy(auto: false, remember: store.remember) }
                    })) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Auto-approve all").font(.system(size: 14, weight: .medium))
                            Text("Run supported actions without asking each time.").font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    }.toggleStyle(.switch)
                    Text("Includes commands, file edits, deletions, and supported downstream approvals. Activity remains visible. Pause still blocks new actions; macOS permissions are unchanged.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Divider()
                    Toggle("Remember across restarts", isOn: Binding(get: { store.remember }, set: { store.setPolicy(auto: store.autoApprove, remember: $0) })).toggleStyle(.checkbox)
                    Text(store.policyPending ? "Your choice is queued and will apply when the runtime connects. You do not need to enable Remember to choose session-only auto-approval." : "Without Remember, auto-approval lasts only for this app session. You can choose it even while disconnected.")
                        .font(.system(size: 11)).foregroundStyle(store.policyPending ? .orange : .secondary)
                }.padding(18).background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 10) {
                    Text("Connection").font(.system(size: 14, weight: .medium))
                    if store.connected.isEmpty { connectionCard }
                    else {
                        Text("\(store.connected.count) runtime\(store.connected.count == 1 ? "" : "s") connected to the activity stream.").font(.system(size: 12)).foregroundStyle(.secondary)
                        HStack {
                            Button("Reconnect runtime…") { store.requestReconnect() }
                            Button("Connection details") { showConnectionDetails = true }
                        }
                    }
                }
                Divider()
                Toggle("Launch Local Dev at login", isOn: Binding(get: { store.launchAtLogin }, set: { store.setLaunchAtLogin($0) })).toggleStyle(.switch)
                Text("Closing the panel keeps the menu-bar app running. Quitting first pauses admission of new actions.").font(.system(size: 11)).foregroundStyle(.secondary)
                Divider()
                VStack(alignment: .leading, spacing: 9) {
                    Text("Full records stay on your Mac").font(.system(size: 14, weight: .medium))
                    Text("The timeline summarizes recorded facts; nothing is removed from the original archive. Exact inputs, outputs, environment values, and diagnostics remain unmasked and may contain secrets. There is no automatic upload or archive deletion.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Text(store.directory.path).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                    HStack {
                        Button("Open archive") { store.revealArchive() }
                        Button("Diagnostic event log") { showDiagnostics = true }
                    }.controlSize(.small)
                    Text("Internal work that a downstream tool does not report is not independently observed. The local control socket is not a sandbox against other programs running as your user.")
                        .font(.system(size: 10)).foregroundStyle(.tertiary)
                }
            }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var inspector: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Tool call details").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(store.inspectorText, forType: .string) } label: { Image(systemName: "doc.on.doc") }.help("Copy the complete view")
                Button { store.exportInspection() } label: { Image(systemName: "square.and.arrow.up") }
                Button("Done") { showInspector = false }.keyboardShortcut(.cancelAction)
            }.padding(16)
            Picker("View", selection: $store.inspectorMode) {
                Text("Readable details").tag("Readable")
                Text("Full output").tag("Output")
                Text("Original JSON").tag("Raw events")
            }.pickerStyle(.segmented).padding(.horizontal, 16).padding(.bottom, 12)
            if !store.inspectorImages.isEmpty && store.inspectorMode != "Raw events" {
                ScrollView(.horizontal) {
                    HStack { ForEach(Array(store.inspectorImages.enumerated()), id: \.offset) { _, image in Image(nsImage: image).resizable().scaledToFit().frame(height: 140) } }.padding(10)
                }.frame(height: 155)
            }
            Divider()
            RawTextView(text: store.inspectorText)
            Divider()
            Text("Complete captured records · Local only · No masking").font(.system(size: 10)).foregroundStyle(.secondary).padding(10)
        }.frame(width: 750, height: 610)
    }

    private var connectionDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Connection details").font(.headline)
                Spacer()
                Button("Done") { showConnectionDetails = false }
            }
            Text(store.connectionHealth.explanation).font(.system(size: 12)).foregroundStyle(.secondary)
            RawTextView(text: store.connectionHealth.transcript.isEmpty ? "No tunnel-management command has returned yet." : store.connectionHealth.transcript)
        }.padding(18).frame(width: 750, height: 520)
    }

    private var diagnosticEvents: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Diagnostic event log").font(.headline)
                Spacer()
                Button("Done") { showDiagnostics = false }
            }.padding(16)
            Text("Low-level events are retained here, separate from the readable tool-call timeline.").font(.caption).foregroundStyle(.secondary).padding(.bottom, 12)
            List(store.records.reversed()) { record in
                Button {
                    store.selection = .record(record.id); store.inspectorMode = "Raw events"
                    showDiagnostics = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { showInspector = true }
                } label: {
                    HStack {
                        Text(record.timestamp).foregroundStyle(.secondary)
                        Text(record.type)
                        Spacer()
                        Text(record.label).lineLimit(1)
                    }.font(.system(size: 10, design: .monospaced))
                }.buttonStyle(.plain)
            }
        }.frame(width: 760, height: 560)
    }

    private var footer: some View {
        HStack {
            Image(systemName: "lock.shield").foregroundStyle(.secondary)
            Text("Private local activity").font(.system(size: 10)).foregroundStyle(.secondary)
            Spacer()
            Text("\(store.history.count) tool calls").font(.system(size: 10)).foregroundStyle(.tertiary)
            Button("Archive") { store.revealArchive() }.buttonStyle(.plain).font(.system(size: 10)).padding(.leading, 10)
            Button("Quit…") { store.requestQuit() }.buttonStyle(.plain).font(.system(size: 10)).padding(.leading, 10)
        }.padding(.horizontal, 22).padding(.vertical, 10)
    }
}

struct ToolCallRow: View {
    @ObservedObject var store: ActivityStore
    let row: ToolTimelineItem
    let children: [ToolTimelineItem]
    let inspect: (InspectorSelection, String) -> Void
    @State private var expanded = false
    @State private var showInputs = false

    private var color: Color {
        switch row.state {
        case "failed": return .red
        case "waiting", "denied", "interrupted": return .orange
        case "completed": return .green
        case "running", "stopping": return .blue
        default: return .secondary
        }
    }
    private var selection: InspectorSelection { .operation(runtime: row.runtimeId, id: row.operationId) }
    private var commandSteps: [TimelineStep] {
        var steps = row.steps
        let pendingState = row.state == "waiting" ? "Awaiting approval" : row.active ? "Queued" : "Not started"
        if !row.presentation.pendingCommands.isEmpty {
            steps += row.presentation.pendingCommands.dropFirst(steps.count).map { value in
                var pending = value; pending.state = pendingState; return pending
            }
        } else if steps.isEmpty && !row.presentation.argv.isEmpty {
            steps = [TimelineStep(id: "pending-\(row.operationId)", title: row.presentation.command ?? "", detail: row.presentation.requestedCwd,
                state: pendingState, argv: row.presentation.argv)]
        }
        if row.state == "interrupted" {
            steps = steps.map { value in
                var step = value
                if step.isRunning { step.state = "Connection lost · last known running" }
                return step
            }
        }
        return steps
    }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                Image(systemName: row.state == "completed" ? "checkmark" : row.state == "failed" ? "xmark" : row.presentation.symbol)
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(color)
                    .frame(width: 28, height: 28).background(color.opacity(0.07), in: Circle())
                Rectangle().fill(Color.primary.opacity(0.08)).frame(width: 1).frame(maxHeight: .infinity).padding(.top, 5)
            }.frame(width: 28)
            VStack(alignment: .leading, spacing: 9) {
                Button { expanded.toggle() } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(row.presentation.title).font(.system(size: 13, weight: .medium)).foregroundStyle(.primary).lineLimit(2).multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        if row.active { elapsed }
                        else { Text(row.duration).font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary) }
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain)
                if !row.presentation.subtitle.isEmpty {
                    Text(row.presentation.subtitle).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(expanded ? nil : 1).textSelection(.enabled)
                }
                HStack(spacing: 9) {
                    Text(row.statusLabel).foregroundStyle(color)
                    if let approval = row.approval { Text("·").foregroundStyle(.tertiary); Text(approval).foregroundStyle(.secondary) }
                    if !children.isEmpty { Text("· \(children.count) nested calls").foregroundStyle(.secondary) }
                    Spacer()
                    if let date = activityDate(row.startedAt) { Text(date, style: .time).foregroundStyle(.tertiary) }
                }.font(.system(size: 10))
                if !row.outcome.isEmpty && (row.state == "failed" || row.state == "denied" || row.presentation.command != nil) {
                    Text(row.outcome).font(.system(size: 11)).foregroundStyle(row.state == "failed" ? .red : .secondary).lineLimit(expanded ? nil : 2).textSelection(.enabled)
                }
                if row.state == "waiting" {
                    HStack(spacing: 10) {
                        Button("Approve") { store.send("approve", runtime: row.runtimeId, values: ["operationId": row.operationId]) }.buttonStyle(.borderedProminent).disabled(store.paused)
                        Button("Deny") { store.send("deny", runtime: row.runtimeId, values: ["operationId": row.operationId]) }
                        Button("Inspect action") { expanded = true; showInputs = true }.buttonStyle(.plain).foregroundStyle(.secondary)
                    }.controlSize(.small)
                }
                ForEach(children.filter { $0.state == "waiting" }) { child in
                    HStack(spacing: 9) {
                        Image(systemName: "hand.raised").foregroundStyle(.orange)
                        Text(child.presentation.title).font(.system(size: 11)).lineLimit(2)
                        Spacer()
                        Button("Approve") { store.send("approve", runtime: child.runtimeId, values: ["operationId": child.operationId]) }.disabled(store.paused)
                        Button("Deny") { store.send("deny", runtime: child.runtimeId, values: ["operationId": child.operationId]) }
                    }.controlSize(.small).padding(9).background(Color.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
                }
                if expanded {
                    ForEach(Array(commandSteps.enumerated()), id: \.element.id) { index, step in
                        CommandCard(store: store, step: step, runtime: row.runtimeId, ordinal: commandSteps.count > 1 ? "\(index + 1) / \(commandSteps.count)" : nil) {
                            if row.steps.contains(where: { $0.id == step.id }) { inspect(.process(runtime: row.runtimeId, id: step.id), "Raw events") }
                            else { inspect(selection, "Raw events") }
                        }
                    }
                    expandedContent
                } else if row.state == "running" && !row.latestMessage.isEmpty {
                    Text(row.latestMessage).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
                }
            }.padding(.top, 5).padding(.bottom, 23)
        }.fixedSize(horizontal: false, vertical: true)
    }

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            DisclosureGroup(row.presentation.symbol == "pencil.line" ? "Requested change" : "Inputs", isExpanded: $showInputs) {
                RawTextView(text: row.presentation.input)
                    .frame(height: min(240, max(65, CGFloat(row.presentation.input.split(separator: "\n").count) * 15 + 24)))
                    .clipShape(RoundedRectangle(cornerRadius: 6)).padding(.top, 6)
            }.font(.system(size: 11))
            ForEach(children) { child in
                HStack {
                    Image(systemName: child.presentation.symbol).foregroundStyle(.secondary)
                    Text(child.presentation.title).font(.system(size: 11))
                    Spacer()
                    Text(child.statusLabel).font(.system(size: 10)).foregroundStyle(.secondary)
                    Button("Details") { inspect(.operation(runtime: child.runtimeId, id: child.operationId), "Readable") }.buttonStyle(.plain).font(.system(size: 10))
                }.padding(.leading, 10)
            }
            HStack(spacing: 15) {
                Button("View full output") { inspect(selection, "Output") }.foregroundStyle(.tint)
                Button("Technical details") { inspect(selection, "Raw events") }.foregroundStyle(.secondary)
                Spacer()
                if row.state == "running" || row.state == "stopping" {
                    Button(row.state == "stopping" ? "Stopping…" : "Stop operation") { store.send("stop", runtime: row.runtimeId, values: ["operationId": row.operationId]) }.disabled(row.state == "stopping")
                }
            }.buttonStyle(.plain).font(.system(size: 11))
            Text(row.tool + " · \(row.eventCount) recorded events").font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
        }.padding(.top, 3)
    }

    private var elapsed: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int(context.date.timeIntervalSince(activityDate(row.startedAt) ?? context.date)))
            Text("\(seconds)s").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
        }
    }
}
