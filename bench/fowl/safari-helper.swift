import AppKit
import ApplicationServices

// /Applications/Safari.app is a symlink into the Safari cryptex on current macOS, and a running Safari reports the
// cryptex path, so the identity checks compare against the resolved path (2026-10-18: every launch failed identity).
let executable = URL(fileURLWithPath: "/Applications/Safari.app/Contents/MacOS/Safari").resolvingSymlinksInPath().path
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
func attributeNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    _ = AXUIElementCopyAttributeNames(element, &names)
    return names as? [String] ?? []
}
func redactedAttributes(_ names: [String], profileAttribute: String? = nil) -> [String: String] {
    Dictionary(uniqueKeysWithValues: names.map { ($0, $0 == profileAttribute ? profileName : "[redacted]") })
}
func preferredProfileEvidence(_ matches: [[String: Any]]) -> [String: Any]? {
    let preferred = matches.filter { ($0["identifier"] as? String ?? "").localizedCaseInsensitiveContains("profile") }
    let candidates = preferred.isEmpty ? matches : preferred
    return candidates.count == 1 ? candidates[0] : nil
}
// Safari 26 labels the toolbar profile button only through its identifier, "TabGroupPickerButton?Profile=sleight%20benchmark&Icon=...";
// its title, description and value are empty (2026-10-18).
func identifierProfile(_ identifier: String) -> String? {
    guard identifier.hasPrefix("TabGroupPickerButton?"), let query = identifier.split(separator: "?", maxSplits: 1).last else { return nil }
    for pair in query.split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        if parts.count == 2, parts[0] == "Profile" { return parts[1].removingPercentEncoding }
    }
    return nil
}
func profileEvidence(_ window: AXUIElement) throws -> [String: Any]? {
    let toolbar = try chrome(window).filter { string($0, "AXRole") == "AXToolbar" }.flatMap { try chrome($0) }
    var matches: [[String: Any]] = []
    for element in toolbar where ["AXMenuButton", "AXPopUpButton", "AXButton"].contains(string(element, "AXRole")) {
        let named = ["AXTitle", "AXDescription", "AXValue"].first { string(element, $0) == profileName }
        let attribute = named ?? (identifierProfile(string(element, "AXIdentifier")) == profileName ? "AXIdentifier" : nil)
        if let name = attribute {
            matches.append(["element": identifier(element), "role": string(element, "AXRole"),
                            "identifier": string(element, "AXIdentifier"), "attribute": name, "value": profileName])
        }
    }
    return preferredProfileEvidence(matches)
}
// The sidebar (an AXOutline named LibraryView) lists tabs and groups; with it open the tab count is not readable here.
func hasSidebar(_ window: AXUIElement) throws -> Bool {
    try chrome(window).contains { string($0, "AXRole") == "AXOutline" || string($0, "AXIdentifier") == "LibraryView" }
}
// A window still showing Safari's Start Page (no web content, nothing navigated) is what a fresh launch opens.
func isStartPage(_ window: AXUIElement) throws -> Bool {
    var web = false
    func hasWebArea(_ element: AXUIElement, _ depth: Int) throws {
        guard depth < 30 else { throw refuse("BENCH_SAFARI_AX_LIMIT") }
        if string(element, "AXRole") == "AXWebArea" { web = true; return }
        for child in elements(element) { try hasWebArea(child, depth + 1) }
    }
    try hasWebArea(window, 0)
    return try !web && chrome(window).contains { string($0, "AXIdentifier") == "StartPageCollectionView" }
}
func windowSnapshot(_ id: String, evidence: [String: Any]?, startPage: Bool = false, content: () throws -> [String: Any]) rethrows -> [String: Any] {
    var result: [String: Any] = ["id": id, "profileEvidence": evidence as Any? ?? NSNull()]
    if startPage { result["startPage"] = true }
    if evidence != nil { result.merge(try content()) { _, new in new } }
    return result
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
    let result = try elements(application, "AXWindows").map { window in
        try windowSnapshot(identifier(window), evidence: profileEvidence(window), startPage: isStartPage(window)) {
            let groups = try chrome(window).filter { string($0, "AXRole") == "AXTabGroup" }
            // Safari 26 puts the tab bar in an AXOpaqueProviderGroup beside the split group, with AXRadioButton/AXTabButton children,
            // and draws no tab bar for a single tab.
            let tabNodes = try (groups.flatMap { try chrome($0) } + chrome(window).filter { string($0, "AXSubrole") == "AXTabButton" })
                .filter { ["AXRadioButton", "AXTab"].contains(string($0, "AXRole")) }
            var unique: [AXUIElement] = []
            for tab in tabNodes where !unique.contains(where: { CFEqual($0, tab) }) { unique.append(tab) }
            let title = string(window, "AXTitle")
            if unique.isEmpty, groups.count == 1, try !hasSidebar(window), let field = try? address(window) {
                // No tab bar and no sidebar listing tabs means one tab; its title is the window title after the profile prefix.
                let prefix = profileName + " — ", url = string(field, "AXValue")
                return ["title": title, "tabs": url.isEmpty ? [] : [["id": identifier(groups[0]),
                    "title": title.hasPrefix(prefix) ? String(title.dropFirst(prefix.count)) : title, "url": url]]]
            }
            let tabs: [[String: Any]] = unique.map { tab in
                var url = string(tab, "AXURL")
                if url.isEmpty { url = string(tab, "AXDocument") }
                // A selected tab can use the verified profile window's address field.
                if url.isEmpty && (unique.count == 1 || (attribute(tab, "AXValue") as? NSNumber)?.boolValue == true),
                   let field = try? address(window) { url = string(field, "AXValue") }
                return ["id": identifier(tab), "title": string(tab, "AXTitle"), "url": url]
            }
            return ["title": title, "tabs": tabs]
        }
    }
    return ["windows": result]
}
func probeSnapshot(_ application: AXUIElement) throws -> [String: Any] {
    let windows = try elements(application, "AXWindows").map { window -> [String: Any] in
        let evidence = try profileEvidence(window)
        let nodes = try chrome(window).map { element -> [String: Any] in
            let id = identifier(element)
            return ["id": id, "role": string(element, "AXRole"),
                    "attributes": redactedAttributes(attributeNames(element),
                        profileAttribute: id == evidence?["element"] as? String ? evidence?["attribute"] as? String : nil)]
        }
        return ["id": identifier(window), "chrome": nodes]
    }
    return ["windows": windows]
}

var owned: NSRunningApplication?, birth: Date?, launchPending = false, launchRequested = false, profileRequested = false
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
    guard try profileEvidence(entry.1) != nil else { throw refuse("BENCH_SAFARI_PROFILE_WINDOW_UNPROVED") }
    return entry.1
}
func press(_ element: AXUIElement) throws {
    guard AXUIElementPerformAction(element, "AXPress" as CFString) == .success else { throw refuse("BENCH_SAFARI_AX_PRESS_REFUSED") }
}
func verifyKeyWindow(hasProfile: Bool, matches: Bool) throws {
    guard hasProfile && matches else { throw refuse("BENCH_SAFARI_KEY_WINDOW_UNPROVED") }
}
func key(_ code: CGKeyCode, window: AXUIElement) throws {
    let app = try ownedApplication(), ax = try ownedAX()
    let focused = attribute(ax, "AXFocusedWindow")
    try verifyKeyWindow(hasProfile: try profileEvidence(window) != nil,
                        matches: focused.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, window) } ?? false)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw refuse("BENCH_SAFARI_KEY_UNAVAILABLE") }
    down.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier)
}
func keyProfileWindow() throws -> AXUIElement {
    let app = try ownedAX()
    guard let focused = attribute(app, "AXFocusedWindow"), CFGetTypeID(focused) == AXUIElementGetTypeID() else { throw refuse("BENCH_SAFARI_KEY_WINDOW_UNPROVED") }
    return try windowById(identifier(focused as! AXUIElement))
}
func menuStateClear(_ nodes: [[String: Any]]) -> Bool {
    !nodes.contains { node in
        (node["role"] as? String ?? "").isEmpty ||
        (node["role"] as? String == "AXMenuBarItem" && node["selected"] as? Bool != false) ||
        (node["role"] as? String == "AXMenu" && node["visible"] as? Bool != false)
    }
}
func menusClear() throws -> Bool {
    let app = try ownedAX()
    guard let value = attribute(app, "AXMenuBar"), CFGetTypeID(value) == AXUIElementGetTypeID(),
          attribute(value as! AXUIElement, "AXChildren") is [AXUIElement] else { throw refuse("BENCH_SAFARI_MENU_STUCK") }
    // Only the bar, its items and each item's menu say whether a menu is open. Walking every menu item (about 3,800 elements in
    // Safari 26) is slow and races Safari rebuilding its menus after a press (an element vanishes mid-walk, 2026-10-18).
    let bar = value as! AXUIElement
    let nodes = [bar] + elements(bar).flatMap { [$0] + elements($0) }
    return menuStateClear(try nodes.map { element in
        let names = attributeNames(element), role = string(element, "AXRole")
        guard !names.isEmpty, menuChildrenReadable(role: role, names: names, readable: attribute(element, "AXChildren") is [AXUIElement]) else { throw refuse("BENCH_SAFARI_MENU_STUCK") }
        return ["role": role, "selected": attribute(element, "AXSelected") as Any,
                "visible": menuVisible(role: role, names: names, value: attribute(element, "AXVisible") as Any)]
    })
}
// Safari 26 (2026-10-18): AXMenu has no AXVisible at all, so an open menu shows as a selected bar item.
func menuChildrenReadable(role: String, names: [String], readable: Bool) -> Bool {
    !["AXMenuBar", "AXMenuBarItem", "AXMenu"].contains(role) || !names.contains("AXChildren") || readable
}
func menuVisible(role: String, names: [String], value: Any) -> Any {
    role == "AXMenu" && !names.contains("AXVisible") ? false : value
}
// Right after a menu item is pressed Safari rebuilds its menus, and a menu can briefly refuse to list its children (2026-10-18).
func menusClearSoon(_ seconds: Double) throws -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline { if (try? menusClear()) == true { return true }; pump(0.05) }
    return try menusClear()
}
func cleanMenus(escape: () throws -> Void, clear: () throws -> Bool) throws -> [String: Any] {
    for count in 1...2 {
        try escape()
        if try clear() { return ["menuEscapePosted": true, "menuEscapes": count, "menuCleared": true] }
    }
    throw refuse("BENCH_SAFARI_MENU_STUCK")
}
func newProfile() throws -> [String: Any] {
    profileRequested = true
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
    // Menu tracking must be dismissed, but keys must never reach an owner window.
    let deadline = Date().addingTimeInterval(2)
    while (try? keyProfileWindow()) == nil && Date() < deadline { pump(0.025) }
    let cleanup = try cleanMenus(escape: { try key(53, window: keyProfileWindow()); pump(0.1) }, clear: { try menusClearSoon(1) })
    if let error = failure { throw error }
    return cleanup
}
func launch() throws -> [String: Any] {
    guard owned == nil, !launchPending,
          !NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == "com.apple.Safari" }) else { throw refuse("BENCH_SAFARI_ALREADY_RUNNING") }
    launchPending = true; launchRequested = true
    let started = Date(), configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.createsNewApplicationInstance = true
    // Never reopen the windows of an earlier session (the owner's or a quit round's): they belong to other profiles and stop
    // the round (BENCH_SAFARI_RESTORED_WINDOWS, 2026-10-18). The argument only affects this launch, not the owner's settings.
    configuration.arguments = ["-ApplePersistenceIgnoreState", "YES"]
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
// A task that typed into a form leaves Safari asking "Are you sure you want to quit Safari? You have entered text on ..."
// (AXDialog UnsubmittedFormTextAlert), which blocks the quit for good (2026-10-18: form-checkout left Safari running). That alert
// is about the benchmark page in the process this helper launched; confirming it only discards the round's own form text.
func confirmUnsubmittedFormQuit() -> Bool {
    guard let ax = try? ownedAX() else { return false }
    for window in elements(ax, "AXWindows") where string(window, "AXIdentifier") == "UnsubmittedFormTextAlert" && string(window, "AXSubrole") == "AXDialog" {
        for button in elements(window) where string(button, "AXIdentifier") == "ConfirmButton" && string(button, "AXTitle") == "Quit" {
            return AXUIElementPerformAction(button, "AXPress" as CFString) == .success
        }
    }
    return false
}
func quit(_ seconds: Double) throws -> [String: Any] {
    guard !launchPending else { throw refuse("BENCH_SAFARI_LAUNCH_PENDING") }
    guard owned != nil || !launchRequested else { throw refuse("BENCH_SAFARI_LAUNCH_UNRECEIPTED") }
    var confirmed = false
    if let app = owned {
        if !app.isTerminated {
            _ = try ownedApplication()
            guard app.terminate() else { throw refuse("BENCH_SAFARI_QUIT_REFUSED") }
            let deadline = Date().addingTimeInterval(seconds)
            while !app.isTerminated && Date() < deadline {
                if !confirmed && confirmUnsubmittedFormQuit() { confirmed = true }
                pump(0.025)
            }
            guard app.isTerminated else { throw refuse("BENCH_BROWSER_CLEANUP_UNPROVED") }
        }
    }
    return ["browserClosed": true, "unsubmittedFormQuitConfirmed": confirmed]
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
    case "close-launch-window":
        // Only the Start Page window Safari opens by itself in the first two minutes of the process this helper launched, and
        // only before the benchmark's own window exists. It holds no navigation, so nothing of the owner's is lost.
        guard let id = input["window"] as? String else { throw refuse("BENCH_SAFARI_WINDOW_UNPROVED") }
        let app = try ownedAX()
        guard !profileRequested, let started = birth, Date().timeIntervalSince(started) < 120 else { throw refuse("BENCH_SAFARI_LAUNCH_WINDOW_UNPROVED") }
        guard let entry = references.first(where: { $0.0 == id }),
              elements(app, "AXWindows").contains(where: { CFEqual($0, entry.1) }),
              elements(entry.1, "AXSheets").isEmpty else { throw refuse("BENCH_SAFARI_WINDOW_UNPROVED") }
        guard try isStartPage(entry.1) else { throw refuse("BENCH_SAFARI_LAUNCH_WINDOW_UNPROVED") }
        guard let closeValue = attribute(entry.1, "AXCloseButton"), CFGetTypeID(closeValue) == AXUIElementGetTypeID() else { throw refuse("BENCH_SAFARI_CLOSE_UNAVAILABLE") }
        try press(closeValue as! AXUIElement); return [:]
    case "navigate":
        guard let id = input["window"] as? String, let url = input["url"] as? String, url.hasPrefix("data:text/html,") else { throw refuse("BENCH_SAFARI_MARKER_INVALID") }
        let window = try windowById(id), field = try address(window)
        try verifyKeyWindow(hasProfile: try profileEvidence(window) != nil,
                            matches: attribute(try ownedAX(), "AXFocusedWindow").map { CFEqual($0, window) } ?? false)
        guard AXUIElementSetAttributeValue(field, "AXValue" as CFString, url as CFString) == .success,
              AXUIElementSetAttributeValue(field, "AXFocused" as CFString, kCFBooleanTrue) == .success else { throw refuse("BENCH_SAFARI_ADDRESS_SET_REFUSED") }
        try key(36, window: window); return [:]
    case "quit": return try quit(min(25, max(0.001, (input["quitMs"] as? Double ?? 25000) / 1000)))
    default: throw refuse("BENCH_SAFARI_COMMAND_INVALID")
    }
}
func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self)); fflush(stdout)
}

if CommandLine.arguments.dropFirst() == ["--self-test-owner-safety"] {
    // Pure policy fixtures: no application lookup, AX messaging or event posting.
    var ownerReads = 0, verifiedReads = 0, result: [String: Any] = [:]
    result["ownerSnapshot"] = windowSnapshot("owner", evidence: nil) { ownerReads += 1; return ["title": "private"] }
    _ = windowSnapshot("profile", evidence: ["value": profileName]) { verifiedReads += 1; return ["title": "marker"] }
    result["ownerContentReads"] = ownerReads; result["verifiedContentReads"] = verifiedReads
    result["probe"] = redactedAttributes(["AXTitle", "AXDescription", "AXURL", "AXValue"], profileAttribute: "AXDescription")
    func refusal(_ body: () throws -> Void) -> String {
        do { try body(); return "NOT_REFUSED" } catch { return (error as? Refusal)?.message ?? "UNKNOWN" }
    }
    result["wrongKey"] = refusal { try verifyKeyWindow(hasProfile: true, matches: false) }
    result["missingKey"] = refusal { try verifyKeyWindow(hasProfile: true, matches: false) }
    result["missingProfile"] = refusal { try verifyKeyWindow(hasProfile: false, matches: true) }
    try verifyKeyWindow(hasProfile: true, matches: true); result["verifiedKey"] = true
    var escapes = 0
    let cleaned = try cleanMenus(escape: { escapes += 1 }, clear: {
        menuStateClear(escapes == 1 ? [["role": "AXMenuBarItem", "selected": true]] : [["role": "AXMenu", "visible": false]])
    })
    result["menuEscapes"] = escapes; result["menuEscapePosted"] = cleaned["menuEscapePosted"]
    escapes = 0
    result["stuckMenu"] = refusal {
        _ = try cleanMenus(escape: { escapes += 1 }, clear: { menuStateClear([["role": "AXMenu"]]) })
    }
    result["stuckEscapes"] = escapes; escapes = 0
    result["unsafeMenu"] = refusal {
        _ = try cleanMenus(escape: { try verifyKeyWindow(hasProfile: false, matches: true); escapes += 1 }, clear: { true })
    }
    result["unsafeEscapes"] = escapes
    result["identifierProfile"] = identifierProfile("TabGroupPickerButton?Profile=sleight%20benchmark&Icon=hammer.fill") == profileName
    result["identifierOther"] = identifierProfile("TabGroupPickerButton?Profile=owner&Icon=x") == profileName
    result["identifierPrefix"] = identifierProfile("Other?Profile=sleight%20benchmark") == nil
    result["searchFieldReadable"] = menuChildrenReadable(role: "AXTextField", names: ["AXChildren"], readable: false)
    result["menuChildrenUnreadable"] = menuChildrenReadable(role: "AXMenu", names: ["AXChildren"], readable: false)
    result["menuWithoutVisible"] = menuStateClear([["role": "AXMenu", "visible": menuVisible(role: "AXMenu", names: ["AXChildren"], value: Optional<CFTypeRef>.none as Any)]])
    result["menuVisibleUnknown"] = menuStateClear([["role": "AXMenu", "visible": menuVisible(role: "AXMenu", names: ["AXVisible"], value: Optional<CFTypeRef>.none as Any)]])
    result["preferredElement"] = preferredProfileEvidence([["element": "other"], ["element": "profile", "identifier": "ProfileButton"]])?["element"]
    result["ambiguousProfile"] = preferredProfileEvidence([["element": "one"], ["element": "two"]]) == nil
    result["visibleMenuClear"] = menuStateClear([["role": "AXMenu", "visible": true]])
    result["selectedMenuClear"] = menuStateClear([["role": "AXMenuBarItem", "selected": true]])
    escapes = 0
    _ = try cleanMenus(escape: { escapes += 1 }, clear: { true }); result["clearMenuEscapes"] = escapes
    result["unknownSelectedMenuClear"] = menuStateClear([["role": "AXMenuBarItem"]])
    result["unknownRoleMenuClear"] = menuStateClear([["role": ""]])
    result["bridgedSelectedMenuClear"] = menuStateClear([["role": "AXMenuBarItem", "selected": Optional<CFTypeRef>.some(kCFBooleanTrue) as Any]])
    try emit(result); exit(0)
}
if CommandLine.arguments.dropFirst() == ["--self-test-unreceipted-launch"] {
    // Simulate a missing launch receipt; quit must refuse before any app lookup.
    launchRequested = true
    do { try emit(quit(0.001)); exit(1) }
    catch { try emit(["error": (error as? Refusal)?.message ?? error.localizedDescription]); exit(0) }
}
if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--probe", let pid = Int32(CommandLine.arguments[2]), pid > 0 {
    // Run only with no owner windows. Roles and attribute names; values are redacted.
    guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == "com.apple.Safari",
          app.executableURL?.resolvingSymlinksInPath().path == executable else { throw refuse("BENCH_SAFARI_PROBE_IDENTITY") }
    try emit(probeSnapshot(AXUIElementCreateApplication(pid))); exit(0)
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
