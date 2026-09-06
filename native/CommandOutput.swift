import Foundation

struct CommandDisplay {
    let argv: [String]
    var executable: String { argv.first ?? "" }
    var name: String { URL(fileURLWithPath: executable).lastPathComponent }
    var exact: String { shellDisplay(argv) }
    var scriptIndex: Int? {
        // Only interpret well-known inline-source flags, not arbitrary argument values.
        let interpreters = ["node", "nodejs", "python", "python3", "ruby", "perl", "swift"]
        guard interpreters.contains(name), argv.count > 2 else { return nil }
        let flags = name.hasPrefix("python") ? ["-c"] : ["-e", "--eval"]
        guard let flag = argv.indices.dropFirst().first(where: { flags.contains(argv[$0]) }), flag + 1 < argv.count else { return nil }
        return flag + 1
    }
    var script: String? { scriptIndex.map { argv[$0] } }
    var invocation: String {
        guard let source = scriptIndex else { return shellDisplay([name] + argv.dropFirst()) }
        let before = shellDisplay([name] + argv[1..<source])
        let after = shellDisplay(Array(argv.dropFirst(source + 1)))
        return before + " ‹inline script below›" + (after.isEmpty ? "" : " " + after)
    }
}

enum OutputChannel: String, CaseIterable, Identifiable {
    case all = "All", stdout = "stdout", stderr = "stderr"
    var id: String { rawValue }
}

/// Display-only decoder. Raw JSONL records and original byte payloads are untouched.
/// CSI/OSC sequences are not executed. Carriage-return updates remain separate lines.
struct OutputTextDecoder {
    private enum Mode { case text, escape, csi, osc, oscEscape }
    private var mode: Mode = .text
    private var carriageReturn = false

    mutating func append(_ source: String) -> String {
        var result = ""
        for scalar in source.unicodeScalars {
            switch mode {
            case .escape:
                if scalar == "[" { mode = .csi }
                else if scalar == "]" || scalar == "P" || scalar == "^" || scalar == "_" { mode = .osc }
                else { mode = .text }
                continue
            case .csi:
                if (0x40...0x7E).contains(scalar.value) { mode = .text }
                continue
            case .osc:
                if scalar.value == 7 || scalar.value == 0x9C { mode = .text }
                else if scalar.value == 27 { mode = .oscEscape }
                continue
            case .oscEscape:
                mode = scalar == "\\" ? .text : .osc
                continue
            case .text: break
            }
            if scalar.value == 27 { mode = .escape; continue }
            if scalar.value == 0x9B { mode = .csi; continue }
            if scalar.value == 0x9D { mode = .osc; continue }
            if scalar == "\r" {
                result.append("\n"); carriageReturn = true; continue
            }
            if scalar == "\n" {
                if !carriageReturn { result.append("\n") }
                carriageReturn = false; continue
            }
            // Preserve the position of backspaces visibly instead of letting them alter history.
            if scalar.value == 8 { result.append("␈"); continue }
            if scalar.value < 32 && scalar != "\t" { continue }
            if (0x7F...0x9F).contains(scalar.value) { continue }
            carriageReturn = false
            result.unicodeScalars.append(scalar)
        }
        return result
    }
}

struct CapturedCommandOutput {
    private var decoders: [String: OutputTextDecoder] = [:]
    private(set) var combined = ""
    private(set) var stdout = ""
    private(set) var stderr = ""
    private(set) var bytes = 0
    private(set) var stdoutBytes = 0
    private(set) var stderrBytes = 0
    private(set) var revision = 0
    private(set) var earlierOutputOmitted = false
    private let limit: Int?

    init(limit: Int? = 16_000) { self.limit = limit }

    mutating func append(text: String, stream: String, byteCount: Int) {
        let channel = stream == "stderr" ? "stderr" : "stdout"
        var decoder = decoders[channel] ?? OutputTextDecoder()
        let displayed = decoder.append(text)
        decoders[channel] = decoder
        bytes += byteCount; revision += 1
        if channel == "stderr" { stderrBytes += byteCount; stderr += displayed }
        else { stdoutBytes += byteCount; stdout += displayed }
        combined += displayed
        if let limit {
            if combined.count > limit { combined = String(combined.suffix(limit)); earlierOutputOmitted = true }
            if stdout.count > limit { stdout = String(stdout.suffix(limit)); earlierOutputOmitted = true }
            if stderr.count > limit { stderr = String(stderr.suffix(limit)); earlierOutputOmitted = true }
        }
    }

    func text(for channel: OutputChannel) -> String {
        switch channel { case .all: return combined; case .stdout: return stdout; case .stderr: return stderr }
    }
    func byteCount(for channel: OutputChannel) -> Int {
        switch channel { case .all: return bytes; case .stdout: return stdoutBytes; case .stderr: return stderrBytes }
    }
}

/// Fetches complete captured output only when the user opens it. No chunk separators
/// are added: a line split across several stdout events is still one line.
func readCommandOutput(records: [JournalRecord], runtime: String, processID: String) throws -> CapturedCommandOutput {
    var output = CapturedCommandOutput(limit: nil)
    let matching = records.filter { $0.runtimeId == runtime && $0.processId == processID && $0.type == "process.output" }
    var handles: [URL: FileHandle] = [:]
    defer { for handle in handles.values { try? handle.close() } }
    for record in matching.sorted(by: { $0.sequence < $1.sequence }) {
        let handle: FileHandle
        if let existing = handles[record.file] { handle = existing }
        else { handle = try FileHandle(forReadingFrom: record.file); handles[record.file] = handle }
        try handle.seek(toOffset: record.offset)
        guard let bytes = try handle.read(upToCount: record.length), bytes.count == record.length,
              let event = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let detail = event["detail"] as? [String: Any] else {
            throw NSError(domain: "LocalDev.Output", code: 1, userInfo: [NSLocalizedDescriptionKey: "The original output record is no longer available in full."])
        }
        output.append(text: detail["text"] as? String ?? "", stream: detail["stream"] as? String ?? "stdout", byteCount: detail["bytes"] as? Int ?? 0)
    }
    return output
}
