// Separate child of the runner. All input is bound to one fixture PID, window and Allow Once button.
// No TCC prompt and no global HID posting. Spoofed HID metadata is still delivered only to the owned PID.
import ApplicationServices
import Foundation
import Darwin

func receipt(_ outcome: String, _ fields: [String: Any] = [:]) {
    var record = fields; record["outcome"] = outcome
    let bytes = try! JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes + Data([10]))
}
func fail(_ reason: String) -> Never { receipt("poster-failed", ["reason": reason]); exit(1) }
func permission(_ name: String) -> Never { receipt("permission-absent", ["permission": name]); exit(77) }
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 5, ["ax", "pid", "hid"].contains(args[0]),
    let pid = Int32(args[1]), pid > 0, getppid() > 1,
    let window = UInt32(args[2]), window > 0,
    let x = Double(args[3]), let y = Double(args[4]), x.isFinite, y.isFinite else { fail("ARGUMENTS") }
let mode = args[0]
// AX calls have individual timeouts; this independent ceiling also bounds an unresponsive AX traversal.
DispatchQueue.global().asyncAfter(deadline: .now() + 8) { fail("POSTER_DEADLINE") }
let expectedBinary = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
    .appendingPathComponent("shell-card").resolvingSymlinksInPath().path
func fixtureIdentity() {
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0,
        (String(cString: path) as NSString).resolvingSymlinksInPath == expectedBinary else { fail("FIXTURE_BINARY_IDENTITY") }
}
fixtureIdentity()
guard AXIsProcessTrusted() else { permission("Accessibility") }
if mode != "ax" { guard CGPreflightPostEventAccess() else { permission("Post-event") } }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 1)
func attribute(_ element: AXUIElement, _ key: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key, &value) == .success else { return nil }
    return value
}
func point(_ element: AXUIElement) -> CGPoint? {
    guard let raw = attribute(element, kAXPositionAttribute as CFString), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var value = CGPoint.zero
    guard AXValueGetValue(raw as! AXValue, .cgPoint, &value) else { return nil }
    return value
}
func size(_ element: AXUIElement) -> CGSize? {
    guard let raw = attribute(element, kAXSizeAttribute as CFString), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var value = CGSize.zero
    guard AXValueGetValue(raw as! AXValue, .cgSize, &value) else { return nil }
    return value
}
func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 1 }
func target() -> AXUIElement {
    fixtureIdentity()
    guard !FileManager.default.fileExists(atPath: "/tmp/sleight-hold") else { fail("HOLD") }
    // Quartz's ID arrays contain raw window IDs, not CFNumber objects. Request only our fixture window.
    var requestedWindow = UnsafeRawPointer(bitPattern: UInt(window))
    guard let requestedWindows = CFArrayCreate(kCFAllocatorDefault, &requestedWindow, 1, nil),
        let list = CGWindowListCreateDescriptionFromArray(requestedWindows) as? [[String: Any]] else { fail("WINDOW_QUERY_UNAVAILABLE") }
    guard list.count == 1 else { fail("WINDOW_QUERY_COUNT") }
    guard let info = list.first else { fail("WINDOW_QUERY_EMPTY") }
    guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else { fail("WINDOW_OWNER_MISMATCH") }
    guard (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window else { fail("WINDOW_NUMBER_MISMATCH") }
    guard let bounds = info[kCGWindowBounds as String] as? NSDictionary else { fail("WINDOW_BOUNDS_UNAVAILABLE") }
    guard let rect = CGRect(dictionaryRepresentation: bounds) else { fail("WINDOW_BOUNDS_MALFORMED") }
    guard rect.contains(CGPoint(x: x, y: y)) else { fail("WINDOW_POINT_OUTSIDE") }
    guard let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] else { fail("AX_WINDOWS_UNAVAILABLE") }
    let matches = windows.filter { element in
        guard let origin = point(element), let extent = size(element) else { return false }
        return near(origin.x, rect.minX) && near(origin.y, rect.minY) && near(extent.width, rect.width) && near(extent.height, rect.height)
    }
    guard matches.count == 1 else { fail("AMBIGUOUS_WINDOW") }
    var visited = 0, buttons: [AXUIElement] = [], truncated = false
    func walk(_ element: AXUIElement, _ depth: Int) {
        visited += 1
        guard visited < 1000, depth < 20 else { truncated = true; return }
        if attribute(element, kAXTitleAttribute as CFString) as? String == "Allow Once",
            attribute(element, kAXRoleAttribute as CFString) as? String == kAXButtonRole as String { buttons.append(element) }
        for child in attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? [] { walk(child, depth + 1) }
    }
    walk(matches[0], 0)
    guard !truncated, buttons.count == 1, let button = buttons.first,
        attribute(button, kAXEnabledAttribute as CFString) as? Bool == true,
        let origin = point(button), let extent = size(button),
        near(origin.x + extent.width / 2, CGFloat(x)), near(origin.y + extent.height / 2, CGFloat(y)) else { fail("BUTTON_IDENTITY") }
    return button
}
if mode == "ax" {
    let result = AXUIElementPerformAction(target(), kAXPressAction as CFString)
    receipt("attempted", ["mode": mode, "pid": pid, "window": window, "axResult": result.rawValue])
} else {
    let state: CGEventSourceStateID = mode == "hid" ? .hidSystemState : .privateState
    guard let source = CGEventSource(stateID: state) else { fail("EVENT_SOURCE") }
    source.userData = 0
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        _ = target()
        guard let event = CGEvent(mouseEventSource: source, mouseType: type,
            mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { fail("MOUSE_EVENT") }
        if mode == "hid" {
            event.setIntegerValueField(.eventSourceStateID, value: Int64(CGEventSourceStateID.hidSystemState.rawValue))
            event.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
        }
        event.setIntegerValueField(.eventSourceUserData, value: 0)
        event.postToPid(pid)
        receipt("posted-event", ["mode": mode, "pid": pid, "window": window, "type": event.type.rawValue,
            "sourceState": event.getIntegerValueField(.eventSourceStateID),
            "sourcePid": event.getIntegerValueField(.eventSourceUnixProcessID),
            "userData": event.getIntegerValueField(.eventSourceUserData)])
        usleep(100000)
    }
    receipt("attempted", ["mode": mode, "pid": pid, "window": window])
}
