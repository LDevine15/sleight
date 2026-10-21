// Offscreen fixture: real AppKit controls, synthetic identity, no host, engine, input, or screen capture.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
func frame(_ rect: NSRect) -> [String: Double] {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}
var records: [[String: Any]] = []
let destination = CommandLine.arguments[1]
let installedIcon = CommandLine.arguments[2]
func capture(_ card: AskCardPanel, _ name: String) throws {
    let view = card.panel.contentView!
    view.layoutSubtreeIfNeeded()
    let buttons = descendants(view).compactMap { $0 as? NSButton }.filter { $0.title != "Details" }
    let fields = descendants(view).compactMap { $0 as? NSTextField }.filter { !$0.isHiddenOrHasHiddenAncestor }
    let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
    view.cacheDisplay(in: view.bounds, to: bitmap)
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: destination + "/" + name + ".png"))
    records.append(["name": name, "frame": frame(view.bounds), "windowFrame": frame(card.panel.frame), "visible": card.panel.isVisible,
        "detailsFlipped": card.detailsText.isFlipped, "detailsViewport": frame(card.detailsScroll.documentVisibleRect),
        "detailsDocument": frame(card.detailsText.frame),
        "detailsHidden": card.detailsScroll.isHiddenOrHasHiddenAncestor, "detailsFrame": frame(card.detailsScroll.frame),
        "summaryFrame": frame(card.scroll.frame),
        "hidesOnDeactivate": card.panel.hidesOnDeactivate,
        "buttons": buttons.map { ["title": $0.title, "tag": $0.tag, "frame": frame($0.convert($0.bounds, to: view)),
            "intrinsicWidth": $0.intrinsicContentSize.width, "default": $0.keyEquivalent == "\r"] },
        "fields": fields.map { ["text": $0.stringValue, "frame": frame($0.convert($0.bounds, to: view))] }])
}
let ordinary = AskCard(question: "Allow Grok Bot to use TextEdit?", detail: "Allow for this Grok Bot session only.", host: "Grok Bot", icon: installedIcon, kind: "app", choices: ["cancel", "once"])
let deadline = Date().timeIntervalSince1970 * 1000 + 60000
var answers: [String] = []
let ordinaryPanel = AskCardPanel(ordinary, deadline: deadline) { answers.append($0) }
try capture(ordinaryPanel, "ordinary")
ordinaryPanel.close()
for temporary in [true, false] {
    let app: [String: Any] = ["name": "Fixture Editor", "bundleId": "invalid.fixture.editor", "signer": "TEAM123456", "version": "1.2.3",
        "runtime": "electron/39", "profile": NSTemporaryDirectory() + String(repeating: "long-profile-segment/", count: 12), "temporary": temporary,
        "pid": 4242, "pidBirth": "1760000000.25", "executable": "/Applications/Fixture Editor.app/Contents/MacOS/Fixture Editor",
        "cdhash": String(repeating: "a", count: 40)]
    let data: [String: Any] = ["kind": "debugger", "app": app, "session": String(repeating: "session-", count: 16), "turn": "fixture", "epoch": 1]
    let choices = temporary ? ["once", "session", "cancel"] : ["once", "session", "always", "cancel"]
    let automatic = automaticCard(data, choices)!
    let card = AskCard(question: automatic.question, detail: automatic.detail, host: automatic.host, icon: installedIcon,
        kind: automatic.kind, choices: automatic.choices, diagnostics: automatic.diagnostics)
    let panel = AskCardPanel(card, deadline: deadline) { answers.append($0) }
    let prefix = temporary ? "electron-three" : "electron-four"
    try capture(panel, prefix + "-collapsed")
    let buttons = descendants(panel.panel.contentView!).compactMap { $0 as? NSButton }
    let approval = buttons.first { $0.title == "Allow once" }!
    let originalTarget = approval.target
    let originalTimer = panel.timer
    if let details = buttons.first(where: { $0.title == "Details" }), let target = details.target as? NSObject, let action = details.action {
        _ = target.perform(action, with: details)
        try capture(panel, prefix + "-expanded")
        refuseConsentInput(approval)
        try capture(panel, prefix + "-feedback")
        _ = target.perform(action, with: details)
        try capture(panel, prefix + "-feedback-collapsed")
    }
    precondition(approval.target === originalTarget && panel.timer === originalTimer && answers.isEmpty && !panel.finished)
    panel.close()
    if !temporary {
        let narrow = AskCardPanel(card, deadline: deadline) { answers.append($0) }
        narrow.layout(in: NSRect(x: 0, y: 0, width: 480, height: 480))
        try capture(narrow, "narrow-display")
        narrow.toggleDetails(narrow.disclosure)
        refuseConsentInput(narrow.buttons[1])
        try capture(narrow, "narrow-display-feedback")
        narrow.close()
        var longApp = app
        longApp["name"] = "Fixture Editor for Customer Support and Documentation"
        let longData = data.merging(["app": longApp]) { $1 }
        let longPanel = AskCardPanel(automaticCard(longData, choices)!, deadline: deadline) { answers.append($0) }
        longPanel.layout(in: NSRect(x: 0, y: 0, width: 640, height: 480))
        try capture(longPanel, "long-name-small-display")
        longPanel.toggleDetails(longPanel.disclosure)
        try capture(longPanel, "long-name-small-display-expanded")
        refuseConsentInput(longPanel.buttons[1])
        try capture(longPanel, "long-name-small-display-feedback")
        longPanel.close()
        let relaunchData = longData.merging(["kind": "relaunch"]) { $1 }
        let relaunch = AskCardPanel(automaticCard(relaunchData, ["relaunch", "cancel"])!, deadline: deadline) { answers.append($0) }
        try capture(relaunch, "relaunch")
        relaunch.close()
        var maximumApp = app
        maximumApp["name"] = String(String(repeating: "Long Fixture Editor ", count: 20).prefix(256))
        maximumApp["version"] = String(repeating: "1.", count: 64)
        maximumApp["bundleId"] = "invalid.fixture." + String(repeating: "a", count: 239)
        maximumApp["signer"] = String(repeating: "S", count: 256)
        maximumApp["runtime"] = String(repeating: "r", count: 128)
        maximumApp["executable"] = "/" + String(repeating: "e", count: 4095)
        maximumApp["profile"] = "/" + String(repeating: "p", count: 4095)
        for kind in ["debugger", "relaunch"] {
            let maximumData = data.merging(["kind": kind, "app": maximumApp, "session": String(repeating: "s", count: 128)]) { $1 }
            let model = automaticCard(maximumData, kind == "relaunch" ? ["relaunch", "cancel"] : choices)!
            let maximum = AskCardPanel(model, deadline: deadline) { answers.append($0) }
            maximum.layout(in: NSRect(x: 0, y: 0, width: 480, height: 480))
            try capture(maximum, "maximum-identity-" + kind + "-collapsed")
            maximum.toggleDetails(maximum.disclosure)
            try capture(maximum, "maximum-identity-" + kind + "-expanded")
            refuseConsentInput(maximum.buttons[1])
            try capture(maximum, "maximum-identity-" + kind + "-feedback")
            maximum.close()
        }
    }
}
let output = try JSONSerialization.data(withJSONObject: ["cards": records, "answers": answers], options: [.sortedKeys])
print(String(data: output, encoding: .utf8)!)
