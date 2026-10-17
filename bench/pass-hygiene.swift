import AppKit
import ApplicationServices
import CoreGraphics

func failure(_ message: String) -> NSError { NSError(domain: "PassHygiene", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func identity(_ app: NSRunningApplication) -> [String: Any]? {
    guard let start = app.launchDate?.timeIntervalSince1970, let bundle = app.bundleIdentifier else { return nil }
    return ["pid": Int(app.processIdentifier), "start": start, "bundle": bundle]
}
func snapshot() throws -> [String: Any] {
    guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        throw failure("CGWindowList unavailable")
    }
    let apps = NSWorkspace.shared.runningApplications.compactMap(identity)
    var rows: [[String: Any]] = []
    for window in windows {
        guard window[kCGWindowLayer as String] as? Int == 0,
              let pid = window[kCGWindowOwnerPID as String] as? Int,
              let id = window[kCGWindowNumber as String] as? Int,
              var row = apps.first(where: { $0["pid"] as? Int == pid }) else { continue }
        row["id"] = id
        row["onScreen"] = window[kCGWindowIsOnscreen as String] as? Bool ?? false
        rows.append(row)
    }
    return ["apps": apps, "windows": rows]
}
func exactApp(_ request: [String: Any]) throws -> NSRunningApplication {
    guard let pid = request["pid"] as? Int, pid > 0, pid <= Int(Int32.max),
          let app = NSRunningApplication(processIdentifier: Int32(pid)), !app.isTerminated,
          let start = request["start"] as? Double, let actualStart = app.launchDate?.timeIntervalSince1970,
          (actualStart * 1000).rounded() == (start * 1000).rounded(),
          let bundle = request["bundle"] as? String, app.bundleIdentifier == bundle else {
        throw failure("Process identity changed; kept")
    }
    return app
}
func waitBriefly(_ done: () -> Bool) {
    let deadline = Date().addingTimeInterval(1)
    while !done() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
}
func perform(_ request: [String: Any]) throws -> [String: Any] {
    if request["action"] as? String == "snapshot" { return try snapshot() }
    let app = try exactApp(request)
    if request["action"] as? String == "quit" {
        // One gentle request only. A save/terminate prompt stays for the operator.
        guard app.terminate() else { throw failure("Quit refused; kept") }
        waitBriefly { app.isTerminated }
        return ["running": !app.isTerminated]
    }
    guard request["action"] as? String == "close", let id = request["id"] as? Int,
          AXIsProcessTrusted() else { throw failure("AX close unavailable; kept") }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 1)
    guard let windows = attr(element, "AXWindows") as? [AXUIElement] else { throw failure("AX windows unavailable; kept") }
    // A sheet or modal window stops this app. Never press its buttons or dismiss it.
    for window in windows {
        if attr(window, "AXModal") as? Bool == true || attr(window, "AXRole") as? String == "AXSheet" ||
            !(attr(window, "AXSheets") as? [AXUIElement] ?? []).isEmpty {
            throw failure("Application dialog; kept")
        }
    }
    guard let window = windows.first(where: { attr($0, "AXWindowNumber") as? Int == id }),
          let rawButton = attr(window, "AXCloseButton"), CFGetTypeID(rawButton) == AXUIElementGetTypeID() else {
        throw failure("Exact AX window or close button unavailable; kept")
    }
    let button = unsafeBitCast(rawButton, to: AXUIElement.self)
    guard attr(button, "AXEnabled") as? Bool == true else { throw failure("Close disabled; kept") }
    _ = try exactApp(request)
    guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw failure("Close refused; kept") }
    var closed = false
    waitBriefly {
        guard let current = attr(element, "AXWindows") as? [AXUIElement] else { return false }
        closed = !current.contains(where: { attr($0, "AXWindowNumber") as? Int == id })
        return closed
    }
    if !closed { throw failure("Window still open; kept without answering a prompt") }
    return ["closed": true]
}
do {
    guard CommandLine.arguments.count == 2, let data = CommandLine.arguments[1].data(using: .utf8),
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure("Invalid request") }
    let result = try perform(request)
    print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
