import AppKit
import ApplicationServices

// Accessibility bridge for bench/fowl/chrome-allow.mjs. It reads one Chrome process's windows and presses one button by AX
// action. It never activates an app, raises a window, posts an event or moves the pointer, and it asks for no permission
// prompt. The policy (which window is Claude's prompt, which button to press) lives in the JS module, where it is tested.
//
//   chrome-allow windows <pid>                      window list: title, subrole, size, tab strip present
//   chrome-allow tree <pid> <index> <title>         one window's AX tree (turns on Chrome's page accessibility first)
//   chrome-allow press <pid> <index> <title> <path> <label>
//                                                   AXPress on the button at child-index path, if it still reads <label>
// Output is one JSON line. Failures are {"ok":false,"error":CODE}.

func fail(_ code: String) -> Never {
    print("{\"ok\":false,\"error\":\"\(code)\"}")
    exit(0)
}
func emit(_ value: [String: Any]) -> Never {
    var out = value
    out["ok"] = true
    guard let data = try? JSONSerialization.data(withJSONObject: out), let line = String(data: data, encoding: .utf8) else { fail("encode") }
    print(line)
    exit(0)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func string(_ element: AXUIElement, _ name: String) -> String {
    if let url = attribute(element, name) as? URL { return url.absoluteString }
    if let text = attribute(element, name) as? String { return text }
    return ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, "AXChildren") as? [AXUIElement] ?? []
}
func size(_ element: AXUIElement) -> (Double, Double) {
    guard let raw = attribute(element, "AXSize"), CFGetTypeID(raw) == AXValueGetTypeID() else { return (0, 0) }
    var value = CGSize.zero
    AXValueGetValue(raw as! AXValue, .cgSize, &value)
    return (Double(value.width), Double(value.height))
}
func clip(_ text: String) -> String { text.count > 400 ? String(text.prefix(400)) : text }

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2, let pidValue = Int32(arguments[1]), pidValue > 1 else { fail("usage") }
guard AXIsProcessTrusted() else { fail("not-trusted") } // Never request the permission prompt.
guard let app = NSRunningApplication(processIdentifier: pidValue), !app.isTerminated,
      app.bundleIdentifier == "com.google.Chrome" else { fail("not-chrome") }
let application = AXUIElementCreateApplication(pidValue)
let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []

// Chrome's own toolbar and tab strip, without descending into page content.
func hasChromeUI(_ window: AXUIElement) -> (tabs: Bool, toolbar: Bool) {
    var tabs = false, toolbar = false, visited = 0
    func walk(_ element: AXUIElement, _ depth: Int) {
        visited += 1
        if depth > 8 || visited > 300 { return }
        let role = string(element, "AXRole")
        if role == "AXWebArea" { return }
        if role == "AXTabGroup" || string(element, "AXSubrole") == "AXTabButton" { tabs = true }
        if role == "AXToolbar" { toolbar = true }
        for child in children(element) { walk(child, depth + 1) }
    }
    walk(window, 0)
    return (tabs, toolbar)
}

func window(at indexText: String, titled title: String) -> AXUIElement {
    guard let index = Int(indexText), index >= 0, index < windows.count else { fail("stale") }
    let candidate = windows[index]
    guard string(candidate, "AXTitle") == title else { fail("stale") }
    return candidate
}

var budget = 900
func describe(_ element: AXUIElement, _ depth: Int) -> [String: Any] {
    budget -= 1
    var node: [String: Any] = ["role": string(element, "AXRole")]
    for (key, name) in [("subrole", "AXSubrole"), ("title", "AXTitle"), ("desc", "AXDescription"), ("value", "AXValue"),
                        ("url", "AXURL"), ("id", "AXIdentifier")] {
        let text = clip(string(element, name))
        if !text.isEmpty { node[key] = text }
    }
    if let enabled = attribute(element, "AXEnabled") as? Bool { node["enabled"] = enabled }
    if depth < 25, budget > 0 {
        node["children"] = children(element).prefix(60).compactMap { budget > 0 ? describe($0, depth + 1) : nil }
    }
    return node
}

switch arguments[0] {
case "windows":
    emit(["windows": windows.enumerated().map { index, item -> [String: Any] in
        let (w, h) = size(item)
        let ui = hasChromeUI(item)
        return ["index": index, "title": clip(string(item, "AXTitle")), "subrole": string(item, "AXSubrole"),
                "w": w, "h": h, "tabs": ui.tabs, "toolbar": ui.toolbar]
    }])
case "tree":
    guard arguments.count == 4 else { fail("usage") }
    let target = window(at: arguments[2], titled: arguments[3])
    // Chrome builds page accessibility on request. This is an attribute write on the app; it takes no focus.
    _ = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    emit(["tree": describe(target, 0)])
case "press":
    guard arguments.count == 6 else { fail("usage") }
    var element = window(at: arguments[2], titled: arguments[3])
    for step in arguments[4].split(separator: ",") {
        guard let index = Int(step), index >= 0 else { fail("stale") }
        let below = children(element)
        guard index < below.count else { fail("stale") }
        element = below[index]
    }
    let label = arguments[5]
    guard string(element, "AXRole") == "AXButton", attribute(element, "AXEnabled") as? Bool != false,
          [string(element, "AXTitle"), string(element, "AXDescription"), string(element, "AXValue")].contains(label)
    else { fail("stale") }
    guard AXUIElementPerformAction(element, "AXPress" as CFString) == .success else { fail("press-failed") }
    emit(["pressed": true])
default:
    fail("usage")
}
