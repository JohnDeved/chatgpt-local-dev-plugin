import Foundation

struct RunNote: Identifiable {
    var id: String
    var kind: String
    var text: String
    var timestamp: String
    var label: String { kind == "decision" ? "Decision summary" : kind == "plan" ? "Plan" : "Progress" }
}

struct RunSteering: Identifiable {
    var id: String
    var text: String
    var state: String
    var createdAt: String
    var response: String?
    var label: String {
        switch state {
        case "returned": return "Included in tool response · not yet acknowledged"
        case "acknowledged": return "Acknowledged by ChatGPT"
        default: return "Queued for the next tool response"
        }
    }
    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, let text = value["text"] as? String else { return nil }
        self.id = id; self.text = text
        state = value["state"] as? String ?? "queued"
        createdAt = value["createdAt"] as? String ?? ""
        response = value["response"] as? String
    }
}

struct WorkerRunItem: Identifiable {
    var runtimeId: String
    var runId: String
    var id: String { runtimeId + ":" + runId }
    var goal: String?
    var title: String
    var origin: String
    var state: String
    var startedAt: String
    var endedAt: String?
    var summary: String?
    var contextScope: String
    var notes: [RunNote] = []
    var steering: [RunSteering] = []
    var backgroundProcesses = 0
    var connected = false
    var legacy = false
    var active: Bool { state == "running" }
    var completionLabel: String {
        switch state {
        case "completed": return "Run completed"
        case "failed": return "Run failed"
        case "cancelled": return "Run cancelled"
        case "interrupted": return "Tracking interrupted · completion unknown"
        default: return connected ? "Run in progress" : "Disconnected · end not reported"
        }
    }
    var elapsed: String {
        guard let start = activityDate(startedAt), let end = endedAt.flatMap(activityDate) else { return "" }
        let seconds = max(0, Int(end.timeIntervalSince(start)))
        return seconds >= 60 ? "\(seconds / 60)m \(seconds % 60)s" : "\(seconds)s"
    }
    init?(_ value: [String: Any], runtime: String) {
        guard let id = value["id"] as? String else { return nil }
        runtimeId = runtime; runId = id
        goal = value["goal"] as? String
        title = value["title"] as? String ?? goal ?? "Goal not reported"
        origin = value["origin"] as? String ?? "observed"
        state = value["state"] as? String ?? "running"
        startedAt = value["startedAt"] as? String ?? ""
        endedAt = value["endedAt"] as? String
        summary = value["summary"] as? String
        contextScope = value["contextScope"] as? String ?? "runtime"
        steering = (value["steering"] as? [[String: Any]] ?? []).compactMap(RunSteering.init)
    }
}

struct RunTimelineIndex {
    private(set) var runs: [String: WorkerRunItem] = [:]
    mutating func accept(_ event: [String: Any]) {
        guard let runtime = event["runtimeId"] as? String, let type = event["type"] as? String else { return }
        let timestamp = event["timestamp"] as? String ?? ""
        if type == "runtime.closed" {
            for key in Array(runs.keys) where runs[key]?.runtimeId == runtime && runs[key]?.active == true {
                runs[key]?.state = "interrupted"; runs[key]?.endedAt = timestamp
            }
            return
        }
        guard let runId = event["runId"] as? String else { return }
        let key = runtime + ":" + runId
        let detail = event["detail"] as? [String: Any] ?? [:]
        if type == "run.started", let value = detail["run"] as? [String: Any], let run = WorkerRunItem(value, runtime: runtime) {
            runs[key] = run
            return
        }
        guard var run = runs[key] else { return }
        switch type {
        case "run.goal":
            run.goal = detail["goal"] as? String
            if let title = detail["title"] as? String { run.title = title }
            if let origin = detail["origin"] as? String { run.origin = origin }
        case "run.note":
            if let text = detail["text"] as? String {
                let id = "\(runtime):\(event["sequence"] as? Int ?? 0)"
                if !run.notes.contains(where: { $0.id == id }) {
                    run.notes.append(RunNote(id: id, kind: detail["kind"] as? String ?? "progress", text: text, timestamp: timestamp))
                }
            }
        case "run.ended":
            run.state = detail["state"] as? String ?? "interrupted"
            run.endedAt = detail["endedAt"] as? String ?? timestamp
            run.summary = detail["summary"] as? String
            run.backgroundProcesses = detail["backgroundProcesses"] as? Int ?? 0
        case "run.interrupted":
            run.state = "interrupted"; run.endedAt = detail["endedAt"] as? String ?? timestamp
            run.summary = detail["summary"] as? String
        case "steering.queued":
            if let value = detail["message"] as? [String: Any], let message = RunSteering(value), !run.steering.contains(where: { $0.id == message.id }) {
                run.steering.append(message)
            }
        case "steering.returned", "steering.acknowledged":
            if let id = detail["id"] as? String, let index = run.steering.firstIndex(where: { $0.id == id }) {
                run.steering[index].state = type == "steering.returned" ? "returned" : "acknowledged"
                run.steering[index].response = detail["response"] as? String ?? run.steering[index].response
            }
        default: break
        }
        runs[key] = run
    }
    var ordered: [WorkerRunItem] { runs.values.sorted { $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt } }
}
