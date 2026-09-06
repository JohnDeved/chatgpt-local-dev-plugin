import AppKit
import Foundation
import SwiftUI

@MainActor
func runWorkerRunChecks(in root: URL) throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var index = RunTimelineIndex()
    var sequence = 0
    let start = "2026-09-05T10:00:00.000Z"
    func accept(_ type: String, detail: [String: Any], run: String = "run-one") {
        sequence += 1
        index.accept(["runtimeId": "fixture", "runId": run, "type": type, "sequence": sequence,
            "timestamp": "2026-09-05T10:00:05.000Z", "detail": detail])
    }
    accept("run.started", detail: ["run": ["id": "run-one", "goal": NSNull(), "title": "Goal not reported", "origin": "observed",
        "state": "running", "startedAt": start, "contextScope": "session", "steering": []]])
    precondition(index.ordered.count == 1 && index.ordered[0].goal == nil)
    accept("run.goal", detail: ["goal": "Make worker runs understandable", "title": "Readable worker runs", "origin": "assistant"])
    accept("run.note", detail: ["kind": "plan", "text": "Inspect the existing execution and timeline code.", "source": "assistant_summary"])
    accept("run.note", detail: ["kind": "decision", "text": "Preserve raw records and add a concise run summary.", "source": "assistant_summary"])
    precondition(index.ordered.count == 1 && index.ordered[0].notes.count == 2)
    precondition(index.ordered[0].notes.last?.label == "Decision summary")
    precondition(index.ordered[0].title == "Readable worker runs" && index.ordered[0].origin == "assistant")
    precondition(index.ordered[0].active && index.ordered[0].endedAt == nil, "Notes or idle time cannot invent an end marker")
    let message: [String: Any] = ["id": "message-one", "text": "Only change the local UI.", "state": "queued", "createdAt": start]
    accept("steering.queued", detail: ["message": message])
    accept("steering.queued", detail: ["message": message])
    precondition(index.ordered[0].steering.count == 1, "Journal replay must not duplicate steering")
    precondition(index.ordered[0].steering[0].label.hasPrefix("Queued"))
    accept("steering.returned", detail: ["id": "message-one"])
    precondition(index.ordered[0].steering[0].state == "returned")
    precondition(index.ordered[0].steering[0].label.contains("not yet acknowledged"), "A response receipt is not proof ChatGPT read it")
    accept("steering.acknowledged", detail: ["id": "message-one", "response": "I will restrict changes to the UI."])
    precondition(index.ordered[0].steering[0].response == "I will restrict changes to the UI.")
    accept("run.ended", detail: ["state": "completed", "summary": "UI changes passed their checks.", "endedAt": "2026-09-05T10:01:25.000Z", "backgroundProcesses": 1])
    precondition(!index.ordered[0].active && index.ordered[0].completionLabel == "Run completed")
    precondition(index.ordered[0].elapsed == "1m 25s" && index.ordered[0].backgroundProcesses == 1)
    accept("run.started", detail: ["run": ["id": "run-two", "goal": "Another task", "title": "Another task", "state": "running", "startedAt": "2026-09-05T10:02:00.000Z"]], run: "run-two")
    index.accept(["runtimeId": "fixture", "type": "runtime.closed", "timestamp": "2026-09-05T10:03:00.000Z"])
    precondition(index.ordered[0].state == "completed", "Disconnect cannot overwrite a completed result")
    precondition(index.ordered[1].state == "interrupted" && index.ordered[1].completionLabel.contains("unknown"))

    let store = ActivityStore(home: root, startMonitoring: false)
    store.historyRuns = index.ordered
    precondition(store.workerRuns.count == 2 && store.activeRuns.isEmpty)
    store.steeringDraft = "Keep this unsent instruction"
    store.sendSteering()
    precondition(store.steeringDraft == "Keep this unsent instruction" && !store.sendingSteering)
    precondition(store.steeringNotice?.contains("connected") == true)

    let manifestData = try JSONSerialization.data(withJSONObject: ["runtimeId": "fixture", "pid": 1, "socketPath": "/tmp/fixture.sock", "journalPath": "/tmp/fixture.jsonl", "startedAt": start])
    let manifest = try JSONDecoder().decode(RuntimeManifest.self, from: manifestData)
    let active = WorkerRunItem(["id": "run-three", "title": "Next task", "goal": "Next goal", "state": "running", "startedAt": start], runtime: "fixture")!
    var state = RuntimeState(manifest: manifest)
    state.connected = true; state.supportsRuns = true; state.runs = [active]
    store.runtimes["fixture"] = state
    precondition(store.activeRuns.count == 1 && store.activeRuns[0].runId == "run-three")
    precondition(store.runReportingAvailable)
    state.connected = false; store.runtimes["fixture"] = state
    precondition(store.activeRuns.isEmpty, "A disconnected run cannot receive steering")

    let card = NSHostingView(rootView: WorkerRunCard(store: store, run: index.ordered[0], calls: [], inspect: { _, _ in }).padding(16).frame(width: 780))
    card.setFrameSize(NSSize(width: 780, height: 350)); card.layoutSubtreeIfNeeded()
    precondition(card.fittingSize.height > 120 && card.fittingSize.width <= 785)
    let panel = NSHostingView(rootView: ActivityPanel(store: store))
    panel.setFrameSize(NSSize(width: 820, height: 730)); panel.layoutSubtreeIfNeeded()
    precondition(panel.fittingSize.width == 820 && panel.fittingSize.height == 730)
    if let output = ProcessInfo.processInfo.environment["LOCAL_DEV_NATIVE_PREVIEW_DIR"] {
        let directory = URL(fileURLWithPath: output)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 730), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = panel; panel.layoutSubtreeIfNeeded()
        if let bitmap = panel.bitmapImageRepForCachingDisplay(in: panel.bounds) {
            panel.cacheDisplay(in: panel.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { preconditionFailure("Worker run preview rendering failed") }
            try png.write(to: directory.appendingPathComponent("worker-runs.png"))
        }
        window.orderOut(nil)
    }
    print("Worker run checks passed: explicit starts/ends, observed goal promotion, public summaries, steering receipts, interruption, active-target eligibility, draft retention, and native layout")
}

/// Called only by the isolated integration harness, never against the user's real HOME.
@MainActor
func verifyNativeRunWorkflow() throws {
    guard let value = ProcessInfo.processInfo.environment["LOCAL_DEV_RUN_TEST_HOME"] else {
        throw NSError(domain: "RunChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing isolated integration home"])
    }
    let home = URL(fileURLWithPath: value).resolvingSymlinksInPath()
    let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path
    guard home.path.hasPrefix(temporary + "/"), home.lastPathComponent.hasPrefix("local-dev-native-run-") else {
        throw NSError(domain: "RunChecks", code: 2, userInfo: [NSLocalizedDescriptionKey: "The native steering harness must use an isolated temporary home"])
    }
    let store = ActivityStore(home: home)
    let deadline = Date().addingTimeInterval(20)
    var sent = false
    var acknowledged = false
    while Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
        if !sent, let run = store.activeRuns.first {
            store.steeringTarget = run.id
            store.steeringDraft = "Keep the native integration check read-only."
            store.sendSteering()
            sent = true
        }
        if store.workerRuns.contains(where: { $0.steering.contains(where: { $0.state == "acknowledged" }) }) { acknowledged = true }
        if acknowledged, let ended = store.workerRuns.first(where: { $0.state == "completed" }) {
            guard ended.goal == "Verify the native steering UI model" && store.steeringDraft.isEmpty else {
                throw NSError(domain: "RunChecks", code: 3, userInfo: [NSLocalizedDescriptionKey: "Native goal display or draft acknowledgement did not match"])
            }
            print("Native workflow passed: goal received; steering submitted through ActivityStore and Unix IPC; acknowledgement and explicit completion displayed.")
            return
        }
    }
    throw NSError(domain: "RunChecks", code: 4, userInfo: [NSLocalizedDescriptionKey: "Native workflow timed out: sent=\(sent) acknowledged=\(acknowledged) error=\(store.lastError ?? "none")"])
}
