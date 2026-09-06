import Foundation
import Darwin

/// Newline-framed JSON over a user-owned Unix socket. No TCP listener or web view.
final class LocalSocket {
    let path: String
    var onMessage: (([String: Any]) -> Void)?
    var onState: ((Bool, String?) -> Void)?
    private let lock = NSLock()
    private var descriptor: Int32 = -1
    private var stopped = false
    private let reads = DispatchQueue(label: "local-dev.ipc.read", qos: .utility)
    private let writes = DispatchQueue(label: "local-dev.ipc.write", qos: .userInitiated)

    init(path: String) { self.path = path }

    func start() {
        reads.async { [self] in
            let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { notify(false, "Cannot create local socket: \(errno)"); return }
            defer {
                lock.lock(); descriptor = -1; lock.unlock()
                Darwin.close(fd)
                notify(false, nil)
            }
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            let bytes = path.utf8CString
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
                notify(false, "Local socket path is too long"); return
            }
            withUnsafeMutableBytes(of: &address.sun_path) { target in
                bytes.withUnsafeBytes { source in target.copyMemory(from: source) }
            }
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard connected == 0 else { notify(false, "Runtime is not connected"); return }
            var noSignal: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            lock.lock()
            if stopped { lock.unlock(); return }
            descriptor = fd
            lock.unlock()
            notify(true, nil)
            var pending = Data()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = Darwin.read(fd, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { break }
                pending.append(contentsOf: buffer.prefix(count))
                while let newline = pending.firstIndex(of: 10) {
                    let line = Data(pending[..<newline])
                    pending.removeSubrange(...newline)
                    do {
                        guard let message = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                            throw NSError(domain: "LocalDev", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid local message"])
                        }
                        DispatchQueue.main.async { [weak self] in self?.onMessage?(message) }
                    } catch { notify(false, error.localizedDescription); return }
                }
            }
        }
    }

    func send(_ message: [String: Any]) {
        writes.async { [self] in
            do {
                var data = try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys])
                data.append(10)
                lock.lock()
                defer { lock.unlock() }
                guard descriptor >= 0 && !stopped else { notify(false, "Control connection is unavailable"); return }
                try data.withUnsafeBytes { bytes in
                    var offset = 0
                    while offset < bytes.count {
                        let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                        if count < 0 && errno == EINTR { continue }
                        guard count > 0 else {
                            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                        }
                        offset += count
                    }
                }
            } catch { notify(false, error.localizedDescription) }
        }
    }

    func stop() {
        lock.lock()
        stopped = true
        if descriptor >= 0 { Darwin.shutdown(descriptor, SHUT_RDWR) }
        lock.unlock()
    }

    private func notify(_ connected: Bool, _ error: String?) {
        DispatchQueue.main.async { [weak self] in self?.onState?(connected, error) }
    }
}
