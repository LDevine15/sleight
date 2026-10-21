// Separate child of the runner. All input is bound to one fixture PID, window and Allow Once button.
// No TCC prompt and no global HID posting. Spoofed HID metadata is still delivered only to the owned PID.
import AppKit
import Foundation
import Darwin

func receipt(_ outcome: String, _ fields: [String: Any] = [:]) {
    var record = fields; record["outcome"] = outcome
    let bytes = try! JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes + Data([10]))
}
func fail(_ reason: String) -> Never { receipt("poster-failed", ["reason": reason]); exit(1) }
func permission(_ name: String) -> Never { receipt("permission-absent", ["permission": name]); exit(77) }
// BEGIN SHELL MOUSE EVENT
private typealias ShellWindowLocationSetter = @convention(c) (CGEvent, CGPoint) -> Void
private typealias ShellWindowLocationGetter = @convention(c) (CGEvent) -> CGPoint
private let shellWindowLocation: (set: ShellWindowLocationSetter, get: ShellWindowLocationGetter)? = {
    guard let framework = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW | RTLD_LOCAL) else { return nil }
    guard let setter = dlsym(framework, "CGEventSetWindowLocation"),
        let getter = dlsym(framework, "CGEventGetWindowLocation") else {
        dlclose(framework)
        return nil
    }
    // Keep the framework loaded for the lifetime of these function pointers.
    return (unsafeBitCast(setter, to: ShellWindowLocationSetter.self),
        unsafeBitCast(getter, to: ShellWindowLocationGetter.self))
}()
func shellMouseEvent(type: CGEventType, source: CGEventSource, mode: String,
    window: UInt32, rect: CGRect, point: CGPoint) -> CGEvent? {
    guard [.leftMouseDown, .leftMouseUp].contains(type), window > 0, rect.contains(point),
        let windowLocation = shellWindowLocation else { return nil }
    let local = CGPoint(x: point.x - rect.minX, y: rect.maxY - point.y)
    guard let native = NSEvent.mouseEvent(with: type == .leftMouseDown ? .leftMouseDown : .leftMouseUp,
        location: local, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: Int(window), context: nil, eventNumber: 1, clickCount: 1,
        pressure: type == .leftMouseDown ? 1 : 0), let event = native.cgEvent else { return nil }
    event.setSource(source)
    // A foreign window has no local AppKit transform. Set the global point first;
    // the window-location annotation uses a top-left origin, unlike NSEvent.
    event.location = point
    event.flags = []
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    if mode == "hid" {
        event.setIntegerValueField(.eventSourceStateID, value: Int64(CGEventSourceStateID.hidSystemState.rawValue))
        event.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
    }
    event.setIntegerValueField(.eventSourceUserData, value: 0)
    windowLocation.set(event, CGPoint(x: point.x - rect.minX, y: point.y - rect.minY))
    return event
}
// END SHELL MOUSE EVENT
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 5, ["ax", "pid", "hid", "inspect"].contains(args[0]),
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
if ["pid", "hid"].contains(mode) { guard CGPreflightPostEventAccess() else { permission("Post-event") } }
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
func target() -> (button: AXUIElement, rect: CGRect) {
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
    guard matches.count == 1 else {
        // Metadata from this verified fixture PID only. Never read window titles or document text.
        let geometry: [[String: Any]] = windows.prefix(8).map { element in
            var values: [String: Any] = [:]
            if let origin = point(element) { values["x"] = origin.x; values["y"] = origin.y }
            if let extent = size(element) { values["width"] = extent.width; values["height"] = extent.height }
            return values
        }
        receipt("window-diagnostic", ["axWindows": windows.count, "geometryMatches": matches.count,
            "expected": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
            "axGeometry": geometry, "truncated": windows.count > 8])
        if windows.isEmpty {
            // Observe publication timing only after failure. Even a later window cannot resume input.
            let started = ProcessInfo.processInfo.systemUptime
            for delay: useconds_t in [100000, 400000] {
                usleep(delay)
                fixtureIdentity()
                guard !FileManager.default.fileExists(atPath: "/tmp/sleight-hold") else { fail("HOLD") }
                var value: CFTypeRef?
                let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
                let count = (value as? [AXUIElement])?.count ?? -1
                receipt("window-publication-sample", ["afterMs": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
                    "axStatus": status.rawValue, "axWindows": count])
            }
        }
        fail("AMBIGUOUS_WINDOW")
    }
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
    return (button, rect)
}
if mode == "inspect" {
    fixtureIdentity()
    guard !FileManager.default.fileExists(atPath: "/tmp/sleight-hold") else { fail("HOLD") }
    var requestedWindow = UnsafeRawPointer(bitPattern: UInt(window))
    guard let requestedWindows = CFArrayCreate(kCFAllocatorDefault, &requestedWindow, 1, nil),
        let list = CGWindowListCreateDescriptionFromArray(requestedWindows) as? [[String: Any]] else { fail("INSPECTION_WINDOW_QUERY_UNAVAILABLE") }
    guard list.count == 1 else { fail("INSPECTION_WINDOW_QUERY_COUNT") }
    guard let info = list.first else { fail("INSPECTION_WINDOW_QUERY_EMPTY") }
    guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else { fail("INSPECTION_WINDOW_OWNER_MISMATCH") }
    guard (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window else { fail("INSPECTION_WINDOW_NUMBER_MISMATCH") }
    // CGWindow.h defines an absent optional key as not ordered on screen.
    // Visibility is an observation, separate from the required identity fields above.
    let onscreenValue = info[kCGWindowIsOnscreen as String]
    if let onscreenValue, !(onscreenValue is Bool) { fail("INSPECTION_WINDOW_ONSCREEN_MALFORMED") }
    let onscreen = onscreenValue as? Bool ?? false
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    receipt("inspection", ["mode": mode, "pid": pid, "window": window, "cgOnscreen": onscreen,
        "cgOnscreenKeyPresent": onscreenValue != nil,
        "axStatus": status.rawValue, "axWindows": (value as? [AXUIElement])?.count ?? -1])
    exit(0)
} else if mode == "ax" {
    let result = AXUIElementPerformAction(target().button, kAXPressAction as CFString)
    receipt("attempted", ["mode": mode, "pid": pid, "window": window, "axResult": result.rawValue])
} else {
    let state: CGEventSourceStateID = mode == "hid" ? .hidSystemState : .privateState
    guard let source = CGEventSource(stateID: state) else { fail("EVENT_SOURCE") }
    source.userData = 0
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        let bound = target()
        guard let event = shellMouseEvent(type: type, source: source, mode: mode,
            window: window, rect: bound.rect, point: CGPoint(x: x, y: y)) else { fail("MOUSE_EVENT") }
        // Sender-side NSEvent cannot convert a foreign window's local point.
        // Validate its stored top-left annotation against the verified geometry.
        guard let windowLocation = shellWindowLocation,
            let native = NSEvent(cgEvent: event), native.windowNumber == Int(window),
            near(event.location.x, CGFloat(x)), near(event.location.y, CGFloat(y)),
            near(windowLocation.get(event).x, CGFloat(x) - bound.rect.minX),
            near(windowLocation.get(event).y, CGFloat(y) - bound.rect.minY), native.clickCount == 1 else {
            receipt("event-encoding-failed", ["window": window, "screenPoint": ["x": event.location.x, "y": event.location.y]])
            fail("MOUSE_EVENT_BINDING")
        }
        event.postToPid(pid)
        receipt("posted-event", ["mode": mode, "pid": pid, "window": window, "type": event.type.rawValue,
            "sourceState": event.getIntegerValueField(.eventSourceStateID),
            "sourcePid": event.getIntegerValueField(.eventSourceUnixProcessID),
            "userData": event.getIntegerValueField(.eventSourceUserData)])
        usleep(100000)
    }
    receipt("attempted", ["mode": mode, "pid": pid, "window": window])
}
