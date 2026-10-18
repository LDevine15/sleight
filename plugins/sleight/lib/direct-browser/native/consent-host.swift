// Original sleight source. UI choices come only from native button/menu events.
// No accessibility grant, synthetic input, browser launch or page bridge.
// With --hand the same binary is the ghost hand's host instead: it only draws, and never writes stdout.
import AppKit
import Foundation
import CoreFoundation
import QuartzCore
import Carbon.HIToolbox

// BEGIN SESSION FRAME
func sessionFrame(_ data: [String: Any], _ choices: [String]) -> (kind: String, session: String)? {
    guard Set(data.keys) == Set(["kind", "session", "epoch"]),
        let kind = data["kind"] as? String, ["opt-in", "resume"].contains(kind),
        let session = data["session"] as? String, !session.isEmpty, session.count <= 128,
        session.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
        let epoch = data["epoch"] as? NSNumber, CFGetTypeID(epoch) != CFBooleanGetTypeID(),
        epoch.doubleValue >= 0, epoch.doubleValue.rounded() == epoch.doubleValue,
        choices == [kind == "opt-in" ? "enable" : "resume", "cancel"] else { return nil }
    return (kind, session)
}
// END SESSION FRAME

// BEGIN APP FRAME
// Debugger and relaunch cards for an Electron app. Exact keys and exact choice sets: Always is offered only on a
// debugger card for a persistent profile, and a relaunch card never offers a standing choice.
func appFrame(_ data: [String: Any], _ choices: [String]) -> (kind: String, app: [String: Any], session: String, turn: String)? {
    func text(_ value: Any?, _ limit: Int) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= limit,
            value.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f && !(0x80...0x9f).contains($0.value) }) else { return nil }
        return value
    }
    func count(_ value: Any?) -> Bool {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return false }
        return value.doubleValue >= 1 && value.doubleValue.rounded() == value.doubleValue
    }
    // A process, or the unlaunched form (pid 0 with birth "unlaunched", as electron-identity validates it) on a
    // debugger card only: the card names the code before sleight starts it. A relaunch card needs a running process.
    func process(_ kind: String, _ app: [String: Any]) -> Bool {
        guard let birth = text(app["pidBirth"], 64) else { return false }
        if count(app["pid"]) { return birth != "unlaunched" }
        guard let pid = app["pid"] as? NSNumber, CFGetTypeID(pid) != CFBooleanGetTypeID() else { return false }
        return kind == "debugger" && pid.doubleValue == 0 && birth == "unlaunched"
    }
    guard Set(data.keys) == Set(["kind", "app", "session", "turn", "epoch"]),
        let kind = data["kind"] as? String, ["debugger", "relaunch"].contains(kind),
        let app = data["app"] as? [String: Any],
        Set(app.keys) == Set(["name", "bundleId", "signer", "version", "runtime", "profile", "temporary", "pid", "pidBirth", "executable", "cdhash"]),
        text(app["executable"], 4096)?.hasPrefix("/") == true,
        text(app["cdhash"], 64)?.range(of: "^([0-9a-f]{40}|[0-9a-f]{64})$", options: .regularExpression) != nil,
        text(app["name"], 256) != nil, text(app["signer"], 256) != nil, text(app["version"], 128) != nil, text(app["runtime"], 128) != nil,
        process(kind, app),
        let bundle = text(app["bundleId"], 255), bundle.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil,
        let profile = text(app["profile"], 4096), profile.hasPrefix("/"),
        let temporary = app["temporary"] as? NSNumber, CFGetTypeID(temporary) == CFBooleanGetTypeID(),
        let session = data["session"] as? String, !session.isEmpty, session.count <= 128,
        session.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
        let turn = text(data["turn"], 4096),
        count(data["epoch"]),
        choices == (kind == "relaunch" ? ["relaunch", "cancel"] : temporary.boolValue ? ["once", "session", "cancel"] : ["once", "session", "always", "cancel"])
        else { return nil }
    return (kind, app, session, turn)
}
func appCardText(_ card: (kind: String, app: [String: Any], session: String, turn: String)) -> (title: String, body: String) {
    let name = card.app["name"] as? String ?? "", version = card.app["version"] as? String ?? ""
    let bundle = card.app["bundleId"] as? String ?? "", profile = card.app["profile"] as? String ?? ""
    let pid = (card.app["pid"] as? NSNumber)?.intValue ?? 0
    let executable = card.app["executable"] as? String ?? "", signer = card.app["signer"] as? String ?? ""
    let process = pid == 0 ? "not running (sleight starts it only after this approval)" : "\(pid)"
    let identity = "\(name) \(version)\nBundle: \(bundle)\nSigner: \(signer)\nExecutable: \(executable)\nProfile: \(profile)\nProcess: \(process)\nSession: \(card.session)"
    if card.kind == "relaunch" {
        return ("Quit and reopen " + name + " for sleight?",
            "sleight will ask " + name + " to quit through its own Quit command, then reopen it with the debugger connection. Unsaved work follows the app's own prompts. This approval is for this process only, once.\n\n" + identity)
    }
    return ("Let sleight debug " + name + "?",
        "The debugger lets sleight read the pages in " + name + " and operate them in the background, including anything open or signed in. This is separate from the app approval you already gave. Once ends with this turn, This session ends with the session, and Always allow stays until you revoke it for this build and profile.\n\n" + identity)
}
// END APP FRAME

// BEGIN STATUS MENU
// The menu bar item shows only while turbo is in use: connected, idle, paused or waiting for cleanup, or while a request
// waits for the person. Disconnected with nothing pending, it is hidden. The menu is a status block (coloured dot, bold
// state, quiet detail lines), the session controls, Turn Turbo Off… (confirmed first), Settings & Help…, and the version.
// The worker's choices map to labels here and nowhere else.
enum StatusRow: Equatable {
    case status(title: String, dot: String, details: [String])
    case action(String, choice: String)
    case confirm(String, choice: String)
    case help
    case separator
    case footer(String)
}
let stateWords = ["connected": "Connected", "connected-idle": "Connected", "paused": "Paused", "cleanup-required": "Cleanup needed", "disconnected": "Disconnected"]
let dotColours = ["connected": "green", "connected-idle": "green", "paused": "orange", "cleanup-required": "red", "disconnected": "gray"]
let choiceWords = ["pause": "Pause", "resume": "Resume", "disconnect": "Disconnect", "connect": "Connect", "cleanup": "Clean Up", "turbo-off": "Turn Turbo Off…", "cancel": "Cancel"]
let paymentWords = ["ask": "Payments: asks unless you named the amount", "always": "Payments: always asks", "never": "Payments: asks only for ones you didn't request"]
let optOutFailed = "Couldn't turn turbo off. Run sleight-mcp turbo off."
func statusVisible(_ status: String?, requests: Int) -> Bool {
    requests > 0 || ["connected", "connected-idle", "paused", "cleanup-required"].contains(status ?? "")
}
func statusRows(_ data: [String: Any], _ choices: [String]) -> [StatusRow]? {
    guard let status = data["status"] as? String, let word = stateWords[status], let dot = dotColours[status],
        choices.allSatisfy({ choiceWords[$0] != nil }) else { return nil }
    let browser = (data["browser"] as? String).flatMap { name in
        !name.isEmpty && name.count <= 40 && name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == " " }) ? name : nil }
    let title = browser.map { status.hasPrefix("connected") ? word + " to " + $0 : word + " · " + $0 } ?? word
    var details: [String] = []
    if status == "connected-idle" { details.append("Its Claude Code session has ended") }
    if status == "paused" { details.append("Resumes when Claude next asks, with your OK") }
    if let payments = data["payments"] as? String, let words = paymentWords[payments] { details.append(words) }
    if data["optOut"] as? String == "failed" { details.append(optOutFailed) }
    var rows: [StatusRow] = [.status(title: title, dot: dot, details: details)]
    let session = choices.filter { $0 != "turbo-off" }
    if !session.isEmpty { rows.append(.separator); rows += session.map { .action(choiceWords[$0]!, choice: $0) } }
    rows.append(.separator)
    if choices.contains("turbo-off") { rows.append(.confirm(choiceWords["turbo-off"]!, choice: "turbo-off")) }
    rows.append(.help)
    if let version = data["version"] as? String, version.range(of: #"^\d{1,3}\.\d{1,3}\.\d{1,3}$"#, options: .regularExpression) != nil {
        rows += [.separator, .footer("sleight " + version)]
    }
    return rows
}
// END STATUS MENU

final class ConsentHost: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var pending: [String: [String: Any]] = [:]
    var nonce: String?
    let outputLock = NSLock()

    var status: String?
    // Fable's menu bar glove (2026-10-18, picked by the owner): an open glove whose wrist breaks into the icon's square dabs,
    // with the pointer at its fingertips. A vector template image, drawn by macOS in the bar's own colour.
    static let glyph = ##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 18" width="24" height="18"><g fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"><line x1="5"  y1="3.5" x2="5"  y2="10"/><line x1="8"  y1="2"   x2="8"  y2="10"/><line x1="11" y1="2.8" x2="11" y2="10"/><line x1="14" y1="4.5" x2="14" y2="10"/><line x1="5.5" y1="12.5" x2="1.8" y2="8.5"/></g><path fill="#000" d="M4 9 H15 V11 L14 13.5 H6 L5 11 Z"/><rect x="6"    y="14.5" width="2"   height="2"   fill="#000"/><rect x="9.5"  y="15"   width="2"   height="2"   fill="#000"/><rect x="13"   y="14.5" width="2"   height="2"   fill="#000"/><rect x="2.5"  y="16"   width="2"   height="2"   fill="#000"/><path fill="#000" d="M16.5 1 L16.5 9.75 L18.6 7.86 L20.4 11.22 L21.68 10.59 L19.95 7.44 L22.94 7.44 Z"/></svg>"##

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let data = ConsentHost.glyph.data(using: .utf8), let image = NSImage(data: data) {
            image.size = NSSize(width: 24, height: 18)
            image.isTemplate = true
            item.button?.image = image
        } else { item.button?.title = "sleight" }
        item.isVisible = false
        item.menu = NSMenu()
        DispatchQueue.global().async { [weak self] in
            var buffer = Data()
            while let self = self {
                let chunk = FileHandle.standardInput.availableData
                if chunk.isEmpty { DispatchQueue.main.async { NSApp.terminate(nil) }; return }
                buffer.append(chunk)
                if buffer.count > 131072 { exit(65) }
                while let end = buffer.firstIndex(of: 10) {
                    let line = buffer.prefix(upTo: end)
                    buffer.removeSubrange(...end)
                    guard line.count <= 65536,
                        let frame = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { exit(65) }
                    DispatchQueue.main.async { self.receive(frame) }
                }
            }
        }
    }
    func receive(_ frame: [String: Any]) {
        guard let id = frame["id"] as? String, !id.isEmpty,
            let incoming = frame["nonce"] as? String, incoming.count == 64,
            nonce == nil || nonce == incoming,
            let choices = frame["choices"] as? [String], !choices.isEmpty,
            let deadline = frame["deadline"] as? Double,
            deadline > Date().timeIntervalSince1970 * 1000,
            let data = frame["data"] as? [String: Any], pending.count < 32 else { exit(65) }
        nonce = incoming
        guard pending[id] == nil else { exit(65) }
        pending[id] = frame
        if let status = data["status"] as? String {
            // Status is broker-owned; page observations belong only in the sheet.
            guard statusRows(data, choices) != nil else { exit(65) }
            self.status = status
            item.button?.toolTip = "sleight turbo: " + (stateWords[status] ?? status)
            item.button?.appearsDisabled = status == "paused"
            for old in Array(pending.keys) where old != id && (pending[old]?["data"] as? [String: Any])?["status"] != nil {
                pending.removeValue(forKey: old)
            }
        } else if data["kind"] as? String == "debugger" || data["kind"] as? String == "relaunch" {
            guard appFrame(data, choices) != nil else { exit(65) }
        } else if data["kind"] != nil {
            guard sessionFrame(data, choices) != nil else { exit(65) }
        } else {
            // A payment or operation sheet offers exactly what consent-ui sends: Allow once or Cancel.
            guard choices == ["once", "cancel"] else { exit(65) }
        }
        rebuildMenu()
    }
    func rebuildMenu() {
        let menu = NSMenu()
        for id in pending.keys.sorted() {
            guard let frame = pending[id], let choices = frame["choices"] as? [String],
                let data = frame["data"] as? [String: Any] else { continue }
            if data["status"] != nil {
                for row in statusRows(data, choices) ?? [] {
                    switch row {
                    case let .status(title, dot, details):
                        let entry = NSMenuItem(); entry.view = statusView(title, dot: dot, details: details); menu.addItem(entry)
                    case let .action(title, choice), let .confirm(title, choice):
                        let entry = NSMenuItem(title: title, action: row == .confirm(title, choice: choice) ? #selector(confirmOff(_:)) : #selector(control(_:)), keyEquivalent: "")
                        entry.target = self; entry.representedObject = ["id": id, "choice": choice]; menu.addItem(entry)
                    case .help:
                        let entry = NSMenuItem(title: "Settings & Help…", action: #selector(help(_:)), keyEquivalent: "")
                        entry.target = self; menu.addItem(entry)
                    case .separator: menu.addItem(NSMenuItem.separator())
                    case let .footer(text): menu.addItem(NSMenuItem(title: text, action: nil, keyEquivalent: ""))
                    }
                }
            } else {
                let row = NSMenuItem(title: "Review sleight request", action: #selector(review(_:)), keyEquivalent: "")
                row.target = self; row.representedObject = id; menu.addItem(row)
            }
        }
        item.menu = menu
        let requests = pending.values.filter { ($0["data"] as? [String: Any])?["status"] == nil }.count
        item.isVisible = statusVisible(status, requests: requests)
    }
    @objc func control(_ sender: NSMenuItem) {
        guard let event = sender.representedObject as? [String: String], let id = event["id"], let choice = event["choice"] else { return }
        respond(id, choice)
    }
    // Turning turbo off lasts past this session and reaches every session, so it asks once.
    @objc func confirmOff(_ sender: NSMenuItem) {
        guard let event = sender.representedObject as? [String: String], let id = event["id"], let choice = event["choice"] else { return }
        let alert = NSAlert()
        alert.messageText = "Turn turbo off?"
        alert.informativeText = "Turbo stops in every Claude Code session within a minute, and browsers go back to the engine's slower path. Run sleight-mcp turbo on to turn it back on."
        alert.addButton(withTitle: "Turn Off")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { respond(id, choice) }
    }
    @objc func help(_ sender: NSMenuItem) {
        if let url = URL(string: "https://github.com/Land-o-Clusters/sleight/blob/main/docs/settings.md#turbo") { NSWorkspace.shared.open(url) }
    }
    // The status block: a coloured dot and the state in bold, then quiet detail lines under it. A view, so it never highlights.
    func statusView(_ title: String, dot: String, details: [String]) -> NSView {
        let colours: [String: NSColor] = ["green": .systemGreen, "orange": .systemOrange, "red": .systemRed, "gray": .systemGray]
        let mark = NSImageView()
        if let circle = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 8, weight: .regular).applying(.init(paletteColors: [colours[dot] ?? .systemGray]))) {
            mark.image = circle
        }
        let heading = NSTextField(labelWithString: title)
        heading.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
        let top = NSStackView(views: [mark, heading]); top.spacing = 6
        let stack = NSStackView(views: [top]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 3
        stack.edgeInsets = NSEdgeInsets(top: 6, left: 14, bottom: 6, right: 16)
        for line in details {
            let label = NSTextField(labelWithString: line)
            label.font = .systemFont(ofSize: NSFont.smallSystemFontSize); label.textColor = .secondaryLabelColor
            let indented = NSStackView(views: [label]); indented.edgeInsets = NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 0)
            stack.addArrangedSubview(indented)
        }
        stack.frame = NSRect(origin: .zero, size: stack.fittingSize)
        return stack
    }
    @objc func review(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let frame = pending[id],
            let data = frame["data"] as? [String: Any], let choices = frame["choices"] as? [String],
            pending[id] != nil else { return }
        if let session = sessionFrame(data, choices) {
            let alert = NSAlert()
            alert.messageText = session.kind == "opt-in" ? "Enable sleight turbo for " + session.session : "Resume sleight turbo for " + session.session
            alert.informativeText = "This choice applies only to this session. Site permissions and action confirmations still apply."
            for choice in choices { alert.addButton(withTitle: choice.capitalized) }
            let result = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            respond(id, result >= 0 && result < choices.count ? choices[result] : "cancel")
            return
        }
        if let card = appFrame(data, choices) {
            let alert = NSAlert()
            let words = appCardText(card)
            alert.messageText = words.title
            alert.informativeText = words.body
            let labels = ["once": "Allow once", "session": "Allow this session", "always": "Always allow", "relaunch": "Quit and reopen", "cancel": "Cancel"]
            for choice in choices { alert.addButton(withTitle: labels[choice] ?? "Cancel") }
            let result = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            respond(id, result >= 0 && result < choices.count ? choices[result] : "cancel")
            return
        }
        guard
            let privateOperation = data["operation"] as? [String: Any],
            let view = data["view"] as? [String: Any],
            let session = view["clientSession"] as? String, let origin = view["origin"] as? String,
            let bytes = try? JSONSerialization.data(withJSONObject: privateOperation, options: [.prettyPrinted, .sortedKeys]),
            let text = String(data: bytes, encoding: .utf8) else { return }
        let alert = NSAlert()
        // A document inside an Electron app is named as one. It never reads as a web address.
        if view["documentKind"] as? String == "app-document" {
            alert.messageText = "sleight request for " + session + " in app document " + origin + " of " + (view["app"] as? String ?? "an app")
        } else { alert.messageText = "sleight request for " + session + " at " + origin }
        // Native plain text, outside the page. Exact destination, payload and
        // payment terms are visible to the person, and never emitted on stdout.
        alert.informativeText = "Page labels are observations. Review this exact operation:\n" + text
        for choice in choices { alert.addButton(withTitle: choice.capitalized) }
        let result = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if result >= 0 && result < choices.count { respond(id, choices[result]) }
        else { respond(id, "cancel") }
    }
    func respond(_ id: String, _ choice: String) {
        guard let frame = pending.removeValue(forKey: id), let choices = frame["choices"] as? [String],
            choices.contains(choice), let deadline = frame["deadline"] as? Double,
            deadline > Date().timeIntervalSince1970 * 1000, let nonce = nonce,
            let bytes = try? JSONSerialization.data(withJSONObject: ["id": id, "choice": choice, "nonce": nonce]) else { rebuildMenu(); return }
        outputLock.lock(); defer { outputLock.unlock() }
        FileHandle.standardOutput.write(bytes + Data([10]))
        rebuildMenu()
    }
}

// BEGIN HAND FRAME
// The ghost hand's stdin frames: a kind and global top-left screen points, nonce-bound and never answered. Exact keys only.
struct HandAct {
    let seq: Int, kind: String, pid: Int32, windowId: UInt32, at: CGPoint, path: [CGPoint], delay: Double, beats: Int
}
enum HandFrame { case act(String, HandAct), hide(String) }
let handKinds: Set<String> = ["click", "double", "right", "key", "type", "drag", "scroll"]
func handFrame(_ data: [String: Any]) -> HandFrame? {
    func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
        return value.doubleValue
    }
    func integer(_ value: Any?, _ range: ClosedRange<Double>) -> Int? {
        guard let value = number(value), value.rounded() == value, range.contains(value) else { return nil }
        return Int(value)
    }
    func point(_ value: Any?) -> CGPoint? {
        guard let pair = value as? [Any], pair.count == 2, let x = number(pair[0]), let y = number(pair[1]),
            abs(x) <= 100000, abs(y) <= 100000 else { return nil }
        return CGPoint(x: x, y: y)
    }
    guard let nonce = data["nonce"] as? String, nonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { return nil }
    if data["hand"] as? String == "hide" { return Set(data.keys) == ["hand", "nonce"] ? .hide(nonce) : nil }
    guard data["hand"] as? String == "act",
        Set(data.keys) == ["hand", "nonce", "seq", "kind", "pid", "windowId", "at", "path", "delayMs", "beats"],
        let seq = integer(data["seq"], 0...9007199254740991), let kind = data["kind"] as? String, handKinds.contains(kind),
        let pid = integer(data["pid"], 1...2147483647), let windowId = integer(data["windowId"], 1...4294967295),
        let at = point(data["at"]), let raw = data["path"] as? [Any], (1...64).contains(raw.count),
        let delay = integer(data["delayMs"], 0...10000), let beats = integer(data["beats"], 1...20) else { return nil }
    let path = raw.compactMap(point)
    guard path.count == raw.count else { return nil }
    return .act(nonce, HandAct(seq: seq, kind: kind, pid: Int32(pid), windowId: UInt32(windowId), at: at, path: path,
        delay: Double(delay) / 1000, beats: beats))
}
// Consecutive repeats dropped, so a one-point route means the hand appears there without a glide.
func handPoints(_ points: [CGPoint]) -> [CGPoint] {
    points.enumerated().filter { $0.offset == 0 || points[$0.offset - 1] != $0.element }.map { $0.element }
}
// The panel's frame for a route: the route's box plus 48 pt, before clipping to the target window.
func handBox(_ points: [CGPoint]) -> CGRect {
    let xs = points.map { $0.x }, ys = points.map { $0.y }
    guard let left = xs.min(), let right = xs.max(), let top = ys.min(), let bottom = ys.max() else { return .null }
    return CGRect(x: left - 48, y: top - 48, width: right - left + 96, height: bottom - top + 96)
}
// END HAND FRAME

// BEGIN HAND ART
// The one place for the ghost hand's look. Until the art director's assets land (ROADMAP 2.7, H7) it is the menu bar glove's own
// shapes, white at 70% opacity with a thin dark outline so it reads on light and dark windows, 32 pt tall at 1x and 2x.
enum HandArt {
    static let height: CGFloat = 32, opacity = 0.7
    // The glyph's 24 by 18 viewBox with room for the outline, at the art's aspect, and its pointer tip: the hand's action point.
    static let box = CGRect(x: -1, y: -1, width: 26.25, height: 20), tip = CGPoint(x: 16.5, y: 1)
    static var size: CGSize { CGSize(width: (height * box.width / box.height).rounded(), height: height) }
    // The layer's anchor sits on the tip (layer y runs up from the bottom).
    static var anchor: CGPoint { CGPoint(x: (tip.x - box.minX) / box.width, y: 1 - (tip.y - box.minY) / box.height) }
    static func shapes(_ colour: String, outline: Double) -> String {
        let fingers: [(Double, Double, Double, Double)] = [(5, 3.5, 5, 10), (8, 2, 8, 10), (11, 2.8, 11, 10), (14, 4.5, 14, 10), (5.5, 12.5, 1.8, 8.5)]
        let fills = ["M4 9 H15 V11 L14 13.5 H6 L5 11 Z", "M16.5 1 L16.5 9.75 L18.6 7.86 L20.4 11.22 L21.68 10.59 L19.95 7.44 L22.94 7.44 Z"]
        let dabs: [(Double, Double)] = [(6, 14.5), (9.5, 15), (13, 14.5), (2.5, 16)]
        let edge = outline > 0 ? " stroke=\"\(colour)\" stroke-width=\"\(outline)\" stroke-linejoin=\"round\"" : ""
        return "<g fill=\"none\" stroke=\"\(colour)\" stroke-width=\"\(2 + outline)\" stroke-linecap=\"round\">"
            + fingers.map { "<line x1=\"\($0.0)\" y1=\"\($0.1)\" x2=\"\($0.2)\" y2=\"\($0.3)\"/>" }.joined() + "</g>"
            + fills.map { "<path fill=\"\(colour)\"\(edge) d=\"\($0)\"/>" }.joined()
            + dabs.map { "<rect x=\"\($0.0)\" y=\"\($0.1)\" width=\"2\" height=\"2\" fill=\"\(colour)\"\(edge)/>" }.joined()
    }
    // The outline is the same shapes drawn wider in dark under the white ones.
    static var svg: String {
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"\(box.minX) \(box.minY) \(box.width) \(box.height)\" width=\"\(size.width)\" height=\"\(size.height)\">"
            + shapes("#1d1d1f", outline: 1.2) + shapes("#ffffff", outline: 0) + "</svg>"
    }
    static func image(scale: CGFloat) -> CGImage? {
        guard let data = svg.data(using: .utf8), let picture = NSImage(data: data),
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
            else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState(); defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        picture.draw(in: NSRect(origin: .zero, size: size))
        return rep.cgImage
    }
}
// END HAND ART

// BEGIN HAND HOST
// The ghost hand (ROADMAP 2.7): a glove that glides to where sleight acts in a background window, flourishes and fades. It only
// draws: the panel never activates, takes key, catches a click or shows in another process's capture, and it is released after
// the fade, so an idle host has no window and no scheduled work.
enum HandTiming { static let glide = 0.3, flourish = 0.15, fade = 0.3, silence = 1.5 }
final class HandPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
// Capture: hidden (.none) keeps the panel out of every capture, the user's own screenshots and recordings included, and
// visible (.readOnly) lets them show it. The client passes the user's setting as --capture=hidden|visible; hidden is the default.
let handCaptureModes: [String: NSWindow.SharingType] = ["hidden": NSWindow.SharingType.none, "visible": NSWindow.SharingType.readOnly]
func handCapture(_ args: [String]) -> String? {
    if args.isEmpty { return "hidden" }
    guard args.count == 1, args[0].hasPrefix("--capture="), handCaptureModes[String(args[0].dropFirst(10))] != nil else { return nil }
    return String(args[0].dropFirst(10))
}
func makeHandPanel(capture: String) -> HandPanel {
    let panel = HandPanel(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered, defer: true)
    panel.level = .floating
    panel.ignoresMouseEvents = true
    panel.hasShadow = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.sharingType = handCaptureModes[capture] ?? NSWindow.SharingType.none
    panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .stationary]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.animationBehavior = .none
    panel.setAccessibilityElement(false)
    let view = NSView()
    view.wantsLayer = true
    view.setAccessibilityElement(false)
    panel.contentView = view
    return panel
}
// Global top-left points to AppKit's bottom-left screen coordinates, which start at the primary display.
func appKitRect(_ rect: CGRect) -> NSRect {
    NSRect(x: rect.minX, y: (NSScreen.screens.first?.frame.maxY ?? 0) - rect.maxY, width: rect.width, height: rect.height)
}
// The target window's bounds while it is on screen and still the frame's pid's. Bounds and owner need no recording grant.
func handWindowBounds(_ windowId: UInt32, pid: Int32) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowId)) as? [[String: Any]],
        let info = list.first, (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowId,
        (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
        (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
        let bounds = info[kCGWindowBounds as String] as? NSDictionary,
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
    return rect
}
func handDemoRect(_ text: String) -> CGRect? {
    let parts = text.split(separator: ",", omittingEmptySubsequences: false).map { Double($0) }
    guard parts.count == 4, let x = parts[0], let y = parts[1], let width = parts[2], let height = parts[3],
        [x, y, width, height].allSatisfy({ $0.isFinite && abs($0) <= 100000 }), width >= 1, height >= 1 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

final class HandHost: NSObject, NSApplicationDelegate {
    var panel: HandPanel?
    var hand: CALayer?
    var box = CGRect.null       // the panel's frame, global top-left points
    var windowId: UInt32 = 0
    var pending: [Int: DispatchWorkItem] = [:]
    var fading: DispatchWorkItem?
    var next = 0
    var demo: CGRect?
    var capture = "hidden"
    lazy var images = [HandArt.image(scale: 1), HandArt.image(scale: 2)]
    var idle: Bool { panel == nil && hand == nil && pending.isEmpty && fading == nil }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let demo = demo { play(demo); return }
        DispatchQueue.global().async { self.read() }
    }
    // Validation, the nonce binding and the seq order run on this reader thread in frame order. Any bad frame ends the host.
    func read() {
        var buffer = Data(), bound: String?, last = -1
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { DispatchQueue.main.async { NSApp.terminate(nil) }; return }
            buffer.append(chunk)
            if buffer.count > 131072 { exit(65) }
            while let end = buffer.firstIndex(of: 10) {
                let line = buffer.prefix(upTo: end)
                buffer.removeSubrange(...end)
                guard line.count <= 8192, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                    let frame = handFrame(data) else { exit(65) }
                switch frame {
                case let .hide(nonce):
                    guard bound == nil || bound == nonce else { exit(65) }
                    bound = nonce
                    DispatchQueue.main.async { self.hide() }
                case let .act(nonce, act):
                    guard bound == nil || bound == nonce, act.seq > last else { exit(65) }
                    bound = nonce; last = act.seq
                    DispatchQueue.main.async { self.schedule(act) }
                }
            }
        }
    }
    // A frame plays after its delay unless a hide comes first. Past 64 waiting frames, new ones are dropped.
    func schedule(_ act: HandAct) {
        guard pending.count < 64 else { return }
        let id = next; next += 1
        let item = DispatchWorkItem { [weak self] in
            self?.pending[id] = nil
            if let bounds = handWindowBounds(act.windowId, pid: act.pid) { self?.draw(act, clip: bounds) }
        }
        pending[id] = item
        DispatchQueue.main.asyncAfter(deadline: .now() + act.delay, execute: item)
    }
    func hide() {
        pending.values.forEach { $0.cancel() }; pending.removeAll()
        if panel != nil { fade(after: 0) }
    }
    // The approach glides along the path into the action point. A drag approaches its grab point, then carries along the path.
    func draw(_ act: HandAct, clip: CGRect) {
        let start = panel != nil && windowId == act.windowId ? hand.map { global(($0.presentation() ?? $0).position) } : nil
        let approach = handPoints((start.map { [$0] } ?? []) + (act.kind == "drag" ? [act.at] : act.path + [act.at]))
        let carry = act.kind == "drag" ? handPoints([act.at] + act.path) : []
        guard layout(approach + carry, clip: clip), let panel = panel, let hand = hand else { return }
        fading?.cancel(); fading = nil
        let now = CACurrentMediaTime(), glide = HandTiming.glide, flourish = HandTiming.flourish
        func keyframes(_ path: String, _ values: [Any], at begin: Double, for duration: Double, repeats: Int = 1) {
            let animation = CAKeyframeAnimation(keyPath: path)
            animation.values = values; animation.beginTime = begin; animation.duration = duration
            animation.repeatCount = Float(repeats); animation.fillMode = .backwards
            hand.add(animation, forKey: path)
        }
        func route(_ points: [CGPoint], at begin: Double) {
            let path = CGMutablePath(); path.move(to: local(points[0]))
            for point in points.dropFirst() { path.addLine(to: local(point)) }
            let animation = CAKeyframeAnimation(keyPath: "position")
            animation.path = path; animation.calculationMode = .paced; animation.beginTime = begin; animation.duration = glide
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut); animation.fillMode = .backwards
            hand.add(animation, forKey: begin == now ? "approach" : "carry")
        }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let shown = (hand.presentation() ?? hand).opacity
        hand.removeAllAnimations()
        if shown < Float(HandArt.opacity) { keyframes("opacity", [shown, HandArt.opacity], at: now, for: flourish) }
        hand.opacity = Float(HandArt.opacity)
        var time = now
        if approach.count > 1 { route(approach, at: time); time += glide }
        hand.position = local((carry.count > 1 ? carry : approach).last!)
        switch act.kind {
        case "drag":
            // Grab, carry, release: the glove closes a little for the whole carry.
            let total = flourish * 2 + (carry.count > 1 ? glide : 0)
            let scale = CAKeyframeAnimation(keyPath: "transform.scale")
            scale.values = [1, 0.82, 0.82, 1]; scale.keyTimes = [0, NSNumber(value: flourish / total), NSNumber(value: 1 - flourish / total), 1]
            scale.beginTime = time; scale.duration = total; scale.fillMode = .backwards
            hand.add(scale, forKey: "transform.scale")
            if carry.count > 1 { route(carry, at: time + flourish) }
            time += total
        case "type" where IsSecureEventInputEnabled():
            break // a hand pecking at a password field would mislead
        default:
            let moves: [String: (String, [Double])] = ["click": ("transform.scale", [1, 0.82, 1]), "double": ("transform.scale", [1, 0.82, 1, 0.82, 1]),
                "right": ("transform.rotation.z", [0, -0.3, 0]), "key": ("transform.translation.y", [0, -3, 0]),
                "type": ("transform.translation.y", [0, -2, 0]), "scroll": ("transform.translation.y", [0, 5, -5, 0])]
            if let (path, values) = moves[act.kind] { keyframes(path, values, at: time, for: flourish, repeats: act.beats); time += flourish * Double(act.beats) }
        }
        CATransaction.commit()
        if !panel.isVisible { panel.orderFrontRegardless() }
        windowId = act.windowId
        fade(after: time - now + HandTiming.silence)
    }
    // Sizes the panel (made on first use) to the points' box plus 48 pt clipped to the window, keeping the hand where it is on
    // screen. It never shows the panel.
    func layout(_ points: [CGPoint], clip: CGRect) -> Bool {
        let frame = handBox(points).intersection(clip)
        guard !frame.isNull, frame.width >= 1, frame.height >= 1, let last = points.last else { return false }
        let panel = self.panel ?? makeHandPanel(capture: capture), hand = self.hand ?? CALayer()
        let screen = NSScreen.screens.first { NSPointInRect(NSPoint(x: last.x, y: appKitRect(CGRect(origin: last, size: .zero)).minY), $0.frame) }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let current = self.hand.map { global(($0.presentation() ?? $0).position) }
        panel.setFrame(appKitRect(frame), display: false)
        box = frame
        if self.hand == nil {
            hand.bounds = CGRect(origin: .zero, size: HandArt.size); hand.anchorPoint = HandArt.anchor; hand.opacity = 0
            panel.contentView?.layer?.addSublayer(hand)
        }
        if let current = current { hand.removeAllAnimations(); hand.position = local(current) }
        hand.contentsScale = screen?.backingScaleFactor ?? 2
        hand.contents = images[hand.contentsScale > 1 ? 1 : 0]
        CATransaction.commit()
        self.panel = panel; self.hand = hand
        return true
    }
    func local(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x - box.minX, y: box.maxY - point.y) }
    func global(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x + box.minX, y: box.maxY - point.y) }
    func fade(after delay: Double) {
        fading?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self = self, let hand = self.hand else { self?.release(); return }
            let animation = CABasicAnimation(keyPath: "opacity")
            animation.fromValue = (hand.presentation() ?? hand).opacity; animation.toValue = 0; animation.duration = HandTiming.fade
            hand.opacity = 0; hand.add(animation, forKey: "fade")
            let done = DispatchWorkItem { [weak self] in self?.release() }
            self.fading = done
            DispatchQueue.main.asyncAfter(deadline: .now() + HandTiming.fade, execute: done)
        }
        fading = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }
    func release() {
        panel?.orderOut(nil); panel?.close(); hand?.removeFromSuperlayer()
        panel = nil; hand = nil; box = .null; fading = nil
    }
    // --hand-demo X,Y,W,H plays every kind in turn inside that rect (global top-left points) for 30 seconds, then exits. It is
    // the live capture test's subject, and never reads stdin.
    func play(_ rect: CGRect) {
        let kinds = ["click", "double", "right", "key", "type", "drag", "scroll"]
        var step = 0
        let spot = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y) }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            let kind = kinds[step % kinds.count], at = spot(0.25 + 0.25 * CGFloat(step % 3), 0.4 + 0.2 * CGFloat(step % 2))
            self?.draw(HandAct(seq: step, kind: kind, pid: 0, windowId: 0, at: at, path: kind == "drag" ? [spot(0.8, 0.7)] : [at],
                delay: 0, beats: kind == "type" ? 3 : 1), clip: rect)
            step += 1
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { exit(0) }
    }
}
// END HAND HOST

// BEGIN HAND DUMP
// --hand-dump prints the panel's flags, the art, the timings and the box arithmetic as JSON for tests. Nothing is shown.
func handDump(capture: String) -> [String: Any] {
    let host = HandHost(), route = [CGPoint(x: 100, y: 100), CGPoint(x: 160, y: 200)]
    host.capture = capture
    let rect = { (r: CGRect) in [r.minX, r.minY, r.width, r.height].map { Double($0) } }
    let unclipped = handBox(route)
    _ = host.layout(route, clip: CGRect(x: 60, y: 0, width: 200, height: 200))
    let clipped = host.box
    guard let panel = host.panel else { return [:] }
    let behaviours: [(NSWindow.CollectionBehavior, String)] = [(.canJoinAllSpaces, "canJoinAllSpaces"), (.fullScreenAuxiliary, "fullScreenAuxiliary"),
        (.fullScreenNone, "fullScreenNone"), (.fullScreenPrimary, "fullScreenPrimary"), (.ignoresCycle, "ignoresCycle"), (.managed, "managed"),
        (.moveToActiveSpace, "moveToActiveSpace"), (.participatesInCycle, "participatesInCycle"), (.stationary, "stationary"), (.transient, "transient")]
    let sharing: [NSWindow.SharingType: String] = [.none: "none", .readOnly: "readOnly", .readWrite: "readWrite"]
    let size = HandArt.size, images = host.images
    // Opaque light and dark pixels at 2x: the white glove and its outline.
    var tones = [0, 0]
    if let image = images[1] {
        let rep = NSBitmapImageRep(cgImage: image)
        for x in 0..<rep.pixelsWide { for y in 0..<rep.pixelsHigh {
            guard let colour = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB), colour.alphaComponent > 0.9 else { continue }
            if colour.brightnessComponent > 0.9 { tones[0] += 1 } else if colour.brightnessComponent < 0.3 { tones[1] += 1 }
        } }
    }
    let dump: [String: Any] = [
        "panel": [
            "borderless": panel.styleMask.subtracting(.nonactivatingPanel).isEmpty, "nonactivatingPanel": panel.styleMask.contains(.nonactivatingPanel),
            "canBecomeKey": panel.canBecomeKey, "canBecomeMain": panel.canBecomeMain, "ignoresMouseEvents": panel.ignoresMouseEvents,
            "hasShadow": panel.hasShadow, "opaque": panel.isOpaque, "backgroundAlpha": Double(panel.backgroundColor.alphaComponent),
            "level": panel.level.rawValue, "sharingType": sharing[panel.sharingType] ?? "other",
            "collectionBehavior": behaviours.filter { panel.collectionBehavior.contains($0.0) }.map { $0.1 },
            "accessibilityElement": panel.isAccessibilityElement(), "contentAccessibilityElement": panel.contentView?.isAccessibilityElement() ?? true,
            "hidesOnDeactivate": panel.hidesOnDeactivate, "visible": panel.isVisible,
        ],
        "timing": ["glide": HandTiming.glide, "flourish": HandTiming.flourish, "fade": HandTiming.fade, "silence": HandTiming.silence],
        "art": ["width": Double(size.width), "height": Double(size.height), "opacity": HandArt.opacity,
            "anchor": [Double(HandArt.anchor.x), Double(HandArt.anchor.y)], "pixels": images.map { [$0?.width ?? 0, $0?.height ?? 0] }, "tones": tones],
        "box": ["unclipped": rect(unclipped), "clipped": rect(clipped)],
        "capture": host.capture,
    ]
    host.release()
    return dump.merging(["idle": host.idle]) { $1 }
}
// END HAND DUMP

// No arguments: the consent host. --hand [--capture=…], --hand-demo X,Y,W,H [--capture=…] and --hand-dump [--capture=…]: the hand.
let arguments = Array(CommandLine.arguments.dropFirst())
let app = NSApplication.shared
if arguments.isEmpty {
    let host = ConsentHost()
    app.setActivationPolicy(.accessory)
    app.delegate = host
    app.run()
} else {
    let mode = arguments[0]
    var rest = Array(arguments.dropFirst()), demo: CGRect?
    if mode == "--hand-demo" { guard let first = rest.first, let rect = handDemoRect(first) else { exit(64) }; demo = rect; rest.removeFirst() }
    guard ["--hand", "--hand-demo", "--hand-dump"].contains(mode), let capture = handCapture(rest) else { exit(64) }
    if mode == "--hand-dump" {
        guard let bytes = try? JSONSerialization.data(withJSONObject: handDump(capture: capture), options: [.sortedKeys]) else { exit(70) }
        FileHandle.standardOutput.write(bytes + Data([10]))
        exit(0)
    }
    let hand = HandHost()
    hand.demo = demo; hand.capture = capture
    app.setActivationPolicy(.accessory)
    app.delegate = hand
    app.run()
}
