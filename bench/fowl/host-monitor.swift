// Read-only notifications and window metadata, following front-watch.sh and
// keyboard-taps.swift. No AX content, screenshots, input or activation requests.
import AppKit
import ApplicationServices
import Foundation

// Subscription results are coverage evidence, independent of front-app state.
// The same policy runs with injected registrations in the offline self-test.
// The ghost hand host's panel is sleight's own overlay over the target window, not a host change. Its
// host starts lazily inside a run, so the starter names it on stdin ("ignore-pid N") when it spawns. A pid
// is ignored only while that process lives: after it exits, a later app may get the same pid.
final class IgnoredPids {
    private(set) var pids = Set<Int>()
    private let alive: (Int) -> Bool
    init(alive: @escaping (Int) -> Bool) { self.alive = alive }
    // The pid newly ignored, or nil for a malformed line, one already ignored or a process already gone.
    func read(_ line: String) -> Int? {
        let parts = line.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0] == "ignore-pid", let pid = Int(parts[1]), pid > 0, pid <= Int(Int32.max),
              !pids.contains(pid), alive(pid) else { return nil }
        pids.insert(pid)
        return pid
    }
    func contains(_ pid: Int) -> Bool { pids.contains(pid) }
    func forget(_ pid: Int) { pids.remove(pid) }
}

final class WindowSubscriptions {
    private var registered = [Int: Bool]()
    private let ignored: IgnoredPids
    // nil means the process is already gone: it can't take focus, so it counts as terminated.
    private let subscribe: (Int) -> Bool?
    private let report: ([String: Any]) -> Void
    init(ignored: IgnoredPids, subscribe: @escaping (Int) -> Bool?, report: @escaping ([String: Any]) -> Void) {
        self.ignored = ignored
        self.subscribe = subscribe
        self.report = report
    }
    var complete: Bool { registered.values.allSatisfy { $0 } }
    func watch(_ pid: Int) {
        if registered[pid] == true || ignored.contains(pid) { return }
        report(["kind": "host-window-watch", "pid": pid, "covered": false, "pending": true])
        guard let covered = subscribe(pid) else { return remove(pid) }
        registered[pid] = covered
        report(["kind": "host-window-watch", "pid": pid, "covered": covered, "pending": false])
    }
    func remove(_ pid: Int) {
        registered.removeValue(forKey: pid)
        report(["kind": "host-window-watch", "pid": pid, "covered": true, "pending": false, "terminated": true])
    }
    // After ignored.read named the pid: it no longer holds coverage back, and the record says why.
    func ignore(_ pid: Int) {
        registered.removeValue(forKey: pid)
        report(["kind": "host-window-watch", "pid": pid, "covered": true, "pending": false, "ignored": true])
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
    var permitted: [Int: Bool?] = [10: true, 20: false, 30: true, 50: nil]
    var attempts = [Int](), records = [[String: Any]](), pendingBeforeSubscribe = true
    let subscriptions = WindowSubscriptions(ignored: IgnoredPids(alive: { _ in true }), subscribe: { pid in
        attempts.append(pid)
        pendingBeforeSubscribe = pendingBeforeSubscribe && records.last?["pending"] as? Bool == true
        return permitted[pid] ?? false
    }, report: { records.append($0) })
    subscriptions.watch(50) // Quit between the app listing and the subscription.
    let gone = subscriptions.complete && records.last?["terminated"] as? Bool == true
    attempts.removeAll()
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
    // A hand host watched before the starter names it: then dropped from coverage and never watched again.
    let hand = IgnoredPids(alive: { $0 != 70 })
    var handAttempts = [Int](), handRecords = [[String: Any]]()
    let handSubscriptions = WindowSubscriptions(ignored: hand, subscribe: { pid in handAttempts.append(pid); return false },
                                                report: { handRecords.append($0) })
    handSubscriptions.watch(60)
    let malformed = ["ignore-pid 0", "ignore-pid -3", "ignore-pid x", "ignore-pid 2147483648", "pid 60", "ignore-pid 60 1",
                     "ignore-pid  60", ""].allSatisfy { hand.read($0) == nil }
    let named = hand.read("ignore-pid 60") == 60 && hand.read("ignore-pid 60") == nil && hand.contains(60)
    handSubscriptions.ignore(60)
    handSubscriptions.watch(60)
    let handIgnored = malformed && named && handSubscriptions.complete && handAttempts == [60] &&
        handRecords.last?["ignored"] as? Bool == true && handRecords.last?["covered"] as? Bool == true
    // The hand exits and a later app gets its pid: watched and reported again. A pid already gone is never ignored.
    handSubscriptions.remove(60)
    hand.forget(60)
    handSubscriptions.watch(60)
    let handReused = !hand.contains(60) && handAttempts == [60, 60] && !handSubscriptions.complete
    let handGone = hand.read("ignore-pid 70") == nil && !hand.contains(70)
    guard gone && partial && recovered && launched && failedLaunch && terminated && pendingBeforeSubscribe && handIgnored && handReused && handGone else { exit(1) }
    emit(["kind": "subscription-self-test", "partial": partial, "recovered": recovered,
          "backgroundLaunch": launched, "failedLaunch": failedLaunch, "terminated": terminated,
          "pendingBeforeSubscribe": pendingBeforeSubscribe, "gone": gone, "handIgnored": handIgnored,
          "handReused": handReused, "handGone": handGone])
    exit(0) // Before any NSWorkspace, AX or window metadata access.
}
func windowID(_ pid: pid_t) -> Int? {
    guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return nil }
    return windows.first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) &&
        ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowNumber as String] as? Int
}
let ignored = IgnoredPids(alive: { kill(pid_t($0), 0) == 0 || errno == EPERM })
var axObservers = [pid_t: AXObserver]()
var tokens = [NSObjectProtocol]()
let center = NSWorkspace.shared.notificationCenter
let callback: AXObserverCallback = { _, element, _, _ in
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    if ignored.contains(Int(pid)) { return }
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
let subscriptions = WindowSubscriptions(ignored: ignored, subscribe: { pid in
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else { return nil }
    if watchWindow(app) { return true }
    return kill(pid_t(pid), 0) == 0 || errno != ESRCH ? false : nil
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
        ignored.forget(Int(app.processIdentifier))
    }
})
emit(["kind": "host-ready", "app": true, "space": true, "window": windowReady])
if let app = front { emit(["kind": "host-front", "pid": Int(app.processIdentifier), "initial": true]) }
// The repository launcher owns this process through stdin. Parent exit or normal
// stop closes the pipe, collects this observer and removes its compilation bank.
// Lines before that name pids to ignore.
DispatchQueue.global().async {
    var pending = ""
    while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { break }
        pending += String(decoding: data, as: UTF8.self)
        var lines = pending.components(separatedBy: "\n")
        pending = lines.removeLast()
        if pending.utf8.count > 4096 { pending = "" }
        for line in lines {
            DispatchQueue.main.async {
                guard let pid = ignored.read(line) else { return }
                if let observer = axObservers.removeValue(forKey: pid_t(pid)) {
                    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
                }
                subscriptions.ignore(pid)
            }
        }
    }
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
