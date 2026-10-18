// Probe for the Slack and Spotify benchmark tasks (bench/real-apps.mjs). One JSON request in argv[1], one JSON line out.
// No input events and no Apple events. Output is counts and booleans: message text never leaves this process.
import AppKit
import ApplicationServices

struct ProbeError: Error { let code: String; init(_ code: String) { self.code = code } }
func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data([10]))
}
func pump(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }

// Slack's tree as measured 2026-10-18 (AXManualAccessibility on): AXWindow > ... > AXList "new-channel (channel)" >
// AXGroup > AXStaticText, and the composer AXTextArea "Message to new-channel".
final class Walker {
    let app: AXUIElement
    let deadline = Date().addingTimeInterval(25)
    var nodes = 0
    init(_ pid: pid_t) { app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 2) }
    func read(_ node: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
        guard Date() < deadline else { throw ProbeError("APP_NATIVE_TIMEOUT") }
        var value: CFTypeRef?
        let code = AXUIElementCopyAttributeValue(node, attribute as CFString, &value)
        if code == .attributeUnsupported || code == .noValue { return nil }
        guard code == .success else { throw ProbeError("APP_AX_UNAVAILABLE") }
        return value
    }
    func text(_ node: AXUIElement, _ attribute: String) throws -> String { try read(node, attribute) as? String ?? "" }
    func windows() throws -> [AXUIElement] { try read(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] }
    func enable() {
        // The app is quit after the check, so the switch is left on.
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        pump(0.5)
    }
    func slack(channel: String, message: String) throws -> [String: Any] {
        var lists = 0, count = 0, composerHolds = false
        func visit(_ node: AXUIElement, depth: Int, inList: Bool) throws {
            guard nodes < 40000, depth <= 48 else { throw ProbeError("APP_AX_LIMIT") }
            nodes += 1
            let role = try text(node, kAXRoleAttribute)
            let description = try text(node, kAXDescriptionAttribute)
            var inside = inList
            if role == "AXList" && description == "\(channel) (channel)" { lists += 1; inside = true }
            if inside && role == "AXStaticText" { if try text(node, kAXValueAttribute) == message { count += 1 } }
            if role == "AXTextArea" && description == "Message to \(channel)" { if try text(node, kAXValueAttribute).contains(message) { composerHolds = true } }
            for child in try read(node, kAXChildrenAttribute) as? [AXUIElement] ?? [] { try visit(child, depth: depth + 1, inList: inside) }
        }
        for window in try windows() { try visit(window, depth: 0, inList: false) }
        return ["listFound": lists > 0, "count": count, "composerHolds": composerHolds, "nodes": nodes]
    }
}

func main() throws {
    guard let data = CommandLine.arguments.dropFirst().first?.data(using: .utf8),
        let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let operation = request["op"] as? String, let bundle = request["bundle"] as? String else { throw ProbeError("APP_SETUP_FAILED") }
    func running() -> [NSRunningApplication] { NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle && !$0.isTerminated } }
    if operation == "table" {
        let processes: [[String: Any]] = running().map { ["pid": Int($0.processIdentifier), "launchedAt": $0.launchDate?.timeIntervalSince1970 as Any? ?? NSNull(),
            "finished": $0.isFinishedLaunching] }
        try emit(["processes": processes, "trusted": AXIsProcessTrusted()]); return
    }
    guard let pid = (request["pid"] as? Int).map({ pid_t($0) }) else { throw ProbeError("APP_SETUP_FAILED") }
    let target = running().first { $0.processIdentifier == pid }
    if operation == "quit" {
        // Never force-quit, and never pick another process by bundle.
        guard let target else { try emit(["quit": true]); return }
        guard target.terminate() else { throw ProbeError("APP_CLEANUP_UNCONFIRMED") }
        let deadline = Date().addingTimeInterval(15)
        while !target.isTerminated && Date() < deadline { pump(0.1) }
        guard target.isTerminated else { throw ProbeError("APP_CLEANUP_UNCONFIRMED") }
        try emit(["quit": true]); return
    }
    guard target != nil else { throw ProbeError("APP_NOT_RUNNING") }
    guard AXIsProcessTrusted() else { throw ProbeError("APP_ACCESSIBILITY_UNAVAILABLE") }
    let walker = Walker(pid)
    if operation == "ready" { try emit(["ready": try walker.windows().count > 0]); return }
    if operation == "slack", let nonce = request["nonce"] as? String, let channel = request["channel"] as? String {
        walker.enable()
        try emit(try walker.slack(channel: channel, message: "bench \(nonce)")); return
    }
    throw ProbeError("APP_SETUP_FAILED")
}
do { try main() }
catch { FileHandle.standardError.write(Data(((error as? ProbeError)?.code ?? "APP_SETUP_FAILED").utf8) + Data([10])); exit(1) }
