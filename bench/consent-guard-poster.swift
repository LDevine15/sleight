// Separate-process input attempts against only the probe's PID and exact test button.
import ApplicationServices
import Foundation
import Darwin

func fail(_ text: String) -> Never { fputs(text + "\n", stderr); exit(1) }
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 4, let pid = Int32(args[1]), pid > 0,
    let x = Double(args[2]), let y = Double(args[3]), x.isFinite, y.isFinite else { fail("usage: poster ax|pid|hid PID X Y") }
// These checks never request TCC permission. The operator supplies it outside this probe if needed.
guard AXIsProcessTrusted() else { fail("Accessibility is not granted; no permission prompt requested") }
let mode = args[0]
if mode == "ax" {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 2)
    func attribute(_ element: AXUIElement, _ key: CFString) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key, &value) == .success else { return nil }
        return value
    }
    var visited = 0
    func find(_ element: AXUIElement, _ depth: Int = 0) -> AXUIElement? {
        visited += 1
        guard depth < 20, visited < 1000 else { return nil }
        let title = attribute(element, kAXTitleAttribute as CFString) as? String
        let role = attribute(element, kAXRoleAttribute as CFString) as? String
        if title == "Always allow" && role == kAXButtonRole as String { return element }
        for child in attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? [] {
            if let result = find(child, depth + 1) { return result }
        }
        return nil
    }
    guard let button = find(app) else { fail("probe button not found in the supplied PID") }
    let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
    print("{\"mode\":\"ax\",\"axResult\":\(result.rawValue)}")
} else {
    guard ["pid", "hid"].contains(mode) else { fail("unknown posting mode") }
    guard CGPreflightPostEventAccess() else { fail("Post-event access is not granted; no permission prompt requested") }
    let state: CGEventSourceStateID = mode == "hid" ? .hidSystemState : .privateState
    guard let source = CGEventSource(stateID: state) else { fail("event source unavailable") }
    source.userData = 0
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type,
            mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { fail("mouse event unavailable") }
        // Try spoofed HID provenance through WindowServer, not just an in-memory NSEvent seam.
        if mode == "hid" {
            event.setIntegerValueField(.eventSourceStateID, value: Int64(CGEventSourceStateID.hidSystemState.rawValue))
            event.setIntegerValueField(.eventSourceUnixProcessID, value: 0)
        }
        event.setIntegerValueField(.eventSourceUserData, value: 0)
        let fields: [String: Any] = ["mode": mode, "type": event.type.rawValue,
            "sourceState": event.getIntegerValueField(.eventSourceStateID),
            "sourcePid": event.getIntegerValueField(.eventSourceUnixProcessID),
            "userData": event.getIntegerValueField(.eventSourceUserData)]
        print(String(data: try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), encoding: .utf8)!)
        if mode == "pid" { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
        usleep(100_000)
    }
}
