import AppKit
import ApplicationServices

let executable = "/Applications/Safari.app/Contents/MacOS/Safari"
let profileName = "sleight benchmark"
struct Refusal: Error { let message: String }
func refuse(_ message: String) -> Refusal { Refusal(message: message) }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func string(_ element: AXUIElement, _ name: String) -> String {
    if let url = attribute(element, name) as? URL { return url.absoluteString }
    return attribute(element, name) as? String ?? ""
}
func elements(_ element: AXUIElement, _ name: String = "AXChildren") -> [AXUIElement] {
    attribute(element, name) as? [AXUIElement] ?? []
}
func pump(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
var references: [(String, AXUIElement)] = []
func identifier(_ element: AXUIElement) -> String {
    if let entry = references.first(where: { CFEqual($0.1, element) }) { return entry.0 }
    let id = UUID().uuidString
    references.append((id, element)); return id
}
func chrome(_ root: AXUIElement) throws -> [AXUIElement] {
    var result: [AXUIElement] = [], visited: [AXUIElement] = []
    func walk(_ element: AXUIElement, _ depth: Int) throws {
        if visited.contains(where: { CFEqual($0, element) }) { return }
        visited.append(element)
        if string(element, "AXRole") == "AXWebArea" { return }
        guard depth < 30, visited.count < 4000 else { throw refuse("BENCH_SAFARI_AX_LIMIT") }
        result.append(element)
        for child in elements(element) { try walk(child, depth + 1) }
    }
    try walk(root, 0); return result
}
func scalars(_ element: AXUIElement) -> [String: Any] {
    var names: CFArray?
    _ = AXUIElementCopyAttributeNames(element, &names)
    var result: [String: Any] = [:]
    for name in names as? [String] ?? [] {
        let value = attribute(element, name)
        if let text = value as? String { result[name] = text }
        else if let number = value as? NSNumber { result[name] = number }
        else if let url = value as? URL { result[name] = url.absoluteString }
        else if let value = value, CFGetTypeID(value) == AXValueGetTypeID() { result[name] = String(describing: value) }
    }
    return result
}
func node(_ element: AXUIElement) -> [String: Any] {
    ["id": identifier(element), "role": string(element, "AXRole"), "title": string(element, "AXTitle"),
     "description": string(element, "AXDescription"), "value": string(element, "AXValue"),
     "identifier": string(element, "AXIdentifier"), "attributes": scalars(element)]
}
func address(_ window: AXUIElement) throws -> AXUIElement {
    let toolbars = try chrome(window).filter { string($0, "AXRole") == "AXToolbar" }
    let fields = try toolbars.flatMap { try chrome($0) }.filter {
        string($0, "AXRole") == "AXTextField" &&
        (string($0, "AXIdentifier") == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" || string($0, "AXDescription") == "Address and Search")
    }
    guard fields.count == 1 else { throw refuse("BENCH_SAFARI_ADDRESS_UNPROVED") }
    return fields[0]
}
func snapshot(_ application: AXUIElement) throws -> [String: Any] {
    var result: [[String: Any]] = []
    for window in elements(application, "AXWindows") {
        let nodes = try chrome(window)
        let toolbar = try nodes.filter { string($0, "AXRole") == "AXToolbar" }.flatMap { try chrome($0) }
        let groups = nodes.filter { string($0, "AXRole") == "AXTabGroup" }
        let tabNodes = try groups.flatMap { try chrome($0) }.filter { ["AXRadioButton", "AXTab"].contains(string($0, "AXRole")) }
        var unique: [AXUIElement] = []
        for tab in tabNodes where !unique.contains(where: { CFEqual($0, tab) }) { unique.append(tab) }
        let tabs: [[String: Any]] = unique.map { tab in
            var url = string(tab, "AXURL")
            if url.isEmpty { url = string(tab, "AXDocument") }
            // A single selected tab can be corroborated by the owned window's address field.
            if url.isEmpty && (unique.count == 1 || (attribute(tab, "AXValue") as? NSNumber)?.boolValue == true),
               let field = try? address(window) { url = string(field, "AXValue") }
            return ["id": identifier(tab), "title": string(tab, "AXTitle"), "url": url, "attributes": scalars(tab)]
        }
        result.append(["id": identifier(window), "title": string(window, "AXTitle"), "attributes": scalars(window),
                       "toolbar": toolbar.map(node), "tabs": tabs,
                       "chrome": nodes.map(node)])
    }
    return ["windows": result]
}

var owned: NSRunningApplication?, birth: Date?, launchPending = false, launchRequested = false
func ownedApplication() throws -> NSRunningApplication {
    guard let app = owned, !app.isTerminated, let date = birth,
          let current = NSRunningApplication(processIdentifier: app.processIdentifier), !current.isTerminated,
          current.launchDate == date, current.executableURL?.resolvingSymlinksInPath().path == executable else { throw refuse("BENCH_SAFARI_IDENTITY_UNPROVED") }
    return current
}
func ownedAX() throws -> AXUIElement {
    let app = AXUIElementCreateApplication(try ownedApplication().processIdentifier)
    guard AXUIElementSetMessagingTimeout(app, 5) == .success else { throw refuse("BENCH_SAFARI_AX_TIMEOUT_UNAVAILABLE") }
    return app
}
func windowById(_ id: String) throws -> AXUIElement {
    let app = try ownedAX()
    guard let entry = references.first(where: { $0.0 == id }),
          elements(app, "AXWindows").contains(where: { CFEqual($0, entry.1) }),
          elements(entry.1, "AXSheets").isEmpty else { throw refuse("BENCH_SAFARI_WINDOW_UNPROVED") }
    return entry.1
}
func press(_ element: AXUIElement) throws {
    guard AXUIElementPerformAction(element, "AXPress" as CFString) == .success else { throw refuse("BENCH_SAFARI_AX_PRESS_REFUSED") }
}
func key(_ code: CGKeyCode) throws {
    let app = try ownedApplication()
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw refuse("BENCH_SAFARI_KEY_UNAVAILABLE") }
    down.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier)
}
func newProfile() throws -> [String: Any] {
    var failure: Error?
    do {
        let app = try ownedAX()
        guard let menuBarValue = attribute(app, "AXMenuBar"), CFGetTypeID(menuBarValue) == AXUIElementGetTypeID() else { throw refuse("BENCH_SAFARI_MENU_UNAVAILABLE") }
        let menuBar = menuBarValue as! AXUIElement
        let files = elements(menuBar).filter { string($0, "AXTitle") == "File" }
        guard files.count == 1 else { throw refuse("BENCH_SAFARI_FILE_MENU_UNAVAILABLE") }
        let file = files[0], title = "New \(profileName) Window"
        func target() throws -> AXUIElement? {
            let matches = try chrome(file).filter { string($0, "AXTitle") == title && string($0, "AXRole") == "AXMenuItem" }
            guard matches.count <= 1 else { throw refuse("BENCH_SAFARI_PROFILE_MENU_AMBIGUOUS") }
            return matches.first
        }
        if try target() == nil {
            try press(file); pump(0.1)
            if try target() == nil {
                let menus = try chrome(file).filter { string($0, "AXTitle") == "New Window" && string($0, "AXRole") == "AXMenuItem" }
                guard menus.count == 1 else { throw refuse("BENCH_SAFARI_PROFILE_MENU_UNAVAILABLE") }
                try press(menus[0]); pump(0.1)
            }
        }
        guard let item = try target() else { throw refuse("BENCH_SAFARI_PROFILE_MENU_UNAVAILABLE") }
        try press(item)
    } catch { failure = error }
    // One pid-directed Escape also runs after errors; AX menus can leave a tracking session.
    try key(53)
    if let error = failure { throw error }
    return ["menuEscapePosted": true]
}
func launch() throws -> [String: Any] {
    guard owned == nil, !launchPending,
          !NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == "com.apple.Safari" }) else { throw refuse("BENCH_SAFARI_ALREADY_RUNNING") }
    launchPending = true; launchRequested = true
    let started = Date(), configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.createsNewApplicationInstance = true
    var finished = false, launchError: Error?
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/Applications/Safari.app"), configuration: configuration) { app, error in
        owned = app; birth = app?.launchDate; launchError = error; finished = true
    }
    while !finished && Date().timeIntervalSince(started) < 15 { pump(0.025) }
    guard finished else { throw refuse("BENCH_SAFARI_LAUNCH_TIMEOUT") }
    launchPending = false
    if let error = launchError { throw error }
    let app = try ownedApplication()
    guard let date = birth, date >= started else { throw refuse("BENCH_SAFARI_LAUNCH_DATE_UNPROVED") }
    return ["pid": app.processIdentifier, "executable": executable, "launchDate": date.timeIntervalSince1970]
}
func quit(_ seconds: Double) throws -> [String: Any] {
    guard !launchPending else { throw refuse("BENCH_SAFARI_LAUNCH_PENDING") }
    guard owned != nil || !launchRequested else { throw refuse("BENCH_SAFARI_LAUNCH_UNRECEIPTED") }
    if let app = owned {
        if !app.isTerminated {
            _ = try ownedApplication()
            guard app.terminate() else { throw refuse("BENCH_SAFARI_QUIT_REFUSED") }
            let deadline = Date().addingTimeInterval(seconds)
            while !app.isTerminated && Date() < deadline { pump(0.025) }
            guard app.isTerminated else { throw refuse("BENCH_BROWSER_CLEANUP_UNPROVED") }
        }
    }
    return ["browserClosed": true]
}
func command(_ input: [String: Any]) throws -> [String: Any] {
    switch input["op"] as? String {
    case "launch": return try launch()
    case "snapshot": return try snapshot(ownedAX())
    case "new-profile": return try newProfile()
    case "close-window":
        guard let id = input["window"] as? String else { throw refuse("BENCH_SAFARI_WINDOW_UNPROVED") }
        let window = try windowById(id)
        guard let closeValue = attribute(window, "AXCloseButton"), CFGetTypeID(closeValue) == AXUIElementGetTypeID() else { throw refuse("BENCH_SAFARI_CLOSE_UNAVAILABLE") }
        try press(closeValue as! AXUIElement); return [:]
    case "navigate":
        guard let id = input["window"] as? String, let url = input["url"] as? String, url.hasPrefix("data:text/html,") else { throw refuse("BENCH_SAFARI_MARKER_INVALID") }
        let field = try address(windowById(id))
        guard AXUIElementSetAttributeValue(field, "AXValue" as CFString, url as CFString) == .success,
              AXUIElementSetAttributeValue(field, "AXFocused" as CFString, kCFBooleanTrue) == .success else { throw refuse("BENCH_SAFARI_ADDRESS_SET_REFUSED") }
        try key(36); return [:]
    case "quit": return try quit(min(25, max(0.001, (input["quitMs"] as? Double ?? 25000) / 1000)))
    default: throw refuse("BENCH_SAFARI_COMMAND_INVALID")
    }
}
func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self)); fflush(stdout)
}

if CommandLine.arguments.dropFirst() == ["--self-test-unreceipted-launch"] {
    // Simulate a missing launch receipt; quit must refuse before any app lookup.
    launchRequested = true
    do { try emit(quit(0.001)); exit(1) }
    catch { try emit(["error": (error as? Refusal)?.message ?? error.localizedDescription]); exit(0) }
}
if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--probe", let pid = Int32(CommandLine.arguments[2]), pid > 0 {
    // Read-only, no launch/activation/menu/input/quit; attributes of every existing window.
    guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == "com.apple.Safari",
          app.executableURL?.resolvingSymlinksInPath().path == executable else { throw refuse("BENCH_SAFARI_PROBE_IDENTITY") }
    try emit(snapshot(AXUIElementCreateApplication(pid))); exit(0)
}
guard CommandLine.arguments.count == 1 else { exit(64) }
while let line = readLine() {
    do {
        guard let input = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { throw refuse("BENCH_SAFARI_COMMAND_INVALID") }
        try emit(command(input))
    } catch { try emit(["error": (error as? Refusal)?.message ?? error.localizedDescription]) }
}
// EOF collects only the recorded owned launch and never force-quits or answers a dialog.
do { _ = try quit(25) } catch { fputs("BENCH_BROWSER_CLEANUP_UNPROVED\n", stderr); exit(1) }
