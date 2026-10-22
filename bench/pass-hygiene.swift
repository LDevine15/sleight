import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

func failure(_ message: String) -> NSError { NSError(domain: "PassHygiene", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func identity(_ app: NSRunningApplication, kernelFallback: Bool = false) -> [String: Any]? {
    // The cover check's snapshot also counts regular apps without an AppKit launch date, such as a browser the benchmark
    // starts from its executable, using the kernel's start time. Hygiene snapshots keep the AppKit-only identity.
    let kernelStart = kernelFallback && app.activationPolicy == .regular ? processInfo(app.processIdentifier)?["start"] as? Double : nil
    guard let bundle = app.bundleIdentifier, let start = app.launchDate?.timeIntervalSince1970 ?? kernelStart else { return nil }
    return ["pid": Int(app.processIdentifier), "start": start, "bundle": bundle, "name": app.localizedName ?? ""]
}
func processInfo(_ pid: Int32) -> [String: Any]? {
    var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size == MemoryLayout<kinfo_proc>.stride else { return nil }
    let time = info.kp_proc.p_un.__p_starttime
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
    return ["pid": Int(pid), "ppid": Int(info.kp_eproc.e_ppid),
            "start": Double(time.tv_sec) + Double(time.tv_usec) / 1_000_000, "path": String(cString: path)]
}
func processes() throws -> [[String: Any]] {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL], size = 0
    guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0 else { throw failure("Process inventory unavailable") }
    var rows = [kinfo_proc](repeating: kinfo_proc(), count: size / MemoryLayout<kinfo_proc>.stride + 128)
    size = rows.count * MemoryLayout<kinfo_proc>.stride
    let status = rows.withUnsafeMutableBytes { sysctl(&mib, u_int(mib.count), $0.baseAddress, &size, nil, 0) }
    guard status == 0 else { throw failure("Process inventory incomplete") }
    return rows.prefix(size / MemoryLayout<kinfo_proc>.stride).compactMap { processInfo($0.kp_proc.p_pid) }
}
func hasDialog(_ windows: [AXUIElement]) -> Bool {
    windows.contains { attr($0, "AXModal") as? Bool == true || attr($0, "AXRole") as? String == "AXSheet" ||
        !(attr($0, "AXSheets") as? [AXUIElement] ?? []).isEmpty }
}
func windowDocument(_ window: AXUIElement) -> String {
    for attribute in ["AXDocument", "AXURL"] {
        let raw = attr(window, attribute)
        if let value = raw as? String, !value.isEmpty { return value }
        if let value = raw as? URL { return value.absoluteString }
    }
    return ""
}
func axFrame(_ window: AXUIElement) -> CGRect? {
    guard let rawPosition = attr(window, "AXPosition"), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
          let rawSize = attr(window, "AXSize"), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
    var position = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(rawPosition, to: AXValue.self), .cgPoint, &position),
          AXValueGetValue(unsafeBitCast(rawSize, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: position, size: size)
}
// AXWindowNumber is optional. Geometry can bind a window only when both inventories have one match.
func exactWindow(_ windows: [AXUIElement], _ id: Int, _ pid: Int32, _ cg: [[String: Any]]) -> AXUIElement? {
    let numbered = windows.filter { attr($0, "AXWindowNumber") as? Int == id }
    if numbered.count == 1 { return numbered[0] }
    func cgFrame(_ info: [String: Any]) -> CGRect? {
        guard let bounds = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: bounds)
    }
    let candidates = cg.filter { $0[kCGWindowOwnerPID as String] as? Int32 == pid && $0[kCGWindowLayer as String] as? Int == 0 }
    guard let info = candidates.first(where: { $0[kCGWindowNumber as String] as? Int == id }), let frame = cgFrame(info),
          candidates.filter({ cgFrame($0) == frame }).count == 1 else { return nil }
    let matching = windows.filter { axFrame($0) == frame }
    return matching.count == 1 ? matching[0] : nil
}
func snapshot(_ includeFloating: Bool) throws -> [String: Any] {
    guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        throw failure("CGWindowList unavailable")
    }
    let apps = NSWorkspace.shared.runningApplications.compactMap { identity($0, kernelFallback: includeFloating) }
    var rows: [[String: Any]] = []
    var axWindows: [Int: [AXUIElement]] = [:]
    if AXIsProcessTrusted() {
        for app in apps {
            guard let pid = app["pid"] as? Int else { continue }
            let element = AXUIElementCreateApplication(Int32(pid))
            AXUIElementSetMessagingTimeout(element, 1)
            axWindows[pid] = attr(element, "AXWindows") as? [AXUIElement] ?? []
        }
    }
    for window in windows {
        guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 || (includeFloating && layer > 0 && layer < 20),
              let pid = window[kCGWindowOwnerPID as String] as? Int,
              let id = window[kCGWindowNumber as String] as? Int,
              var row = apps.first(where: { $0["pid"] as? Int == pid }) else { continue }
        row["id"] = id
        row["layer"] = layer
        row["alpha"] = window[kCGWindowAlpha as String] as? Double ?? 1
        if let bounds = window[kCGWindowBounds as String] as? NSDictionary,
           let frame = CGRect(dictionaryRepresentation: bounds) {
            row["frame"] = ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
        }
        row["onScreen"] = window[kCGWindowIsOnscreen as String] as? Bool ?? false
        if let exact = exactWindow(axWindows[pid] ?? [], id, Int32(pid), windows) {
            row["title"] = attr(exact, "AXTitle") as? String
            row["document"] = windowDocument(exact)
            row["dialog"] = hasDialog([exact])
        }
        rows.append(row)
    }
    return ["apps": apps, "windows": rows, "processes": try processes(), "at": Date().timeIntervalSince1970]
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
    if request["action"] as? String == "snapshot" { return try snapshot(request["includeFloating"] as? Bool == true) }
    if request["action"] as? String == "stop" {
        guard let pid = request["pid"] as? Int32, pid > 0,
              let actual = processInfo(pid), let start = request["start"] as? Double,
              let actualStart = actual["start"] as? Double, (start * 1000).rounded() == (actualStart * 1000).rounded(),
              actual["path"] as? String == request["path"] as? String else { throw failure("Daemon identity changed; kept") }
        guard Darwin.kill(pid, SIGTERM) == 0 else { throw failure("Daemon stop refused; kept") }
        waitBriefly { processInfo(pid) == nil }
        guard processInfo(pid) == nil else { throw failure("Daemon still running; kept") }
        return ["stopped": true]
    }
    let app = try exactApp(request)
    if request["action"] as? String == "quit" {
        // One gentle request only. A save/terminate prompt stays for the operator.
        guard app.terminate() else { throw failure("Quit refused; kept") }
        waitBriefly { app.isTerminated }
        return ["running": !app.isTerminated]
    }
    guard request["action"] as? String == "close", let id = request["id"] as? Int,
          AXIsProcessTrusted() else { throw failure("AX close unavailable; kept") }
    if request["finderOnly"] as? Bool == true && app.bundleIdentifier != "com.apple.finder" {
        throw failure("Finder identity changed; kept")
    }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 1)
    guard let windows = attr(element, "AXWindows") as? [AXUIElement] else { throw failure("AX windows unavailable; kept") }
    // A sheet or modal window stops this app. Never press its buttons or dismiss it.
    if hasDialog(windows) { return ["dialog": true] }
    guard let cg = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let window = exactWindow(windows, id, app.processIdentifier, cg) else {
        return ["skipped": "no-ax-window"]
    }
    func validateFixture() throws {
        if let fixtures = request["fixtures"] as? [String: Any] {
        let names = fixtures["fixtureNames"] as? [String] ?? [], paths = fixtures["fixturePaths"] as? [String] ?? []
        let title = attr(window, "AXTitle") as? String ?? ""
        let rawDocument = windowDocument(window)
        let documentURL = rawDocument.hasPrefix("file:") ? URL(string: rawDocument) : URL(fileURLWithPath: rawDocument)
        let document = !rawDocument.isEmpty && documentURL?.isFileURL == true ? documentURL?.resolvingSymlinksInPath().standardizedFileURL.path ?? "" : ""
        let pathMatch = paths.contains(where: {
            let path = URL(fileURLWithPath: $0).resolvingSymlinksInPath().standardizedFileURL.path
            return !document.isEmpty && (document == path || document.hasPrefix(path + "/"))
        })
        guard pathMatch || (names.contains(title) && (request["finderOnly"] as? Bool != true || rawDocument.isEmpty)) else {
            throw failure("Fixture title or document changed; kept")
        }
        }
    }
    try validateFixture()
    guard let rawButton = attr(window, "AXCloseButton"), CFGetTypeID(rawButton) == AXUIElementGetTypeID() else {
        throw failure("Exact AX close button unavailable; kept")
    }
    let button = unsafeBitCast(rawButton, to: AXUIElement.self)
    guard attr(button, "AXEnabled") as? Bool == true else { throw failure("Close disabled; kept") }
    _ = try exactApp(request)
    try validateFixture()
    guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw failure("Close refused; kept") }
    var closed = false, dialog = false
    waitBriefly {
        guard let current = attr(element, "AXWindows") as? [AXUIElement] else { return false }
        dialog = hasDialog(current)
        closed = !current.contains(where: { CFEqual($0, window) })
        return closed || dialog
    }
    if let current = attr(element, "AXWindows") as? [AXUIElement] { dialog = dialog || hasDialog(current) }
    if dialog { return ["closed": closed, "dialog": true] }
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
