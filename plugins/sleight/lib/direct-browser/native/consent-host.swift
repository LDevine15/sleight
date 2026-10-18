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

final class ConsentHost: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var pending: [String: [String: Any]] = [:]
    var nonce: String?
    let outputLock = NSLock()

    func applicationDidFinishLaunching(_ notification: Notification) {
        item.button?.title = "sleight disconnected"
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
            guard ["connected-idle", "connected", "paused", "disconnected", "cleanup-required"].contains(status),
                choices.allSatisfy({ ["pause", "resume", "disconnect", "connect", "cancel", "cleanup"].contains($0) }) else { exit(65) }
            item.button?.title = "sleight " + status
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
                for choice in choices {
                    let row = NSMenuItem(title: choice.capitalized, action: #selector(control(_:)), keyEquivalent: "")
                    row.target = self; row.representedObject = ["id": id, "choice": choice]; menu.addItem(row)
                }
            } else {
                let row = NSMenuItem(title: "Review sleight request", action: #selector(review(_:)), keyEquivalent: "")
                row.target = self; row.representedObject = id; menu.addItem(row)
            }
        }
        item.menu = menu
    }
    @objc func control(_ sender: NSMenuItem) {
        guard let event = sender.representedObject as? [String: String], let id = event["id"], let choice = event["choice"] else { return }
        respond(id, choice)
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
