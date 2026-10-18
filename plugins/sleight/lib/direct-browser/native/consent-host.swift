// Original sleight source. UI choices come only from native button/menu events.
// No accessibility grant, synthetic input, browser launch or page bridge.
import AppKit
import Foundation
import CoreFoundation

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
    // pid 0: no process with the debugger yet. A copy the user is running without it gets its own relaunch card next.
    let process = pid == 0 ? "not connected yet (sleight starts or reopens it only after your approval)" : "\(pid)"
    let identity = "\(name) \(version)\nBundle: \(bundle)\nSigner: \(signer)\nExecutable: \(executable)\nProfile: \(profile)\nProcess: \(process)\nSession: \(card.session)"
    if card.kind == "relaunch" {
        return ("Quit and reopen " + name + " for sleight?",
            "sleight will ask " + name + " to quit through its own Quit command, then reopen it in the background on the same profile with the debugger connection. Unsaved work follows the app's own prompts, and sleight answers none of them. Cancel keeps " + name + " as it is. This approval is for this process only, once.\n\n" + identity)
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

let app = NSApplication.shared
let host = ConsentHost()
app.setActivationPolicy(.accessory)
app.delegate = host
app.run()
