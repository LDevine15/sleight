// Read-only notifications and window metadata, following front-watch.sh and
// keyboard-taps.swift. No AX content, screenshots, input or activation requests.
import AppKit
import ApplicationServices
import Foundation

// Subscription results are coverage evidence, independent of front-app state.
// The same policy runs with injected registrations in the offline self-test.
final class WindowSubscriptions {
    private var registered = [Int: Bool]()
    private let subscribe: (Int) -> Bool
    private let report: ([String: Any]) -> Void
    init(subscribe: @escaping (Int) -> Bool, report: @escaping ([String: Any]) -> Void) {
        self.subscribe = subscribe
        self.report = report
    }
    var complete: Bool { registered.values.allSatisfy { $0 } }
    func watch(_ pid: Int) {
        if registered[pid] == true { return }
        report(["kind": "host-window-watch", "pid": pid, "covered": false, "pending": true])
        let covered = subscribe(pid)
        registered[pid] = covered
        report(["kind": "host-window-watch", "pid": pid, "covered": covered, "pending": false])
    }
    func remove(_ pid: Int) {
        registered.removeValue(forKey: pid)
        report(["kind": "host-window-watch", "pid": pid, "covered": true, "pending": false, "terminated": true])
    }
}

func emit(_ fields: [String: Any]) {
    var entry = fields
    entry["t"] = Date().timeIntervalSince1970 * 1000
    if let data = try? JSONSerialization.data(withJSONObject: entry), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}
if Array(CommandLine.arguments.dropFirst()) == ["--self-test"] {
    var permitted = [10: true, 20: false, 30: true]
    var attempts = [Int](), records = [[String: Any]](), pendingBeforeSubscribe = true
    let subscriptions = WindowSubscriptions(subscribe: { pid in
        attempts.append(pid)
        pendingBeforeSubscribe = pendingBeforeSubscribe && records.last?["pending"] as? Bool == true
        return permitted[pid] ?? false
    }, report: { records.append($0) })
    subscriptions.watch(10)
    subscriptions.watch(20)
    let partial = !subscriptions.complete
    permitted[20] = true
    subscriptions.watch(20)
    let recovered = subscriptions.complete
    subscriptions.watch(30) // A background launch, without a front-app event.
    subscriptions.watch(30) // A later activation doesn't duplicate registration.
    let launched = attempts == [10, 20, 20, 30] && subscriptions.complete
    subscriptions.watch(40)
    let failedLaunch = !subscriptions.complete
    subscriptions.remove(40)
    let terminated = subscriptions.complete
    guard partial && recovered && launched && failedLaunch && terminated && pendingBeforeSubscribe else { exit(1) }
    emit(["kind": "subscription-self-test", "partial": partial, "recovered": recovered,
          "backgroundLaunch": launched, "failedLaunch": failedLaunch, "terminated": terminated,
          "pendingBeforeSubscribe": pendingBeforeSubscribe])
    exit(0) // Before any NSWorkspace, AX or window metadata access.
}
func windowID(_ pid: pid_t) -> Int? {
    guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return nil }
    return windows.first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) &&
        ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowNumber as String] as? Int
}
var axObservers = [pid_t: AXObserver]()
var tokens = [NSObjectProtocol]()
let center = NSWorkspace.shared.notificationCenter
let callback: AXObserverCallback = { _, element, _, _ in
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    var event: [String: Any] = ["kind": "host-window", "pid": Int(pid)]
    if let id = windowID(pid) { event["windowId"] = id }
    emit(event)
}
func watchWindow(_ app: NSRunningApplication) -> Bool {
    let pid = app.processIdentifier
    if axObservers[pid] != nil { return true }
    var observer: AXObserver?
    guard AXObserverCreate(pid, callback, &observer) == .success, let observer = observer else { return false }
    let element = AXUIElementCreateApplication(pid)
    let result = AXObserverAddNotification(observer, element, kAXFocusedWindowChangedNotification as CFString, nil)
    guard result == .success || result == .notificationAlreadyRegistered else { return false }
    axObservers[pid] = observer
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
    return true
}
let trusted = AXIsProcessTrusted() // Never request a permission prompt.
let subscriptions = WindowSubscriptions(subscribe: { pid in
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return false }
    return watchWindow(app)
}, report: emit)
if trusted {
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        subscriptions.watch(Int(app.processIdentifier))
    }
}
let front = NSWorkspace.shared.frontmostApplication
if trusted, let app = front { subscriptions.watch(Int(app.processIdentifier)) }
let windowReady = trusted && front != nil && subscriptions.complete
tokens.append(center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
    guard trusted, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
          app.activationPolicy == .regular else { return }
    subscriptions.watch(Int(app.processIdentifier))
})
tokens.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    if trusted { subscriptions.watch(Int(app.processIdentifier)) }
    emit(["kind": "host-front", "pid": Int(app.processIdentifier), "app": app.bundleIdentifier ?? "unknown"])
})
tokens.append(center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
    emit(["kind": "host-space"])
})
tokens.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
        axObservers.removeValue(forKey: app.processIdentifier)
        subscriptions.remove(Int(app.processIdentifier))
    }
})
emit(["kind": "host-ready", "app": true, "space": true, "window": windowReady])
if let app = front { emit(["kind": "host-front", "pid": Int(app.processIdentifier), "initial": true]) }
// The repository launcher owns this process through stdin. Parent exit or normal
// stop closes the pipe, collects this observer and removes its compilation bank.
DispatchQueue.global().async {
    while !FileHandle.standardInput.availableData.isEmpty {}
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
