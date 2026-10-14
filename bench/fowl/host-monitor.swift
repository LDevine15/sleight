// Read-only notifications and window metadata, following front-watch.sh and
// keyboard-taps.swift. No AX content, screenshots, input or activation requests.
import AppKit
import ApplicationServices
import Foundation

func emit(_ fields: [String: Any]) {
    var entry = fields
    entry["t"] = Date().timeIntervalSince1970 * 1000
    if let data = try? JSONSerialization.data(withJSONObject: entry), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
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
if trusted {
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular { _ = watchWindow(app) }
}
let front = NSWorkspace.shared.frontmostApplication
let windowReady = trusted && (front.map { watchWindow($0) } ?? false)
tokens.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    if trusted && !watchWindow(app) { emit(["kind": "host-error", "message": "focused-window observer unavailable", "pid": Int(app.processIdentifier)]) }
    emit(["kind": "host-front", "pid": Int(app.processIdentifier), "app": app.bundleIdentifier ?? "unknown"])
})
tokens.append(center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
    emit(["kind": "host-space"])
})
tokens.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { axObservers.removeValue(forKey: app.processIdentifier) }
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
