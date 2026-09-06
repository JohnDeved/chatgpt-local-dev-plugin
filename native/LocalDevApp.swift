import AppKit
import ServiceManagement
import SwiftUI

@MainActor
final class MenuAppDelegate: NSObject, NSApplicationDelegate {
    static weak var store: ActivityStore?
    static var mayQuit = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if Self.mayQuit { return .terminateNow }
        Self.store?.requestQuit()
        return .terminateCancel
    }
}

@main
struct LocalDevMenuApp: App {
    @NSApplicationDelegateAdaptor(MenuAppDelegate.self) private var delegate
    @StateObject private var store: ActivityStore

    init() {
        if CommandLine.arguments.contains("--self-test") {
            do { try runNativeChecks(); print("Native menu-bar checks passed"); exit(0) }
            catch { fputs("Native menu-bar check failed: \(error)\n", stderr); exit(1) }
        }
        if CommandLine.arguments.contains("--verify-run-workflow") {
            do { try verifyNativeRunWorkflow(); exit(0) }
            catch { fputs("Native run workflow failed: \(error)\n", stderr); exit(1) }
        }
        if CommandLine.arguments.contains("--register-login") {
            do {
                try SMAppService.mainApp.register()
                print("Login registration enabled: \(SMAppService.mainApp.status == .enabled)")
                exit(0)
            } catch { fputs("Login registration: \(error)\n", stderr); exit(1) }
        }
        if let bundle = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first(where: { $0.processIdentifier != getpid() }) {
            if CommandLine.arguments.contains("--replace-running") {
                guard existing.forceTerminate() else {
                    fputs("Could not replace the existing menu-bar app.\n", stderr); exit(1)
                }
            } else {
                existing.activate(options: [])
                exit(0)
            }
        }
        let model = ActivityStore()
        _store = StateObject(wrappedValue: model)
        MenuAppDelegate.store = model
        if CommandLine.arguments.contains("--request-reconnect") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { model.requestReconnect() }
        }
    }

    var body: some Scene {
        MenuBarExtra {
            ActivityPanel(store: store)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: store.icon)
                Text("Local Dev · \(store.status)")
                if store.autoApprove { Text("AUTO").font(.system(size: 9, weight: .bold)) }
            }
        }
        .menuBarExtraStyle(.window)
        .commands {
            CommandGroup(replacing: .appTermination) {
                Button("Pause and Quit Local Dev…") { store.requestQuit() }.keyboardShortcut("q")
            }
        }
    }
}
